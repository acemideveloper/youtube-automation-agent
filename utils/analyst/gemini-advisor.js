'use strict';

const crypto = require('crypto');

const PROMPT_VERSION = 'analyst-advisor-v1';
const DEFAULT_MODEL = 'gemini-3.7-flash';

const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    evidenceUsed: { type: 'array', items: { type: 'string' } },
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string', enum: ['packaging', 'title', 'thumbnail', 'hook', 'content', 'topic', 'insufficient_evidence'] },
          observation: { type: 'string' },
          rationale: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] }
        },
        required: ['area', 'observation', 'rationale', 'confidence']
      }
    },
    title: {
      type: 'object',
      properties: {
        assessment: { type: 'string' },
        alternatives: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              strategy: { type: 'string' },
              title: { type: 'string' },
              rationale: { type: 'string' }
            },
            required: ['strategy', 'title', 'rationale']
          }
        },
        avoid: { type: 'array', items: { type: 'string' } }
      },
      required: ['assessment', 'alternatives', 'avoid']
    },
    thumbnail: {
      type: 'object',
      properties: {
        assessment: { type: 'string' },
        strengths: { type: 'array', items: { type: 'string' } },
        issues: { type: 'array', items: { type: 'string' } },
        concepts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              concept: { type: 'string' },
              focalSubject: { type: 'string' },
              composition: { type: 'string' },
              textOverlay: { type: 'string' },
              rationale: { type: 'string' }
            },
            required: ['concept', 'focalSubject', 'composition', 'textOverlay', 'rationale']
          }
        }
      },
      required: ['assessment', 'strengths', 'issues', 'concepts']
    },
    hook: {
      type: 'object',
      properties: {
        assessment: { type: 'string' },
        recommendations: { type: 'array', items: { type: 'string' } }
      },
      required: ['assessment', 'recommendations']
    },
    nextAction: {
      type: 'object',
      properties: {
        priority: { type: 'string', enum: ['observe', 'low', 'medium', 'high'] },
        action: { type: 'string' },
        reason: { type: 'string' },
        successMetric: { type: 'string' }
      },
      required: ['priority', 'action', 'reason', 'successMetric']
    },
    limitations: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary', 'confidence', 'evidenceUsed', 'hypotheses', 'title', 'thumbnail', 'hook', 'nextAction', 'limitations']
};

class GeminiAdvisor {
  constructor(credentials = {}, options = {}) {
    const raw = credentials?.credentials || credentials || {};
    this.repository = options.repository || null;
    this.logger = options.logger || console;
    this.http = options.http || null;
    this.model = options.model || process.env.ANALYST_GEMINI_MODEL || raw.gemini?.model || DEFAULT_MODEL;
    this.outputLanguage = options.outputLanguage || process.env.ANALYST_OUTPUT_LANGUAGE || 'tr';
    this.promptVersion = options.promptVersion || PROMPT_VERSION;
    this.maxThumbnailBytes = Math.max(256000, Number(options.maxThumbnailBytes || process.env.ANALYST_MAX_THUMBNAIL_BYTES || 8 * 1024 * 1024));
    this.client = options.client || null;

    if (!this.client) {
      const apiKey = options.apiKey || raw.gemini?.apiKey || process.env.GEMINI_API_KEY;
      if (apiKey) {
        try {
          const { GoogleGenAI } = require('@google/genai');
          this.client = new GoogleGenAI({ apiKey });
        } catch (error) {
          this.warn(`Gemini advisor initialization failed: ${error.message}`);
        }
      }
    }
  }

  isAvailable() {
    return Boolean(this.client?.models?.generateContent);
  }

  async advise(input = {}) {
    if (!this.isAvailable()) throw new Error('Gemini advisor is unavailable; configure GEMINI_API_KEY');
    const video = input.video || {};
    const diagnosis = input.diagnosis || {};
    const measurementWindow = input.measurementWindow || diagnosis.selectedWindow || diagnosis.measurementWindow || '28d';
    if (!video.videoId) throw new Error('Gemini advisor requires a videoId');

    const thumbnail = await this.fetchThumbnail(video.thumbnailUrl).catch(error => {
      this.warn(`Thumbnail fetch skipped for ${video.videoId}: ${error.message}`);
      return null;
    });
    const evidence = this.buildEvidence(input, thumbnail);
    const evidenceFingerprint = this.fingerprint({
      promptVersion: this.promptVersion,
      evidence,
      thumbnailSha256: thumbnail?.sha256 || null
    });

    if (this.repository?.getCachedAdvice) {
      const cached = await this.repository.getCachedAdvice(video.videoId, 'video_advisor', measurementWindow, evidenceFingerprint);
      if (cached) return { ...cached, cached: true };
    }

    const prompt = this.buildPrompt(evidence);
    const contents = [{ text: prompt }];
    if (thumbnail) {
      contents.push({
        inlineData: {
          mimeType: thumbnail.mimeType,
          data: thumbnail.base64
        }
      });
    }

    const response = await this.client.models.generateContent({
      model: this.model,
      contents,
      config: {
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: ADVICE_SCHEMA
      }
    });
    const text = response?.text;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Gemini advisor returned an empty response');
    const output = this.parseOutput(text);
    const record = {
      videoId: video.videoId,
      analysisType: 'video_advisor',
      measurementWindow,
      evidenceFingerprint,
      model: this.model,
      promptVersion: this.promptVersion,
      thumbnailSha256: thumbnail?.sha256 || null,
      inputSummary: evidence,
      output
    };
    if (this.repository?.saveAdvice) {
      const saved = await this.repository.saveAdvice(record);
      return { ...saved, cached: false };
    }
    return { ...record, cached: false };
  }

  buildEvidence(input, thumbnail) {
    const video = input.video || {};
    const diagnosis = input.diagnosis || {};
    const result = diagnosis.diagnosis || diagnosis;
    return {
      video: {
        videoId: video.videoId,
        title: String(video.title || '').slice(0, 120),
        descriptionExcerpt: String(video.description || '').slice(0, 1200),
        tags: Array.isArray(video.tags) ? video.tags.slice(0, 25) : [],
        publishedAt: video.publishedAt || null,
        durationSeconds: video.durationSeconds ?? null,
        creatorContentType: video.creatorContentType || 'UNSPECIFIED',
        publicStats: {
          views: video.viewCount ?? null,
          likes: video.likeCount ?? null,
          comments: video.commentCount ?? null
        },
        thumbnailAvailable: Boolean(thumbnail)
      },
      measurementWindow: input.measurementWindow || diagnosis.selectedWindow || result.measurementWindow || null,
      deterministicDiagnosis: this.compactDiagnosis(result),
      retentionEvidence: this.compactRetention(input.retentionEvidence),
      channelContext: this.compactChannelContext(input.channelContext || input.channelSummary || {})
    };
  }

  compactDiagnosis(value) {
    if (!value || typeof value !== 'object') return {};
    return {
      status: value.status || null,
      diagnosis: value.diagnosis || null,
      action: value.action || null,
      confidence: value.confidence || null,
      observations: Array.isArray(value.observations) ? value.observations.slice(0, 8) : [],
      benchmark: value.benchmark ? {
        cohort: value.benchmark.cohort,
        cohortSize: value.benchmark.cohortSize,
        ctr: value.benchmark.ctr,
        retention: value.benchmark.retention,
        target: value.benchmark.target
      } : null,
      reasons: Array.isArray(value.reasons) ? value.reasons.slice(0, 8) : []
    };
  }

  compactRetention(value) {
    const summary = value?.summary || value?.retention?.summary || null;
    if (!summary || typeof summary !== 'object') return null;
    return {
      measurementWindow: value?.measurementWindow || value?.retention?.measurementWindow || null,
      measuredAt: value?.measuredAt || value?.retention?.measuredAt || null,
      opening: summary.opening ? {
        targetSeconds: summary.opening.targetSeconds ?? null,
        audienceWatchRatio: summary.opening.audienceWatchRatio ?? null,
        relativeRetentionPerformance: summary.opening.relativeRetentionPerformance ?? null,
        relativeToSimilarLengthMedian: summary.opening.relativeToSimilarLengthMedian || 'unknown',
        dropFromFirstPointPctPoints: summary.opening.dropFromFirstPointPctPoints ?? null
      } : null,
      steepDrops: Array.isArray(summary.steepDrops) ? summary.steepDrops.slice(0, 5).map(item => ({
        elapsedSeconds: item.elapsedSeconds ?? null,
        elapsedRatio: item.elapsedRatio ?? null,
        dropPctPoints: item.dropPctPoints ?? null,
        relativeRetentionPerformance: item.relativeRetentionPerformance ?? null
      })) : [],
      rewatchSignals: Array.isArray(summary.rewatchSignals) ? summary.rewatchSignals.slice(0, 5).map(item => ({
        elapsedSeconds: item.elapsedSeconds ?? null,
        elapsedRatio: item.elapsedRatio ?? null,
        deltaPctPoints: item.deltaPctPoints ?? null,
        audienceWatchRatio: item.audienceWatchRatio ?? null
      })) : [],
      relativeRetention: summary.relativeRetention || null,
      evidencePolicy: summary.evidencePolicy || null
    };
  }

  compactChannelContext(value) {
    if (!value || typeof value !== 'object') return {};
    const coverage = value.measurementCoverage || value.coverage || {};
    return {
      catalogVideos: coverage.catalogVideos ?? null,
      measuredVideos: coverage.measuredVideos ?? null,
      snapshotCount: coverage.snapshots ?? null,
      evidencePolicy: value.evidencePolicy || null
    };
  }

  buildPrompt(evidence) {
    const language = this.outputLanguage === 'tr' ? 'Türkçe' : this.outputLanguage;
    return [
      `You are a conservative YouTube channel analyst. Return all natural-language fields in ${language}.`,
      'Your task is to interpret supplied evidence, not invent performance data.',
      'Rules:',
      '- Never claim a title, thumbnail, or topic will go viral or guarantee views.',
      '- Treat deterministicDiagnosis and benchmark numbers as authoritative evidence.',
      '- Do not replace channel-relative evidence with generic claims such as “CTR under 4% is bad”.',
      '- If evidence is insufficient, say so explicitly and keep confidence low.',
      '- Separate observation from hypothesis. Correlation is not proof of causation.',
      '- Thumbnail comments must describe only what is actually visible in the supplied image.',
      '- When retentionEvidence exists, use exact curve locations as descriptive evidence only; never invent the cause of a drop without transcript/context evidence.',
      '- Title alternatives must preserve the video subject and avoid misleading clickbait.',
      '- Recommend one next test/action that can be measured. Do not auto-publish or imply that changes were applied.',
      '- Keep title alternatives to at most 5 and thumbnail concepts to at most 3.',
      '',
      'Evidence JSON:',
      JSON.stringify(evidence)
    ].join('\n');
  }

  async fetchThumbnail(url) {
    if (!url) return null;
    const parsed = this.validateThumbnailUrl(url);
    if (!this.http) {
      // Lazy-load so the module can be unit-tested outside a full AgentTube install.
      this.http = require('axios');
    }
    const response = await this.http.get(parsed.toString(), {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 0,
      maxContentLength: this.maxThumbnailBytes,
      maxBodyLength: this.maxThumbnailBytes,
      validateStatus: status => status >= 200 && status < 300
    });
    const data = Buffer.from(response.data);
    if (!data.length) throw new Error('thumbnail response was empty');
    if (data.length > this.maxThumbnailBytes) throw new Error('thumbnail exceeds configured byte limit');
    const rawType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    const mimeType = rawType.startsWith('image/') ? rawType : this.detectMimeType(data);
    if (!mimeType) throw new Error('thumbnail MIME type is not a supported image');
    return {
      mimeType,
      base64: data.toString('base64'),
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      bytes: data.length
    };
  }

  validateThumbnailUrl(value) {
    let parsed;
    try { parsed = new URL(String(value)); } catch (_error) { throw new Error('thumbnail URL is invalid'); }
    if (parsed.protocol !== 'https:') throw new Error('thumbnail URL must use HTTPS');
    const host = parsed.hostname.toLowerCase();
    const allowed = host === 'i.ytimg.com' || host === 'img.youtube.com' || host.endsWith('.ytimg.com');
    if (!allowed) throw new Error(`thumbnail host is not allowed: ${host}`);
    return parsed;
  }

  detectMimeType(data) {
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
    if (data.length >= 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    return null;
  }

  parseOutput(text) {
    let output;
    try { output = JSON.parse(text); } catch (error) { throw new Error(`Gemini advisor returned invalid JSON: ${error.message}`); }
    const required = ['summary', 'confidence', 'evidenceUsed', 'hypotheses', 'title', 'thumbnail', 'hook', 'nextAction', 'limitations'];
    for (const key of required) {
      if (output[key] === undefined || output[key] === null) throw new Error(`Gemini advisor output is missing ${key}`);
    }
    if (!['low', 'medium', 'high'].includes(output.confidence)) throw new Error('Gemini advisor confidence is invalid');
    if (!Array.isArray(output.title?.alternatives) || output.title.alternatives.length > 5) throw new Error('Gemini advisor title alternatives are invalid');
    if (!Array.isArray(output.thumbnail?.concepts) || output.thumbnail.concepts.length > 3) throw new Error('Gemini advisor thumbnail concepts are invalid');
    return output;
  }

  fingerprint(value) {
    return crypto.createHash('sha256').update(this.stableStringify(value)).digest('hex');
  }

  stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  warn(message) {
    if (typeof this.logger?.warn === 'function') this.logger.warn(message);
  }
}

module.exports = { GeminiAdvisor, ADVICE_SCHEMA, PROMPT_VERSION };
