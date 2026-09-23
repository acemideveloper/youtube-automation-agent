'use strict';

const READ_ONLY_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly'
]);

const MONETARY_SCOPE = 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly';

const FULL_AGENTTUBE_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
]);

const WRITE_CAPABLE_SCOPES = new Set([
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtubepartner'
]);

const ALLOWED_YOUTUBE_METHODS = new Set([
  'list',
  'getRating'
]);

class AnalystModeWriteBlockedError extends Error {
  constructor(operation) {
    super(`Analyst Mode blocked YouTube write-capable operation: ${operation}`);
    this.name = 'AnalystModeWriteBlockedError';
    this.code = 'ANALYST_MODE_WRITE_BLOCKED';
    this.operation = operation;
    this.status = 403;
  }
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function isAnalystMode() {
  // Safe-by-default for the analyst fork. Explicitly set ANALYST_MODE=false
  // only when intentionally restoring full AgentTube production behavior.
  return envFlag('ANALYST_MODE', true);
}

function includeMonetaryAnalytics() {
  return envFlag('ANALYST_INCLUDE_MONETARY', false);
}


function analystHost() {
  return String(process.env.ANALYST_HOST || '127.0.0.1').trim() || '127.0.0.1';
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value);
}

function assertSafeAnalystBinding(host = analystHost()) {
  if (!isAnalystMode()) return host;
  if (isLoopbackHost(host)) return host;
  if (String(process.env.API_KEY || '').trim()) return host;
  const error = new Error(
    `Analyst Mode refuses to bind to non-loopback host "${host}" without API_KEY. ` +
    'Set ANALYST_HOST=127.0.0.1 or configure a strong API_KEY before exposing the dashboard.'
  );
  error.code = 'ANALYST_MODE_UNSAFE_BIND';
  error.status = 500;
  throw error;
}

function getYouTubeScopes() {
  if (!isAnalystMode()) return [...FULL_AGENTTUBE_SCOPES];
  const scopes = [...READ_ONLY_SCOPES];
  if (includeMonetaryAnalytics()) scopes.push(MONETARY_SCOPE);
  return scopes;
}

function parseGrantedScopes(scopeValue) {
  return String(scopeValue || '')
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean);
}


function hasRequiredReadOnlyScopes(scopeValue) {
  const granted = new Set(parseGrantedScopes(scopeValue));
  return READ_ONLY_SCOPES.every(scope => granted.has(scope));
}

function findWriteCapableScopes(scopeValue) {
  return parseGrantedScopes(scopeValue).filter(scope => WRITE_CAPABLE_SCOPES.has(scope));
}

function hasWriteCapableScopes(scopeValue) {
  return findWriteCapableScopes(scopeValue).length > 0;
}

function protectYouTubeClient(client) {
  if (!isAnalystMode() || !client || typeof client !== 'object') return client;

  const cache = new WeakMap();

  const wrap = (value, path = []) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (cache.has(value)) return cache.get(value);

    const proxy = new Proxy(value, {
      get(target, prop, receiver) {
        const next = Reflect.get(target, prop, receiver);
        const nextPath = [...path, String(prop)];

        if (typeof next === 'function') {
          const methodName = String(prop);
          if (ALLOWED_YOUTUBE_METHODS.has(methodName)) {
            return next.bind(target);
          }
          return function analystBlockedMethod() {
            throw new AnalystModeWriteBlockedError(nextPath.join('.'));
          };
        }

        if (next && typeof next === 'object') return wrap(next, nextPath);
        return next;
      }
    });

    cache.set(value, proxy);
    return proxy;
  };

  return wrap(client, ['youtube']);
}

module.exports = {
  READ_ONLY_SCOPES,
  MONETARY_SCOPE,
  FULL_AGENTTUBE_SCOPES,
  WRITE_CAPABLE_SCOPES,
  AnalystModeWriteBlockedError,
  envFlag,
  isAnalystMode,
  includeMonetaryAnalytics,
  analystHost,
  isLoopbackHost,
  assertSafeAnalystBinding,
  getYouTubeScopes,
  parseGrantedScopes,
  hasRequiredReadOnlyScopes,
  findWriteCapableScopes,
  hasWriteCapableScopes,
  protectYouTubeClient
};
