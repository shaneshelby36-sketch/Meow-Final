'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, writeJsonAtomic } = require('./paths');

const COORD_FILENAME = 'bot-coordination.json';
/** Primary must refresh within this window or backup treats it as offline. */
const COORD_STALE_MS_DEFAULT = 90_000;
/** Backup only rescues after primary has been retrying an exit this long. */
const BACKUP_RESCUE_MIN_STUCK_MS_DEFAULT = 12_000;

function botRole() {
  const r = String(process.env.BOT_ROLE || 'primary').toLowerCase();
  return r === 'backup' ? 'backup' : 'primary';
}

function isPrimaryBotRole() {
  return botRole() === 'primary';
}

function isBackupBotRole() {
  return botRole() === 'backup';
}

function botInstanceId() {
  const id = process.env.BOT_INSTANCE_ID;
  if (id && String(id).trim()) return String(id).trim();
  return `bot-${process.pid}`;
}

function coordinationDir() {
  if (process.env.BOT_COORD_DIR) return path.resolve(process.env.BOT_COORD_DIR);
  return DATA_DIR;
}

function coordinationPath() {
  return path.join(coordinationDir(), COORD_FILENAME);
}

function coordStaleMs(config = {}) {
  const n = Number(config.botCoordStaleMs);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const env = Number(process.env.BOT_COORD_STALE_MS);
  if (Number.isFinite(env) && env > 0) return Math.round(env);
  return COORD_STALE_MS_DEFAULT;
}

function backupRescueMinStuckMs(config = {}) {
  const n = Number(config.botBackupRescueMinStuckMs);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  const env = Number(process.env.BOT_BACKUP_RESCUE_MIN_STUCK_MS);
  if (Number.isFinite(env) && env >= 0) return Math.round(env);
  return BACKUP_RESCUE_MIN_STUCK_MS_DEFAULT;
}

function loadCoordination() {
  try {
    const p = coordinationPath();
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function isCoordinationFresh(coord, now = Date.now(), config = {}) {
  if (!coord || !Number.isFinite(Number(coord.updatedAt))) return false;
  return now - Number(coord.updatedAt) <= coordStaleMs(config);
}

function serializeOpenTrade(trade) {
  if (!trade || String(trade.status) !== 'open') return null;
  const ticker = String(trade.ticker || '');
  if (!ticker) return null;
  return {
    id: trade.id,
    ticker,
    symbol: String(trade.symbol || '').toUpperCase(),
    side: String(trade.side || '').toLowerCase(),
    windowCloseTime: trade.windowCloseTime,
    pendingForceExit: trade.pendingForceExit ? String(trade.pendingForceExit) : null,
    pendingForceExitSince: Number(trade.pendingForceExitSince) || null,
    entryPriceCents: Number(trade.entryPriceCents),
    contracts: Number(trade.contracts),
    strategy: trade.strategy || 'model',
    mode: trade.mode || 'live',
    status: 'open',
  };
}

/** Primary publishes open inventory so backup can enforce one-bot-per-window. */
function publishPrimaryCoordination({ openTrades, instanceId, now = Date.now() } = {}) {
  if (!isPrimaryBotRole()) return null;
  const payload = {
    role: 'primary',
    instanceId: instanceId || botInstanceId(),
    updatedAt: now,
    openTrades: (openTrades || [])
      .map(serializeOpenTrade)
      .filter(Boolean),
  };
  writeJsonAtomic(coordinationPath(), payload);
  return payload;
}

function primaryOpenOnTicker(coord, ticker) {
  if (!coord || String(coord.role) !== 'primary') return null;
  const t = String(ticker || '');
  if (!t) return null;
  return (coord.openTrades || []).find(
    (row) => row && row.status === 'open' && String(row.ticker) === t
  ) || null;
}

function primaryOpenOnWindow(coord, { ticker, symbol, windowCloseTime } = {}) {
  const byTicker = primaryOpenOnTicker(coord, ticker);
  if (byTicker) return byTicker;
  const sym = String(symbol || '').toUpperCase();
  const close = Number(windowCloseTime);
  if (!sym || !Number.isFinite(close)) return null;
  return (
    (coord.openTrades || []).find((row) => {
      if (!row || row.status !== 'open') return false;
      if (String(row.symbol || '').toUpperCase() !== sym) return false;
      return Number(row.windowCloseTime) === close;
    }) || null
  );
}

/**
 * Backup must not enter when primary already holds this market/window.
 * Primary always allowed.
 */
function checkBackupEntryAllowed({
  coord,
  ticker,
  symbol,
  windowCloseTime,
  now = Date.now(),
  config = {},
} = {}) {
  if (!isBackupBotRole()) return { ok: true };
  if (!coord || !isCoordinationFresh(coord, now, config)) {
    return {
      ok: false,
      reason:
        'Backup bot: primary coordination missing or stale — entries blocked (rescue-only).',
    };
  }
  const held = primaryOpenOnWindow(coord, { ticker, symbol, windowCloseTime });
  if (held) {
    return {
      ok: false,
      reason:
        `Backup bot: primary holds ${held.symbol} ${String(held.side || '').toUpperCase()} ` +
        `on this window — no second entry.`,
      primaryTrade: held,
    };
  }
  return { ok: true };
}

/** Primary trades stuck on a force-retry exit — backup may sell to flatten. */
function backupRescueCandidates(coord, { now = Date.now(), config = {} } = {}) {
  if (!coord || String(coord.role) !== 'primary') return [];
  if (!isCoordinationFresh(coord, now, config)) return [];
  const minStuck = backupRescueMinStuckMs(config);
  return (coord.openTrades || []).filter((row) => {
    if (!row || row.status !== 'open') return false;
    const reason = row.pendingForceExit;
    if (!reason) return false;
    const since = Number(row.pendingForceExitSince);
    if (!Number.isFinite(since)) return minStuck <= 0;
    return now - since >= minStuck;
  });
}

function coordinationTradeStub(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticker: row.ticker,
    symbol: row.symbol,
    side: row.side,
    contracts: row.contracts,
    entryPriceCents: row.entryPriceCents,
    windowCloseTime: row.windowCloseTime,
    strategy: row.strategy || 'model',
    mode: row.mode || 'live',
    status: 'open',
    backupRescue: true,
  };
}

function noteBackupRescueAttempt({ tradeId, ticker, reason, ok, detail, now = Date.now() } = {}) {
  const coord = loadCoordination() || { role: 'primary', openTrades: [] };
  coord.lastBackupRescue = {
    at: now,
    instanceId: botInstanceId(),
    tradeId,
    ticker,
    reason,
    ok: !!ok,
    detail: detail ? String(detail) : '',
  };
  writeJsonAtomic(coordinationPath(), coord);
}

module.exports = {
  botRole,
  isPrimaryBotRole,
  isBackupBotRole,
  botInstanceId,
  coordinationPath,
  coordStaleMs,
  backupRescueMinStuckMs,
  loadCoordination,
  isCoordinationFresh,
  publishPrimaryCoordination,
  primaryOpenOnTicker,
  primaryOpenOnWindow,
  checkBackupEntryAllowed,
  backupRescueCandidates,
  coordinationTradeStub,
  noteBackupRescueAttempt,
  COORD_STALE_MS_DEFAULT,
  BACKUP_RESCUE_MIN_STUCK_MS_DEFAULT,
};
