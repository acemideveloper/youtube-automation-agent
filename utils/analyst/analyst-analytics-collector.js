'use strict';

class AnalystAnalyticsCollector {
  constructor(db, credentials, options = {}) {
    if (!db) throw new Error('AnalystAnalyticsCollector requires a database');
    this.db = db;
    this.credentials = credentials;
    this.repository = options.repository;
    this.windows = options.windows;
    this.logger = options.logger || console;
    this.youtubeAnalytics = options.youtubeAnalytics || null;
  }

  async initialize() {
    if (!this.repository) throw new Error('AnalystAnalyticsCollector requires an analyst repository');
    if (!this.windows) throw new Error('AnalystAnalyticsCollector requires a measurement-window policy');
    if (!this.youtubeAnalytics) {
      const { google } = require('googleapis');
      this.youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth: this.credentials.getYouTubeAuth() });
    }
    return true;
  }

  async measureVideo(videoId, measurementWindow) {
    await this.initialize();
    const video = await this.repository.getVideo(videoId);
    if (!video) {
      const error = new Error(`Video ${videoId} is not present in the analyst catalog`);
      error.code = 'ANALYST_VIDEO_NOT_FOUND';
      throw error;
    }
    const period = this.windows.period(video.publishedAt, measurementWindow);
    if (!period) {
      const error = new Error(`Measurement window ${measurementWindow} is not ready for ${videoId}`);
      error.code = 'ANALYST_WINDOW_NOT_READY';
      throw error;
    }

    const [views, watchTime] = await Promise.all([
      this.getViewsAnalytics(videoId, period.startDate, period.endDate),
      this.getWatchTimeAnalytics(videoId, period.startDate, period.endDate)
    ]);
    const publicViews = Number(video.viewCount || 0);
    const interactions = Number(video.likeCount || 0) + Number(video.commentCount || 0);
    const metrics = {
      views: Number(views.totalViews || 0),
      impressions: Number(views.totalImpressions || 0),
      ctr: Number(views.averageCTR || 0),
      retention: Number(watchTime.averageViewPercentage || 0),
      averageViewDuration: Number(watchTime.averageViewDuration || 0),
      watchMinutes: Number(watchTime.totalWatchTime || 0),
      watchHours: Number((Number(watchTime.totalWatchTime || 0) / 60).toFixed(3)),
      engagementRate: publicViews > 0 ? Number(((interactions / publicViews) * 100).toFixed(3)) : 0
    };
    const snapshot = await this.db.savePerformanceSnapshot({
      videoId,
      productionId: null,
      measurementWindow,
      publishedAt: video.publishedAt,
      metrics,
      contentAttributes: {
        source: 'analyst_catalog',
        creatorContentType: video.creatorContentType || 'UNSPECIFIED',
        surface: this.surface(video),
        durationSeconds: video.durationSeconds ?? null,
        measurementPrecision: period.precision || 'calendar_day'
      },
      baseline: {},
      deltas: {},
      confidence: this.confidence(metrics),
      simulated: false,
      measuredAt: new Date().toISOString()
    });
    return {
      analyzedAt: snapshot?.measuredAt || new Date().toISOString(),
      measurementWindow,
      measurementPrecision: period.precision || 'calendar_day',
      period,
      metrics,
      learningSnapshot: snapshot
    };
  }

  async getViewsAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views,impressions,impressionClickThroughRate',
      dimensions: 'day',
      filters: `video==${videoId}`
    });
    const indexes = this.headerIndexes(response.data?.columnHeaders || [], {
      day: 0, views: 1, impressions: 2, impressionClickThroughRate: 3
    });
    const rows = response.data?.rows || [];
    const totalViews = rows.reduce((sum, row) => sum + Number(row[indexes.views] || 0), 0);
    const totalImpressions = rows.reduce((sum, row) => sum + Number(row[indexes.impressions] || 0), 0);
    const weightedCTR = totalImpressions > 0
      ? rows.reduce((sum, row) => sum + Number(row[indexes.impressions] || 0) * Number(row[indexes.impressionClickThroughRate] || 0), 0) / totalImpressions
      : 0;
    return {
      totalViews,
      totalImpressions,
      averageCTR: weightedCTR,
      dailyData: rows
    };
  }

  async getWatchTimeAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'estimatedMinutesWatched,averageViewDuration,averageViewPercentage',
      filters: `video==${videoId}`
    });
    const indexes = this.headerIndexes(response.data?.columnHeaders || [], {
      estimatedMinutesWatched: 0, averageViewDuration: 1, averageViewPercentage: 2
    });
    const row = response.data?.rows?.[0] || [];
    return {
      totalWatchTime: Number(row[indexes.estimatedMinutesWatched] || 0),
      averageViewDuration: Number(row[indexes.averageViewDuration] || 0),
      averageViewPercentage: Number(row[indexes.averageViewPercentage] || 0)
    };
  }

  async getAudienceRetention(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'audienceWatchRatio,relativeRetentionPerformance',
      dimensions: 'elapsedVideoTimeRatio',
      filters: `video==${videoId}`
    });
    const indexes = this.headerIndexes(response.data?.columnHeaders || [], {
      elapsedVideoTimeRatio: 0, audienceWatchRatio: 1, relativeRetentionPerformance: 2
    });
    return (response.data?.rows || []).map(row => ({
      elapsedRatio: Number(row[indexes.elapsedVideoTimeRatio]),
      audienceWatchRatio: Number(row[indexes.audienceWatchRatio]),
      relativeRetentionPerformance: Number(row[indexes.relativeRetentionPerformance])
    })).filter(point => (
      Number.isFinite(point.elapsedRatio) &&
      Number.isFinite(point.audienceWatchRatio) &&
      Number.isFinite(point.relativeRetentionPerformance)
    )).sort((a, b) => a.elapsedRatio - b.elapsedRatio);
  }

  async getTrafficSourcesAnalytics(videoId, startDate, endDate) {
    const response = await this.youtubeAnalytics.reports.query({
      ids: 'channel==MINE',
      startDate,
      endDate,
      metrics: 'views',
      dimensions: 'insightTrafficSourceType',
      filters: `video==${videoId}`
    });
    const indexes = this.headerIndexes(response.data?.columnHeaders || [], { insightTrafficSourceType: 0, views: 1 });
    const rows = response.data?.rows || [];
    const totalViews = rows.reduce((sum, row) => sum + Number(row[indexes.views] || 0), 0);
    const sources = rows.map(row => {
      const views = Number(row[indexes.views] || 0);
      return {
        source: String(row[indexes.insightTrafficSourceType] || 'unknown'),
        views,
        percentage: totalViews > 0 ? Number(((views / totalViews) * 100).toFixed(3)) : 0
      };
    }).sort((a, b) => b.views - a.views);
    return { sources, topSource: sources[0]?.source || 'unknown' };
  }

  headerIndexes(headers, fallback) {
    const result = {};
    headers.forEach((header, index) => { result[header.name] = index; });
    for (const [name, index] of Object.entries(fallback)) {
      if (result[name] === undefined) result[name] = index;
    }
    return result;
  }

  confidence(metrics) {
    if (metrics.impressions >= 1000 && metrics.views >= 100) return 'high';
    if (metrics.impressions >= 100 && metrics.views >= 20) return 'medium';
    return 'low';
  }

  surface(video) {
    const type = String(video.creatorContentType || '').toUpperCase();
    if (type === 'SHORTS') return 'shorts';
    if (type === 'LIVE_STREAM') return 'live';
    return 'long_form';
  }
}

module.exports = { AnalystAnalyticsCollector };
