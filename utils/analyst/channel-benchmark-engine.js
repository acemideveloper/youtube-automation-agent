'use strict';

class ChannelBenchmarkEngine {
  constructor(options = {}) {
    this.minCohortSize = Math.max(4, Number(options.minCohortSize || process.env.ANALYST_MIN_COHORT_SIZE || 5));
    this.highConfidenceCohortSize = Math.max(this.minCohortSize, Number(options.highConfidenceCohortSize || 12));
    this.minImpressions = Math.max(50, Number(options.minImpressions || process.env.ANALYST_MIN_IMPRESSIONS || 500));
  }

  diagnose(targetSnapshot, allSnapshots = [], videoMetadata = {}) {
    if (!targetSnapshot) return { status: 'insufficient_evidence', reasons: ['missing_snapshot'] };
    const target = this.enrich(targetSnapshot, videoMetadata[targetSnapshot.videoId] || videoMetadata[targetSnapshot.video_id] || {});
    if (!target.measurementWindow) return { status: 'insufficient_evidence', reasons: ['missing_measurement_window'] };

    const candidates = allSnapshots
      .filter(item => (item.videoId || item.video_id) !== target.videoId)
      .map(item => this.enrich(item, videoMetadata[item.videoId || item.video_id] || {}))
      .filter(item => item.measurementWindow === target.measurementWindow);

    const cohortSelection = this.selectCohort(target, candidates);
    if (!cohortSelection || cohortSelection.items.length < this.minCohortSize) {
      return {
        status: 'insufficient_evidence',
        reasons: ['cohort_too_small'],
        evidence: { measurementWindow: target.measurementWindow, availableComparables: candidates.length, minimum: this.minCohortSize }
      };
    }

    const cohort = cohortSelection.items;
    const ctrValues = cohort.map(item => item.ctr).filter(Number.isFinite);
    const retentionValues = cohort.map(item => item.retention).filter(Number.isFinite);
    const impressions = Number(target.impressions || 0);
    if (ctrValues.length < this.minCohortSize || retentionValues.length < this.minCohortSize) {
      return {
        status: 'insufficient_evidence',
        reasons: ['metric_coverage_too_small'],
        evidence: { cohortSize: cohort.length, ctrSamples: ctrValues.length, retentionSamples: retentionValues.length }
      };
    }

    const ctrRank = this.percentileRank(target.ctr, ctrValues);
    const retentionRank = this.percentileRank(target.retention, retentionValues);
    const benchmark = {
      cohort: cohortSelection.label,
      cohortSize: cohort.length,
      ctr: this.summary(ctrValues),
      retention: this.summary(retentionValues),
      impressions: this.summary(cohort.map(item => item.impressions).filter(Number.isFinite)),
      target: {
        ctr: target.ctr,
        retention: target.retention,
        impressions,
        ctrPercentile: ctrRank,
        retentionPercentile: retentionRank
      }
    };

    if (!Number.isFinite(target.ctr) || !Number.isFinite(target.retention) || impressions < this.minImpressions) {
      return {
        status: 'insufficient_evidence',
        reasons: [impressions < this.minImpressions ? 'low_impressions' : 'missing_metrics'],
        confidence: 'low',
        benchmark
      };
    }

    let diagnosis = 'mixed_or_normal';
    let action = 'observe';
    const observations = [];
    if (ctrRank <= 0.25 && retentionRank >= 0.5) {
      diagnosis = 'packaging_opportunity';
      action = 'test_title_thumbnail';
      observations.push('CTR is in the lower quartile while retention is at or above the cohort median.');
    } else if (ctrRank >= 0.75 && retentionRank <= 0.25) {
      diagnosis = 'promise_delivery_gap';
      action = 'inspect_hook_and_opening';
      observations.push('Packaging earns clicks, but retention is in the lower quartile for comparable videos.');
    } else if (ctrRank >= 0.75 && retentionRank >= 0.75) {
      diagnosis = 'strong_pattern';
      action = 'preserve_and_reuse_pattern';
      observations.push('Both CTR and retention are in the top quartile of the comparable cohort.');
    } else if (ctrRank <= 0.25 && retentionRank <= 0.25) {
      diagnosis = 'topic_packaging_content_review';
      action = 'review_topic_packaging_and_content';
      observations.push('Both click-through and retention trail comparable videos.');
    } else {
      observations.push('Performance is mixed or near the middle of the comparable cohort.');
    }

    return {
      status: 'ok',
      diagnosis,
      action,
      observations,
      confidence: this.confidence(cohort.length, impressions),
      benchmark
    };
  }

  buildBenchmarks(snapshots = [], videoMetadata = {}) {
    const groups = new Map();
    for (const snapshot of snapshots) {
      const id = snapshot.videoId || snapshot.video_id;
      const enriched = this.enrich(snapshot, videoMetadata[id] || {});
      if (!enriched.measurementWindow) continue;
      const key = [enriched.measurementWindow, enriched.contentType, enriched.durationBucket].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(enriched);
    }
    return [...groups.entries()].map(([key, items]) => ({
      key,
      sampleSize: items.length,
      eligible: items.length >= this.minCohortSize,
      metrics: {
        ctr: this.summary(items.map(item => item.ctr).filter(Number.isFinite)),
        retention: this.summary(items.map(item => item.retention).filter(Number.isFinite)),
        impressions: this.summary(items.map(item => item.impressions).filter(Number.isFinite)),
        views: this.summary(items.map(item => item.views).filter(Number.isFinite))
      }
    })).sort((a, b) => b.sampleSize - a.sampleSize);
  }

  selectCohort(target, candidates) {
    const levels = [
      {
        label: 'same_content_type_and_duration',
        predicate: item => item.contentType === target.contentType && item.durationBucket === target.durationBucket
      },
      {
        label: 'same_content_type',
        predicate: item => item.contentType === target.contentType
      },
      { label: 'same_measurement_window', predicate: () => true }
    ];
    for (const level of levels) {
      const items = candidates.filter(level.predicate);
      if (items.length >= this.minCohortSize) return { ...level, items };
    }
    return null;
  }

  enrich(snapshot, video = {}) {
    const metrics = snapshot.metrics || snapshot.analytics_data || {};
    const attrs = snapshot.contentAttributes || snapshot.content_attributes || {};
    const rawContentType = String(video.creatorContentType || video.creator_content_type || attrs.creatorContentType || 'UNSPECIFIED').toUpperCase();
    const surfaceHint = String(video.surfaceHint || video.surface_hint || attrs.surface || 'unknown').toUpperCase();
    // Do not collapse unresolved fresh videos into one misleading cohort. A hint
    // remains explicitly labelled as a hint until Analytics resolves creatorContentType.
    const contentType = rawContentType === 'UNSPECIFIED' && surfaceHint !== 'UNKNOWN'
      ? `HINT_${surfaceHint}`
      : rawContentType;
    const durationSeconds = this.number(video.durationSeconds ?? video.duration_seconds ?? attrs.durationSeconds);
    return {
      videoId: snapshot.videoId || snapshot.video_id,
      measurementWindow: snapshot.measurementWindow || snapshot.measurement_window,
      contentType,
      durationBucket: this.durationBucket(durationSeconds, contentType),
      ctr: this.optionalNumber(metrics.ctr),
      retention: this.optionalNumber(metrics.retention),
      impressions: this.optionalNumber(metrics.impressions),
      views: this.optionalNumber(metrics.views),
      measuredAt: snapshot.measuredAt || snapshot.measured_at || null
    };
  }

  durationBucket(seconds, contentType) {
    if (String(contentType).toUpperCase() === 'SHORTS') return 'shorts';
    if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
    if (seconds < 180) return 'under_3m';
    if (seconds < 480) return '3_to_8m';
    if (seconds < 900) return '8_to_15m';
    if (seconds < 1800) return '15_to_30m';
    return '30m_plus';
  }

  confidence(cohortSize, impressions) {
    if (cohortSize >= this.highConfidenceCohortSize && impressions >= Math.max(1000, this.minImpressions * 2)) return 'high';
    if (cohortSize >= this.minCohortSize && impressions >= this.minImpressions) return 'medium';
    return 'low';
  }

  summary(values) {
    if (!values.length) return { count: 0, median: null, p25: null, p75: null, mad: null };
    const sorted = [...values].sort((a, b) => a - b);
    const median = this.quantile(sorted, 0.5);
    const deviations = sorted.map(value => Math.abs(value - median)).sort((a, b) => a - b);
    return {
      count: sorted.length,
      median: this.round(median),
      p25: this.round(this.quantile(sorted, 0.25)),
      p75: this.round(this.quantile(sorted, 0.75)),
      mad: this.round(this.quantile(deviations, 0.5))
    };
  }

  percentileRank(value, values) {
    if (!Number.isFinite(value) || !values.length) return null;
    const less = values.filter(item => item < value).length;
    const equal = values.filter(item => item === value).length;
    return (less + 0.5 * equal) / values.length;
  }

  quantile(sorted, q) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const index = (sorted.length - 1) * q;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }

  optionalNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  number(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  round(value) {
    return value === null || value === undefined ? null : Number(Number(value).toFixed(3));
  }
}

module.exports = { ChannelBenchmarkEngine };
