'use strict';

const { AnalystRepository } = require('./analyst-repository');

class YouTubeChannelSyncService {
  constructor(db, credentials, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.repository = options.repository || new AnalystRepository(db);
    this.logger = options.logger || console;
    this.youtube = options.youtube || null;
    this.youtubeAnalytics = options.youtubeAnalytics || null;
    this.maxBackfillVideos = Math.max(1, Math.min(5000, Number(options.maxBackfillVideos || process.env.ANALYST_MAX_BACKFILL_VIDEOS || 500)));
  }

  async initialize() {
    await this.repository.initialize();
    this.youtube ||= this.credentials.getYouTubeClient();
    if (!this.youtubeAnalytics) {
      const { google } = require('googleapis');
      this.youtubeAnalytics = google.youtubeAnalytics({ version: 'v2', auth: this.credentials.getYouTubeAuth() });
    }
    return true;
  }

  async syncChannel(options = {}) {
    await this.initialize();
    const maxVideos = Math.max(1, Math.min(5000, Number(options.maxVideos || this.maxBackfillVideos)));
    const runId = await this.repository.startSyncRun('channel_catalog', { maxVideos });
    let scannedCount = 0;
    let updatedCount = 0;

    try {
      const channel = await this.fetchOwnedChannel();
      await this.repository.upsertChannel(channel);
      const videoIds = await this.fetchUploadVideoIds(channel.uploadsPlaylistId, maxVideos);
      scannedCount = videoIds.length;
      const details = await this.fetchVideoDetails(videoIds);
      const contentTypes = options.resolveContentTypes === false
        ? new Map()
        : await this.fetchCreatorContentTypes(details).catch(error => {
            this.warn(`Creator content type lookup skipped: ${error.message}`);
            return new Map();
          });

      for (const item of details) {
        const parsed = this.parseVideo(item, contentTypes.get(item.id));
        await this.repository.upsertVideo(parsed);
        updatedCount++;
      }

      await this.repository.finishSyncRun(runId, {
        status: 'completed',
        scannedCount,
        updatedCount,
        details: { channelId: channel.channelId, maxVideos, creatorContentTypesResolved: contentTypes.size }
      });
      return { runId, channel, scannedCount, updatedCount };
    } catch (error) {
      await this.repository.finishSyncRun(runId, {
        status: 'failed', scannedCount, updatedCount, error: error.message
      }).catch(() => {});
      throw error;
    }
  }

  async fetchOwnedChannel() {
    const response = await this.youtube.channels.list({
      part: 'snippet,statistics,contentDetails',
      mine: true,
      maxResults: 1
    });
    const item = response.data?.items?.[0];
    if (!item) throw new Error('No YouTube channel is available for the authenticated account');
    return {
      channelId: item.id,
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      customUrl: item.snippet?.customUrl || null,
      country: item.snippet?.country || null,
      uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
      publishedAt: item.snippet?.publishedAt || null,
      subscriberCount: item.statistics?.hiddenSubscriberCount ? null : this.integer(item.statistics?.subscriberCount),
      videoCount: this.integer(item.statistics?.videoCount),
      viewCount: this.integer(item.statistics?.viewCount),
      raw: item
    };
  }

  async fetchUploadVideoIds(playlistId, limit) {
    if (!playlistId) throw new Error('The channel uploads playlist could not be resolved');
    const ids = [];
    let pageToken = undefined;
    do {
      const response = await this.youtube.playlistItems.list({
        part: 'contentDetails',
        playlistId,
        maxResults: Math.min(50, limit - ids.length),
        ...(pageToken ? { pageToken } : {})
      });
      for (const item of response.data?.items || []) {
        const id = item.contentDetails?.videoId;
        if (id && !ids.includes(id)) ids.push(id);
        if (ids.length >= limit) break;
      }
      pageToken = ids.length < limit ? response.data?.nextPageToken : null;
    } while (pageToken && ids.length < limit);
    return ids;
  }

  async fetchVideoDetails(videoIds) {
    const items = [];
    for (let offset = 0; offset < videoIds.length; offset += 50) {
      const ids = videoIds.slice(offset, offset + 50);
      const response = await this.youtube.videos.list({
        part: 'snippet,statistics,contentDetails,status',
        id: ids.join(','),
        maxResults: 50
      });
      items.push(...(response.data?.items || []));
    }
    return items;
  }

  async fetchCreatorContentTypes(videoItems) {
    if (!videoItems.length || !this.youtubeAnalytics) return new Map();
    const map = new Map();
    const fallbackStart = '2019-01-01';
    const publishedDates = videoItems
      .map(item => item.snippet?.publishedAt)
      .filter(Boolean)
      .map(value => new Date(value))
      .filter(value => !Number.isNaN(value.getTime()));
    const earliest = publishedDates.length ? new Date(Math.max(new Date(fallbackStart).getTime(), Math.min(...publishedDates.map(d => d.getTime())))) : new Date(fallbackStart);
    const yesterday = new Date(Date.now() - 86400000);
    // Reports are date-based and cannot include today reliably. A channel with only
    // very recent uploads must still produce a valid startDate <= endDate.
    const effectiveStart = new Date(Math.min(earliest.getTime(), yesterday.getTime()));
    const startDate = effectiveStart.toISOString().slice(0, 10);
    const endDate = yesterday.toISOString().slice(0, 10);

    for (let offset = 0; offset < videoItems.length; offset += 500) {
      const batch = videoItems.slice(offset, offset + 500).map(item => item.id);
      const response = await this.youtubeAnalytics.reports.query({
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'views',
        dimensions: 'video,creatorContentType',
        filters: `video==${batch.join(',')}`,
        maxResults: 1000
      });
      const indexes = this.headerIndexes(response.data?.columnHeaders || []);
      const candidates = new Map();
      for (const row of response.data?.rows || []) {
        const videoId = row[indexes.video];
        const type = row[indexes.creatorContentType];
        const views = Number(row[indexes.views] || 0);
        if (!videoId || !type) continue;
        if (!candidates.has(videoId) || candidates.get(videoId).views < views) {
          candidates.set(videoId, { type, views });
        }
      }
      for (const [videoId, candidate] of candidates) map.set(videoId, candidate.type);
    }
    return map;
  }

  parseVideo(item, creatorContentType) {
    const durationSeconds = this.parseDuration(item.contentDetails?.duration);
    const live = item.snippet?.liveBroadcastContent || 'none';
    const resolvedType = creatorContentType || (live !== 'none' ? 'LIVE_STREAM' : 'UNSPECIFIED');
    return {
      videoId: item.id,
      channelId: item.snippet?.channelId,
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
      publishedAt: item.snippet?.publishedAt,
      durationSeconds,
      categoryId: item.snippet?.categoryId || null,
      tags: item.snippet?.tags || [],
      thumbnails: item.snippet?.thumbnails || {},
      thumbnailUrl: this.bestThumbnail(item.snippet?.thumbnails || {}),
      viewCount: this.integer(item.statistics?.viewCount),
      likeCount: this.integer(item.statistics?.likeCount),
      commentCount: this.integer(item.statistics?.commentCount),
      liveBroadcastContent: live,
      creatorContentType: resolvedType,
      surfaceHint: this.surfaceHint(resolvedType, durationSeconds),
      raw: item
    };
  }

  surfaceHint(contentType, durationSeconds) {
    const type = String(contentType || '').toUpperCase();
    if (type === 'SHORTS') return 'shorts';
    if (type === 'LIVE_STREAM') return 'live';
    if (type === 'VIDEO_ON_DEMAND') return 'long_form';
    if (Number.isFinite(durationSeconds) && durationSeconds <= 180) return 'short_candidate';
    if (Number.isFinite(durationSeconds)) return 'long_form_candidate';
    return 'unknown';
  }

  bestThumbnail(thumbnails) {
    for (const name of ['maxres', 'standard', 'high', 'medium', 'default']) {
      if (thumbnails?.[name]?.url) return thumbnails[name].url;
    }
    return null;
  }

  parseDuration(value) {
    if (!value) return null;
    const match = String(value).match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!match) return null;
    return Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 + Number(match[3] || 0) * 60 + Number(match[4] || 0);
  }

  headerIndexes(headers) {
    const result = {};
    headers.forEach((header, index) => { result[header.name] = index; });
    // API rows are documented in requested dimension/metric order; keep a fallback
    // for test doubles or older responses without columnHeaders.
    if (result.video === undefined) result.video = 0;
    if (result.creatorContentType === undefined) result.creatorContentType = 1;
    if (result.views === undefined) result.views = 2;
    return result;
  }

  integer(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }

  warn(message) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(message);
  }
}

module.exports = { YouTubeChannelSyncService };
