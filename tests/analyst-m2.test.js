'use strict';

const assert = require('assert');
const { GeminiAdvisor } = require('../utils/analyst/gemini-advisor');

const outputFixture = {
  summary: 'Packaging may be the main opportunity.',
  confidence: 'medium',
  evidenceUsed: ['CTR lower quartile', 'retention above median'],
  hypotheses: [{ area: 'packaging', observation: 'CTR trails cohort', rationale: 'Retention remains healthy', confidence: 'medium' }],
  title: {
    assessment: 'Title can be more specific.',
    alternatives: [
      { strategy: 'direct benefit', title: 'A Better Title', rationale: 'Clarifies payoff.' },
      { strategy: 'curiosity', title: 'What Changes the Result?', rationale: 'Creates a measured curiosity gap.' }
    ],
    avoid: ['Do not promise an outcome the video does not deliver.']
  },
  thumbnail: {
    assessment: 'Main subject should be clearer.',
    strengths: ['High contrast'],
    issues: ['Competing focal points'],
    concepts: [{ concept: 'Single focal subject', focalSubject: 'Main object', composition: 'Close crop', textOverlay: '2 words max', rationale: 'Reduces visual competition.' }]
  },
  hook: { assessment: 'No hook-specific evidence is available.', recommendations: ['Inspect first 30 seconds before changing pacing.'] },
  nextAction: { priority: 'high', action: 'Test one packaging variant', reason: 'Packaging diagnosis has cohort evidence', successMetric: 'CTR versus comparable traffic mix' },
  limitations: ['No causal claim can be made from correlation alone.']
};

(async () => {
  let calls = 0;
  const client = {
    models: {
      async generateContent(request) {
        calls++;
        assert.strictEqual(request.model, 'gemini-test');
        assert.strictEqual(request.config.responseMimeType, 'application/json');
        assert(request.contents.some(part => part.inlineData));
        return { text: JSON.stringify(outputFixture) };
      }
    }
  };
  const http = {
    async get() {
      return {
        data: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]),
        headers: { 'content-type': 'image/jpeg' }
      };
    }
  };
  const cache = new Map();
  const repository = {
    async getCachedAdvice(videoId, type, window, fp) { return cache.get(`${videoId}:${type}:${window}:${fp}`) || null; },
    async saveAdvice(record) {
      const saved = { ...record, id: 'advice-1', output: record.output };
      cache.set(`${record.videoId}:${record.analysisType}:${record.measurementWindow}:${record.evidenceFingerprint}`, saved);
      return saved;
    }
  };
  const advisor = new GeminiAdvisor({}, { client, http, repository, model: 'gemini-test', outputLanguage: 'tr' });
  assert.throws(() => advisor.validateThumbnailUrl('http://i.ytimg.com/vi/v1/default.jpg'), /HTTPS/);
  assert.throws(() => advisor.validateThumbnailUrl('https://127.0.0.1/internal.jpg'), /not allowed/);
  const input = {
    video: {
      videoId: 'v1', title: 'Original title', description: 'Description', tags: ['one'],
      publishedAt: '2026-01-01T00:00:00Z', durationSeconds: 600,
      creatorContentType: 'VIDEO_ON_DEMAND', viewCount: 5000, likeCount: 300, commentCount: 20,
      thumbnailUrl: 'https://i.ytimg.com/vi/v1/maxresdefault.jpg'
    },
    measurementWindow: '28d',
    diagnosis: {
      status: 'ok', diagnosis: 'packaging_opportunity', action: 'test_title_thumbnail', confidence: 'medium',
      observations: ['CTR is in the lower quartile while retention is above median.'],
      benchmark: {
        cohort: 'same_content_type_and_duration', cohortSize: 8,
        ctr: { median: 6.1, p25: 5.4, p75: 6.8 },
        retention: { median: 52, p25: 48, p75: 58 },
        target: { ctr: 3.2, retention: 55, impressions: 8000, ctrPercentile: 0.1, retentionPercentile: 0.65 }
      }
    },
    channelContext: { measurementCoverage: { catalogVideos: 100, measuredVideos: 70, snapshots: 180 }, evidencePolicy: 'channel-relative' }
  };

  const first = await advisor.advise(input);
  assert.strictEqual(first.cached, false);
  assert.strictEqual(first.output.confidence, 'medium');
  assert.strictEqual(calls, 1);
  const second = await advisor.advise(input);
  assert.strictEqual(second.cached, true);
  assert.strictEqual(calls, 1, 'cached evidence must not call Gemini again');

  // Changed thumbnail bytes must invalidate the cache fingerprint.
  http.get = async () => ({ data: Buffer.from([0xff, 0xd8, 0xff, 0xee, 0x01, 0x02]), headers: { 'content-type': 'image/jpeg' } });
  const third = await advisor.advise(input);
  assert.strictEqual(third.cached, false);
  assert.strictEqual(calls, 2);

  // Text-only fallback remains usable if the thumbnail cannot be downloaded.
  const textOnlyClient = { models: { generateContent: async request => {
    assert(!request.contents.some(part => part.inlineData));
    return { text: JSON.stringify({ ...outputFixture, limitations: ['Thumbnail image unavailable.'] }) };
  } } };
  const textOnly = new GeminiAdvisor({}, {
    client: textOnlyClient,
    http: { get: async () => { throw new Error('network'); } },
    model: 'gemini-test',
    logger: { warn() {} }
  });
  const fallback = await textOnly.advise(input);
  assert.strictEqual(fallback.output.confidence, 'medium');

  console.log('Analyst M2 Gemini advisor tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
