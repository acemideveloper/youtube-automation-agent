#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');

const envPath = path.join(root, '.env.example');
let env = fs.readFileSync(envPath, 'utf8');
if (!env.includes('# AgentTube Analyst sidecar')) {
  env += `\n# AgentTube Analyst sidecar\nANALYST_MODE=true\nANALYST_HOST=127.0.0.1\nANALYST_PORT=3456\nANALYST_INCLUDE_MONETARY=false\nANALYST_MAX_BACKFILL_VIDEOS=500\nANALYST_MEASUREMENT_BATCH=10\nANALYST_REQUEST_DELAY_MS=750\nANALYST_LIFETIME_REFRESH_HOURS=24\nANALYST_MIN_COHORT_SIZE=5\nANALYST_MIN_IMPRESSIONS=500\nANALYST_OUTPUT_LANGUAGE=tr\n# ANALYST_GEMINI_MODEL=gemini-3.7-flash\nANALYST_MAX_THUMBNAIL_BYTES=8388608\nANALYST_OUTCOME_WINDOW_DAYS=7\nANALYST_MAX_TRAFFIC_SHIFT=0.25\nANALYST_RETENTION_GUARDRAIL_DROP=0.10\nANALYST_CATALOG_CRON=15 5 * * *\nANALYST_MEASURE_CRON=0 */4 * * *\nANALYST_OUTCOME_CRON=30 6 * * *\nANALYST_UPDATE_CHECK_CRON=0 7 * * 1\nANALYST_OUTCOME_EVAL_BATCH=20\nANALYST_UPSTREAM_REPO=darkzOGx/youtube-automation-agent\nANALYST_UPSTREAM_BRANCH=master\nANALYST_UPSTREAM_BASE_SHA=941c3bee2b2c54f3f1a8e4dc9e034e061a5fed3a\n`;
  fs.writeFileSync(envPath, env);
}

const giPath = path.join(root, '.gitignore');
let gi = fs.readFileSync(giPath, 'utf8');
if (!gi.includes('config/analyst-tokens.json')) {
  gi = gi.replace('config/tokens.json\n', 'config/tokens.json\nconfig/analyst-tokens.json\n');
  fs.writeFileSync(giPath, gi);
}
