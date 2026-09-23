'use strict';

const WINDOW_DEFINITIONS = Object.freeze({
  '24h': { thresholdHours: 24, fixedDays: 2, precision: 'calendar_day_proxy', label: '~24h early signal' },
  '72h': { thresholdHours: 72, fixedDays: 4, precision: 'calendar_day_proxy', label: '~72h early signal' },
  '7d': { thresholdHours: 168, fixedDays: 7, precision: 'calendar_day', label: 'First 7 calendar days' },
  '28d': { thresholdHours: 672, fixedDays: 28, precision: 'calendar_day', label: 'First 28 calendar days' },
  lifetime: { thresholdHours: 24, fixedDays: null, precision: 'calendar_day', label: 'Lifetime to latest complete day' }
});

class MeasurementWindowPolicy {
  constructor(options = {}) {
    this.lifetimeRefreshHours = Math.max(6, Number(options.lifetimeRefreshHours || process.env.ANALYST_LIFETIME_REFRESH_HOURS || 24));
  }

  definitions() {
    return WINDOW_DEFINITIONS;
  }

  dueWindows(video, existingSnapshots = [], now = new Date()) {
    const published = new Date(video.published_at || video.publishedAt);
    if (Number.isNaN(published.getTime())) return [];
    const ageHours = (now.getTime() - published.getTime()) / 3600000;
    const byWindow = new Map(existingSnapshots.map(item => [item.measurementWindow || item.measurement_window, item]));
    const due = [];

    for (const [name, definition] of Object.entries(WINDOW_DEFINITIONS)) {
      if (ageHours < definition.thresholdHours) continue;
      const existing = byWindow.get(name);
      if (name !== 'lifetime') {
        if (!existing) due.push(name);
        continue;
      }
      if (!existing) {
        due.push(name);
        continue;
      }
      const measuredAt = new Date(existing.measuredAt || existing.measured_at || 0);
      if (Number.isNaN(measuredAt.getTime()) || (now.getTime() - measuredAt.getTime()) / 3600000 >= this.lifetimeRefreshHours) {
        due.push(name);
      }
    }
    return due;
  }

  period(publishedAt, measurementWindow, now = new Date()) {
    const definition = WINDOW_DEFINITIONS[measurementWindow];
    if (!definition || !publishedAt) return null;
    const start = new Date(publishedAt);
    if (Number.isNaN(start.getTime())) return null;
    const startDate = this.date(start);

    if (measurementWindow === 'lifetime') {
      const yesterday = new Date(now.getTime() - 86400000);
      const end = yesterday < start ? start : yesterday;
      return { startDate, endDate: this.date(end), precision: definition.precision, label: definition.label };
    }

    // YouTube Analytics targeted queries are date-based, not hour-based. For 24h/72h
    // milestones we intentionally use a conservative calendar-day proxy and persist
    // its precision so the UI never presents it as exact hourly evidence.
    const end = new Date(start.getTime() + (definition.fixedDays - 1) * 86400000);
    const completeDay = new Date(now.getTime() - 86400000);
    const boundedEnd = end > completeDay ? completeDay : end;
    if (boundedEnd < start) return null;
    return { startDate, endDate: this.date(boundedEnd), precision: definition.precision, label: definition.label };
  }

  date(value) {
    return value.toISOString().slice(0, 10);
  }
}

module.exports = { MeasurementWindowPolicy, WINDOW_DEFINITIONS };
