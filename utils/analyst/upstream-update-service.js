'use strict';

class UpstreamUpdateService {
  constructor(db, options = {}) {
    this.db = db;
    this.fetch = options.fetch || globalThis.fetch;
    this.repository = options.repository || process.env.ANALYST_UPSTREAM_REPO || 'darkzOGx/youtube-automation-agent';
    this.branch = options.branch || process.env.ANALYST_UPSTREAM_BRANCH || 'master';
    this.baseSha = options.baseSha || process.env.ANALYST_UPSTREAM_BASE_SHA || '941c3bee2b2c54f3f1a8e4dc9e034e061a5fed3a';
    this.logger = options.logger || console;
  }

  async check() {
    if (typeof this.fetch !== 'function') throw new Error('Fetch is unavailable for upstream update checks');
    const url = `https://api.github.com/repos/${this.repository}/commits/${encodeURIComponent(this.branch)}`;
    const response = await this.fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'AgentTube-Analyst-Update-Checker'
      }
    });
    if (!response.ok) throw new Error(`Upstream update check failed with HTTP ${response.status}`);
    const data = await response.json();
    const latestSha = String(data.sha || '');
    if (!/^[a-f0-9]{40}$/i.test(latestSha)) throw new Error('Upstream update response did not include a valid commit SHA');
    const result = {
      repository: this.repository,
      branch: this.branch,
      baseSha: this.baseSha,
      latestSha,
      updateAvailable: latestSha !== this.baseSha,
      commitUrl: data.html_url || `https://github.com/${this.repository}/commit/${latestSha}`,
      message: data.commit?.message || null,
      committedAt: data.commit?.committer?.date || data.commit?.author?.date || null,
      checkedAt: new Date().toISOString(),
      autoApply: false,
      policy: 'Updates are detected only. They are never downloaded, executed, merged, or installed automatically.'
    };
    if (this.db?.setSetting) await this.db.setSetting('analyst_upstream_update', JSON.stringify(result));
    return result;
  }

  async getLastCheck() {
    if (!this.db?.getSetting) return null;
    const raw = await this.db.getSetting('analyst_upstream_update');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_error) { return null; }
  }
}

module.exports = { UpstreamUpdateService };
