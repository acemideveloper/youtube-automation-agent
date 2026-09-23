'use strict';

const assert = require('assert');
const { RecommendationTracker } = require('../utils/analyst/recommendation-tracker');

class FakeRepository {
  constructor() { this.items = new Map(); this.events = []; }
  async upsertRecommendation(input) {
    const id = input.id || 'rec-1';
    const current = this.items.get(id) || {};
    const value = { ...current, ...input, id, status: input.status || current.status || 'pending', baseline: input.baseline || current.baseline || {}, outcome: input.outcome || current.outcome || {}, evaluatedAt: input.evaluatedAt || current.evaluatedAt || null };
    this.items.set(id, value);
    return value;
  }
  async getRecommendation(id) { return this.items.get(id) || null; }
  async updateRecommendation(id, changes) {
    const current = this.items.get(id);
    if (!current) return null;
    const updated = { ...current, ...changes };
    this.items.set(id, updated);
    return updated;
  }
  async listRecommendations({ status } = {}) {
    return [...this.items.values()].filter(item => !status || item.status === status);
  }
  async addRecommendationEvent(id, type, payload) { this.events.push({ id, type, payload }); }
}

function makeAnalytics({ beforeCTR = 4, afterCTR = 5, beforeRetention = 50, afterRetention = 51, shift = false } = {}) {
  return {
    async getViewsAnalytics(_videoId, startDate) {
      const before = startDate < '2026-09-11';
      return { totalImpressions: 5000, averageCTR: before ? beforeCTR : afterCTR };
    },
    async getWatchTimeAnalytics(_videoId, startDate) {
      const before = startDate < '2026-09-11';
      return { averageViewPercentage: before ? beforeRetention : afterRetention };
    },
    async getTrafficSourcesAnalytics(_videoId, startDate) {
      const before = startDate < '2026-09-11';
      if (!shift) return { topSource: 'BROWSE', sources: [{ source: 'BROWSE', percentage: '70' }, { source: 'SEARCH', percentage: '30' }] };
      return before
        ? { topSource: 'BROWSE', sources: [{ source: 'BROWSE', percentage: '90' }, { source: 'SEARCH', percentage: '10' }] }
        : { topSource: 'SEARCH', sources: [{ source: 'BROWSE', percentage: '20' }, { source: 'SEARCH', percentage: '80' }] };
    }
  };
}

(async () => {
  const repo = new FakeRepository();
  const tracker = new RecommendationTracker(repo, makeAnalytics(), { outcomeWindowDays: 7 });
  const advice = {
    id: 'adv-1', videoId: 'video-1', evidenceFingerprint: 'fp-1', measurementWindow: '28d',
    output: { nextAction: { action: 'Test a new title and thumbnail', successMetric: 'CTR versus comparable traffic mix' } }
  };
  const diagnosis = {
    selectedWindow: '28d',
    diagnosis: {
      diagnosis: 'packaging_opportunity',
      benchmark: { target: { ctr: 4, retention: 50, impressions: 5000 } }
    }
  };
  const recommendation = await tracker.materializeFromAdvice(advice, diagnosis);
  assert.strictEqual(recommendation.targetMetric, 'ctr');
  assert.strictEqual(recommendation.status, 'pending');

  const applied = await tracker.setStatus(recommendation.id, 'applied', { appliedAt: '2026-09-10T14:00:00Z', note: 'Changed title manually in YouTube Studio' });
  assert.strictEqual(applied.status, 'applied');

  const waiting = await tracker.evaluate(recommendation.id, new Date('2026-09-15T12:00:00Z'));
  assert.strictEqual(waiting.status, 'waiting_for_evidence');

  const result = await tracker.evaluate(recommendation.id, new Date('2026-09-20T12:00:00Z'));
  assert.strictEqual(result.status, 'improved_directionally');
  assert.strictEqual(result.causalClaim, false);
  assert(result.primaryDeltaPct >= 20);
  assert.strictEqual(result.periods.before.endDate, '2026-09-09');
  assert.strictEqual(result.periods.after.startDate, '2026-09-11');

  // A major traffic-source shift must make an otherwise improved CTR result inconclusive.
  const repo2 = new FakeRepository();
  const tracker2 = new RecommendationTracker(repo2, makeAnalytics({ shift: true }), { outcomeWindowDays: 7, maxTrafficShift: 0.25 });
  await repo2.upsertRecommendation({ id: 'rec-2', videoId: 'video-2', evidenceFingerprint: 'fp-2', category: 'packaging_opportunity', action: 'test', targetMetric: 'ctr', status: 'applied', appliedAt: '2026-09-10T10:00:00Z' });
  const shifted = await tracker2.evaluate('rec-2', new Date('2026-09-20T12:00:00Z'));
  assert.strictEqual(shifted.status, 'inconclusive');
  assert(shifted.reasons.includes('traffic_mix_shift'));

  // Retention guardrail prevents declaring a packaging win when the click lift accompanies a material retention drop.
  const repo3 = new FakeRepository();
  const tracker3 = new RecommendationTracker(repo3, makeAnalytics({ beforeCTR: 4, afterCTR: 5, beforeRetention: 50, afterRetention: 40 }), { outcomeWindowDays: 7, retentionGuardrailDrop: 0.1 });
  await repo3.upsertRecommendation({ id: 'rec-3', videoId: 'video-3', evidenceFingerprint: 'fp-3', category: 'packaging_opportunity', action: 'test', targetMetric: 'ctr', status: 'applied', appliedAt: '2026-09-10T10:00:00Z' });
  const guarded = await tracker3.evaluate('rec-3', new Date('2026-09-20T12:00:00Z'));
  assert.strictEqual(guarded.status, 'inconclusive');
  assert(guarded.reasons.includes('retention_guardrail_regression'));

  console.log('Analyst M3 recommendation lifecycle tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
