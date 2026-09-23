'use strict';

const { AnalystRepository } = require('./analyst-repository');
const { YouTubeChannelSyncService } = require('./youtube-channel-sync-service');
const { MeasurementWindowPolicy } = require('./measurement-window-policy');
const { ChannelBenchmarkEngine } = require('./channel-benchmark-engine');
const { GeminiAdvisor } = require('./gemini-advisor');
const { RecommendationTracker } = require('./recommendation-tracker');
const { AnalystAnalyticsCollector } = require('./analyst-analytics-collector');
const { RetentionIntelligence } = require('./retention-intelligence');

class AnalystService {
  constructor(db, credentials, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.logger = options.logger || console;
    this.repository = options.repository || new AnalystRepository(db);
    this.windows = options.windows || new MeasurementWindowPolicy(options);
    this.benchmarks = options.benchmarks || new ChannelBenchmarkEngine(options);
    this.analytics = options.analyticsCollector || new AnalystAnalyticsCollector(db, credentials, {
      repository: this.repository,
      windows: this.windows,
      logger: this.logger,
      youtubeAnalytics: options.youtubeAnalytics
    });
    this.sync = options.sync || new YouTubeChannelSyncService(db, credentials, {
      repository: this.repository,
      logger: this.logger,
      maxBackfillVideos: options.maxBackfillVideos
    });
    this.advisor = options.advisor || new GeminiAdvisor(credentials, { repository: this.repository, logger: this.logger });
    this.recommendations = options.recommendations || new RecommendationTracker(this.repository, this.analytics, { logger: this.logger });
    this.retention = options.retention || new RetentionIntelligence(this.repository, this.analytics, this.windows, { logger: this.logger });
    this.measurementBatchSize = Math.max(1, Math.min(100, Number(options.measurementBatchSize || process.env.ANALYST_MEASUREMENT_BATCH || 10)));
    this.requestDelayMs = Math.max(0, Number(options.requestDelayMs ?? process.env.ANALYST_REQUEST_DELAY_MS ?? 750));
  }

  async initialize() {
    await this.repository.initialize();
    if (this.analytics?.initialize) await this.analytics.initialize();
    return true;
  }

  async syncCatalog(options = {}) {
    return this.sync.syncChannel(options);
  }

  async collectDueMeasurements(options = {}) {
    if (!this.analytics) throw new Error('Analytics agent is not initialized');
    await this.initialize();
    const limit = Math.max(1, Math.min(100, Number(options.limit || this.measurementBatchSize)));
    const videos = await this.repository.listVideos({ limit: Number(options.videoScanLimit || 5000) });
    const queue = [];

    // Oldest missing fixed milestones are prioritized before lifetime refreshes.
    for (const video of videos) {
      const existing = await this.db.listPerformanceSnapshots({ videoId: video.videoId, reliableOnly: true });
      const due = this.windows.dueWindows(video, existing);
      for (const measurementWindow of due) {
        queue.push({ video, measurementWindow, priority: this.measurementPriority(video, measurementWindow) });
      }
    }
    queue.sort((a, b) => a.priority - b.priority || new Date(a.video.publishedAt) - new Date(b.video.publishedAt));

    const selected = queue.slice(0, limit);
    const results = [];
    for (const [index, item] of selected.entries()) {
      try {
        const report = await this.analytics.measureVideo(item.video.videoId, item.measurementWindow);
        results.push({ videoId: item.video.videoId, measurementWindow: item.measurementWindow, status: 'completed', report });
      } catch (error) {
        results.push({ videoId: item.video.videoId, measurementWindow: item.measurementWindow, status: 'failed', error: error.message });
        this.warn(`Analyst measurement failed for ${item.video.videoId}/${item.measurementWindow}: ${error.message}`);
      }
      if (index < selected.length - 1 && this.requestDelayMs) await this.sleep(this.requestDelayMs);
    }

    return {
      queued: queue.length,
      attempted: selected.length,
      completed: results.filter(item => item.status === 'completed').length,
      failed: results.filter(item => item.status === 'failed').length,
      results: results.map(({ report, ...item }) => ({
        ...item,
        confidence: report?.learningSnapshot?.confidence || null,
        measuredAt: report?.learningSnapshot?.measuredAt || report?.analyzedAt || null
      }))
    };
  }

  async getSummary(options = {}) {
    await this.initialize();
    const [catalog, videos, snapshots] = await Promise.all([
      this.repository.getSummary(),
      this.repository.listVideos({ limit: Number(options.videoLimit || 5000) }),
      this.db.listPerformanceSnapshots({ reliableOnly: true })
    ]);
    const metadata = Object.fromEntries(videos.map(video => [video.videoId, video]));
    const benchmarkSets = this.benchmarks.buildBenchmarks(snapshots, metadata);
    const preferred = this.preferredSnapshots(snapshots);
    const diagnoses = preferred.map(snapshot => ({
      videoId: snapshot.videoId,
      measurementWindow: snapshot.measurementWindow,
      title: metadata[snapshot.videoId]?.title || snapshot.videoId,
      ...this.benchmarks.diagnose(snapshot, snapshots, metadata)
    }));

    const recommendations = await this.repository.listRecommendations({ limit: 100 });

    return {
      catalog,
      measurementCoverage: this.coverage(videos, snapshots),
      benchmarkSets,
      recommendationSummary: {
        total: recommendations.length,
        pending: recommendations.filter(item => item.status === 'pending').length,
        applied: recommendations.filter(item => item.status === 'applied').length,
        rejected: recommendations.filter(item => item.status === 'rejected').length,
        deferred: recommendations.filter(item => item.status === 'deferred').length,
        awaitingOutcome: recommendations.filter(item => item.status === 'applied' && !item.evaluatedAt).length
      },
      diagnoses: {
        packagingOpportunities: diagnoses.filter(item => item.diagnosis === 'packaging_opportunity').slice(0, 20),
        hookOpportunities: diagnoses.filter(item => item.diagnosis === 'promise_delivery_gap').slice(0, 20),
        strongPatterns: diagnoses.filter(item => item.diagnosis === 'strong_pattern').slice(0, 20),
        insufficientEvidence: diagnoses.filter(item => item.status === 'insufficient_evidence').length
      },
      evidencePolicy: 'Recommendations are channel-relative. Fixed historical windows use calendar-day Analytics evidence; early 24h/72h milestones are explicitly marked as proxies, not hour-exact measurements.'
    };
  }

  async getAdvice(videoId, measurementWindow = '28d') {
    await this.initialize();
    if (!this.advisor?.isAvailable?.()) {
      const error = new Error('Gemini advisor is unavailable; configure GEMINI_API_KEY');
      error.status = 503;
      error.code = 'ANALYST_AI_UNAVAILABLE';
      throw error;
    }
    const diagnosisBundle = await this.getVideoDiagnosis(videoId, measurementWindow);
    if (!diagnosisBundle) return null;
    if (diagnosisBundle.status === 'unmeasured') {
      const error = new Error('Video needs a reliable analytics snapshot before AI advice can be generated');
      error.status = 409;
      error.code = 'ANALYST_EVIDENCE_REQUIRED';
      throw error;
    }
    const [videos, snapshots] = await Promise.all([
      this.repository.listVideos({ limit: 5000 }),
      this.db.listPerformanceSnapshots({ reliableOnly: true })
    ]);
    const channelContext = {
      measurementCoverage: this.coverage(videos, snapshots),
      evidencePolicy: 'Channel-relative benchmark evidence only; no generic CTR or retention score is treated as universally good or bad.'
    };
    let retentionEvidence = null;
    try {
      retentionEvidence = await this.retention.analyze(
        diagnosisBundle.video,
        diagnosisBundle.selectedWindow,
        { refresh: false }
      );
    } catch (error) {
      this.warn(`Retention evidence unavailable for ${videoId}/${diagnosisBundle.selectedWindow}: ${error.message}`);
    }
    const advice = await this.advisor.advise({
      video: diagnosisBundle.video,
      measurementWindow: diagnosisBundle.selectedWindow,
      diagnosis: diagnosisBundle.diagnosis,
      channelContext,
      retentionEvidence
    });
    const recommendation = await this.recommendations.materializeFromAdvice(advice, diagnosisBundle);
    return { advice, recommendation };
  }

  async getRetentionAnalysis(videoId, measurementWindow = '28d', options = {}) {
    await this.initialize();
    const [video, snapshots] = await Promise.all([
      this.repository.getVideo(videoId),
      this.db.listPerformanceSnapshots({ videoId, reliableOnly: true })
    ]);
    if (!video) return null;
    const target = snapshots.find(item => item.measurementWindow === measurementWindow)
      || this.preferredSnapshots(snapshots)[0];
    if (!target) {
      const error = new Error('Video needs a reliable analytics snapshot before retention analysis');
      error.status = 409;
      error.code = 'ANALYST_EVIDENCE_REQUIRED';
      throw error;
    }
    const retention = await this.retention.analyze(video, target.measurementWindow, {
      refresh: options.refresh === true
    });
    return {
      video,
      selectedWindow: target.measurementWindow,
      retention
    };
  }

  listRecommendations(options = {}) {
    return this.repository.listRecommendations(options);
  }

  setRecommendationStatus(id, status, options = {}) {
    return this.recommendations.setStatus(id, status, options);
  }

  evaluateRecommendation(id, now = new Date()) {
    return this.recommendations.evaluate(id, now);
  }

  evaluateDueRecommendations(now = new Date(), limit = 20) {
    return this.recommendations.evaluateDue(now, limit);
  }

  async getVideoDiagnosis(videoId, measurementWindow = '28d') {
    await this.initialize();
    const [video, snapshots, allSnapshots, videos] = await Promise.all([
      this.repository.getVideo(videoId),
      this.db.listPerformanceSnapshots({ videoId, reliableOnly: true }),
      this.db.listPerformanceSnapshots({ reliableOnly: true }),
      this.repository.listVideos({ limit: 5000 })
    ]);
    if (!video) return null;
    const target = snapshots.find(item => item.measurementWindow === measurementWindow)
      || this.preferredSnapshots(snapshots)[0];
    if (!target) return { video, status: 'unmeasured', availableWindows: [] };
    const metadata = Object.fromEntries(videos.map(item => [item.videoId, item]));
    return {
      video,
      availableWindows: snapshots.map(item => item.measurementWindow),
      selectedWindow: target.measurementWindow,
      diagnosis: this.benchmarks.diagnose(target, allSnapshots, metadata)
    };
  }

  measurementPriority(video, measurementWindow, now = Date.now()) {
    const published = new Date(video.publishedAt || video.published_at || 0).getTime();
    const ageDays = Number.isFinite(published) ? (now - published) / 86400000 : Infinity;
    if (['24h', '72h'].includes(measurementWindow) && ageDays <= 14) return 0;
    if (measurementWindow === 'lifetime') return 2;
    return 1;
  }

  preferredSnapshots(snapshots) {
    const rank = { '28d': 6, '7d': 5, '72h': 4, '24h': 3, lifetime: 2, rolling: 1 };
    const selected = new Map();
    for (const snapshot of snapshots) {
      const current = selected.get(snapshot.videoId);
      if (!current || (rank[snapshot.measurementWindow] ?? -1) > (rank[current.measurementWindow] ?? -1)) {
        selected.set(snapshot.videoId, snapshot);
      }
    }
    return [...selected.values()];
  }

  coverage(videos, snapshots) {
    const byWindow = {};
    for (const snapshot of snapshots) byWindow[snapshot.measurementWindow] = (byWindow[snapshot.measurementWindow] || 0) + 1;
    return {
      catalogVideos: videos.length,
      measuredVideos: new Set(snapshots.map(item => item.videoId)).size,
      snapshots: snapshots.length,
      byWindow,
      windows: this.windows.definitions()
    };
  }

  warn(message) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(message);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { AnalystService };
