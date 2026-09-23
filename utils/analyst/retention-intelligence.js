'use strict';

class RetentionIntelligence {
  constructor(repository, analyticsCollector, windowPolicy, options = {}) {
    if (!repository) throw new Error('RetentionIntelligence requires an analyst repository');
    if (!analyticsCollector) throw new Error('RetentionIntelligence requires an analytics collector');
    if (!windowPolicy) throw new Error('RetentionIntelligence requires a measurement-window policy');
    this.repository = repository;
    this.analytics = analyticsCollector;
    this.windows = windowPolicy;
    this.logger = options.logger || console;
  }

  async analyze(video, measurementWindow = '28d', options = {}) {
    if (!video?.videoId) throw new Error('RetentionIntelligence requires a catalog video');
    const cached = await this.repository.getRetentionCurve(video.videoId, measurementWindow);
    if (cached && !options.refresh && measurementWindow !== 'lifetime') return { ...cached, cached: true };
    if (cached && !options.refresh && measurementWindow === 'lifetime' && !this.isStale(cached.measuredAt)) return { ...cached, cached: true };

    const period = this.windows.period(video.publishedAt, measurementWindow);
    if (!period) {
      const error = new Error(`Retention window ${measurementWindow} is not ready`);
      error.code = 'ANALYST_RETENTION_WINDOW_NOT_READY';
      throw error;
    }
    const points = await this.analytics.getAudienceRetention(video.videoId, period.startDate, period.endDate);
    if (!points.length) {
      const error = new Error('YouTube returned no audience-retention points for this video/window');
      error.code = 'ANALYST_RETENTION_UNAVAILABLE';
      throw error;
    }
    const enriched = points.map(point => ({
      ...point,
      elapsedSeconds: Number.isFinite(Number(video.durationSeconds))
        ? Number((point.elapsedRatio * Number(video.durationSeconds)).toFixed(3))
        : null
    }));
    const summary = this.summarize(enriched, Number(video.durationSeconds));
    const saved = await this.repository.saveRetentionCurve({
      videoId: video.videoId,
      measurementWindow,
      periodStart: period.startDate,
      periodEnd: period.endDate,
      points: enriched,
      summary: { ...summary, measurementPrecision: period.precision || 'calendar_day' }
    });
    return { ...saved, cached: false };
  }

  summarize(points, durationSeconds) {
    const ordered = [...points].sort((a, b) => a.elapsedRatio - b.elapsedRatio);
    const first = ordered[0];
    const targetSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.min(30, durationSeconds) : null;
    const targetRatio = targetSeconds !== null ? targetSeconds / durationSeconds : Math.min(0.1, ordered.at(-1)?.elapsedRatio || 0.1);
    const openingPoint = this.nearest(ordered, targetRatio);
    const openingDropPctPoints = first && openingPoint
      ? Number(((first.audienceWatchRatio - openingPoint.audienceWatchRatio) * 100).toFixed(2))
      : null;

    const transitions = [];
    for (let i = 1; i < ordered.length; i++) {
      const prior = ordered[i - 1];
      const current = ordered[i];
      transitions.push({
        elapsedRatio: current.elapsedRatio,
        elapsedSeconds: current.elapsedSeconds,
        deltaPctPoints: Number(((current.audienceWatchRatio - prior.audienceWatchRatio) * 100).toFixed(2)),
        audienceWatchRatio: current.audienceWatchRatio,
        relativeRetentionPerformance: current.relativeRetentionPerformance
      });
    }
    const steepDrops = transitions
      .filter(item => item.deltaPctPoints < 0)
      .sort((a, b) => a.deltaPctPoints - b.deltaPctPoints)
      .slice(0, 5)
      .map(item => ({ ...item, dropPctPoints: Number(Math.abs(item.deltaPctPoints).toFixed(2)) }));

    const rewatchSignals = transitions
      .filter(item => item.deltaPctPoints >= 2 || item.audienceWatchRatio > 1)
      .sort((a, b) => b.deltaPctPoints - a.deltaPctPoints)
      .slice(0, 5);

    const relativeValues = ordered.map(point => point.relativeRetentionPerformance).filter(Number.isFinite).sort((a, b) => a - b);
    const openingRelative = openingPoint?.relativeRetentionPerformance ?? null;
    return {
      pointCount: ordered.length,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      opening: {
        targetSeconds,
        elapsedRatio: openingPoint?.elapsedRatio ?? null,
        elapsedSeconds: openingPoint?.elapsedSeconds ?? null,
        audienceWatchRatio: openingPoint?.audienceWatchRatio ?? null,
        relativeRetentionPerformance: openingRelative,
        relativeToSimilarLengthMedian: openingRelative === null ? 'unknown' : openingRelative > 0.5 ? 'above' : openingRelative < 0.5 ? 'below' : 'at',
        dropFromFirstPointPctPoints: openingDropPctPoints
      },
      steepDrops,
      rewatchSignals,
      relativeRetention: {
        median: this.quantile(relativeValues, 0.5),
        p25: this.quantile(relativeValues, 0.25),
        p75: this.quantile(relativeValues, 0.75)
      },
      evidencePolicy: 'Curve evidence comes from YouTube audienceWatchRatio and relativeRetentionPerformance. Drop/rewatch locations are descriptive signals; they do not prove why viewers behaved that way.'
    };
  }

  nearest(points, ratio) {
    if (!points.length) return null;
    return points.reduce((best, point) => (
      Math.abs(point.elapsedRatio - ratio) < Math.abs(best.elapsedRatio - ratio) ? point : best
    ), points[0]);
  }

  quantile(sorted, q) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return Number(sorted[0].toFixed(3));
    const index = (sorted.length - 1) * q;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const value = lower === upper
      ? sorted[lower]
      : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
    return Number(value.toFixed(3));
  }

  isStale(value) {
    const measured = new Date(value || 0).getTime();
    if (!Number.isFinite(measured)) return true;
    const hours = Number(process.env.ANALYST_RETENTION_REFRESH_HOURS || 24);
    return Date.now() - measured >= Math.max(6, hours) * 3600000;
  }
}

module.exports = { RetentionIntelligence };
