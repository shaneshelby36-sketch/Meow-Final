'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Where bot settings, ledger, calibration, and credentials are stored.
 *
 * Locally, `./data` survives reboots. On Render, the app directory is wiped on
 * every restart/deploy — attach a Persistent Disk (usually mounted at
 * `/var/data`) and set DATA_DIR, or leave DATA_DIR unset and we will use
 * `/var/data` automatically when that mount is writable.
 */
const DEFAULT_LOCAL_DIR = path.join(__dirname, 'data');
const RENDER_DISK_CANDIDATE = '/var/data';
const ON_RENDER = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);

function canUseDir(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  if (canUseDir(RENDER_DISK_CANDIDATE)) return path.resolve(RENDER_DISK_CANDIDATE);
  return DEFAULT_LOCAL_DIR;
}

const DATA_DIR = resolveDataDir();
// True when Render would wipe this path on restart (app dir, no persistent disk).
const DATA_DIR_EPHEMERAL = ON_RENDER && path.resolve(DATA_DIR) === path.resolve(DEFAULT_LOCAL_DIR);
const DATA_DIR_FROM_ENV = Boolean(process.env.DATA_DIR);

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'archive'), { recursive: true });
}

function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

/**
 * How long to keep rotated ledger/tracker/trade-log snapshots under
 * data/archive/. Default 14 days (matches a biweekly top-up cadence).
 * Set ARCHIVE_RETENTION_DAYS=0 to disable pruning.
 */
const ARCHIVE_RETENTION_DAYS = (() => {
  const raw = process.env.ARCHIVE_RETENTION_DAYS;
  if (raw === undefined || raw === '') return 14;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 14;
})();

/**
 * Deletes archive/*.json older than ARCHIVE_RETENTION_DAYS.
 * Live files (bot-ledger.json, trade-log.json, config, calibration) are never touched.
 */
function pruneArchiveFiles({ now = Date.now() } = {}) {
  if (!ARCHIVE_RETENTION_DAYS || ARCHIVE_RETENTION_DAYS <= 0) {
    return { deleted: 0, kept: 0, retentionDays: ARCHIVE_RETENTION_DAYS };
  }
  const archiveDir = path.join(DATA_DIR, 'archive');
  const cutoff = now - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let kept = 0;
  try {
    if (!fs.existsSync(archiveDir)) return { deleted: 0, kept: 0, retentionDays: ARCHIVE_RETENTION_DAYS };
    for (const name of fs.readdirSync(archiveDir)) {
      if (!name.endsWith('.json')) continue;
      const full = path.join(archiveDir, name);
      let mtime;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) {
        try {
          fs.unlinkSync(full);
          deleted += 1;
        } catch (err) {
          console.error(`[paths] failed to prune archive ${name}:`, err.message);
        }
      } else {
        kept += 1;
      }
    }
  } catch (err) {
    console.error('[paths] archive prune failed:', err.message);
  }
  if (deleted > 0) {
    console.log(
      `[paths] pruned ${deleted} archive file(s) older than ${ARCHIVE_RETENTION_DAYS}d (${kept} kept)`
    );
  }
  return { deleted, kept, retentionDays: ARCHIVE_RETENTION_DAYS };
}

/** Atomic JSON write so a crash mid-save cannot leave a half-written config. */
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = {
  DATA_DIR,
  DATA_DIR_EPHEMERAL,
  DATA_DIR_FROM_ENV,
  ARCHIVE_RETENTION_DAYS,
  ensureDataDir,
  dataPath,
  pruneArchiveFiles,
  writeJsonAtomic,
};
