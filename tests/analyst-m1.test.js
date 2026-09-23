'use strict';

const assert = require('assert');
const { ChannelBenchmarkEngine } = require('../utils/analyst/channel-benchmark-engine');
const { MeasurementWindowPolicy } = require('../utils/analyst/measurement-window-policy');
const { YouTubeChannelSyncService } = require('../utils/analyst/youtube-channel-sync-service');

function snapshot(videoId, ctr, retention, impressions = 5000, window = '28d') {
  return {
    videoId,
    measurementWindow: window,
    metrics: { ctr, retention, impressions, views: Math.round(impressions * ctr / 100) }
  };
}

// Robust cohort diagnosis should rely on channel-relative evidence, not global CTR thresholds.
{
  const engine = new ChannelBenchmarkEngine({ minCohortSize: 5, minImpressions: 500 });
  const metadata = {};
  const comparables = [
    snapshot('a', 6.0, 50), snapshot('b', 6.2, 52), snapshot('c', 6.4, 54),
    snapshot('d', 6.6, 56), snapshot('e', 6.8, 58), snapshot('f', 7.0, 60)
  ];
  for (const item of comparables) metadata[item.videoId] = { creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 600 };
  const target = snapshot('target', 3.0, 57, 7000);
  metadata.target = { creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 620 };
  const result = engine.diagnose(target, [target, ...comparables], metadata);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.diagnosis, 'packaging_opportunity');
  assert(['medium', 'high'].includes(result.confidence));
  assert.strictEqual(result.benchmark.cohort, 'same_content_type_and_duration');
}

// High CTR but weak retention should point toward hook/promise delivery, not thumbnail changes.
{
  const engine = new ChannelBenchmarkEngine({ minCohortSize: 5, minImpressions: 500 });
  const metadata = {};
  const comparables = [
    snapshot('a2', 3.0, 45), snapshot('b2', 4.0, 47), snapshot('c2', 5.0, 49),
    snapshot('d2', 6.0, 51), snapshot('e2', 7.0, 53), snapshot('f2', 8.0, 55)
  ];
  for (const item of comparables) metadata[item.videoId] = { creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 900 };
  const target = snapshot('target2', 9.5, 25, 9000);
  metadata.target2 = { creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 910 };
  const result = engine.diagnose(target, [target, ...comparables], metadata);
  assert.strictEqual(result.diagnosis, 'promise_delivery_gap');
  assert.strictEqual(result.action, 'inspect_hook_and_opening');
}

// Low exposure must not create strong optimization advice.
{
  const engine = new ChannelBenchmarkEngine({ minCohortSize: 5, minImpressions: 500 });
  const metadata = {};
  const comparables = [1,2,3,4,5,6].map((n) => snapshot(`l${n}`, 5 + n / 10, 45 + n));
  for (const item of comparables) metadata[item.videoId] = { creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 500 };
  const target = snapshot('low', 1.0, 60, 80);
  metadata.low = { creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 510 };
  const result = engine.diagnose(target, [target, ...comparables], metadata);
  assert.strictEqual(result.status, 'insufficient_evidence');
  assert(result.reasons.includes('low_impressions'));
}

// Measurement policy: fixed windows are one-shot; lifetime refreshes when stale.
{
  const policy = new MeasurementWindowPolicy({ lifetimeRefreshHours: 24 });
  const now = new Date('2026-09-23T12:00:00Z');
  const video = { videoId: 'x', publishedAt: '2026-08-01T18:00:00Z' };
  const due = policy.dueWindows(video, [], now);
  assert.deepStrictEqual(due, ['24h', '72h', '7d', '28d', 'lifetime']);
  const existing = due.map(name => ({ measurementWindow: name, measuredAt: '2026-09-23T06:00:00Z' }));
  assert.deepStrictEqual(policy.dueWindows(video, existing, now), []);
  existing.find(x => x.measurementWindow === 'lifetime').measuredAt = '2026-09-21T00:00:00Z';
  assert.deepStrictEqual(policy.dueWindows(video, existing, now), ['lifetime']);
  const p24 = policy.period(video.publishedAt, '24h', now);
  assert.strictEqual(p24.precision, 'calendar_day_proxy');
  const p28 = policy.period(video.publishedAt, '28d', now);
  assert.strictEqual(p28.startDate, '2026-08-01');
  assert.strictEqual(p28.endDate, '2026-08-28');
}

// Channel sync discovers videos that AgentTube did not publish and resolves content type via Analytics.
(async () => {
  const saved = { channels: [], videos: [], runs: [] };
  const repository = {
    async initialize() {},
    async startSyncRun() { return 'run-1'; },
    async finishSyncRun(_id, value) { saved.runs.push(value); return value; },
    async upsertChannel(value) { saved.channels.push(value); return value; },
    async upsertVideo(value) { saved.videos.push(value); return value; }
  };
  const youtube = {
    channels: { list: async () => ({ data: { items: [{
      id: 'UC1',
      snippet: { title: 'Channel', description: 'Desc', publishedAt: '2020-01-01T00:00:00Z' },
      statistics: { subscriberCount: '1000', videoCount: '2', viewCount: '50000' },
      contentDetails: { relatedPlaylists: { uploads: 'UU1' } }
    }] } }) },
    playlistItems: { list: async () => ({ data: { items: [
      { contentDetails: { videoId: 'v1' } },
      { contentDetails: { videoId: 'v2' } }
    ] } }) },
    videos: { list: async () => ({ data: { items: [
      {
        id: 'v1', snippet: { channelId: 'UC1', title: 'Long', description: '', publishedAt: '2026-01-01T10:00:00Z', categoryId: '27', thumbnails: { high: { url: 'https://img/1.jpg' } } },
        statistics: { viewCount: '10000', likeCount: '500', commentCount: '50' }, contentDetails: { duration: 'PT10M' }
      },
      {
        id: 'v2', snippet: { channelId: 'UC1', title: 'Short', description: '', publishedAt: '2026-02-01T10:00:00Z', categoryId: '27', thumbnails: { high: { url: 'https://img/2.jpg' } } },
        statistics: { viewCount: '20000', likeCount: '900', commentCount: '70' }, contentDetails: { duration: 'PT45S' }
      }
    ] } }) }
  };
  const youtubeAnalytics = {
    reports: { query: async () => ({ data: {
      columnHeaders: [{ name: 'video' }, { name: 'creatorContentType' }, { name: 'views' }],
      rows: [['v1', 'VIDEO_ON_DEMAND', 10000], ['v2', 'SHORTS', 20000]]
    } }) }
  };
  const service = new YouTubeChannelSyncService({}, {}, { repository, youtube, youtubeAnalytics, maxBackfillVideos: 50 });
  const result = await service.syncChannel();
  assert.strictEqual(result.updatedCount, 2);
  assert.strictEqual(saved.videos[0].creatorContentType, 'VIDEO_ON_DEMAND');
  assert.strictEqual(saved.videos[1].creatorContentType, 'SHORTS');
  assert.strictEqual(saved.videos[0].durationSeconds, 600);
  assert.strictEqual(saved.videos[1].surfaceHint, 'shorts');
  assert.strictEqual(saved.runs[0].status, 'completed');
  console.log('Analyst M1 tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

// AnalystService should process fixed missing milestones before lifetime refreshes,
// and a single video failure must not abort the batch.
(async () => {
  const { AnalystService } = require('../utils/analyst/analyst-service');
  const videos = [
    { videoId: 'old1', title: 'Old 1', publishedAt: '2026-01-01T00:00:00Z', creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 600 },
    { videoId: 'old2', title: 'Old 2', publishedAt: '2026-01-02T00:00:00Z', creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 610 }
  ];
  const existing = {
    old1: [{ videoId: 'old1', measurementWindow: '24h', measuredAt: '2026-01-03T00:00:00Z', simulated: false }],
    old2: [
      { videoId: 'old2', measurementWindow: '24h', measuredAt: '2026-01-04T00:00:00Z', simulated: false },
      { videoId: 'old2', measurementWindow: '72h', measuredAt: '2026-01-06T00:00:00Z', simulated: false },
      { videoId: 'old2', measurementWindow: '7d', measuredAt: '2026-01-10T00:00:00Z', simulated: false },
      { videoId: 'old2', measurementWindow: '28d', measuredAt: '2026-02-02T00:00:00Z', simulated: false },
      { videoId: 'old2', measurementWindow: 'lifetime', measuredAt: '2026-09-20T00:00:00Z', simulated: false }
    ]
  };
  const db = {
    async listPerformanceSnapshots(options = {}) {
      if (options.videoId) return existing[options.videoId] || [];
      return Object.values(existing).flat();
    }
  };
  const repository = {
    async initialize() {},
    async listVideos() { return videos; },
    async getSummary() { return {}; },
    async getVideo(id) { return videos.find(v => v.videoId === id) || null; }
  };
  const called = [];
  const analytics = {
    async initialize() {},
    async measureVideo(videoId, measurementWindow) {
      called.push(`${videoId}:${measurementWindow}`);
      if (videoId === 'old1' && measurementWindow === '72h') throw new Error('fixture failure');
      return { analyzedAt: new Date().toISOString(), learningSnapshot: { confidence: 'medium' } };
    }
  };
  const windows = {
    definitions() { return {}; },
    dueWindows(video) {
      return video.videoId === 'old1' ? ['72h', '7d', '28d', 'lifetime'] : ['lifetime'];
    }
  };
  const service = new AnalystService(db, {}, {
    repository, windows, analyticsCollector: analytics, requestDelayMs: 0, measurementBatchSize: 3,
    sync: { async syncChannel() {} }
  });
  const result = await service.collectDueMeasurements({ limit: 3 });
  assert.deepStrictEqual(called, ['old1:72h', 'old1:7d', 'old1:28d']);
  assert.strictEqual(result.attempted, 3);
  assert.strictEqual(result.completed, 2);
  assert.strictEqual(result.failed, 1);
  console.log('Analyst M1 queue tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

// Fresh-video early signals must outrank historical backfill so new uploads are not starved.
(async () => {
  const { AnalystService } = require('../utils/analyst/analyst-service');
  const now = Date.now();
  const videos = [
    { videoId: 'historic', publishedAt: '2025-01-01T00:00:00Z' },
    { videoId: 'fresh', publishedAt: new Date(now - 2 * 86400000).toISOString() }
  ];
  const db = { async listPerformanceSnapshots() { return []; } };
  const repository = {
    async initialize() {},
    async listVideos() { return videos; },
    async getSummary() { return {}; }
  };
  const called = [];
  const analytics = {
    async initialize() {},
    async measureVideo(videoId, measurementWindow) {
      called.push(`${videoId}:${measurementWindow}`);
      return { analyzedAt: new Date().toISOString(), learningSnapshot: { confidence: 'low' } };
    }
  };
  const windows = {
    definitions() { return {}; },
    dueWindows(video) { return video.videoId === 'fresh' ? ['24h'] : ['7d']; }
  };
  const service = new AnalystService(db, {}, {
    repository, windows, analyticsCollector: analytics, requestDelayMs: 0, measurementBatchSize: 1,
    sync: { async syncChannel() {} }
  });
  await service.collectDueMeasurements({ limit: 1 });
  assert.deepStrictEqual(called, ['fresh:24h']);
  console.log('Analyst M1 fresh-video priority test passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

// The self-contained analyst collector must compute period CTR weighted by impressions
// and persist only real snapshots (no random/simulated fallback path).
(async () => {
  const { AnalystAnalyticsCollector } = require('../utils/analyst/analyst-analytics-collector');
  let savedSnapshot = null;
  const db = {
    async savePerformanceSnapshot(value) {
      savedSnapshot = { ...value, measuredAt: value.measuredAt };
      return savedSnapshot;
    }
  };
  const repository = {
    async getVideo() {
      return {
        videoId: 'weighted', title: 'Weighted CTR', publishedAt: '2026-08-01T00:00:00Z',
        creatorContentType: 'VIDEO_ON_DEMAND', durationSeconds: 600,
        viewCount: 1000, likeCount: 50, commentCount: 10
      };
    }
  };
  const windows = {
    period() { return { startDate: '2026-08-01', endDate: '2026-08-28', precision: 'calendar_day' }; }
  };
  const youtubeAnalytics = {
    reports: {
      async query(request) {
        if (request.dimensions === 'day') {
          return { data: {
            columnHeaders: [
              { name: 'day' }, { name: 'views' }, { name: 'impressions' }, { name: 'impressionClickThroughRate' }
            ],
            rows: [
              ['2026-08-01', 10, 100, 10],
              ['2026-08-02', 90, 900, 2]
            ]
          } };
        }
        return { data: {
          columnHeaders: [
            { name: 'estimatedMinutesWatched' }, { name: 'averageViewDuration' }, { name: 'averageViewPercentage' }
          ],
          rows: [[500, 120, 40]]
        } };
      }
    }
  };
  const collector = new AnalystAnalyticsCollector(db, {}, { repository, windows, youtubeAnalytics });
  const views = await collector.getViewsAnalytics('weighted', '2026-08-01', '2026-08-28');
  assert.strictEqual(views.totalImpressions, 1000);
  assert.strictEqual(Number(views.averageCTR.toFixed(2)), 2.8); // (100*10 + 900*2) / 1000
  const measured = await collector.measureVideo('weighted', '28d');
  assert.strictEqual(measured.metrics.ctr, 2.8);
  assert.strictEqual(savedSnapshot.simulated, false);
  assert.strictEqual(savedSnapshot.contentAttributes.measurementPrecision, 'calendar_day');
  console.log('Analyst M1 collector tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
