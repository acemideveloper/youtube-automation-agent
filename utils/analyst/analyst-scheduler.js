'use strict';

const { UpstreamUpdateService } = require('./upstream-update-service');

class AnalystScheduler {
  constructor(analystService, db, options = {}) {
    if (!analystService) throw new Error('AnalystScheduler requires AnalystService');
    this.analyst = analystService;
    this.db = db;
    this.logger = options.logger || console;
    this.cron = options.cron || null;
    this.updateChecker = options.updateChecker || new UpstreamUpdateService(db, { logger: this.logger });
    this.tasks = new Map();
    this.locks = new Set();
    this.isEnabled = true;
    this.catalogCron = options.catalogCron || process.env.ANALYST_CATALOG_CRON || '15 5 * * *';
    this.measureCron = options.measureCron || process.env.ANALYST_MEASURE_CRON || '0 */4 * * *';
    this.outcomeCron = options.outcomeCron || process.env.ANALYST_OUTCOME_CRON || '30 6 * * *';
    this.updateCron = options.updateCron || process.env.ANALYST_UPDATE_CHECK_CRON || '0 7 * * 1';
  }

  async initialize() {
    if (!this.cron) this.cron = require('node-cron');
    this.register('catalog-sync', this.catalogCron, () => this.runCatalogSync());
    this.register('measurement-sweep', this.measureCron, () => this.runMeasurementSweep());
    this.register('outcome-evaluation', this.outcomeCron, () => this.runOutcomeEvaluation());
    this.register('upstream-update-check', this.updateCron, () => this.runUpdateCheck());
    for (const [name, task] of this.tasks) {
      task.start();
      this.info(`Started analyst scheduled task: ${name}`);
    }
    return true;
  }

  register(name, expression, handler) {
    const task = this.cron.schedule(expression, async () => {
      if (!this.isEnabled) return;
      await this.runLocked(name, handler);
    }, { scheduled: false });
    this.tasks.set(name, task);
  }

  async runCatalogSync() {
    return this.analyst.syncCatalog({
      maxVideos: Number(process.env.ANALYST_MAX_BACKFILL_VIDEOS || 500),
      resolveContentTypes: true
    });
  }

  async runMeasurementSweep() {
    return this.analyst.collectDueMeasurements({
      limit: Number(process.env.ANALYST_MEASUREMENT_BATCH || 10)
    });
  }

  async runOutcomeEvaluation() {
    return this.analyst.evaluateDueRecommendations(new Date(), Number(process.env.ANALYST_OUTCOME_EVAL_BATCH || 20));
  }

  async runUpdateCheck() {
    return this.updateChecker.check();
  }

  async runLocked(name, handler) {
    if (this.locks.has(name)) {
      this.warn(`Skipped overlapping analyst task: ${name}`);
      return { skipped: true, reason: 'already_running' };
    }
    this.locks.add(name);
    const started = new Date().toISOString();
    try {
      const result = await handler();
      await this.recordRun(name, 'success', { started, result });
      return result;
    } catch (error) {
      await this.recordRun(name, 'error', { started, error: error.message });
      this.warn(`Analyst task ${name} failed: ${error.message}`);
      return { failed: true, error: error.message };
    } finally {
      this.locks.delete(name);
    }
  }

  async recordRun(name, status, data) {
    if (this.db?.logAutomationEvent) {
      await this.db.logAutomationEvent(`analyst_${name.replaceAll('-', '_')}`, status, data).catch(() => {});
      return;
    }
    if (this.db?.setSetting) {
      await this.db.setSetting(`analyst_last_${name}`, JSON.stringify({ status, ...data, completedAt: new Date().toISOString() })).catch(() => {});
    }
  }

  pause() {
    this.isEnabled = false;
    return true;
  }

  async pauseAutomation() {
    return this.pause();
  }

  resume() {
    this.isEnabled = true;
    return true;
  }

  async resumeAutomation() {
    return this.resume();
  }

  stop() {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
  }

  info(message) { if (typeof this.logger?.info === 'function') this.logger.info(message); }
  warn(message) { if (typeof this.logger?.warn === 'function') this.logger.warn(message); }
}

module.exports = { AnalystScheduler };
