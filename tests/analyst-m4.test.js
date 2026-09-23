'use strict';

const assert = require('assert');
const { AnalystScheduler } = require('../utils/analyst/analyst-scheduler');
const { UpstreamUpdateService } = require('../utils/analyst/upstream-update-service');

(async () => {
  const scheduled = [];
  const cron = {
    schedule(expression, handler, options) {
      const task = {
        expression, handler, options, started: false,
        start() { this.started = true; },
        stop() { this.started = false; }
      };
      scheduled.push(task);
      return task;
    }
  };
  const calls = [];
  const analyst = {
    async syncCatalog() { calls.push('catalog'); return { synced: true }; },
    async collectDueMeasurements() { calls.push('measure'); return { completed: 1 }; },
    async evaluateDueRecommendations() { calls.push('outcome'); return []; }
  };
  const db = { async setSetting() {} };
  const updateChecker = { async check() { calls.push('update'); return { updateAvailable: true }; } };
  const scheduler = new AnalystScheduler(analyst, db, { cron, updateChecker, logger: { info() {}, warn() {} } });
  await scheduler.initialize();
  assert.strictEqual(scheduled.length, 4);
  assert(scheduled.every(task => task.started));
  await scheduler.runLocked('catalog-sync', () => scheduler.runCatalogSync());
  await scheduler.runLocked('measurement-sweep', () => scheduler.runMeasurementSweep());
  await scheduler.runLocked('outcome-evaluation', () => scheduler.runOutcomeEvaluation());
  await scheduler.runLocked('upstream-update-check', () => scheduler.runUpdateCheck());
  assert.deepStrictEqual(calls, ['catalog', 'measure', 'outcome', 'update']);

  // Overlapping tasks are skipped instead of duplicating API traffic.
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const first = scheduler.runLocked('measurement-sweep', async () => { await blocker; return 'done'; });
  const second = await scheduler.runLocked('measurement-sweep', async () => 'must-not-run');
  assert.strictEqual(second.skipped, true);
  release();
  await first;

  // Upstream checker only reports updates; it never applies code.
  const settings = {};
  const checker = new UpstreamUpdateService({
    async setSetting(key, value) { settings[key] = value; },
    async getSetting(key) { return settings[key]; }
  }, {
    baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    fetch: async () => ({
      ok: true,
      async json() {
        return {
          sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          html_url: 'https://github.com/darkzOGx/youtube-automation-agent/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          commit: { message: 'fix: upstream', committer: { date: '2026-09-23T10:00:00Z' } }
        };
      }
    })
  });
  const update = await checker.check();
  assert.strictEqual(update.updateAvailable, true);
  assert.strictEqual(update.autoApply, false);
  assert(update.policy.includes('never'));
  const last = await checker.getLastCheck();
  assert.strictEqual(last.latestSha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

  console.log('Analyst M4 continuous-update tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
