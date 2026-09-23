'use strict';

class RecommendationTracker {
  constructor(repository, analyticsAgent, options = {}) {
    if (!repository) throw new Error('RecommendationTracker requires an analyst repository');
    this.repository = repository;
    this.analytics = analyticsAgent || null;
    this.logger = options.logger || console;
    this.outcomeWindowDays = Math.max(3, Math.min(28, Number(options.outcomeWindowDays || process.env.ANALYST_OUTCOME_WINDOW_DAYS || 7)));
    this.maxTrafficShift = Math.max(0.05, Math.min(1, Number(options.maxTrafficShift || process.env.ANALYST_MAX_TRAFFIC_SHIFT || 0.25)));
    this.retentionGuardrailDrop = Math.max(0.01, Math.min(0.5, Number(options.retentionGuardrailDrop || process.env.ANALYST_RETENTION_GUARDRAIL_DROP || 0.1)));
  }

  async materializeFromAdvice(adviceRecord, diagnosisBundle = {}) {
    if (!adviceRecord?.videoId || !adviceRecord?.evidenceFingerprint || !adviceRecord?.output?.nextAction) return null;
    const next = adviceRecord.output.nextAction;
    const diagnosis = diagnosisBundle.diagnosis || diagnosisBundle || {};
    const target = diagnosis.benchmark?.target || {};
    const category = diagnosis.diagnosis || 'general';
    const targetMetric = this.inferTargetMetric(next.successMetric, category);
    return this.repository.upsertRecommendation({
      videoId: adviceRecord.videoId,
      adviceId: adviceRecord.id || null,
      evidenceFingerprint: adviceRecord.evidenceFingerprint,
      category,
      action: next.action,
      targetMetric,
      baseline: {
        measurementWindow: diagnosisBundle.selectedWindow || adviceRecord.measurementWindow || null,
        ctr: this.optionalNumber(target.ctr),
        retention: this.optionalNumber(target.retention),
        impressions: this.optionalNumber(target.impressions),
        capturedFrom: 'channel_relative_diagnosis'
      }
    });
  }

  async setStatus(id, status, options = {}) {
    const allowed = new Set(['pending', 'applied', 'rejected', 'deferred']);
    if (!allowed.has(status)) {
      const error = new Error('Recommendation status must be pending, applied, rejected, or deferred');
      error.status = 400;
      throw error;
    }
    const current = await this.repository.getRecommendation(id);
    if (!current) {
      const error = new Error('Recommendation not found');
      error.status = 404;
      throw error;
    }
    const now = new Date().toISOString();
    return this.repository.updateRecommendation(id, {
      status,
      note: options.note,
      appliedAt: status === 'applied' ? (options.appliedAt || now) : current.appliedAt,
      deferredUntil: status === 'deferred' ? (options.deferredUntil || null) : null,
      outcome: status === 'applied' ? {} : current.outcome,
      evaluatedAt: status === 'applied' ? null : current.evaluatedAt
    });
  }

  async evaluate(id, now = new Date()) {
    if (!this.analytics) throw new Error('Analytics agent is required for recommendation outcome evaluation');
    const recommendation = await this.repository.getRecommendation(id);
    if (!recommendation) {
      const error = new Error('Recommendation not found');
      error.status = 404;
      throw error;
    }
    if (recommendation.status !== 'applied' || !recommendation.appliedAt) {
      const error = new Error('Only applied recommendations can be evaluated');
      error.status = 409;
      throw error;
    }

    const applied = new Date(recommendation.appliedAt);
    if (Number.isNaN(applied.getTime())) throw new Error('Recommendation applied_at is invalid');
    const dayMs = 86400000;
    const latestComplete = new Date(now.getTime() - dayMs);
    // Exclude the calendar day on which the change was applied because its
    // metrics may contain both pre-change and post-change traffic.
    const postStart = new Date(this.startOfUtcDay(applied).getTime() + dayMs);
    const postEnd = new Date(postStart.getTime() + (this.outcomeWindowDays - 1) * dayMs);
    if (postEnd > latestComplete) {
      return {
        status: 'waiting_for_evidence',
        eligibleAfter: new Date(postEnd.getTime() + dayMs).toISOString(),
        daysRequired: this.outcomeWindowDays
      };
    }
    const preEnd = new Date(postStart.getTime() - 2 * dayMs);
    const preStart = new Date(preEnd.getTime() - (this.outcomeWindowDays - 1) * dayMs);

    const periods = {
      before: { startDate: this.date(preStart), endDate: this.date(preEnd) },
      after: { startDate: this.date(postStart), endDate: this.date(postEnd) }
    };

    const [before, after] = await Promise.all([
      this.fetchPeriod(recommendation.videoId, periods.before),
      this.fetchPeriod(recommendation.videoId, periods.after)
    ]);
    const trafficShift = this.trafficDistance(before.trafficSources, after.trafficSources);
    const outcome = this.classifyOutcome(recommendation, before, after, trafficShift, periods);
    await this.repository.updateRecommendation(id, {
      outcome,
      evaluatedAt: new Date().toISOString()
    });
    await this.repository.addRecommendationEvent(id, 'evaluated', outcome);
    return outcome;
  }

  async evaluateDue(now = new Date(), limit = 20) {
    const applied = await this.repository.listRecommendations({ status: 'applied', limit });
    const results = [];
    for (const recommendation of applied) {
      if (recommendation.evaluatedAt && recommendation.outcome?.status && recommendation.outcome.status !== 'waiting_for_evidence') continue;
      try {
        results.push({ id: recommendation.id, result: await this.evaluate(recommendation.id, now) });
      } catch (error) {
        results.push({ id: recommendation.id, error: error.message });
      }
    }
    return results;
  }

  async fetchPeriod(videoId, period) {
    const [views, watchTime, trafficSources] = await Promise.all([
      this.analytics.getViewsAnalytics(videoId, period.startDate, period.endDate),
      this.analytics.getWatchTimeAnalytics(videoId, period.startDate, period.endDate),
      this.analytics.getTrafficSourcesAnalytics(videoId, period.startDate, period.endDate).catch(() => ({ sources: [], topSource: 'unknown' }))
    ]);
    return { views, watchTime, trafficSources };
  }

  classifyOutcome(recommendation, before, after, trafficShift, periods) {
    const beforeCTR = this.optionalNumber(before.views?.averageCTR);
    const afterCTR = this.optionalNumber(after.views?.averageCTR);
    const beforeRetention = this.optionalNumber(before.watchTime?.averageViewPercentage);
    const afterRetention = this.optionalNumber(after.watchTime?.averageViewPercentage);
    const beforeImpressions = this.optionalNumber(before.views?.totalImpressions);
    const afterImpressions = this.optionalNumber(after.views?.totalImpressions);
    const metric = recommendation.targetMetric || (recommendation.category === 'packaging_opportunity' ? 'ctr' : 'retention');
    const beforePrimary = metric === 'retention' ? beforeRetention : beforeCTR;
    const afterPrimary = metric === 'retention' ? afterRetention : afterCTR;
    const primaryDeltaPct = this.relativeDelta(beforePrimary, afterPrimary);
    const retentionDeltaPct = this.relativeDelta(beforeRetention, afterRetention);

    let status = 'inconclusive';
    const reasons = [];
    if (beforePrimary === null || afterPrimary === null) {
      reasons.push('primary_metric_missing');
    } else if ((beforeImpressions || 0) < 100 || (afterImpressions || 0) < 100) {
      reasons.push('insufficient_impressions');
    } else if (trafficShift > this.maxTrafficShift) {
      reasons.push('traffic_mix_shift');
    } else if (metric === 'ctr' && retentionDeltaPct !== null && retentionDeltaPct < -this.retentionGuardrailDrop * 100) {
      reasons.push('retention_guardrail_regression');
    } else if (primaryDeltaPct !== null && primaryDeltaPct >= 10) {
      status = 'improved_directionally';
      reasons.push('primary_metric_improved');
    } else if (primaryDeltaPct !== null && primaryDeltaPct <= -10) {
      status = 'worsened_directionally';
      reasons.push('primary_metric_declined');
    } else {
      reasons.push('change_too_small');
    }

    return {
      status,
      causalClaim: false,
      metric,
      periods,
      before: { ctr: beforeCTR, retention: beforeRetention, impressions: beforeImpressions, topTrafficSource: before.trafficSources?.topSource || 'unknown' },
      after: { ctr: afterCTR, retention: afterRetention, impressions: afterImpressions, topTrafficSource: after.trafficSources?.topSource || 'unknown' },
      primaryDeltaPct,
      retentionDeltaPct,
      trafficShift: Number(trafficShift.toFixed(3)),
      reasons,
      evidencePolicy: 'Directional before/after evidence only. Traffic-mix shifts and retention regressions can make a result inconclusive; no causal claim is made.'
    };
  }

  trafficDistance(before = {}, after = {}) {
    const map = source => Object.fromEntries((source?.sources || []).map(item => [item.source, Number(item.percentage || 0) / 100]));
    const a = map(before);
    const b = map(after);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (!keys.size) return 0;
    let l1 = 0;
    for (const key of keys) l1 += Math.abs((a[key] || 0) - (b[key] || 0));
    return l1 / 2;
  }

  inferTargetMetric(text, category) {
    const value = String(text || '').toLowerCase();
    if (value.includes('retention') || value.includes('view percentage') || value.includes('izlenme')) return 'retention';
    if (value.includes('ctr') || value.includes('click')) return 'ctr';
    return category === 'promise_delivery_gap' ? 'retention' : 'ctr';
  }

  relativeDelta(before, after) {
    if (before === null || after === null || before === 0) return null;
    return Number((((after - before) / Math.abs(before)) * 100).toFixed(2));
  }

  optionalNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  startOfUtcDay(value) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  date(value) {
    return value.toISOString().slice(0, 10);
  }
}

module.exports = { RecommendationTracker };
