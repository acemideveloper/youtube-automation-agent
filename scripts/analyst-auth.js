#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { google } = require('googleapis');
const { getYouTubeScopes, hasWriteCapableScopes, hasRequiredReadOnlyScopes } = require('../utils/analyst-mode');

const root = path.resolve(__dirname, '..');
const credentialsPath = path.join(root, 'config', 'credentials.json');
const tokensPath = path.join(root, 'config', 'analyst-tokens.json');

function resolveRedirect(credentials) {
  const configured = [process.env.YOUTUBE_REDIRECT_URI, ...(credentials.youtube?.redirect_uris || [])].filter(Boolean);
  for (const value of configured) {
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
        if (!url.port) url.port = '8765';
        return url;
      }
    } catch (_error) {
      // Ignore malformed or non-loopback redirect candidates.
    }
  }
  return new URL('http://127.0.0.1:8765/');
}

async function main() {
  if (!fs.existsSync(credentialsPath)) throw new Error('config/credentials.json is missing. Configure the Google OAuth client first.');
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  if (!credentials.youtube?.client_id || !credentials.youtube?.client_secret) throw new Error('YouTube OAuth client_id/client_secret are missing in config/credentials.json');
  const redirect = resolveRedirect(credentials);
  const oauth2Client = new google.auth.OAuth2(credentials.youtube.client_id, credentials.youtube.client_secret, redirect.toString());
  const scopes = getYouTubeScopes();
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });

  console.log('\nAgentTube Analyst — read-only YouTube authorization');
  console.log('Only these scopes will be requested:');
  scopes.forEach(scope => console.log(`  - ${scope}`));
  console.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);

  const tokens = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, redirect.toString());
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404); res.end('Not found'); return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error) { res.writeHead(400); res.end('Authorization failed. You may close this tab.'); server.close(); reject(new Error(error)); return; }
      if (!code) { res.writeHead(400); res.end('Authorization code missing.'); return; }
      try {
        const response = await oauth2Client.getToken(code);
        const value = response.tokens;
        value.scope ||= scopes.join(' ');
        if (!hasRequiredReadOnlyScopes(value.scope) || hasWriteCapableScopes(value.scope)) throw new Error('Google returned unexpected OAuth scopes; refusing to save token.');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>AgentTube Analyst authorized</h1><p>You can close this tab and return to the terminal.</p>');
        server.close();
        resolve(value);
      } catch (exchangeError) {
        res.writeHead(500); res.end('Token exchange failed.'); server.close(); reject(exchangeError);
      }
    });
    server.once('error', reject);
    server.listen(Number(redirect.port), redirect.hostname, () => console.log(`Waiting for Google callback on ${redirect.toString()}`));
  });

  fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
  fs.writeFileSync(tokensPath, JSON.stringify({ youtube: tokens }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tokensPath, 0o600); } catch (_error) {
    // Some filesystems do not expose POSIX permissions.
  }
  console.log(`\nSaved read-only analyst token to ${tokensPath}`);
}

main().catch(error => { console.error(`\nAnalyst authorization failed: ${error.message}`); process.exitCode = 1; });
