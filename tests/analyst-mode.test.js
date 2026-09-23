'use strict';

const assert = require('assert');
const {
  getYouTubeScopes,
  hasWriteCapableScopes,
  protectYouTubeClient,
  AnalystModeWriteBlockedError,
  analystHost,
  assertSafeAnalystBinding,
  hasRequiredReadOnlyScopes
} = require('../utils/analyst-mode');

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

withEnv({ ANALYST_MODE: undefined, ANALYST_INCLUDE_MONETARY: undefined }, () => {
  const scopes = getYouTubeScopes();
  assert(scopes.includes('https://www.googleapis.com/auth/youtube.readonly'));
  assert(scopes.includes('https://www.googleapis.com/auth/yt-analytics.readonly'));
  assert(!scopes.includes('https://www.googleapis.com/auth/youtube'));
  assert(!scopes.includes('https://www.googleapis.com/auth/youtube.upload'));
  assert(!scopes.includes('https://www.googleapis.com/auth/youtube.force-ssl'));
});

withEnv({ ANALYST_MODE: 'true', ANALYST_INCLUDE_MONETARY: 'true' }, () => {
  const scopes = getYouTubeScopes();
  assert(scopes.includes('https://www.googleapis.com/auth/yt-analytics-monetary.readonly'));
});


assert.strictEqual(hasRequiredReadOnlyScopes(''), false);
assert.strictEqual(hasRequiredReadOnlyScopes('https://www.googleapis.com/auth/youtube.readonly'), false);
assert.strictEqual(
  hasRequiredReadOnlyScopes('https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly'),
  true
);

assert.strictEqual(
  hasWriteCapableScopes('https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly'),
  false
);
assert.strictEqual(
  hasWriteCapableScopes('https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload'),
  true
);

withEnv({ ANALYST_MODE: 'true' }, () => {
  let listed = false;
  const fake = {
    videos: {
      list() { listed = true; return { data: { items: [] } }; },
      insert() { throw new Error('raw insert must never run'); },
      update() { throw new Error('raw update must never run'); }
    },
    thumbnails: {
      set() { throw new Error('raw thumbnail set must never run'); }
    },
    commentThreads: {
      list() { return { data: { items: [] } }; }
    }
  };

  const youtube = protectYouTubeClient(fake);
  youtube.videos.list({ part: 'snippet' });
  assert.strictEqual(listed, true);

  for (const invoke of [
    () => youtube.videos.insert({}),
    () => youtube.videos.update({}),
    () => youtube.thumbnails.set({})
  ]) {
    assert.throws(invoke, error => (
      error instanceof AnalystModeWriteBlockedError &&
      error.code === 'ANALYST_MODE_WRITE_BLOCKED'
    ));
  }
});


withEnv({ ANALYST_MODE: 'true', ANALYST_HOST: undefined, API_KEY: undefined }, () => {
  assert.strictEqual(analystHost(), '127.0.0.1');
  assert.strictEqual(assertSafeAnalystBinding(), '127.0.0.1');
});

withEnv({ ANALYST_MODE: 'true', ANALYST_HOST: '0.0.0.0', API_KEY: undefined }, () => {
  assert.throws(
    () => assertSafeAnalystBinding(),
    error => error && error.code === 'ANALYST_MODE_UNSAFE_BIND'
  );
});

withEnv({ ANALYST_MODE: 'true', ANALYST_HOST: '0.0.0.0', API_KEY: 'test-secret' }, () => {
  assert.strictEqual(assertSafeAnalystBinding(), '0.0.0.0');
});

withEnv({ ANALYST_MODE: 'false' }, () => {
  const fake = { videos: { insert() { return 'allowed'; } } };
  assert.strictEqual(protectYouTubeClient(fake).videos.insert(), 'allowed');
});

console.log('Analyst Mode safety tests passed');
