'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'data', 'youtube_automation.db');
const backupRoot = path.join(root, 'backups', 'analyst');

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function main() {
  await fsp.mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await fsp.access(source, fs.constants.R_OK);

  const target = path.join(backupRoot, `youtube_automation-${stamp()}.db`);
  const db = new sqlite3.Database(source, sqlite3.OPEN_READONLY);

  await new Promise((resolve, reject) => {
    const backup = db.backup(target);
    backup.step(-1, error => {
      if (error) return reject(error);
      backup.finish(finishError => finishError ? reject(finishError) : resolve());
    });
  }).finally(() => new Promise(resolve => db.close(() => resolve())));

  await fsp.chmod(target, 0o600).catch(() => {});
  const stat = await fsp.stat(target);
  console.log(JSON.stringify({
    success: true,
    backup: target,
    bytes: stat.size,
    secretsIncluded: false,
    note: 'OAuth tokens, credentials.json and .env are intentionally excluded.'
  }, null, 2));
}

main().catch(error => {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
