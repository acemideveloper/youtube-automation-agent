'use strict';

const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const {
  getYouTubeScopes,
  hasRequiredReadOnlyScopes,
  hasWriteCapableScopes,
  protectYouTubeClient
} = require('../analyst-mode');

class AnalystCredentialManager {
  constructor(options = {}) {
    this.root = options.root || path.resolve(__dirname, '..', '..');
    this.credentialsPath = options.credentialsPath || path.join(this.root, 'config', 'credentials.json');
    this.tokensPath = options.tokensPath || path.join(this.root, 'config', 'analyst-tokens.json');
    this.credentials = {};
    this.tokens = {};
  }

  async initialize() {
    await this.loadCredentials();
    await this.loadTokens();
    this.validate();
    return true;
  }

  async loadCredentials() {
    try { this.credentials = JSON.parse(await fs.readFile(this.credentialsPath, 'utf8')); }
    catch (_error) { this.credentials = {}; }
    return this.credentials;
  }

  async loadTokens() {
    try { this.tokens = JSON.parse(await fs.readFile(this.tokensPath, 'utf8')); }
    catch (_error) { this.tokens = {}; }
    return this.tokens;
  }

  validate() {
    if (!this.credentials?.youtube?.client_id || !this.credentials?.youtube?.client_secret) {
      const error = new Error('Google OAuth client credentials are missing. Run the normal AgentTube setup first so config/credentials.json contains the YouTube client ID and secret.');
      error.code = 'ANALYST_OAUTH_CLIENT_MISSING';
      throw error;
    }
    if (!this.tokens?.youtube) {
      const error = new Error('Read-only analyst OAuth token is missing. Run: npm run analyst:auth');
      error.code = 'ANALYST_TOKEN_MISSING';
      throw error;
    }
    const scope = this.tokens.youtube.scope || '';
    if (!hasRequiredReadOnlyScopes(scope) || hasWriteCapableScopes(scope)) {
      const error = new Error('Analyst OAuth token is not strictly read-only. Run: npm run analyst:auth');
      error.code = 'ANALYST_TOKEN_SCOPE_INVALID';
      throw error;
    }
  }

  getYouTubeAuth() {
    const youtube = this.credentials.youtube;
    const redirect = process.env.YOUTUBE_REDIRECT_URI || youtube.redirect_uris?.[0] || 'http://127.0.0.1';
    const oauth2Client = new google.auth.OAuth2(youtube.client_id, youtube.client_secret, redirect);
    oauth2Client.setCredentials(this.tokens.youtube);
    return oauth2Client;
  }

  getYouTubeClient() {
    const auth = this.getYouTubeAuth();
    return protectYouTubeClient(google.youtube({ version: 'v3', auth }));
  }

  getScopes() {
    return getYouTubeScopes();
  }
}

module.exports = { AnalystCredentialManager };
