'use strict';

class AnalystRepository {
  constructor(db) {
    if (!db) throw new Error('AnalystRepository requires a database');
    this.db = db;
  }

  async initialize() {
    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS analyst_channels (
      channel_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      custom_url TEXT,
      country TEXT,
      uploads_playlist_id TEXT,
      published_at TEXT,
      subscriber_count INTEGER,
      video_count INTEGER,
      view_count INTEGER,
      raw_json TEXT NOT NULL DEFAULT '{}',
      first_synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_synced_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS analyst_videos (
      video_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      published_at TEXT NOT NULL,
      duration_seconds REAL,
      category_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      thumbnails TEXT NOT NULL DEFAULT '{}',
      thumbnail_url TEXT,
      view_count INTEGER,
      like_count INTEGER,
      comment_count INTEGER,
      live_broadcast_content TEXT,
      creator_content_type TEXT NOT NULL DEFAULT 'UNSPECIFIED',
      surface_hint TEXT NOT NULL DEFAULT 'unknown',
      raw_json TEXT NOT NULL DEFAULT '{}',
      first_synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(channel_id) REFERENCES analyst_channels(channel_id)
    )`);

    await this.db.executeQuery(`CREATE INDEX IF NOT EXISTS idx_analyst_videos_published
      ON analyst_videos(published_at DESC)`);
    await this.db.executeQuery(`CREATE INDEX IF NOT EXISTS idx_analyst_videos_content_type
      ON analyst_videos(creator_content_type, published_at DESC)`);

    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS analyst_sync_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      scanned_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      details TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT
    )`);

    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS analyst_benchmark_runs (
      id TEXT PRIMARY KEY,
      measurement_window TEXT NOT NULL,
      cohort_key TEXT NOT NULL,
      sample_size INTEGER NOT NULL,
      benchmark TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS analyst_advice (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      measurement_window TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      thumbnail_sha256 TEXT,
      input_summary TEXT NOT NULL DEFAULT '{}',
      output TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(video_id, analysis_type, measurement_window, evidence_fingerprint)
    )`);
    await this.db.executeQuery(`CREATE INDEX IF NOT EXISTS idx_analyst_advice_video
      ON analyst_advice(video_id, created_at DESC)`);

    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS analyst_retention_curves (
      video_id TEXT NOT NULL,
      measurement_window TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      points TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '{}',
      measured_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(video_id, measurement_window)
    )`);

    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS analyst_recommendations (
      id TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      advice_id TEXT,
      evidence_fingerprint TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      target_metric TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      baseline TEXT NOT NULL DEFAULT '{}',
      note TEXT,
      applied_at TEXT,
      deferred_until TEXT,
      outcome TEXT NOT NULL DEFAULT '{}',
      evaluated_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(video_id, evidence_fingerprint, category, action)
    )`);
    await this.db.executeQuery(`CREATE INDEX IF NOT EXISTS idx_analyst_recommendations_status
      ON analyst_recommendations(status, updated_at DESC)`);

    await this.db.executeQuery(`CREATE TABLE IF NOT EXISTS analyst_recommendation_events (
      id TEXT PRIMARY KEY,
      recommendation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(recommendation_id) REFERENCES analyst_recommendations(id)
    )`);

    return true;
  }

  async upsertChannel(channel) {
    await this.db.executeQuery(
      `INSERT INTO analyst_channels (
        channel_id, title, description, custom_url, country, uploads_playlist_id,
        published_at, subscriber_count, video_count, view_count, raw_json,
        first_synced_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(channel_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        custom_url = excluded.custom_url,
        country = excluded.country,
        uploads_playlist_id = excluded.uploads_playlist_id,
        published_at = excluded.published_at,
        subscriber_count = excluded.subscriber_count,
        video_count = excluded.video_count,
        view_count = excluded.view_count,
        raw_json = excluded.raw_json,
        last_synced_at = datetime('now')`,
      [
        channel.channelId,
        channel.title || '',
        channel.description || '',
        channel.customUrl || null,
        channel.country || null,
        channel.uploadsPlaylistId || null,
        channel.publishedAt || null,
        this.integerOrNull(channel.subscriberCount),
        this.integerOrNull(channel.videoCount),
        this.integerOrNull(channel.viewCount),
        JSON.stringify(channel.raw || {})
      ]
    );
    return this.getChannel(channel.channelId);
  }

  async getChannel(channelId) {
    const row = await this.db.getRow('SELECT * FROM analyst_channels WHERE channel_id = ?', [channelId]);
    return row ? this.parseChannel(row) : null;
  }

  async upsertVideo(video) {
    await this.db.executeQuery(
      `INSERT INTO analyst_videos (
        video_id, channel_id, title, description, published_at, duration_seconds,
        category_id, tags, thumbnails, thumbnail_url, view_count, like_count,
        comment_count, live_broadcast_content, creator_content_type, surface_hint,
        raw_json, first_synced_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(video_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        title = excluded.title,
        description = excluded.description,
        published_at = excluded.published_at,
        duration_seconds = excluded.duration_seconds,
        category_id = excluded.category_id,
        tags = excluded.tags,
        thumbnails = excluded.thumbnails,
        thumbnail_url = excluded.thumbnail_url,
        view_count = excluded.view_count,
        like_count = excluded.like_count,
        comment_count = excluded.comment_count,
        live_broadcast_content = excluded.live_broadcast_content,
        creator_content_type = excluded.creator_content_type,
        surface_hint = excluded.surface_hint,
        raw_json = excluded.raw_json,
        last_synced_at = datetime('now')`,
      [
        video.videoId,
        video.channelId,
        video.title || '',
        video.description || '',
        video.publishedAt,
        this.numberOrNull(video.durationSeconds),
        video.categoryId || null,
        JSON.stringify(video.tags || []),
        JSON.stringify(video.thumbnails || {}),
        video.thumbnailUrl || null,
        this.integerOrNull(video.viewCount),
        this.integerOrNull(video.likeCount),
        this.integerOrNull(video.commentCount),
        video.liveBroadcastContent || 'none',
        video.creatorContentType || 'UNSPECIFIED',
        video.surfaceHint || 'unknown',
        JSON.stringify(video.raw || {})
      ]
    );
    return this.getVideo(video.videoId);
  }

  async getVideo(videoId) {
    const row = await this.db.getRow('SELECT * FROM analyst_videos WHERE video_id = ?', [videoId]);
    return row ? this.parseVideo(row) : null;
  }

  async listVideos(options = {}) {
    const where = [];
    const params = [];
    if (options.channelId) {
      where.push('channel_id = ?');
      params.push(options.channelId);
    }
    if (options.creatorContentType) {
      where.push('creator_content_type = ?');
      params.push(options.creatorContentType);
    }
    if (options.since) {
      where.push('published_at >= ?');
      params.push(options.since);
    }
    const limit = Math.max(1, Math.min(5000, Number(options.limit || 500)));
    params.push(limit);
    const rows = await this.db.getAllRows(
      `SELECT * FROM analyst_videos${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY published_at DESC LIMIT ?`,
      params
    );
    return rows.map(row => this.parseVideo(row));
  }

  async startSyncRun(kind, details = {}) {
    const id = this.generateId('analyst_sync');
    await this.db.executeQuery(
      `INSERT INTO analyst_sync_runs (id, kind, status, details) VALUES (?, ?, 'running', ?)`,
      [id, kind, JSON.stringify(details || {})]
    );
    return id;
  }

  async finishSyncRun(id, changes = {}) {
    await this.db.executeQuery(
      `UPDATE analyst_sync_runs SET status = ?, scanned_count = ?, updated_count = ?,
        details = ?, error = ?, completed_at = datetime('now') WHERE id = ?`,
      [
        changes.status || 'completed',
        Number(changes.scannedCount || 0),
        Number(changes.updatedCount || 0),
        JSON.stringify(changes.details || {}),
        changes.error || null,
        id
      ]
    );
    return this.db.getRow('SELECT * FROM analyst_sync_runs WHERE id = ?', [id]);
  }

  async getSummary() {
    const [channel, videoCounts, lastSync] = await Promise.all([
      this.db.getRow('SELECT * FROM analyst_channels ORDER BY last_synced_at DESC LIMIT 1'),
      this.db.getAllRows(`SELECT creator_content_type, COUNT(*) AS count
        FROM analyst_videos GROUP BY creator_content_type ORDER BY count DESC`),
      this.db.getRow('SELECT * FROM analyst_sync_runs ORDER BY started_at DESC LIMIT 1')
    ]);
    return {
      channel: channel ? this.parseChannel(channel) : null,
      videos: videoCounts.map(row => ({ contentType: row.creator_content_type, count: Number(row.count || 0) })),
      lastSync: lastSync || null
    };
  }

  async saveRetentionCurve(input) {
    await this.db.executeQuery(
      `INSERT INTO analyst_retention_curves (video_id, measurement_window, period_start, period_end, points, summary, measured_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(video_id, measurement_window) DO UPDATE SET
         period_start = excluded.period_start,
         period_end = excluded.period_end,
         points = excluded.points,
         summary = excluded.summary,
         measured_at = CURRENT_TIMESTAMP`,
      [
        input.videoId, input.measurementWindow, input.periodStart, input.periodEnd,
        JSON.stringify(input.points || []), JSON.stringify(input.summary || {})
      ]
    );
    return this.getRetentionCurve(input.videoId, input.measurementWindow);
  }

  async getRetentionCurve(videoId, measurementWindow) {
    const row = await this.db.getRow(
      'SELECT * FROM analyst_retention_curves WHERE video_id = ? AND measurement_window = ?',
      [videoId, measurementWindow]
    );
    if (!row) return null;
    return {
      ...row,
      videoId: row.video_id,
      measurementWindow: row.measurement_window,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      points: this.json(row.points, []),
      summary: this.json(row.summary, {}),
      measuredAt: row.measured_at
    };
  }

  async getCachedAdvice(videoId, analysisType, measurementWindow, evidenceFingerprint) {
    const row = await this.db.getRow(
      `SELECT * FROM analyst_advice
       WHERE video_id = ? AND analysis_type = ? AND measurement_window = ? AND evidence_fingerprint = ?
       ORDER BY created_at DESC LIMIT 1`,
      [videoId, analysisType, measurementWindow, evidenceFingerprint]
    );
    return row ? this.parseAdvice(row) : null;
  }

  async saveAdvice(advice) {
    const id = advice.id || this.generateId('analyst_advice');
    await this.db.executeQuery(
      `INSERT INTO analyst_advice (
        id, video_id, analysis_type, measurement_window, evidence_fingerprint,
        model, prompt_version, thumbnail_sha256, input_summary, output
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id, analysis_type, measurement_window, evidence_fingerprint) DO UPDATE SET
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        thumbnail_sha256 = excluded.thumbnail_sha256,
        input_summary = excluded.input_summary,
        output = excluded.output,
        created_at = CURRENT_TIMESTAMP`,
      [
        id,
        advice.videoId,
        advice.analysisType,
        advice.measurementWindow,
        advice.evidenceFingerprint,
        advice.model,
        advice.promptVersion,
        advice.thumbnailSha256 || null,
        JSON.stringify(advice.inputSummary || {}),
        JSON.stringify(advice.output || {})
      ]
    );
    return this.getCachedAdvice(advice.videoId, advice.analysisType, advice.measurementWindow, advice.evidenceFingerprint);
  }

  async listAdvice(videoId, limit = 20) {
    const rows = await this.db.getAllRows(
      `SELECT * FROM analyst_advice WHERE video_id = ? ORDER BY created_at DESC LIMIT ?`,
      [videoId, Math.max(1, Math.min(100, Number(limit || 20)))]
    );
    return rows.map(row => this.parseAdvice(row));
  }

  parseAdvice(row) {
    if (!row) return null;
    return {
      ...row,
      videoId: row.video_id,
      analysisType: row.analysis_type,
      measurementWindow: row.measurement_window,
      evidenceFingerprint: row.evidence_fingerprint,
      promptVersion: row.prompt_version,
      thumbnailSha256: row.thumbnail_sha256,
      inputSummary: this.json(row.input_summary, {}),
      output: this.json(row.output, {})
    };
  }

  async upsertRecommendation(input) {
    const existing = await this.db.getRow(
      `SELECT id FROM analyst_recommendations
       WHERE video_id = ? AND evidence_fingerprint = ? AND category = ? AND action = ?`,
      [input.videoId, input.evidenceFingerprint, input.category, input.action]
    );
    const id = existing?.id || input.id || this.generateId('analyst_rec');
    await this.db.executeQuery(
      `INSERT INTO analyst_recommendations (
        id, video_id, advice_id, evidence_fingerprint, category, action,
        target_metric, status, baseline, note, applied_at, deferred_until, outcome, evaluated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id, evidence_fingerprint, category, action) DO UPDATE SET
        advice_id = excluded.advice_id,
        target_metric = excluded.target_metric,
        updated_at = CURRENT_TIMESTAMP`,
      [
        id, input.videoId, input.adviceId || null, input.evidenceFingerprint,
        input.category, input.action, input.targetMetric || null,
        input.status || 'pending', JSON.stringify(input.baseline || {}), input.note || null,
        input.appliedAt || null, input.deferredUntil || null,
        JSON.stringify(input.outcome || {}), input.evaluatedAt || null
      ]
    );
    const recommendation = await this.getRecommendation(id);
    if (!existing) await this.addRecommendationEvent(id, 'created', { status: recommendation.status });
    return recommendation;
  }

  async getRecommendation(id) {
    const row = await this.db.getRow('SELECT * FROM analyst_recommendations WHERE id = ?', [id]);
    return row ? this.parseRecommendation(row) : null;
  }

  async listRecommendations(options = {}) {
    const conditions = [];
    const params = [];
    if (options.videoId) { conditions.push('video_id = ?'); params.push(options.videoId); }
    if (options.status) { conditions.push('status = ?'); params.push(options.status); }
    const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
    params.push(limit);
    const rows = await this.db.getAllRows(
      `SELECT * FROM analyst_recommendations${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY updated_at DESC LIMIT ?`, params
    );
    return rows.map(row => this.parseRecommendation(row));
  }

  async updateRecommendation(id, changes = {}) {
    const current = await this.getRecommendation(id);
    if (!current) return null;
    await this.db.executeQuery(
      `UPDATE analyst_recommendations SET status = ?, baseline = ?, note = ?, applied_at = ?,
        deferred_until = ?, outcome = ?, evaluated_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [
        changes.status ?? current.status,
        JSON.stringify(changes.baseline ?? current.baseline ?? {}),
        changes.note === undefined ? current.note : changes.note,
        changes.appliedAt === undefined ? current.appliedAt : changes.appliedAt,
        changes.deferredUntil === undefined ? current.deferredUntil : changes.deferredUntil,
        JSON.stringify(changes.outcome ?? current.outcome ?? {}),
        changes.evaluatedAt === undefined ? current.evaluatedAt : changes.evaluatedAt,
        id
      ]
    );
    const updated = await this.getRecommendation(id);
    await this.addRecommendationEvent(id, 'updated', {
      fromStatus: current.status,
      toStatus: updated.status,
      note: changes.note === undefined ? undefined : changes.note
    });
    return updated;
  }

  async addRecommendationEvent(recommendationId, eventType, payload = {}) {
    const id = this.generateId('analyst_rec_event');
    await this.db.executeQuery(
      `INSERT INTO analyst_recommendation_events (id, recommendation_id, event_type, payload)
       VALUES (?, ?, ?, ?)`,
      [id, recommendationId, eventType, JSON.stringify(payload || {})]
    );
    return id;
  }

  parseRecommendation(row) {
    if (!row) return null;
    return {
      ...row,
      videoId: row.video_id,
      adviceId: row.advice_id,
      evidenceFingerprint: row.evidence_fingerprint,
      targetMetric: row.target_metric,
      baseline: this.json(row.baseline, {}),
      appliedAt: row.applied_at,
      deferredUntil: row.deferred_until,
      outcome: this.json(row.outcome, {}),
      evaluatedAt: row.evaluated_at
    };
  }

  parseChannel(row) {
    return {
      ...row,
      channelId: row.channel_id,
      uploadsPlaylistId: row.uploads_playlist_id,
      subscriberCount: this.integerOrNull(row.subscriber_count),
      videoCount: this.integerOrNull(row.video_count),
      viewCount: this.integerOrNull(row.view_count),
      raw: this.json(row.raw_json, {})
    };
  }

  parseVideo(row) {
    return {
      ...row,
      videoId: row.video_id,
      channelId: row.channel_id,
      publishedAt: row.published_at,
      durationSeconds: this.numberOrNull(row.duration_seconds),
      categoryId: row.category_id,
      tags: this.json(row.tags, []),
      thumbnails: this.json(row.thumbnails, {}),
      thumbnailUrl: row.thumbnail_url,
      viewCount: this.integerOrNull(row.view_count),
      likeCount: this.integerOrNull(row.like_count),
      commentCount: this.integerOrNull(row.comment_count),
      liveBroadcastContent: row.live_broadcast_content,
      creatorContentType: row.creator_content_type,
      surfaceHint: row.surface_hint,
      raw: this.json(row.raw_json, {})
    };
  }

  json(value, fallback) {
    try { return JSON.parse(value || JSON.stringify(fallback)); } catch (_error) { return fallback; }
  }

  integerOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }

  numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  generateId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

module.exports = { AnalystRepository };
