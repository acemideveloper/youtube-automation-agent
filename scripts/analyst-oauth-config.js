#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const { URL } = require('url');

const root = path.resolve(__dirname, '..');
const credentialsPath = path.join(root, 'config', 'credentials.json');

function readExisting() {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (_error) {
    return {};
  }
}

function validateRedirect(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'http:') return 'Redirect URI must use http:// for the local desktop OAuth flow';
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return 'Redirect URI must point to localhost/127.0.0.1/::1';
    return true;
  } catch (_error) {
    return 'Enter a valid loopback redirect URI, for example http://127.0.0.1:8765/';
  }
}

async function main() {
  const existing = readExisting();
  const youtube = existing.youtube || {};
  const existingRedirect = youtube.redirect_uris?.[0] || 'http://127.0.0.1:8765/';

  console.log('\nAgentTube Analyst — Google OAuth client configuration');
  console.log('This step only stores the Desktop OAuth client locally.');
  console.log('It does NOT authorize YouTube and does NOT request channel permissions.\n');

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'clientId',
      message: 'Google OAuth Desktop client ID:',
      default: youtube.client_id || undefined,
      validate: value => String(value || '').trim() ? true : 'Client ID is required'
    },
    {
      type: 'password',
      name: 'clientSecret',
      message: youtube.client_secret
        ? 'Google OAuth client secret (leave blank to keep existing):'
        : 'Google OAuth client secret:',
      mask: '*'
    },
    {
      type: 'input',
      name: 'redirectUri',
      message: 'Loopback redirect URI:',
      default: existingRedirect,
      validate: validateRedirect
    }
  ]);

  const clientSecret = String(answers.clientSecret || '').trim() || youtube.client_secret;
  if (!clientSecret) throw new Error('Client secret is required');

  const redirect = new URL(String(answers.redirectUri).trim());
  if (!redirect.port) redirect.port = '8765';

  const next = {
    ...existing,
    youtube: {
      client_id: String(answers.clientId).trim(),
      client_secret: clientSecret,
      redirect_uris: [redirect.toString()]
    }
  };

  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(credentialsPath, 0o600); } catch (_error) {\n    // Some filesystems do not expose POSIX permissions.\n  }

  console.log(`\nSaved OAuth client configuration to ${credentialsPath}`);
  console.log('Next: npm run analyst:auth');
}

main().catch(error => {
  console.error(`\nAnalyst OAuth configuration failed: ${error.message}`);
  process.exitCode = 1;
});
