#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}

function modeIsPrivate(file) {
  if (process.platform === 'win32') return null;
  try {
    const mode = fs.statSync(file).mode & 0o777;
    return { ok: (mode & 0o077) === 0, mode: `0${mode.toString(8)}` };
  } catch (_) { return null; }
}

function runPreflight(target = path.resolve(__dirname, '..'), env = process.env) {
  const result = { target, checks: [], blockers: [], warnings: [] };
  const add = (id, ok, message, level = 'blocker') => {
    result.checks.push({ id, ok, message });
    if (!ok) (level === 'warning' ? result.warnings : result.blockers).push(message);
  };

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18, `Node ${process.versions.node}; required >=18`);

  const analystModePath = path.join(target, 'utils', 'analyst-mode.js');
  add('analyst-module', fs.existsSync(analystModePath), 'Analyst safety module is installed');
  if (!fs.existsSync(analystModePath)) return result;

  const previous = {
    ANALYST_MODE: process.env.ANALYST_MODE,
    ANALYST_HOST: process.env.ANALYST_HOST,
    API_KEY: process.env.API_KEY,
    ANALYST_INCLUDE_MONETARY: process.env.ANALYST_INCLUDE_MONETARY
  };
  Object.assign(process.env, {
    ANALYST_MODE: env.ANALYST_MODE ?? 'true',
    ANALYST_HOST: env.ANALYST_HOST ?? '127.0.0.1',
    API_KEY: env.API_KEY ?? '',
    ANALYST_INCLUDE_MONETARY: env.ANALYST_INCLUDE_MONETARY ?? 'false'
  });

  delete require.cache[require.resolve(analystModePath)];
  const safety = require(analystModePath);
  add('analyst-mode', safety.isAnalystMode(), 'ANALYST_MODE must be true');
  try {
    safety.assertSafeAnalystBinding();
    add('binding', true, `Dashboard binding is safe (${safety.analystHost()})`);
  } catch (error) {
    add('binding', false, error.message);
  }

  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  const credentialsPath = path.join(target, 'config', 'credentials.json');
  const tokensPath = path.join(target, 'config', 'analyst-tokens.json');
  const credentials = safeJson(credentialsPath);
  const tokens = safeJson(tokensPath);

  add('youtube-credentials', Boolean(credentials?.youtube?.client_id && credentials?.youtube?.client_secret),
    'Google/YouTube OAuth client credentials are configured');
  add('youtube-token', Boolean(tokens?.youtube), 'Read-only analyst OAuth token exists');

  if (tokens?.youtube) {
    const scope = tokens.youtube.scope || '';
    add('scope-metadata', Boolean(scope), 'OAuth token includes verifiable scope metadata');
    if (scope) {
      const writes = safety.findWriteCapableScopes(scope);
      add('read-only-scopes', safety.hasRequiredReadOnlyScopes(scope), 'Token includes required YouTube + Analytics read-only scopes');
      add('no-write-scopes', writes.length === 0,
        writes.length ? `Write-capable OAuth scopes detected: ${writes.join(', ')}` : 'No write-capable YouTube OAuth scope detected');
    }
  }

  for (const file of [credentialsPath, tokensPath]) {
    if (!fs.existsSync(file)) continue;
    const privacy = modeIsPrivate(file);
    if (privacy && !privacy.ok) {
      add(`permissions:${path.basename(file)}`, false,
        `${path.basename(file)} permissions are ${privacy.mode}; recommended 0600`, 'warning');
    } else if (privacy) {
      add(`permissions:${path.basename(file)}`, true, `${path.basename(file)} permissions are private (${privacy.mode})`);
    }
  }

  const hasGemini = Boolean(env.GEMINI_API_KEY || credentials?.gemini?.apiKey);
  add('gemini', hasGemini,
    hasGemini ? 'Gemini is configured for on-demand advice' : 'Gemini is not configured; analytics will work but AI advice stays disabled',
    'warning');

  const dbDir = path.join(target, 'data');
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    fs.accessSync(dbDir, fs.constants.R_OK | fs.constants.W_OK);
    add('data-dir', true, 'Local data directory is readable/writable');
  } catch (error) {
    add('data-dir', false, `Local data directory is not writable: ${error.message}`);
  }

  return result;
}

function print(result) {
  console.log('\nAgentTube Analyst preflight');
  console.log('='.repeat(42));
  for (const c of result.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.message}`);
  if (result.warnings.length) {
    console.log('\nWarnings:');
    for (const w of result.warnings) console.log(`- ${w}`);
  }
  if (result.blockers.length) {
    console.log('\nBlockers:');
    for (const b of result.blockers) console.log(`- ${b}`);
  }
  console.log(`\nResult: ${result.blockers.length ? 'NOT READY' : 'READY'}`);
}

if (require.main === module) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
  const result = runPreflight(target);
  print(result);
  process.exitCode = result.blockers.length ? 2 : 0;
}

module.exports = { runPreflight, modeIsPrivate };
