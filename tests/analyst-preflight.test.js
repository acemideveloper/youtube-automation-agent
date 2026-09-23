'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runPreflight } = require('../scripts/preflight-analyst-env');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttube-preflight-'));
fs.mkdirSync(path.join(tmp, 'utils'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'utils', 'analyst-mode.js'), path.join(tmp, 'utils', 'analyst-mode.js'));
fs.writeFileSync(path.join(tmp, 'config', 'credentials.json'), JSON.stringify({
  youtube: { client_id: 'x', client_secret: 'y', redirect_uris: ['http://127.0.0.1'] }
}), { mode: 0o600 });
fs.writeFileSync(path.join(tmp, 'config', 'analyst-tokens.json'), JSON.stringify({
  youtube: {
    scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly'
  }
}), { mode: 0o600 });

let result = runPreflight(tmp, { ANALYST_MODE: 'true', ANALYST_HOST: '127.0.0.1', API_KEY: '' });
assert.strictEqual(result.blockers.length, 0, result.blockers.join('\n'));
assert.ok(result.warnings.some(x => /Gemini is not configured/.test(x)));

fs.writeFileSync(path.join(tmp, 'config', 'analyst-tokens.json'), JSON.stringify({
  youtube: {
    scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.upload'
  }
}), { mode: 0o600 });
result = runPreflight(tmp, { ANALYST_MODE: 'true', ANALYST_HOST: '127.0.0.1', API_KEY: '', GEMINI_API_KEY: 'fake' });
assert.ok(result.blockers.some(x => /Write-capable OAuth scopes detected/.test(x)));

result = runPreflight(tmp, { ANALYST_MODE: 'true', ANALYST_HOST: '0.0.0.0', API_KEY: '' });
assert.ok(result.blockers.some(x => /refuses to bind/.test(x)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('Analyst preflight tests passed');
