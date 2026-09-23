'use strict';

const assert = require('assert');
const { RetentionIntelligence } = require('../utils/analyst/retention-intelligence');
const { GeminiAdvisor } = require('../utils/analyst/gemini-advisor');

(async () => {
  let calls = 0;
  let cached = null;
  const repository = {
    async getRetentionCurve(videoId, measurementWindow) {
      if (cached && cached.videoId === videoId && cached.measurementWindow === measurementWindow) return cached;
      return null;
    },
    async saveRetentionCurve(value) {
      cached = {
        ...value,
        measuredAt: '2026-09-23T12:00:00Z'
      };
      return cached;
    }
  };
  const analytics = {
    async getAudienceRetention() {
      calls++;
      // Ten evenly spaced points are enough to exercise the summarizer. A real
      // YouTube curve is typically denser (~100 elapsed-time points).
      return [
        [0.00, 1.00, 0.58],
        [0.05, 0.84, 0.42], // 30 sec on a 600 sec video: below similar-length median
        [0.10, 0.82, 0.44],
        [0.20, 0.70, 0.40],
        [0.30, 0.69, 0.46],
        [0.40, 1.08, 0.61], // rewatch signal
        [0.50, 0.91, 0.55],
        [0.60, 0.65, 0.39], // steep drop
        [0.80, 0.58, 0.47],
        [1.00, 0.52, 0.50]
      ].map(([elapsedRatio, audienceWatchRatio, relativeRetentionPerformance]) => ({
        elapsedRatio, audienceWatchRatio, relativeRetentionPerformance
      }));
    }
  };
  const windows = {
    period() { return { startDate: '2026-01-01', endDate: '2026-01-28', precision: 'calendar_day' }; }
  };
  const intelligence = new RetentionIntelligence(repository, analytics, windows, { logger: { warn() {} } });
  const video = { videoId: 'ret1', title: 'Retention Fixture', publishedAt: '2026-01-01T00:00:00Z', durationSeconds: 600 };

  const first = await intelligence.analyze(video, '28d');
  assert.strictEqual(first.cached, false);
  assert.strictEqual(calls, 1);
  assert.strictEqual(first.summary.opening.targetSeconds, 30);
  assert.strictEqual(first.summary.opening.elapsedSeconds, 30);
  assert.strictEqual(first.summary.opening.relativeToSimilarLengthMedian, 'below');
  assert.strictEqual(first.summary.opening.dropFromFirstPointPctPoints, 16);
  assert(first.summary.rewatchSignals.some(item => item.audienceWatchRatio > 1));
  assert(first.summary.steepDrops.some(item => item.elapsedSeconds === 360));
  assert.strictEqual(first.summary.evidencePolicy.includes('do not prove why'), true);

  const second = await intelligence.analyze(video, '28d');
  assert.strictEqual(second.cached, true);
  assert.strictEqual(calls, 1, 'cached fixed-window retention must not hit YouTube again');

  // The Gemini evidence package must include compact curve evidence without
  // claiming a cause for the drop.
  const advisor = new GeminiAdvisor({}, { client: { models: { generateContent() {} } } });
  const evidence = advisor.buildEvidence({
    video,
    measurementWindow: '28d',
    diagnosis: { diagnosis: 'promise_delivery_gap', confidence: 'medium' },
    retentionEvidence: first
  }, null);
  assert.strictEqual(evidence.retentionEvidence.opening.targetSeconds, 30);
  assert.strictEqual(evidence.retentionEvidence.opening.relativeToSimilarLengthMedian, 'below');
  assert(evidence.retentionEvidence.steepDrops.length > 0);

  console.log('Analyst M6 retention intelligence tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
