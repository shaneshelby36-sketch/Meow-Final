'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath, ensureDataDir, writeJsonAtomic, pruneArchiveFiles } = require('./paths');
const { bookSideFromLegacy, marketStrikePrice, parseMarketCloseMs, normalizeMarketPrices, marketHasUsableTwoSidedQuote } = require('./kalshiClient');
const {
  windowConsensusSupportsSide,
  modelCalibrationEntryGate,
} = require('./engineCalibration');
const {
  isPrimaryBotRole,
  isBackupBotRole,
  botInstanceId,
  loadCoordination,
  publishPrimaryCoordination,
  checkBackupEntryAllowed,
  backupRescueCandidates,
  coordinationTradeStub,
  noteBackupRescueAttempt,
} = require('./botCoordination');

ensureDataDir();
pruneArchiveFiles();

const LEDGER_PATH = dataPath('bot-ledger.json');
const TRADE_LOG_PATH = dataPath('trade-log.json');
const SHADOW_BOOKS_PATH = dataPath('shadow-books.json');
const CONFIG_PATH = dataPath('bot-config.json');
const KALSHI_SERIES_CACHE_PATH = dataPath('kalshi-series-cache.json');
const CALIBRATION_PATH = dataPath('bot-calibration.json');
const LEGACY_CALIBRATION_PATH = dataPath('calibration.json');
const MODE_STATE_PATH = dataPath('bot-mode-state.json');
const RUN_STATE_PATH = dataPath('bot-run-state.json');
const ARCHIVE_DIR = dataPath('archive');
const ROTATION_PERIOD_MS = 12 * 60 * 60 * 1000; // 12 hours
const TRADE_LOG_MAX = 5000; // permanent history cap (oldest dropped only past this)
// Bump when shipping intentional default resets so stale bot-config.json
// doesn't keep old absolute stop/TP values after deploy.
const SETTINGS_DEFAULTS_VERSION = 85;

/** Min ms between Kalshi series list refreshes per KX*15M (live book only). */
const KALSHI_SERIES_REFRESH_MS = 12_000;
const KALSHI_SERIES_REFRESH_LIMITED_MS = 120_000;
const KALSHI_SERIES_STALE_CAP_MS = 45_000;
const KALSHI_SERIES_STALE_CAP_LIMITED_MS = 120_000;

// Minimum sample sizes before a bucket's win rate is worth trusting, per the
// standard rule of thumb: a handful of trades tells you almost nothing, a
// few hundred starts to actually mean something.
const CALIBRATION_GUIDANCE = {
  minToStartTrusting: 40,
  better: 100,
  best: 200,
};

/** Closed trades retained across paper reset so calibration isn't wiped to zero. */
const PAPER_RESET_KEEP_SAMPLES = CALIBRATION_GUIDANCE.minToStartTrusting;

function loadCalibration() {
  try {
    if (fs.existsSync(CALIBRATION_PATH)) {
      return JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
    }
    if (fs.existsSync(LEGACY_CALIBRATION_PATH)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CALIBRATION_PATH, 'utf8'));
      // Bot schema is { buckets: { "50": {trades,wins}, ... } }.
      if (legacy && legacy.buckets && typeof legacy.buckets === 'object') {
        saveCalibration(legacy);
        console.log('[bot] migrated trade calibration → bot-calibration.json');
        return legacy;
      }
    }
  } catch (err) {
    console.error('[bot] failed to load calibration data, starting fresh:', err.message);
  }
  return { buckets: {} };
}

function saveCalibration(calibration) {
  try {
    writeJsonAtomic(CALIBRATION_PATH, calibration);
  } catch (err) {
    console.error('[bot] failed to persist calibration data:', err.message);
  }
}

// Kalshi's rolling 15-minute crypto series tickers. Confirmed live as of this
// writing: BTC, ETH, SOL, XRP, DOGE, BNB, NEAR, HYPE. ZEC is deliberately NOT
// included here — Kalshi does not currently have a 15-minute market for it
// (confirmed via Kalshi's own market listings), so the bot can track ZEC's
// price/predictions via Coinbase but cannot place Kalshi trades on it.
// VERIFY the non-BTC tickers against docs.kalshi.com / the live /series list
// before trusting them in production — they follow BTC's confirmed
// KXBTC15M naming pattern, but weren't each individually confirmed against
// Kalshi's own spec character-for-character.
const SERIES_BY_SYMBOL = {
  BTC: 'KXBTC15M',
  ETH: 'KXETH15M',
  SOL: 'KXSOL15M',
  XRP: 'KXXRP15M',
  DOGE: 'KXDOGE15M',
  BNB: 'KXBNB15M',
  NEAR: 'KXNEAR15M',
  HYPE: 'KXHYPE15M',
};

/**
 * Pick the soonest-closing market that still has enough time left.
 * Prefer the current 15m window over a later one Kalshi may also list as open.
 */
function pickLiveOpenMarket(markets, nowMs = Date.now(), minMsLeft = 5000) {
  const live = (Array.isArray(markets) ? markets : [])
    .map((m) => {
      const closeRaw = m && (m.close_time != null ? m.close_time : m.expected_expiration_time);
      let closeMs = NaN;
      if (closeRaw != null && closeRaw !== '') {
        if (typeof closeRaw === 'number' && Number.isFinite(closeRaw)) {
          // Unix seconds vs ms.
          closeMs = closeRaw < 1e12 ? closeRaw * 1000 : closeRaw;
        } else {
          closeMs = new Date(closeRaw).getTime();
        }
      }
      return { m, closeMs };
    })
    .filter(({ closeMs }) => Number.isFinite(closeMs) && closeMs > nowMs + minMsLeft);
  if (!live.length) return null;
  live.sort((a, b) => a.closeMs - b.closeMs);
  return live[0].m;
}

// Opt-in coins historically: DOGE / NEAR. Now every coin is gated by autoTradeSymbols.
const OPTIONAL_TRADE_SYMBOLS = new Set(['DOGE', 'NEAR']);

/** Default AUTO universe — BTC / ETH. */
const DEFAULT_AUTO_TRADE_SYMBOLS = ['BTC', 'ETH'];

/** Default opt-outs when config knobs are unset (export for tests / legacy). */
const DISABLED_TRADE_SYMBOLS = new Set(
  Object.keys(SERIES_BY_SYMBOL).filter((s) => !DEFAULT_AUTO_TRADE_SYMBOLS.includes(s))
);

function isOnOffEnabled(value, defaultOn = false) {
  if (value == null || value === '') return defaultOn;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const s = String(value).toLowerCase();
  if (s === 'on' || s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'off' || s === 'false' || s === 'no' || s === '0') return false;
  return defaultOn;
}

function parseOnOffField(v, defaultOn = false) {
  if (v === true || v === 1) return 'on';
  if (v === false || v === 0) return 'off';
  if (v == null || v === '') return defaultOn ? 'on' : 'off';
  const s = String(v).toLowerCase();
  if (s === 'on' || s === 'true' || s === 'yes') return 'on';
  if (s === 'off' || s === 'false' || s === 'no') return 'off';
  return null;
}

/** Normalize autoTradeSymbols from array / CSV / legacy tradeNear+tradeDoge. */
function resolveAutoTradeSymbols(config = null) {
  const raw = config && config.autoTradeSymbols;
  let list = null;
  if (Array.isArray(raw)) {
    list = raw.map((s) => String(s || '').toUpperCase()).filter((s) => SERIES_BY_SYMBOL[s]);
  } else if (typeof raw === 'string' && raw.trim()) {
    list = raw
      .split(/[,|\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => SERIES_BY_SYMBOL[s]);
  }
  if (list && list.length) {
    // Deduplicate, stable SERIES order
    const set = new Set(list);
    return Object.keys(SERIES_BY_SYMBOL).filter((s) => set.has(s));
  }
  // Legacy: all mapped coins except DOGE/NEAR unless toggled on
  if (config && (config.tradeDoge != null || config.tradeNear != null) && raw == null) {
    return Object.keys(SERIES_BY_SYMBOL).filter((s) => {
      if (s === 'DOGE') return isOnOffEnabled(config.tradeDoge, false);
      if (s === 'NEAR') return isOnOffEnabled(config.tradeNear, false);
      return true;
    });
  }
  return DEFAULT_AUTO_TRADE_SYMBOLS.slice();
}

function isKalshiTradeEnabled(symbol, config = null) {
  const sym = String(symbol || '').toUpperCase();
  if (!SERIES_BY_SYMBOL[sym]) return false;
  return resolveAutoTradeSymbols(config).includes(sym);
}

function tradeableKalshiSymbols(config = null) {
  return resolveAutoTradeSymbols(config);
}

/**
 * Symbols that need live Kalshi strike/clock GETs.
 * Tradeable list + any open inventory (so a held coin still gets a real target
 * after you remove it from AUTO). Not the full SERIES map — that was 429 fuel.
 */
function symbolsNeedingKalshiTargets({ config = null, openTrades = [] } = {}) {
  const out = new Set();
  for (const s of tradeableKalshiSymbols(config)) {
    if (SERIES_BY_SYMBOL[s]) out.add(s);
  }
  const pinned = String((config && config.symbol) || '').toUpperCase();
  if (pinned && pinned !== 'AUTO' && SERIES_BY_SYMBOL[pinned]) out.add(pinned);
  for (const t of Array.isArray(openTrades) ? openTrades : []) {
    if (!t || String(t.status || 'open').toLowerCase() !== 'open') continue;
    const s = String(t.symbol || '').toUpperCase();
    if (SERIES_BY_SYMBOL[s]) out.add(s);
  }
  return Object.keys(SERIES_BY_SYMBOL).filter((s) => out.has(s));
}

/**
 * Symbols the prediction engine should compute each cycle.
 * Same as Kalshi-target set, plus BTC when any alt is active (cross-check
 * reference — not a Kalshi poll by itself).
 */
function symbolsNeedingEngineCompute({ config = null, openTrades = [] } = {}) {
  const base = symbolsNeedingKalshiTargets({ config, openTrades });
  const set = new Set(base);
  if ([...set].some((s) => s !== 'BTC') && SERIES_BY_SYMBOL.BTC) {
    set.add('BTC');
  }
  return Object.keys(SERIES_BY_SYMBOL).filter((s) => set.has(s));
}

/**
 * Named MODEL paper setups. Apply one from the dashboard instead of guessing knobs.
 * The active setup is the live book; the others run as silent shadow paper books
 * on the same quotes. Scoreboard also shows a what-if on saved fills (not a replay).
 */
const MODEL_SETUPS = [
  {
    id: 'core',
    recommended: true,
    label: 'Core BTC / ETH',
    why: 'BTC + ETH, one slot, max 88¢, conf 55%, stall 4s, BE chase 20s (only if lean decaying), stagnation 60s (no max-loss cliff).',
    autoTradeSymbols: 'BTC,ETH',
    modelMinConfidence: 55,
    modelEntryLiveLeanMarginPct: 3,
    modelBankGreenCents: 11,
    modelMinTpCents: 11,
    modelNearTargetBankCents: 8,
    modelMaxEntryCents: 88,
    maxOpenPositions: 1,
    modelLowAskMinConfidence: 0,
    modelConfirmCrossCents: 0,
    modelMomentumStallSeconds: 4,
    modelBeChaseSeconds: 20,
    modelStagnationSeconds: 60,
    modelRapidAdverseCents: 0,
  },
  {
    id: 'btc-sol',
    label: 'BTC + SOL only',
    why: 'Fewest names, still enough hits. Use if BNB is chopping.',
    autoTradeSymbols: 'BTC,SOL',
    modelMinConfidence: 55,
    modelEntryLiveLeanMarginPct: 3,
    modelBankGreenCents: 7,
    modelMinTpCents: 7,
    maxOpenPositions: 2,
    modelConfirmCrossCents: 0,
  },
  {
    id: 'tight',
    label: 'Tight (fewer, cleaner)',
    why: 'Higher conf + one slot + faster dump cut. Fewer trades, smaller chance of stacked red.',
    autoTradeSymbols: 'BTC,BNB,SOL',
    modelMinConfidence: 66,
    modelEntryLiveLeanMarginPct: 5,
    modelBankGreenCents: 7,
    modelMinTpCents: 7,
    maxOpenPositions: 1,
    modelConfirmCrossCents: 0,
    modelDumpPullbackCents: 2,
    modelFastRedCents: 2,
    modelMinEntryCents: 62,
  },
  {
    id: 'majors',
    label: 'Majors + ETH',
    why: 'More hits if Core feels too quiet. ETH was the overnight drain — only run this to compare.',
    autoTradeSymbols: 'BTC,BNB,SOL,ETH',
    modelMinConfidence: 62,
    modelEntryLiveLeanMarginPct: 4,
    modelBankGreenCents: 7,
    modelMinTpCents: 7,
    maxOpenPositions: 2,
    modelConfirmCrossCents: 0,
  },
  {
    id: 'hits',
    label: 'More hits (~55% WR neighborhood)',
    why: 'Conf 55 — closest to the two-day ~55% WR tape. 3 slots, slightly easier live favor. Compare remaining cash vs Core.',
    autoTradeSymbols: 'BTC,BNB,SOL',
    modelMinConfidence: 55,
    modelEntryLiveLeanMarginPct: 3,
    modelBankGreenCents: 6,
    modelMinTpCents: 6,
    maxOpenPositions: 3,
    modelConfirmCrossCents: 0,
    modelFastRedCents: 2,
  },
  {
    id: 'cut6',
    label: 'Faster stagnation (45s)',
    why: 'Core coins/conf with quicker stagnation exit (45s vs 60s). Losses from mushy thesis, not a −N¢ price cliff.',
    autoTradeSymbols: 'BTC,BNB,SOL',
    modelMinConfidence: 55,
    modelEntryLiveLeanMarginPct: 3,
    modelBankGreenCents: 7,
    modelMinTpCents: 7,
    maxOpenPositions: 2,
    modelConfirmCrossCents: 0,
    modelStagnationSeconds: 45,
    modelDumpPullbackCents: 2,
    modelFastRedCents: 2,
    modelLeanStopBarrierCents: 50,
  },
  {
    id: 'hold',
    label: 'Hold small red (dump 5 / fast-red 5)',
    why: 'Core coins/conf, but slower scratches. Tests if the ~55% WR run was from holding −2–4¢ instead of cutting.',
    autoTradeSymbols: 'BTC,BNB,SOL',
    modelMinConfidence: 55,
    modelEntryLiveLeanMarginPct: 3,
    modelBankGreenCents: 7,
    modelMinTpCents: 7,
    maxOpenPositions: 2,
    modelConfirmCrossCents: 0,
    modelDumpPullbackCents: 5,
    modelFastRedCents: 5,
  },
];

function summarizeClosedModelTrades(trades) {
  let pnlCents = 0;
  let wins = 0;
  let losses = 0;
  let be = 0;
  let worstCents = 0;
  let n = 0;
  for (const t of trades || []) {
    if (!t || String(t.status) !== 'closed') continue;
    if (t.strategy && String(t.strategy).toLowerCase() !== 'model') continue;
    const p = Number(t.pnlCents);
    if (!Number.isFinite(p)) continue;
    n += 1;
    pnlCents += p;
    if (p > 0) wins += 1;
    else if (p < 0) {
      losses += 1;
      if (p < worstCents) worstCents = p;
    } else be += 1;
  }
  return {
    trades: n,
    wins,
    losses,
    be,
    pnlCents,
    worstCents,
    winRatePct: n ? +((wins / n) * 100).toFixed(1) : null,
  };
}

function filterTradesForModelSetup(trades, setup = {}) {
  const coins = new Set(
    String(setup.autoTradeSymbols || '')
      .split(/[,|\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
  const minConf = Number(setup.modelMinConfidence);
  return (trades || []).filter((t) => {
    if (!t || String(t.status) !== 'closed') return false;
    if (t.strategy && String(t.strategy).toLowerCase() !== 'model') return false;
    const sym = String(t.symbol || '').toUpperCase();
    if (coins.size && !coins.has(sym)) return false;
    const conf = Number(t.engineConfidence);
    if (Number.isFinite(minConf) && Number.isFinite(conf) && conf < minConf) return false;
    return true;
  });
}

function scoreModelSetupsAgainstLog(trades, setups = MODEL_SETUPS) {
  const all = summarizeClosedModelTrades(trades);
  return (setups || []).map((setup) => ({
    ...setup,
    score: summarizeClosedModelTrades(filterTradesForModelSetup(trades, setup)),
  })).concat([
    {
      id: 'all-logged',
      label: 'All logged MODEL trades',
      why: 'Baseline — every coin that actually filled.',
      autoTradeSymbols: Object.keys(SERIES_BY_SYMBOL).join(','),
      recommended: false,
      score: all,
    },
  ]);
}

function modelSetupById(id) {
  const key = String(id || '').toLowerCase();
  return MODEL_SETUPS.find((s) => s.id === key) || null;
}

function modelSetupConfigPatch(setup) {
  if (!setup) return {};
  const patch = {
    symbol: 'AUTO',
    strategyMode: 'model',
    autoTradeSymbols: setup.autoTradeSymbols,
    modelMinConfidence: setup.modelMinConfidence,
    modelEntryLiveLeanMarginPct: setup.modelEntryLiveLeanMarginPct,
    modelBankGreenCents: setup.modelBankGreenCents,
    modelMinTpCents: setup.modelMinTpCents,
    maxOpenPositions: setup.maxOpenPositions,
    modelConfirmCrossCents: setup.modelConfirmCrossCents,
    modelMinEntryCents:
      setup.modelMinEntryCents != null ? setup.modelMinEntryCents : MODEL_MIN_ENTRY_DEFAULT_CENTS,
    modelDumpPullbackCents:
      setup.modelDumpPullbackCents != null ? setup.modelDumpPullbackCents : MODEL_DUMP_PULLBACK_CENTS_DEFAULT,
    modelFastRedCents:
      setup.modelFastRedCents != null ? setup.modelFastRedCents : MODEL_FAST_RED_CENTS_DEFAULT,
    modelLeanStopBarrierCents:
      setup.modelLeanStopBarrierCents != null
        ? setup.modelLeanStopBarrierCents
        : MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT,
    activeSetupId: setup.id,
  };
  if (setup.modelMaxEntryCents != null) patch.modelMaxEntryCents = setup.modelMaxEntryCents;
  if (setup.modelLowAskMinConfidence != null) {
    patch.modelLowAskMinConfidence = setup.modelLowAskMinConfidence;
  }
  if (setup.modelMomentumStallSeconds != null) {
    patch.modelMomentumStallSeconds = setup.modelMomentumStallSeconds;
  }
  if (setup.modelBeChaseSeconds != null) {
    patch.modelBeChaseSeconds = setup.modelBeChaseSeconds;
  }
  if (setup.modelStagnationSeconds != null) {
    patch.modelStagnationSeconds = setup.modelStagnationSeconds;
  }
  if (setup.modelRapidAdverseCents != null) {
    patch.modelRapidAdverseCents = setup.modelRapidAdverseCents;
  }
  return patch;
}

// Rough Kalshi 15m crypto liquidity preference (higher = usually tighter books).
// Used to break ties / prefer fillable markets over thin XRP-style books.
const LIQUIDITY_PRIORITY_BY_SYMBOL = {
  BTC: 50,
  ETH: 40,
  SOL: 30,
  BNB: 20,
  NEAR: 15,
  HYPE: 12,
  XRP: 10,
  DOGE: 5,
};

function liquidityPriority(symbol) {
  return LIQUIDITY_PRIORITY_BY_SYMBOL[String(symbol || '').toUpperCase()] || 0;
}

/**
 * Settle AUTO: asks at/above this are demoted so mid-band names get tried
 * before nearly-certain 95¢+ tickets on the usual majors.
 */
function settleRichAskFloorCents(config = {}) {
  const n = Number(config.settleRichAskFloorCents);
  if (Number.isFinite(n) && n >= 50 && n <= 99) return Math.round(n);
  return 95;
}

/** Ask component of settle rankScore (higher = better). Rich asks get −200. */
function settleRankAskScore(priceCents, { richFloorCents = 95, usedLateBand = false } = {}) {
  const p = Math.round(Number(priceCents));
  if (!Number.isFinite(p)) return -999;
  const bandBonus = usedLateBand ? 0 : 100;
  const askPart = p >= richFloorCents ? p - 200 : p;
  return askPart + bandBonus;
}

/**
 * Minimum cents of upside to settlement (100 − ask) required to open a settle
 * trade. Default 6¢ so 90–94¢ hold-to-settle tickets are allowed. 0 = off.
 * Still blocks 95¢+ dead R:R tickets via rich floor.
 */
function settleMinUpsideCents(config = {}) {
  const explicit = Number(config.settleMinUpsideCents);
  if (Number.isFinite(explicit) && explicit <= 0) return 0;
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(50, Math.round(explicit));
  return 6;
}

/** Settle-mode entry band (default 80–94¢). Clamped to 1–99; swaps if inverted. */
function settleEntryBand(config = {}) {
  let min = Number(config.settleEntryMinCents);
  let max = Number(config.settleEntryMaxCents);
  if (!Number.isFinite(min)) min = 80;
  // Default 94: hold-to-settle tier (≥90¢) is allowed through 94¢.
  if (!Number.isFinite(max)) max = 94;
  min = Math.max(1, Math.min(99, Math.round(min)));
  max = Math.max(1, Math.min(99, Math.round(max)));
  if (max < min) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  return { min, max };
}

/**
 * NO-side settle floor (default 80¢). Matches primary min when min is 80;
 * if YES min is raised above 80, NO can still use this lower floor (capped at band.min).
 */
function settleNoEntryMinCents(config = {}) {
  const band = settleEntryBand(config);
  let n = Number(config.settleNoEntryMinCents);
  if (!Number.isFinite(n)) n = 80;
  n = Math.max(1, Math.min(99, Math.round(n)));
  return Math.min(n, band.min);
}

/** Effective min/max for a settle side (YES uses primary/late; NO may start at 80¢). */
function settleSideEntryBand(config = {}, side = 'yes', minutesRemaining = null) {
  const eff =
    minutesRemaining == null
      ? { ...settleEntryBand(config), late: false }
      : settleEffectiveEntryBand(config, minutesRemaining);
  if (String(side || '').toLowerCase() === 'no') {
    const noMin = settleNoEntryMinCents(config);
    return {
      min: Math.min(eff.min, noMin),
      max: eff.max,
      late: !!eff.late,
    };
  }
  return { min: eff.min, max: eff.max, late: !!eff.late };
}

/** Minutes left at/under which settle may dip below the primary min (0 = off). Default 2.5. */
function settleLateEntryMinutes(config = {}) {
  const m = Number(config.settleLateEntryMinutes);
  if (Number.isFinite(m) && m <= 0) return 0;
  if (Number.isFinite(m) && m > 0) return m;
  return 2.5;
}

/** Floor ask when late fallback is active (default 70¢). Never above primary min. */
function settleLateEntryMinCents(config = {}) {
  const band = settleEntryBand(config);
  let n = Number(config.settleLateEntryMinCents);
  if (!Number.isFinite(n)) n = 70;
  n = Math.max(1, Math.min(99, Math.round(n)));
  return Math.min(n, band.min);
}

/**
 * Effective settle band for this moment. Late fallback expands the floor only when
 * minutesRemaining ≤ settleLateEntryMinutes and no primary-band print is required
 * by the caller — here we just report the expanded range when the clock qualifies.
 */
function settleEffectiveEntryBand(config = {}, minutesRemaining = Infinity) {
  const band = settleEntryBand(config);
  const lateMins = settleLateEntryMinutes(config);
  const lateFloor = settleLateEntryMinCents(config);
  const mins = Number(minutesRemaining);
  const late =
    lateMins > 0 &&
    Number.isFinite(mins) &&
    mins <= lateMins &&
    lateFloor < band.min;
  return {
    min: late ? lateFloor : band.min,
    max: band.max,
    primaryMin: band.min,
    late,
  };
}

function isSettleEntryPriceCents(priceCents, config = {}, minutesRemaining = null, side = null) {
  const band = settleSideEntryBand(config, side || 'yes', minutesRemaining);
  const p = Number(priceCents);
  return Number.isFinite(p) && p >= band.min && p <= band.max;
}

function isSettleStrategyMode(config = {}) {
  return String(config.strategyMode || '').toLowerCase() === 'settle';
}

function isSettleTrade(trade) {
  return trade && String(trade.strategy || '').toLowerCase() === 'settle';
}

function isModelStrategyMode(config = {}) {
  return String(config.strategyMode || '').toLowerCase() === 'model';
}

function isModelTrade(trade) {
  return trade && String(trade.strategy || '').toLowerCase() === 'model';
}

/** Active engine window for Model tab by minutes left in the 15m Kalshi session. */
function pickModelWindowKey(minutesRemaining) {
  const m = Number(minutesRemaining);
  if (!Number.isFinite(m)) return 'w5';
  if (m > 10) return 'w5';
  if (m > 5) return 'w10';
  // Final 5m: use the long-horizon profile (was bouncing back to noisy w5).
  return 'w15';
}

/** Live probability lean first; frozen tracking lock only breaks ties / mush. */
function modelWindowDirection(window) {
  if (!window) return null;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  if (Number.isFinite(up) && Number.isFinite(down)) {
    // Need a clear live lead — 49/50 mush must not flip direction and knife reds.
    const margin = MODEL_SOFT_LEAN_MARGIN_DEFAULT;
    if (up >= down + margin) return 'UP';
    if (down >= up + margin) return 'DOWN';
  }
  const locked = window.tracking && window.tracking.predictedDirection;
  if (locked === 'UP' || locked === 'DOWN') return locked;
  if (Number.isFinite(up) && Number.isFinite(down)) {
    if (up > down) return 'UP';
    if (down > up) return 'DOWN';
  }
  if (Number.isFinite(up)) return up >= 50 ? 'UP' : 'DOWN';
  return null;
}

/**
 * Pick the Model tab's active window + direction for this minutes-left slice.
 * Returns { key, window, direction } or null.
 */
function pickModelWindow(assetPrediction, minutesRemaining) {
  const windows = assetPrediction && assetPrediction.windows;
  if (!windows || typeof windows !== 'object') return null;
  const key = pickModelWindowKey(minutesRemaining);
  const window = windows[key] || null;
  if (!window) return null;
  return { key, window, direction: modelWindowDirection(window) };
}

/** True when engine direction disagrees with the held Kalshi side. */
function modelDirectionAgainstHeld(direction, side) {
  if (direction !== 'UP' && direction !== 'DOWN') return false;
  return (side === 'yes' && direction === 'DOWN') || (side === 'no' && direction === 'UP');
}

/** Fade the model: buy the opposite Kalshi side of the locked lean. Default off. */
function isModelInvertSide(config = {}) {
  return isOnOffEnabled(config && config.modelInvertSide, false);
}

function modelSignalSideFromDirection(direction) {
  return direction === 'UP' ? 'yes' : direction === 'DOWN' ? 'no' : null;
}

function flipKalshiSide(side) {
  if (side === 'yes') return 'no';
  if (side === 'no') return 'yes';
  return side;
}

/** How far the lean/current side has dropped from its entry ask (fade TP). */
function modelSignalDropCents(signalEntryCents, signalBidCents) {
  const entry = Number(signalEntryCents);
  const bid = Number(signalBidCents);
  if (!Number.isFinite(entry) || !Number.isFinite(bid)) return 0;
  return Math.max(0, Math.round(entry - bid));
}

/** Live lean against held side — one point so red exits fire preemptively. */
const MODEL_LIVE_LEAN_MARGIN_DEFAULT = 1;
/** Cash out either contract when the live model becomes this one-sided. */
const MODEL_EXTREME_LIVE_LEAN_EXIT_PCT_DEFAULT = 96;
/** Lean decay cut: must have peaked at/above this (e.g. 99/1). */
const MODEL_LEAN_DECAY_PEAK_MIN_DEFAULT = 90;
/** Cut when held-side lean falls to/below this (~85/15). */
const MODEL_LEAN_DECAY_FLOOR_DEFAULT = 85;
/** Or peak − current ≥ this many pts (99→85). */
const MODEL_LEAN_DECAY_DROP_PTS_DEFAULT = 14;
/** Lean bounce this many pts off trough = recovery (reset timer). */
const MODEL_LEAN_DECAY_RECOVERY_PTS_DEFAULT = 3;
/** In decay zone with no recovery this long → cut. */
const MODEL_LEAN_DECAY_STALL_MS_DEFAULT = 6_000;
/** Stuck force-exit (TP/BE miss): escalate IOC attempts after this long. */
const FORCE_EXIT_ESCALATE_MS_DEFAULT = 8_000;
/** Entry: live lean must favor the locked side by at least this many pts (0 = any lead). */
const MODEL_ENTRY_LIVE_LEAN_MARGIN_DEFAULT = 2;
/** Entry: held-side live prob must be at least this % (0 = off). */
const MODEL_MIN_ENTRY_LEAN_PCT_DEFAULT = 65;
/** Don't early-exit a Model hold until it's been open at least this long. */
const MODEL_MIN_HOLD_MS_DEFAULT = 4_000;
/** After Model BE/TP, sit out that coin this long before rebuy. */
const MODEL_POST_EXIT_COOLDOWN_MS_DEFAULT = 45_000;
/** After any model close, block ALL new entries this long (regime cool-down). */
const MODEL_GLOBAL_POST_EXIT_COOLDOWN_MS_DEFAULT = 20_000;
/** After MODEL lean/dip stop (red), longer sit-out — stops knife-catch churn. */
const MODEL_POST_LEAN_STOP_COOLDOWN_MS_DEFAULT = 120_000;
/** After open grace: when model is not firm, wait this long then BE/cut (avoid ask→bid flicker). */
const MODEL_LEAN_AGAINST_BE_MS_DEFAULT = 2_000;
/** First N ms after open: only hard lean-turning exits (ignore soft + ask/bid haircut). */
const MODEL_OPEN_GRACE_MS_DEFAULT = 4_000;
/** Lean-exit / momentum TP floor — no micro-banks under this. */
const MODEL_MIN_TP_CENTS_DEFAULT = 11;
/** Unconditional bank once this many ¢ green (don't wait for a stall). */
const MODEL_BANK_GREEN_CENTS_DEFAULT = 11;
/** Peak green at/above this → stall-bank at live bid even if full TP is higher. */
const MODEL_NEAR_TARGET_BANK_CENTS_DEFAULT = 8;
/** Start trailing / allow stall-TP once at least this many ¢ green. */
const MODEL_TRAIL_ARM_CENTS_DEFAULT = 3;
/** Held bid at/above this → bank immediately (don't sit 96→100). */
const MODEL_RICH_BANK_CENTS_DEFAULT = 96;
/** Still red after this long, even if lean is with us → only stop if pace → ≤50. */
const MODEL_RED_GIVEUP_MS_DEFAULT = 8_000;
/** Soft lean + still green: bank after this (preemptive — don't wait for the dump). */
const MODEL_SOFT_BANK_MS_DEFAULT = 0;
/** Kalshi bid slide from peak — cut before engine probs catch up (predict the dump). */
const MODEL_DUMP_PULLBACK_CENTS_DEFAULT = 3;
/** Underwater this many ¢ → candidate for stop only if also on pace toward ≤50. */
const MODEL_FAST_RED_CENTS_DEFAULT = 2;
/** Min |netDominance| when trend is weakening before signalScore counts as turning. 0 = off. */
const MODEL_SIGNAL_DOMINANCE_MIN_DEFAULT = 0;
/** Min drop in held-side live prob (pts) from entry before model exit fires. */
const MODEL_PROB_DRIFT_PTS_DEFAULT = 3;
/** Min hold before fast-red (0 = cut same tick if bid gaps on fill). */
const MODEL_FAST_RED_MIN_HOLD_MS_DEFAULT = 0;
/** Max ask−bid spread allowed at entry — blocks absurd gaps, allows thin 15m books. */
const MODEL_MAX_ENTRY_SPREAD_CENTS_DEFAULT = 8;
/** Red lean-stop barrier: stop if bid ≤ this or pace projects here. */
const MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT = 55;
/** Horizon used to project bid pace toward the barrier (ms). */
const MODEL_LEAN_STOP_PACE_HORIZON_MS_DEFAULT = 90_000;
/** Need at least this long of red sample before trusting pace. */
const MODEL_LEAN_STOP_PACE_MIN_SAMPLE_MS_DEFAULT = 8_000;
/**
 * Pace lean-stop only after this much ¢ adverse (or ~35% of room to hard floor).
 * Stops mid-ticket cuts like 84→79 while the hard floor is still 55.
 */
const MODEL_LEAN_STOP_MIN_ADVERSE_CENTS_DEFAULT = 8;
/** Default % of (entry − floor) required before pace projection can lean-stop. */
const MODEL_LEAN_STOP_PACE_DRAWDOWN_PCT_DEFAULT = 35;
/**
 * Pace projection only arms once bid is within this many ¢ of the hard floor.
 * Absolute hit (bid ≤ floor) still stops immediately. Default 8 → arm at ≤63 when floor=55.
 */
const MODEL_LEAN_STOP_PACE_ARM_CENTS_DEFAULT = 8;
/**
 * Progress/stagnation: after this many seconds with no meaningful peak green,
 * exit only if the model is also deteriorating (time is context, not a timer cut).
 * 0 = off.
 */
const MODEL_STAGNATION_SECONDS_DEFAULT = 60;
/** Peak must reach at least this many ¢ above entry to count as progress (matches trail arm). */
const MODEL_STAGNATION_MIN_PROGRESS_CENTS_DEFAULT = 3;
/**
 * Rapid adverse: true ¢ below entry (beyond spread haircut) at/above this + model
 * against → cut immediately (after open grace). Caps cliffs like 81→20. 0 = off.
 */
const MODEL_RAPID_ADVERSE_CENTS_DEFAULT = 0;
/** After crossing breakeven, must reach trail-arm (+3¢) within this many seconds or scratch BE. 0 = off. */
const MODEL_BE_CHASE_SECONDS_DEFAULT = 20;
/** Near settle: close unless losing more than this many ¢ (50 = ride only big losers). */
const MODEL_SETTLE_CLOSE_UNLESS_LOSS_CENTS_DEFAULT = 50;
/**
 * Final barrier (minutes left). Inside this window, exit unless high-possibility
 * extend. Default 2 — was 0 (off), which let firm holds ride into SETTLED losses.
 */
const MODEL_LATE_BARRIER_MINUTES_DEFAULT = 2;
/**
 * Start near-settle cash-outs this many minutes before window end.
 * Default 2.5 — bank flat/green/small-red instead of gambling settlement.
 */
const MODEL_SETTLE_CLOSE_MINUTES_DEFAULT = 2.5;
/** Last N minutes: always sell (never wait for Kalshi 0/100). */
const MODEL_PRE_CLOSE_FORCE_MINUTES_DEFAULT = 1;
/** Confidence required to extend a hold into/through the final barrier. */
const MODEL_LATE_EXTEND_MIN_CONFIDENCE_DEFAULT = 78;
/** After trail is armed, TP if bid sits at peak this long without a new high (ms). */
const MODEL_MOMENTUM_STALL_MS_DEFAULT = 4_000;
/** After trail arm, TP if bid pulls back this many ¢ from peak. */
const MODEL_MOMENTUM_PULLBACK_CENTS_DEFAULT = 2;
/** Model entries below this ask use half stake. 0 = off (full stake at all asks). */
const MODEL_HALF_STAKE_UNDER_CENTS = 0;
/** Kept for saved configs / UI remnants; sizing uses MODEL_HALF_STAKE_UNDER_CENTS. */
const MODEL_UNCERTAIN_MAX_PRICE_CENTS_DEFAULT = 70;
const MODEL_LOW_PRICE_STAKE_QUARTERS_DEFAULT = 2;
/**
 * Confirmation gate: must observe ask below this, then cross it, before entry
 * is eligible. 0 = off. Default 50¢ — don't buy after the move already ran.
 */
const MODEL_CONFIRM_CROSS_CENTS_DEFAULT = 0;
/** After the cross, skip if ask has already run this many ¢ past the cross (chase). */
const MODEL_CONFIRM_MAX_EXTENSION_CENTS_DEFAULT = 15;
/** Need at least this many ¢ of continuation above the cross before buying. */
const MODEL_CONFIRM_MIN_CONTINUE_CENTS_DEFAULT = 2;

/**
 * Live probs of the active window clearly against the held side (not the frozen lock).
 * Requires a margin so 51/49 noise doesn't churn lean-flips.
 */
function modelLiveLeanAgainstHeld(window, side, marginPct = MODEL_LIVE_LEAN_MARGIN_DEFAULT) {
  if (!window) return false;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return false;
  const margin = Number.isFinite(Number(marginPct)) ? Math.max(0, Number(marginPct)) : MODEL_LIVE_LEAN_MARGIN_DEFAULT;
  if (side === 'yes') return down >= up + margin;
  if (side === 'no') return up >= down + margin;
  return false;
}

function modelMinHoldMs(config = {}) {
  const mins = Number(config.modelMinHoldSeconds);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 1000);
  return MODEL_MIN_HOLD_MS_DEFAULT;
}

function modelPostExitCooldownMs(config = {}) {
  const sec = Number(config.modelPostExitCooldownSeconds);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const mins = Number(config.modelPostExitCooldownMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  return MODEL_POST_EXIT_COOLDOWN_MS_DEFAULT;
}

function modelGlobalPostExitCooldownMs(config = {}) {
  const sec = Number(config.modelGlobalPostExitCooldownSeconds);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const ms = Number(config.modelGlobalPostExitCooldownMs);
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  return MODEL_GLOBAL_POST_EXIT_COOLDOWN_MS_DEFAULT;
}

function isModelPostExitCooldownReason(reason) {
  const r = String(reason || '');
  return (
    r === 'model_lean_flip' ||
    r === 'model_lean_stop' ||
    r === 'model_dip_stop' ||
    r === 'model_against' ||
    r === 'model_stagnation' ||
    r === 'model_rapid_adverse' ||
    r === 'model_late_exit' ||
    r === 'model_pre_close' ||
    r === 'breakeven' ||
    r === 'take_profit' ||
    r === 'near_certain'
  );
}

function modelPostLeanStopCooldownMs(config = {}) {
  const mins = Number(config.modelPostLeanStopCooldownMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  const n = Number(config.modelPostLeanStopCooldownMs);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return MODEL_POST_LEAN_STOP_COOLDOWN_MS_DEFAULT;
}

function modelLeanAgainstBeMs(config = {}) {
  const ms = Number(config.modelLeanAgainstBeMs);
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const sec = Number(config.modelLeanAgainstBeSeconds);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  return MODEL_LEAN_AGAINST_BE_MS_DEFAULT;
}

/** Live window still supports this MODEL hold (inverse of lean-turning). */
function modelDirectionSupportsHold({
  window,
  direction,
  side,
  entryHeldProb,
  minConf,
  config = {},
} = {}) {
  if (!window || !side) return { ok: false, firm: false, turning: true };
  const turning = modelEngineTurningAgainst({
    window,
    direction,
    side,
    minConf,
    entryHeldProb,
    config,
  });
  const firm = modelEngineClearlyWithUs({
    window,
    direction,
    side,
    entryHeldProb,
    config,
  });
  return { ok: firm && !turning, firm, turning };
}

function modelOpenGraceMs(config = {}) {
  const n = Number(config.modelOpenGraceMs);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  const sec = Number(config.modelOpenGraceSeconds);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  return MODEL_OPEN_GRACE_MS_DEFAULT;
}

function modelLeanStopBarrierCents(config = {}) {
  const n = Number(config.modelLeanStopBarrierCents);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const hard = modelHardStopFloorCents(config);
  if (hard > 0) return hard;
  return MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT;
}

function modelLeanStopPaceHorizonMs(config = {}) {
  const n = Number(config.modelLeanStopPaceHorizonMs);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  const sec = Number(config.modelLeanStopPaceHorizonSeconds);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  return MODEL_LEAN_STOP_PACE_HORIZON_MS_DEFAULT;
}

/**
 * After buy goes red: only lean-stop if bid is already ≤ barrier (default 55)
 * or linear pace from entry bid projects ≤ barrier — but only after a real
 * drawdown (not a 3–5¢ wick that extrapolates to the floor).
 */
function modelOnPaceBelowBarrier({
  fromBid,
  currentBid,
  elapsedMs,
  barrierCents = MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT,
  horizonMs = MODEL_LEAN_STOP_PACE_HORIZON_MS_DEFAULT,
  minSampleMs = MODEL_LEAN_STOP_PACE_MIN_SAMPLE_MS_DEFAULT,
} = {}) {
  const cur = Number(currentBid);
  const from = Number(fromBid);
  const elapsed = Number(elapsedMs);
  const barrier = Number(barrierCents);
  if (!Number.isFinite(cur)) return false;
  if (Number.isFinite(barrier) && cur <= barrier) return true;
  const minSample = Number.isFinite(Number(minSampleMs))
    ? Math.max(0, Number(minSampleMs))
    : MODEL_LEAN_STOP_PACE_MIN_SAMPLE_MS_DEFAULT;
  if (!Number.isFinite(from) || !Number.isFinite(elapsed) || elapsed < minSample) return false;
  const drop = from - cur;
  if (!(drop > 0)) return false;
  const horizon =
    Number.isFinite(Number(horizonMs)) && horizonMs > 0
      ? Number(horizonMs)
      : MODEL_LEAN_STOP_PACE_HORIZON_MS_DEFAULT;
  const projected = cur - (drop / elapsed) * horizon;
  return projected <= barrier;
}

function modelLeanStopPaceMinSampleMs(config = {}) {
  const n = Number(config.modelLeanStopPaceMinSampleMs);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  const sec = Number(config.modelLeanStopPaceMinSampleSeconds);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  return MODEL_LEAN_STOP_PACE_MIN_SAMPLE_MS_DEFAULT;
}

/** % of (entry − floor) before pace lean-stop can arm (default 35). 0 = use min ¢ only. */
function modelLeanStopPaceDrawdownPct(config = {}) {
  const n = Number(config.modelLeanStopPaceDrawdownPct);
  if (Number.isFinite(n) && n > 0) return Math.min(100, Math.max(1, n)) / 100;
  return MODEL_LEAN_STOP_PACE_DRAWDOWN_PCT_DEFAULT / 100;
}

/** ¢ adverse required before pace-to-floor can lean-stop (absolute barrier still instant). */
function modelLeanStopMinAdverseCents(trade, config = {}) {
  const configured = Number(config.modelLeanStopMinAdverseCents);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured);
  const barrier = modelLeanStopBarrierCents(config);
  const entry = Number(trade && trade.entryPriceCents);
  if (!Number.isFinite(entry) || !(barrier > 0) || entry <= barrier) {
    return MODEL_LEAN_STOP_MIN_ADVERSE_CENTS_DEFAULT;
  }
  const room = Math.max(0, Math.round(entry - barrier));
  const pct = modelLeanStopPaceDrawdownPct(config);
  return Math.max(MODEL_LEAN_STOP_MIN_ADVERSE_CENTS_DEFAULT, Math.round(room * pct));
}

function modelLeanStopPaceArmCents(config = {}) {
  const n = Number(config.modelLeanStopPaceArmCents);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return MODEL_LEAN_STOP_PACE_ARM_CENTS_DEFAULT;
}

function modelShouldLeanStopRed(_trade, _heldSideBidCents, _heldMs, _config = {}) {
  // Disabled: pace/floor lean-stop was too sensitive. MODEL reds wait for
  // stagnation (or a hard lean flip). Helpers above stay for sit-out labels.
  return false;
}

function modelMinTpCents(config = {}) {
  const n = Number(config.modelMinTpCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_MIN_TP_CENTS_DEFAULT;
}

/**
 * Model TAKE_PROFIT floor: never bank a scratch under minTp (default +7¢).
 * Rich near-certain bids (≥96¢) are always allowed.
 */
function modelTakeProfitMeetsFloor(trade, exitPriceCents, config = {}) {
  const entry = Number(trade && trade.entryPriceCents);
  const exit = Number(exitPriceCents);
  if (!Number.isFinite(entry) || entry < 1 || !Number.isFinite(exit)) return false;
  if (exit < entry) return false;
  if (Math.round(exit) >= MODEL_RICH_BANK_CENTS_DEFAULT) return true;
  const minTp = modelMinTpCents(config);
  if (!(minTp > 0)) return exit > entry;
  return Math.round(exit - entry) >= minTp;
}

/** Unconditional bank threshold (¢ green). 0 = only lean-exit TPs. */
function modelBankGreenCents(config = {}) {
  const n = Number(config.modelBankGreenCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_BANK_GREEN_CENTS_DEFAULT;
}

/** Stall-bank when peak reaches this green (≤ full TP). 0 = auto (TP − 3¢). */
function modelNearTargetBankCents(config = {}) {
  const bank = modelBankGreenCents(config);
  const n = Number(config.modelNearTargetBankCents);
  if (Number.isFinite(n) && n > 0) {
    const v = Math.round(n);
    return bank > 0 ? Math.min(v, bank) : v;
  }
  if (bank > 0) return Math.max(1, bank - 3);
  return MODEL_NEAR_TARGET_BANK_CENTS_DEFAULT;
}

/** ¢ green before we trail and TP on a tiny stall. Caps at trail-arm default. */
function modelTrailArmCents(config = {}) {
  const bank = modelBankGreenCents(config);
  if (!(bank > 0)) return MODEL_TRAIL_ARM_CENTS_DEFAULT;
  return Math.max(2, Math.min(MODEL_TRAIL_ARM_CENTS_DEFAULT, bank));
}

function modelSettleCloseMinutes(config = {}) {
  const n = Number(config.modelSettleCloseMinutes);
  if (Number.isFinite(n) && n < 0) return MODEL_SETTLE_CLOSE_MINUTES_DEFAULT;
  if (Number.isFinite(n) && n === 0) return 0;
  if (Number.isFinite(n) && n > 0) return n;
  return MODEL_SETTLE_CLOSE_MINUTES_DEFAULT;
}

function modelLateBarrierMinutes(config = {}) {
  const n = Number(config.modelLateBarrierMinutes);
  if (Number.isFinite(n) && n < 0) return MODEL_LATE_BARRIER_MINUTES_DEFAULT;
  if (Number.isFinite(n) && n === 0) return 0;
  if (Number.isFinite(n) && n > 0) return n;
  return MODEL_LATE_BARRIER_MINUTES_DEFAULT;
}

function modelPreCloseForceMinutes(config = {}) {
  const n = Number(config.modelPreCloseForceMinutes);
  if (Number.isFinite(n) && n < 0) return MODEL_PRE_CLOSE_FORCE_MINUTES_DEFAULT;
  if (Number.isFinite(n) && n === 0) return 0;
  if (Number.isFinite(n) && n > 0) return n;
  return MODEL_PRE_CLOSE_FORCE_MINUTES_DEFAULT;
}

/**
 * A model entry must have enough time to trade before the late-exit policy
 * begins. Keep a 30-second buffer so an entry cannot be opened and then
 * immediately closed by the next management pass.
 */
function modelEntryCutoffMinutes(config = {}) {
  const configured = Number(config.modelMinMinutesToOpen);
  const requested =
    Number.isFinite(configured) && configured > 0
      ? configured
      : MODEL_MIN_MINUTES_TO_OPEN_DEFAULT;
  return Math.max(requested, modelSettleCloseMinutes(config) + 0.5);
}

function modelLateExtendMinConfidence(config = {}) {
  const n = Number(config.modelLateExtendMinConfidence);
  if (Number.isFinite(n) && n > 0) return n;
  return MODEL_LATE_EXTEND_MIN_CONFIDENCE_DEFAULT;
}

/**
 * Extend into the final barrier when the live lean still clearly favors the
 * held side. The final one-minute forced cash-out remains in effect.
 */
function modelLateExtendOk(window, side, config = {}) {
  if (!window || (side !== 'yes' && side !== 'no')) return false;
  return modelLiveLeanStillFavors(window, side, modelEntryLiveLeanMarginPct(config));
}

function modelMomentumStallMs(config = {}) {
  const n = Number(config.modelMomentumStallSeconds);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
  return MODEL_MOMENTUM_STALL_MS_DEFAULT;
}

function modelMomentumPullbackCents(config = {}) {
  const n = Number(config.modelMomentumPullbackCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_MOMENTUM_PULLBACK_CENTS_DEFAULT;
}

function modelDumpPullbackCents(config = {}) {
  const n = Number(config.modelDumpPullbackCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_DUMP_PULLBACK_CENTS_DEFAULT;
}

function modelFastRedCents(config = {}) {
  const n = Number(config.modelFastRedCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_FAST_RED_CENTS_DEFAULT;
}

function modelActualSideBidCents(market, side) {
  if (!market || !side) return null;
  if (side === 'yes') {
    const bid = Number(market.yes_bid);
    return Number.isFinite(bid) ? bid : null;
  }
  if (side === 'no') {
    const bid = Number(market.no_bid);
    return Number.isFinite(bid) ? bid : null;
  }
  return null;
}

function modelMaxEntrySpreadCents(config = {}) {
  const n = Number(config.modelMaxEntrySpreadCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_MAX_ENTRY_SPREAD_CENTS_DEFAULT;
}

/** BNB/SOL books run wider than BTC — allow a couple extra ¢ so they stay usable. */
function modelMaxEntrySpreadCentsForSymbol(symbol, config = {}) {
  const base = modelMaxEntrySpreadCents(config);
  if (!(base > 0)) return base;
  const sym = String(symbol || '').toUpperCase();
  if (sym === 'BTC') return base;
  return Math.min(20, base + 2);
}

function modelLowPriceMaxCents(_config = {}) {
  // When half-stake is off (0), keep a display remnant of 70 for old UI copy.
  return MODEL_HALF_STAKE_UNDER_CENTS > 0
    ? MODEL_HALF_STAKE_UNDER_CENTS
    : MODEL_UNCERTAIN_MAX_PRICE_CENTS_DEFAULT;
}

function modelIsHalfStakeAsk(priceCents) {
  if (!(MODEL_HALF_STAKE_UNDER_CENTS > 0)) return false;
  const p = Number(priceCents);
  return Number.isFinite(p) && p < MODEL_HALF_STAKE_UNDER_CENTS;
}

/** Half-stake under-N¢ is off when threshold is 0. */
function modelLowPriceStakeQuarters(_config = {}) {
  return 2;
}

function modelLowPriceStakeFraction(_config = {}) {
  return 0.5;
}

function modelLowPriceStakeLabel(_config = {}) {
  return '½';
}

function modelConfirmCrossCents(config = {}) {
  const n = Number(config.modelConfirmCrossCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_CONFIRM_CROSS_CENTS_DEFAULT;
}

function modelConfirmMaxExtensionCents(config = {}) {
  const n = Number(config.modelConfirmMaxExtensionCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_CONFIRM_MAX_EXTENSION_CENTS_DEFAULT;
}

function modelConfirmMinContinueCents(config = {}) {
  const n = Number(config.modelConfirmMinContinueCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_CONFIRM_MIN_CONTINUE_CENTS_DEFAULT;
}

function modelLiveLeanMarginPct(config = {}) {
  const n = Number(config.modelLiveLeanMarginPct);
  if (Number.isFinite(n) && n >= 0) return n;
  return MODEL_LIVE_LEAN_MARGIN_DEFAULT;
}

/** 96/1, 1/96, 96/2, etc. all trigger a cash-out; 0 disables the rule. */
function modelExtremeLiveLeanExitPct(config = {}) {
  const n = Number(config.modelExtremeLiveLeanExitPct);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.min(100, n);
  return MODEL_EXTREME_LIVE_LEAN_EXIT_PCT_DEFAULT;
}

function modelExtremeLiveLeanHit(window, config = {}) {
  if (!window) return false;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  const threshold = modelExtremeLiveLeanExitPct(config);
  return (
    threshold > 0 &&
    ((Number.isFinite(up) && up >= threshold) || (Number.isFinite(down) && down >= threshold))
  );
}

/** Opposing live lean ≥ threshold (1/96 on YES, 96/1 on NO, etc.). */
function modelExtremeLeanAgainstHeld(window, side, config = {}) {
  if (!window || !side) return false;
  const threshold = modelExtremeLiveLeanExitPct(config);
  if (threshold <= 0) return false;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  if (side === 'yes') return Number.isFinite(down) && down >= threshold;
  if (side === 'no') return Number.isFinite(up) && up >= threshold;
  return false;
}

/** Held-side live lean ≥ threshold (96/1 on YES, 1/96 on NO). */
function modelExtremeLeanWithUs(window, side, config = {}) {
  if (!window || !side) return false;
  const threshold = modelExtremeLiveLeanExitPct(config);
  if (threshold <= 0) return false;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  if (side === 'yes') return Number.isFinite(up) && up >= threshold;
  if (side === 'no') return Number.isFinite(down) && down >= threshold;
  return false;
}

function modelHeldSideProb(window, side) {
  if (!window || !side) return NaN;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  if (side === 'yes') return Number.isFinite(up) ? up : NaN;
  if (side === 'no') return Number.isFinite(down) ? down : NaN;
  return NaN;
}

function modelLeanDecayPeakMin(config = {}) {
  const n = Number(config.modelLeanDecayPeakMin);
  if (Number.isFinite(n) && n > 0) return Math.min(99, Math.round(n));
  return MODEL_LEAN_DECAY_PEAK_MIN_DEFAULT;
}

function modelLeanDecayFloor(config = {}) {
  const n = Number(config.modelLeanDecayFloor);
  if (Number.isFinite(n) && n > 0) return Math.min(99, Math.round(n));
  return MODEL_LEAN_DECAY_FLOOR_DEFAULT;
}

function modelLeanDecayDropPts(config = {}) {
  const n = Number(config.modelLeanDecayDropPts);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_LEAN_DECAY_DROP_PTS_DEFAULT;
}

function modelLeanDecayRecoveryPts(config = {}) {
  const n = Number(config.modelLeanDecayRecoveryPts);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_LEAN_DECAY_RECOVERY_PTS_DEFAULT;
}

function modelLeanDecayStallMs(config = {}) {
  const sec = Number(config.modelLeanDecayStallSeconds);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const ms = Number(config.modelLeanDecayStallMs);
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  return MODEL_LEAN_DECAY_STALL_MS_DEFAULT;
}

/**
 * Strong lean rotting (99/1 → 85/15): track peak/trough; cut when decay zone
 * persists without recovery. Mutates trade peak/decay timestamps.
 */
function modelLeanDecayCutState(trade, window, side, now = Date.now(), config = {}) {
  const heldProb = modelHeldSideProb(window, side);
  if (!Number.isFinite(heldProb)) {
    return { inDecayZone: false, cutReady: false, heldProb: NaN, peakLean: NaN };
  }
  const peakMin = modelLeanDecayPeakMin(config);
  const floor = modelLeanDecayFloor(config);
  const dropPts = modelLeanDecayDropPts(config);
  const recoveryPts = modelLeanDecayRecoveryPts(config);
  const stallMs = modelLeanDecayStallMs(config);
  const entryHeld = Number(trade && trade.modelEntryHeldProb);
  const prevPeak = Number(trade && trade.peakModelHeldProb);
  const peakLean = Math.max(
    Number.isFinite(prevPeak) ? prevPeak : -Infinity,
    Number.isFinite(entryHeld) ? entryHeld : -Infinity,
    heldProb
  );
  if (trade) trade.peakModelHeldProb = peakLean;

  const wasStrong = peakLean >= peakMin;
  const dropped = peakLean - heldProb;
  const inDecayZone = wasStrong && (heldProb <= floor || dropped >= dropPts);

  if (!inDecayZone) {
    if (trade) {
      delete trade.modelLeanDecaySince;
      delete trade.modelLeanDecayTroughProb;
    }
    return { inDecayZone: false, cutReady: false, heldProb, peakLean, wasStrong };
  }

  const prevTrough = Number(trade && trade.modelLeanDecayTroughProb);
  const trough = Number.isFinite(prevTrough) ? Math.min(prevTrough, heldProb) : heldProb;
  if (trade) {
    trade.modelLeanDecayTroughProb = trough;
    if (!Number.isFinite(Number(trade.modelLeanDecaySince))) {
      trade.modelLeanDecaySince = now;
    }
  }

  const recovered =
    heldProb >= trough + recoveryPts && heldProb > floor && dropped < dropPts;
  if (recovered) {
    if (trade) {
      delete trade.modelLeanDecaySince;
      delete trade.modelLeanDecayTroughProb;
    }
    return { inDecayZone: false, cutReady: false, heldProb, peakLean, recovered: true };
  }

  const decayAge = trade && Number.isFinite(Number(trade.modelLeanDecaySince))
    ? now - Number(trade.modelLeanDecaySince)
    : 0;
  const atFloor = heldProb <= floor;
  const stalled = stallMs > 0 && decayAge >= stallMs;
  // Still clearly favoring (e.g. 90→85 NO) is "decay zone" for tracking only —
  // don't MODEL_AGAINST until the thesis is actually soft/50-50 or flipped.
  const thesisBroken =
    atFloor || // if lean is already below the exit floor, thesis is by definition gone
    modelLiveProbNotWithUs(window, side) ||
    modelLiveLeanAgainstHeld(window, side, modelLiveLeanMarginPct(config)) ||
    !modelLiveLeanStillFavors(window, side, modelSoftLeanMarginPct(config));
  // Floor cut: fires as soon as heldProb drops to/below floor (thesisBroken always true there).
  // Stall cut: time-based override — fires after stallMs regardless of thesis strength.
  const cutReady = (thesisBroken && atFloor) || stalled;

  return {
    inDecayZone: true,
    cutReady,
    heldProb,
    peakLean,
    trough,
    decayAgeMs: decayAge,
    atFloor,
    thesisBroken,
  };
}

/** Entry-only live favor margin (stricter than the exit lean-against margin). */
function modelEntryLiveLeanMarginPct(config = {}) {
  const n = Number(config.modelEntryLiveLeanMarginPct);
  if (Number.isFinite(n) && n >= 0) return n;
  return MODEL_ENTRY_LIVE_LEAN_MARGIN_DEFAULT;
}

function modelMinEntryLeanPct(config = {}) {
  const n = Number(config.modelMinEntryLeanPct);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(Math.min(99, n));
  return MODEL_MIN_ENTRY_LEAN_PCT_DEFAULT;
}

/** Block entries when held-side live lean is too soft (e.g. 72% NO on a 74¢ ticket). */
function modelMinEntryLeanGate({ window, side, config = {} } = {}) {
  const need = modelMinEntryLeanPct(config);
  if (!(need > 0)) return { ok: true, skipped: true };
  const held = modelHeldSideProb(window, side);
  if (!Number.isFinite(held)) {
    return { ok: false, reason: 'held-side lean unavailable' };
  }
  if (held >= need) return { ok: true, held };
  return {
    ok: false,
    reason: `held-side lean ${Math.round(held)}% (need ≥${need}%)`,
  };
}

function modelTrailCents(config = {}) {
  const n = Number(config.modelTrailCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_TRAIL_CENTS_DEFAULT;
}

function modelMaxAdverseCents(config = {}) {
  const n = Number(config.modelMaxAdverseCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_MAX_ADVERSE_CENTS_DEFAULT;
}

/** Hard cliff (¢ below entry) — always exit, lean irrelevant. 0 = off. */
function modelHardAdverseCents(config = {}) {
  const n = Number(config.modelHardAdverseCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const maxLoss = modelMaxLossCents(config);
  if (maxLoss > 0) return maxLoss;
  return MODEL_HARD_ADVERSE_CENTS_DEFAULT;
}

function modelMaxLossCents(config = {}) {
  const n = Number(config.modelMaxLossCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_MAX_LOSS_CENTS_DEFAULT;
}

function modelRichStopFloorCents(config = {}) {
  const n = Number(config.modelRichStopFloorCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_RICH_STOP_FLOOR_CENTS_DEFAULT;
}

function modelHardStopFloorCents(config = {}) {
  const n = Number(config.modelHardStopFloorCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  // Legacy: mid-rich floor configs map onto the universal hard floor.
  const legacy = Number(config.modelMidRichStopFloorCents);
  if (Number.isFinite(legacy) && legacy > 0) return Math.round(legacy);
  return MODEL_HARD_STOP_FLOOR_CENTS_DEFAULT;
}

function modelMidRichStopFloorCents(config = {}) {
  return modelHardStopFloorCents(config);
}

function modelRichStopEntryMinCents(config = {}) {
  const n = Number(config.modelRichStopEntryMinCents);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_RICH_STOP_ENTRY_MIN_CENTS_DEFAULT;
}

function modelRichStopMinConfidence(config = {}) {
  const n = Number(config.modelRichStopMinConfidence);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_RICH_STOP_MIN_CONFIDENCE_DEFAULT;
}

/**
 * Absolute bid floor for this entry — universal hard floor (default 55¢).
 * Rich-floor slider is optional: only used when set (>0) AND lower than hard
 * (more room). A higher rich floor (e.g. 68) is ignored so 78+/80/85 stay on 55.
 */
function modelStopFloorForEntryCents(entryCents, config = {}) {
  const entry = Number(entryCents);
  if (!Number.isFinite(entry)) return 0;
  const hard = modelHardStopFloorCents(config);
  const richFloor = modelRichStopFloorCents(config);
  const richMin = modelRichStopEntryMinCents(config);
  // Optional richer room only if rich floor is below the hard floor (more drawdown).
  if (
    richFloor > 0 &&
    hard > 0 &&
    richFloor < hard &&
    entry >= richMin &&
    entry > richFloor
  ) {
    return richFloor;
  }
  if (hard > 0 && entry > hard) return hard;
  return 0;
}

/**
 * Hard max-loss for this ticket. Slider −N¢ is a cap from entry; never widened
 * to ride all the way to the hard floor (that was booking 70→61 / −9¢ on an 8¢ knob).
 */
function modelEffectiveMaxLossCents(trade, config = {}) {
  const base = modelMaxLossCents(config);
  if (!(base > 0)) return 0;
  const entry = Number(trade && trade.entryPriceCents);
  if (!Number.isFinite(entry)) return base;

  const floor = modelStopFloorForEntryCents(entry, config);
  if (!(floor > 0) || entry <= floor) return base;
  const room = Math.max(0, Math.round(entry - floor));
  return Math.min(base, room);
}

/**
 * After a MODEL direction flip, how long to confirm the new lean before bidding.
 * More time left → longer confirm (avoid chop); late window → faster confirm.
 */
function modelSideSwitchConfirmMs(minutesLeft, config = {}) {
  const configured = Number(config.modelSideSwitchConfirmMs);
  if (Number.isFinite(configured) && configured >= 0) return Math.round(configured);
  const m = Number(minutesLeft);
  if (!(m > 0)) return 8_000;
  if (m >= 10) return 15_000;
  if (m >= 5) return 8_000;
  if (m >= 2) return 5_000;
  return 3_000;
}

function modelSideSwitchConfirmTicks(minutesLeft, config = {}) {
  const configured = Number(config.modelSideSwitchConfirmTicks);
  if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  const m = Number(minutesLeft);
  if (m >= 10) return 3;
  if (m >= 5) return 2;
  return 2;
}

/** Paper: don't book a gap worse than max loss from entry. Live: real bid. */
function modelAdverseExitFillCents(trade, liveBidCents, config = {}, mode = 'paper') {
  const bid = Number(liveBidCents);
  const entry = Number(trade && trade.entryPriceCents);
  const maxLoss = modelEffectiveMaxLossCents(trade, config);
  if (!Number.isFinite(bid)) return bid;
  if (String(mode).toLowerCase() !== 'paper' || !(maxLoss > 0) || !Number.isFinite(entry)) {
    return Math.round(bid);
  }
  return Math.max(Math.round(bid), Math.round(entry - maxLoss));
}

function modelRichAskCents(config = {}) {
  const n = Number(config.modelRichAskCents);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_RICH_ASK_CENTS_DEFAULT;
}

function modelRichMaxSpreadCents(config = {}) {
  const n = Number(config.modelRichMaxSpreadCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_RICH_MAX_SPREAD_CENTS_DEFAULT;
}

function modelRichMinConfidence(config = {}) {
  const n = Number(config.modelRichMinConfidence);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_RICH_MIN_CONFIDENCE_DEFAULT;
}

function modelSoftLeanMarginPct(config = {}) {
  const n = Number(config.modelSoftLeanMarginPct);
  if (Number.isFinite(n) && n >= 0) return n;
  return MODEL_SOFT_LEAN_MARGIN_DEFAULT;
}

/** Held side still has a clear live lead (used to detect softening before a hard flip). */
function modelLiveLeanStillFavors(window, side, keepMargin = MODEL_SOFT_LEAN_MARGIN_DEFAULT) {
  if (!window) return false;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return false;
  const margin = Number.isFinite(Number(keepMargin)) ? Math.max(0, Number(keepMargin)) : MODEL_SOFT_LEAN_MARGIN_DEFAULT;
  if (side === 'yes') return up >= down + margin;
  if (side === 'no') return down >= up + margin;
  return false;
}

/** Live prob tie or lean away from held side (exit margin = 0). */
function modelLiveProbNotWithUs(window, side) {
  if (!window) return false;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return false;
  if (side === 'yes') return up <= down;
  if (side === 'no') return down <= up;
  return false;
}

/** Accumulated signalScore turning against the held side (weakening / dominance flip). */
function modelSignalDominanceMin(config = {}) {
  const n = Number(config.modelSignalDominanceMin);
  // 0 / negative / unset-off → feature off (ignore signalScore for turn/dump).
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return n;
  return MODEL_SIGNAL_DOMINANCE_MIN_DEFAULT;
}

function modelSignalScoreEnabled(config = {}) {
  return modelSignalDominanceMin(config) > 0;
}

function modelSignalTurningAgainst(window, side, config = {}) {
  if (!modelSignalScoreEnabled(config)) return false;
  const ss = window && window.signalScore;
  if (!ss) return false;
  const nd = Number(ss.netDominance);
  const trend = ss.trend;
  if (!Number.isFinite(nd)) return false;
  const minDom = modelSignalDominanceMin(config);
  if (side === 'yes') {
    if (nd <= 0) return true;
    if (trend === 'weakening' && nd < minDom) return true;
  } else if (side === 'no') {
    if (nd >= 0) return true;
    if (trend === 'weakening' && nd > -minDom) return true;
  }
  return false;
}

function modelProbDriftPts(config = {}) {
  const n = Number(config.modelProbDriftPts);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_PROB_DRIFT_PTS_DEFAULT;
}

/** Held-side live prob fell this many pts since entry — model fading before the bid. */
function modelProbDriftAgainst(window, side, entryHeldProb, driftPts = MODEL_PROB_DRIFT_PTS_DEFAULT) {
  const entry = Number(entryHeldProb);
  if (!window || !Number.isFinite(entry)) return false;
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  const cur = side === 'yes' ? up : side === 'no' ? down : NaN;
  const drift = Number.isFinite(Number(driftPts)) ? Math.max(0, Number(driftPts)) : MODEL_PROB_DRIFT_PTS_DEFAULT;
  if (!Number.isFinite(cur) || drift <= 0) return false;
  return cur <= entry - drift;
}

/**
 * Model-native "lean turning" — fires before Kalshi bid dumps.
 * Uses live probs, locked direction, signalScore trend/dominance, conf, entry drift.
 */
function modelEngineTurningAgainst({
  window,
  direction,
  side,
  minConf,
  entryHeldProb,
  config = {},
} = {}) {
  if (!window || !side) return false;
  if (direction && modelDirectionAgainstHeld(direction, side)) return true;
  if (modelLiveLeanAgainstHeld(window, side, modelLiveLeanMarginPct(config))) return true;
  if (modelLiveProbNotWithUs(window, side)) return true;
  if (modelSignalTurningAgainst(window, side, config)) return true;
  if (modelProbDriftAgainst(window, side, entryHeldProb, modelProbDriftPts(config))) return true;
  const conf = Number(window.confidence);
  if (Number.isFinite(minConf) && Number.isFinite(conf) && conf < minConf) return true;
  return false;
}

/**
 * Exit-only: real lean flip (not 50/50 tie, conf wick, signalScore noise, or 1pt lean).
 * Live lean needs a clear lead against us (≥5pts). Soft/50-50 + max-loss depth
 * still cuts via the soft-red path; signalScore stays in soft-turning only.
 */
const MODEL_HARD_LEAN_AGAINST_MARGIN_DEFAULT = 5;

function modelEngineHardAgainst({
  window,
  direction,
  side,
  minConf: _minConf,
  config = {},
} = {}) {
  if (!window || !side) return false;
  if (direction && modelDirectionAgainstHeld(direction, side)) return true;
  const hardMargin = Math.max(
    MODEL_HARD_LEAN_AGAINST_MARGIN_DEFAULT,
    modelLiveLeanMarginPct(config)
  );
  if (modelLiveLeanAgainstHeld(window, side, hardMargin)) return true;
  return false;
}

/** Model still clearly supports the hold — only then allow a short red bounce window. */
function modelEngineClearlyWithUs({ window, direction, side, entryHeldProb, config = {} } = {}) {
  if (!window || !side) return false;
  if (direction && modelDirectionAgainstHeld(direction, side)) return false;
  if (modelLiveLeanAgainstHeld(window, side, modelLiveLeanMarginPct(config))) return false;
  if (modelLiveProbNotWithUs(window, side)) return false;
  if (modelSignalTurningAgainst(window, side, config)) return false;
  if (modelProbDriftAgainst(window, side, entryHeldProb, modelProbDriftPts(config))) return false;
  if (
    !modelLiveLeanStillFavors(window, side, modelLiveLeanMarginPct(config))
  ) {
    return false;
  }
  const ss = window.signalScore;
  if (ss && ss.trend === 'weakening' && modelSignalScoreEnabled(config)) {
    const nd = Number(ss.netDominance);
    const minDom = modelSignalDominanceMin(config);
    if (side === 'yes' && (!Number.isFinite(nd) || nd < minDom)) return false;
    if (side === 'no' && (!Number.isFinite(nd) || nd > -minDom)) return false;
  }
  return true;
}

/** Bid at/above entry or within the recorded entry spread (ask fill → bid mark). */
function modelNearFlatCents(trade, heldSideBidCents) {
  const entry = Number(trade && trade.entryPriceCents);
  const bid = Number(heldSideBidCents);
  if (!Number.isFinite(entry) || !Number.isFinite(bid)) return false;
  if (Math.round(bid) >= Math.round(entry)) return true;
  const spreadStamp = Number(trade.modelEntrySpreadCents);
  const bidStamp = Number(trade.modelEntryBidCents);
  const pad = Number.isFinite(spreadStamp) && spreadStamp > 0
    ? Math.max(1, Math.round(spreadStamp))
    : Number.isFinite(bidStamp) && Number.isFinite(entry)
      ? Math.max(1, Math.round(entry - bidStamp))
      : 2;
  return bid >= entry - pad;
}

/** Model scratch BE: at entry or within spread — not a red cut disguised as BE. */
function modelBreakevenExitAllowed(trade, bookedExit) {
  if (!isModelTrade(trade)) {
    const entry = Number(trade && trade.entryPriceCents);
    const exit = Number(bookedExit);
    return Number.isFinite(entry) && Number.isFinite(exit) && exit >= entry;
  }
  return modelNearFlatCents(trade, bookedExit);
}

/** 50/50 tie or soft lean — scratch flat instead of waiting for a hard flip + min hold. */
function modelLeanStaleForScratch(window, side, engineClearlyWithUs, config = {}) {
  if (!window || !side || engineClearlyWithUs) return false;
  if (modelLiveProbNotWithUs(window, side)) return true;
  return !modelLiveLeanStillFavors(window, side, modelSoftLeanMarginPct(config));
}

function modelStagnationSeconds(config = {}) {
  const n = Number(config.modelStagnationSeconds);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_STAGNATION_SECONDS_DEFAULT;
}

function modelStagnationMinProgressCents(config = {}) {
  const n = Number(config.modelStagnationMinProgressCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  // Default tracks trail arm: if peak never hit stall-bank green, no meaningful progress.
  return modelTrailArmCents(config);
}

function modelRapidAdverseCents(config = {}) {
  const n = Number(config.modelRapidAdverseCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_RAPID_ADVERSE_CENTS_DEFAULT;
}

/** Peak ¢ above entry — how much favorable progress the trade actually made. */
function modelPeakProgressCents(trade, peakHeldBidCents) {
  const entry = Number(trade && trade.entryPriceCents);
  const peak = Number(peakHeldBidCents);
  if (!Number.isFinite(entry) || !Number.isFinite(peak)) return 0;
  return Math.max(0, Math.round(peak - entry));
}

/**
 * No meaningful progress toward TP after N seconds + thesis deteriorating.
 * Time alone never exits — needs both stagnation and model decay.
 */
function modelStagnationExitReady({
  heldMs,
  peakProgressCents,
  modelDeteriorating,
  config = {},
} = {}) {
  const needSec = modelStagnationSeconds(config);
  if (!(needSec > 0)) return { ready: false, skipped: true };
  const held = Number(heldMs);
  if (!Number.isFinite(held) || held < needSec * 1000) {
    return { ready: false, needSec, peakProgress: Number(peakProgressCents) || 0 };
  }
  const needProgress = modelStagnationMinProgressCents(config);
  const progress = Number(peakProgressCents);
  const peaked = Number.isFinite(progress) ? progress : 0;
  if (peaked >= needProgress) {
    return { ready: false, needSec, peakProgress: peaked, progressed: true };
  }
  if (!modelDeteriorating) {
    return { ready: false, needSec, peakProgress: peaked, waitingModel: true };
  }
  return { ready: true, needSec, peakProgress: peaked };
}

/**
 * Sharp dump from entry + model against → cut (does not wait for barrier/pace).
 */
function modelRapidAdverseExitReady({
  trueAdverseCents,
  modelAgainst,
  inOpenGrace,
  config = {},
} = {}) {
  const need = modelRapidAdverseCents(config);
  if (!(need > 0)) return { ready: false, skipped: true };
  if (inOpenGrace) return { ready: false, need, inGrace: true };
  const adverse = Number(trueAdverseCents);
  if (!Number.isFinite(adverse) || adverse < need) {
    return { ready: false, need, adverse: Number.isFinite(adverse) ? adverse : 0 };
  }
  if (!modelAgainst) return { ready: false, need, adverse, waitingModel: true };
  return { ready: true, need, adverse };
}

function modelBeChaseSeconds(config = {}) {
  const n = Number(config.modelBeChaseSeconds);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_BE_CHASE_SECONDS_DEFAULT;
}

/**
 * Bid still rising — fresh highs / bounce, not stalled. BE chase, breakeven skip,
 * and post-+3¢ stall (only bank after a momentum run).
 */
function modelUpwardMomentumEvidence(
  trade,
  {
    greenCents,
    heldSideBidCents,
    peakHeldBidCents,
    peakHeldBidAt,
    now,
    config = {},
    beChaseMode = false,
  } = {}
) {
  const arm = modelTrailArmCents(config);
  const green = Number(greenCents);
  if (!Number.isFinite(green) || green < 1) return false;

  const bid = Number(heldSideBidCents);
  if (!Number.isFinite(bid)) return false;

  const stallMs = modelMomentumStallMs(config);
  const stallPullback = modelMomentumPullbackCents(config);
  const peak = Number(peakHeldBidCents);
  const peakAt = Number(peakHeldBidAt);
  const peakAgeMs = Number.isFinite(peakAt) ? now - peakAt : Infinity;
  const pullback =
    Number.isFinite(peak) && Number.isFinite(bid) ? Math.max(0, Math.round(peak - bid)) : 0;
  const stalled =
    (stallPullback > 0 && pullback >= stallPullback) ||
    (stallMs > 0 && peakAgeMs >= stallMs);
  const atPeak = Number.isFinite(peak) && Math.round(bid) >= Math.round(peak) - 1;

  if (atPeak && !stalled) return true;

  if (beChaseMode && green < arm && trade) {
    const prevTrough = Number(trade.modelBeChaseTroughBid);
    const base = Number.isFinite(prevTrough) ? prevTrough : bid;
    trade.modelBeChaseTroughBid = Math.min(base, bid);
    const trough = Number(trade.modelBeChaseTroughBid);
    const bounce = Number.isFinite(trough) ? Math.max(0, Math.round(bid - trough)) : 0;
    if (bounce >= 1 && !stalled) return true;
  }

  return false;
}

function modelBeChaseUpwardEvidence(trade, args = {}) {
  return modelUpwardMomentumEvidence(trade, { ...args, beChaseMode: true });
}

/**
 * Crossed breakeven (bid ≥ entry) → N seconds to reach +trailArm (default +3¢)
 * or scratch flat. Spread-padded "near flat" (still a hair red) does not start
 * the timer. Dips back underwater reset it; crossing BE again restarts it.
 * While bid is still rising toward +3¢, the timer does not scratch.
 */
function modelBeChaseExitReady(
  trade,
  opts = {}
) {
  const {
    nearFlat,
    flatOrGreen,
    peakProgressCents,
    now,
    config = {},
  } = opts;
  const risingNow = !!(opts.upwardEvidence || opts.upwardEvidence);
  const needSec = modelBeChaseSeconds(config);
  if (!(needSec > 0)) return { ready: false, skipped: true };
  const needProgress = modelTrailArmCents(config);
  const atBe = !!flatOrGreen;

  if (!atBe) {
    if (trade) {
      delete trade.modelBeChaseStartedAt;
      delete trade.modelBeChaseTroughBid;
    }
    return { ready: false, reset: true };
  }

  const peak = Number(peakProgressCents);
  const peaked = Number.isFinite(peak) ? peak : 0;
  if (peaked >= needProgress) {
    if (trade) {
      delete trade.modelBeChaseStartedAt;
      delete trade.modelBeChaseTroughBid;
    }
    return { ready: false, achieved: true, needProgress };
  }

  const t = Number(now);
  if (!Number.isFinite(t)) return { ready: false, needSec, needProgress };

  if (!trade.modelBeChaseStartedAt) {
    trade.modelBeChaseStartedAt = t;
    if (trade) delete trade.modelBeChaseTroughBid;
    return { ready: false, started: true, needSec, needProgress };
  }

  const elapsed = t - Number(trade.modelBeChaseStartedAt);
  if (elapsed >= needSec * 1000) {
    if (risingNow) {
      return {
        ready: false,
        needSec,
        needProgress,
        peakProgress: peaked,
        elapsedMs: elapsed,
        holdingRise: true,
      };
    }
    return { ready: true, needSec, needProgress, peakProgress: peaked, elapsedMs: elapsed };
  }
  return { ready: false, needSec, needProgress, peakProgress: peaked, elapsedMs: elapsed };
}

/**
 * Stall-bank at live bid when green stalls below full TP (+11).
 * Near-target: peak touched within 3¢ of TP → bank on stall even if bid pulled back.
 */
function modelStallBankReady(
  trade,
  {
    greenCents,
    peakProgressCents,
    priceStalled,
    upwardMomentum,
    armed,
    window = null,
    side = null,
    config = {},
  } = {}
) {
  if (!armed || !priceStalled || upwardMomentum) return { ready: false };
  const green = Number(greenCents);
  const peakProg = Number(peakProgressCents);
  if (!Number.isFinite(green) || green < 1) return { ready: false };

  const bankGreen = modelBankGreenCents(config);
  const nearTargetBank = modelNearTargetBankCents(config);
  const arm = modelTrailArmCents(config);
  if (green < arm) return { ready: false };

  // If the lean is still clearly firm and favoring, let it ride to full TP —
  // only bank on stall when the lean is soft, weakening, or against.
  const leanStillFirm =
    window &&
    side &&
    !modelLiveProbNotWithUs(window, side) &&
    !modelLiveLeanAgainstHeld(window, side, modelLiveLeanMarginPct(config)) &&
    modelLiveLeanStillFavors(window, side, modelSoftLeanMarginPct(config));
  if (leanStillFirm) {
    return { ready: false, heldByLean: true };
  }

  const nearTarget =
    bankGreen > 0 && Number.isFinite(peakProg) && peakProg >= nearTargetBank;
  if (nearTarget) {
    return { ready: true, why: 'nearTarget', peakProg, bankGreen, nearTargetBank };
  }

  if (trade?.modelArmHadMomentum) {
    return { ready: true, why: 'momentumFade', peakProg };
  }
  return { ready: false };
}

/**
 * Does NOT require model% ≈ Kalshi ask — that starved every setup for hours
 * (asks sit 65–80¢ while leans often print 55–65%).
 * Returns { dump: true, reason } or { dump: false }.
 */
function modelEntryDumpRisk({
  window,
  direction,
  side,
  priceCents,
  minConf,
  config = {},
  fade = false,
} = {}) {
  if (!window || !side) return { dump: true, reason: 'no model window' };
  const up = Number(window.probabilityUp);
  const down = Number(window.probabilityDown);
  const heldProb = side === 'yes' ? up : side === 'no' ? down : NaN;
  const ask = Number(priceCents);
  const conf = Number(window.confidence);
  const ss = window.signalScore;
  const nd = ss && Number(ss.netDominance);
  const entryMargin = modelEntryLiveLeanMarginPct(config);

  if (Number.isFinite(minConf) && Number.isFinite(conf) && conf < minConf) {
    return { dump: true, reason: `confidence ${Math.round(conf)}% under ${minConf}%` };
  }

  // Signal-score weakening is exit-only (slider). Do not block entries here —
  // it was skipping more good tickets than it saved from dumps.
  // Mid-trade turn still uses modelSignalTurningAgainst when the slider is on.

  // Fade buys the underdog on purpose — conf check above; signalScore is exit-only.
  if (fade) return { dump: false };

  if (!Number.isFinite(heldProb)) {
    return { dump: true, reason: 'no held-side probability' };
  }

  const leanNeed = modelMinEntryLeanPct(config);
  if (leanNeed > 0 && heldProb < leanNeed) {
    return {
      dump: true,
      reason: `held-side lean ${Math.round(heldProb)}% under ${leanNeed}%`,
    };
  }

  // Extreme overpay only: e.g. model 55% vs 85¢ ask. Normal 60% vs 70¢ is allowed.
  if (Number.isFinite(ask) && ask >= 1 && heldProb + 20 < ask) {
    return {
      dump: true,
      reason: `model ${Math.round(heldProb)}% vs ask ${Math.round(ask)}¢ — extreme overpay`,
    };
  }

  // Need a real live lead, not a coin-flip.
  if (!modelLiveLeanStillFavors(window, side, entryMargin)) {
    return {
      dump: true,
      reason: `live lean only ${Number.isFinite(up) ? up.toFixed(0) : '?'}% UP / ${
        Number.isFinite(down) ? down.toFixed(0) : '?'
      }% DOWN — need ≥${entryMargin}pts with ${String(side).toUpperCase()}`,
    };
  }
  if (direction && modelDirectionAgainstHeld(direction, side)) {
    return { dump: true, reason: `locked ${direction} against ${String(side).toUpperCase()}` };
  }
  if (modelLiveProbNotWithUs(window, side) || modelLiveLeanAgainstHeld(window, side, entryMargin)) {
    return { dump: true, reason: `live lean against ${String(side).toUpperCase()}` };
  }
  // Dominance flipped against the ticket — only when signal-score slider is on.
  if (modelSignalScoreEnabled(config) && Number.isFinite(nd)) {
    if (side === 'yes' && nd < -0.15) {
      return { dump: true, reason: `netDominance ${nd.toFixed(2)} against YES` };
    }
    if (side === 'no' && nd > 0.15) {
      return { dump: true, reason: `netDominance ${nd.toFixed(2)} against NO` };
    }
  }
  return { dump: false };
}

/**
 * Normal entries need ≥ modelMinEntry (default 65¢). Below that only if confidence + lean
 * are especially strong, and never below the perfect floor.
 */
function modelMinRoomToFloorCents(config = {}) {
  const n = Number(config.modelMinRoomToFloorCents);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return MODEL_MIN_ROOM_TO_FLOOR_CENTS_DEFAULT;
}

/** Block entries with too little cushion above the hard stop floor. */
function modelEntryRoomToFloorGate(priceCents, config = {}) {
  const price = Number(priceCents);
  const floor = modelHardStopFloorCents(config);
  const minRoom = modelMinRoomToFloorCents(config);
  if (minRoom <= 0 || !Number.isFinite(price) || !(floor > 0)) return { ok: true };
  const room = Math.round(price - floor);
  if (room >= minRoom) return { ok: true };
  return {
    ok: false,
    reason: `only ${Math.max(0, room)}¢ room to ${floor}¢ hard floor (need ≥${minRoom}¢)`,
  };
}

function modelPriceAllowed(priceCents, window, config = {}) {
  const price = Number(priceCents);
  if (!Number.isFinite(price) || price < 1 || price > 99) {
    return { ok: false, reason: 'invalid price' };
  }
  const roomGate = modelEntryRoomToFloorGate(price, config);
  if (!roomGate.ok) return roomGate;
  const maxEntry = Number.isFinite(Number(config.modelMaxEntryCents))
    ? Number(config.modelMaxEntryCents)
    : MODEL_MAX_ENTRY_DEFAULT_CENTS;
  if (maxEntry > 0 && price > maxEntry) {
    return { ok: false, reason: `above model max entry ${maxEntry}¢` };
  }
  const minEntry = Number.isFinite(Number(config.modelMinEntryCents))
    ? Number(config.modelMinEntryCents)
    : MODEL_MIN_ENTRY_DEFAULT_CENTS;
  if (!(minEntry > 0) || price >= minEntry) return { ok: true };

  const perfectFloor = Number.isFinite(Number(config.modelPerfectMinEntryCents))
    ? Number(config.modelPerfectMinEntryCents)
    : MODEL_PERFECT_MIN_ENTRY_DEFAULT_CENTS;
  if (price < perfectFloor) {
    return {
      ok: false,
      reason: `below ${minEntry}¢ and under perfect floor ${perfectFloor}¢`,
    };
  }
  const needConf = Number.isFinite(Number(config.modelPerfectConfidence))
    ? Number(config.modelPerfectConfidence)
    : MODEL_PERFECT_CONFIDENCE_DEFAULT;
  const needLean = Number.isFinite(Number(config.modelPerfectLeanPts))
    ? Number(config.modelPerfectLeanPts)
    : MODEL_PERFECT_LEAN_DEFAULT;
  const conf = window && Number(window.confidence);
  const lean = window ? Math.abs(Number(window.probabilityUp) - 50) : NaN;
  if (Number.isFinite(conf) && conf >= needConf && Number.isFinite(lean) && lean >= needLean) {
    return { ok: true, perfect: true };
  }
  return {
    ok: false,
    reason: `below ${minEntry}¢ (need conf≥${needConf}% and lean≥${needLean}pts for exception)`,
  };
}

function modelLowAskCeilingCents(config = {}) {
  const n = Number(config.modelLowAskCeilingCents);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_LOW_ASK_CEILING_CENTS_DEFAULT;
}

function modelLowAskMinConfidence(config = {}) {
  const n = Number(config.modelLowAskMinConfidence);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_LOW_ASK_MIN_CONFIDENCE_DEFAULT;
}

function modelLowAskLiveFavorPts(config = {}) {
  const n = Number(config.modelLowAskLiveFavorPts);
  if (Number.isFinite(n) && n >= 0) return n;
  return MODEL_LOW_ASK_LIVE_FAVOR_DEFAULT;
}

function modelLowAskHeldProbMin(config = {}) {
  const n = Number(config.modelLowAskHeldProbMin);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_LOW_ASK_HELD_PROB_DEFAULT;
}

/**
 * Asks ≤69¢: optional near-certain gate (off by default).
 * conf ≥ slider when on + live favor ≥4pts + held-side ≥72%.
 * Stake under 70¢ stays half regardless.
 */
function modelLowAskConvictionGate({ priceCents, window, signalSide, config = {} } = {}) {
  const confNeed = modelLowAskMinConfidence(config);
  if (!(confNeed > 0)) return { ok: true, skipped: true };
  const ask = Math.round(Number(priceCents));
  const ceiling = modelLowAskCeilingCents(config);
  if (!Number.isFinite(ask) || ask < 1 || ask > ceiling) return { ok: true, skipped: true };
  if (!window) {
    return { ok: false, reason: `${ask}¢ low-ask needs a live model window` };
  }
  const conf = Number(window.confidence);
  if (!Number.isFinite(conf) || conf < confNeed) {
    return {
      ok: false,
      reason:
        `${ask}¢ needs near-certain direction (conf ≥${confNeed}%, have ` +
        `${Number.isFinite(conf) ? Math.round(conf) : '?'}%)`,
    };
  }
  const favorNeed = modelLowAskLiveFavorPts(config);
  const side = String(signalSide || '').toLowerCase();
  if (!modelLiveLeanStillFavors(window, side, favorNeed)) {
    const up = Number(window.probabilityUp);
    const down = Number(window.probabilityDown);
    return {
      ok: false,
      reason:
        `${ask}¢ needs live favor ≥${favorNeed}pts ` +
        `(have ${Number.isFinite(up) ? up.toFixed(0) : '?'}% UP / ${
          Number.isFinite(down) ? down.toFixed(0) : '?'
        }% DOWN)`,
    };
  }
  const heldNeed = modelLowAskHeldProbMin(config);
  const held = side === 'yes' ? Number(window.probabilityUp) : Number(window.probabilityDown);
  if (!Number.isFinite(held) || held < heldNeed) {
    return {
      ok: false,
      reason:
        `${ask}¢ needs held-side live ≥${heldNeed}% ` +
        `(have ${Number.isFinite(held) ? held.toFixed(0) : '?'}%)`,
    };
  }
  return { ok: true, conviction: true };
}

/**
 * After a Model BE/TP/lean-stop on this coin, block new model entries until cooldown elapses.
 * Lean/dip stops use a longer sit-out so we don't knife-catch the same loser every ~30s.
 */
function checkModelPostExitCooldown({
  trades,
  symbol,
  cooldownMs,
  leanStopCooldownMs,
  now = Date.now(),
} = {}) {
  const sym = String(symbol || '').toUpperCase();
  const cdTp = Number(cooldownMs);
  const cdLean = Number.isFinite(Number(leanStopCooldownMs))
    ? Number(leanStopCooldownMs)
    : MODEL_POST_LEAN_STOP_COOLDOWN_MS_DEFAULT;
  if (!sym) return { ok: true };
  let best = null;
  let bestAt = -Infinity;
  for (const t of trades || []) {
    if (!t || String(t.strategy || '').toLowerCase() !== 'model') continue;
    if (String(t.symbol || '').toUpperCase() !== sym) continue;
    if (t.status && String(t.status) !== 'closed') continue;
    const reason = String(t.exitReason || '');
    if (!isModelPostExitCooldownReason(reason)) continue;
    const at = Number(t.closedAt);
    const score = Number.isFinite(at) ? at : -Infinity;
    if (score >= bestAt) {
      bestAt = score;
      best = t;
    }
  }
  if (!best || !Number.isFinite(bestAt)) return { ok: true };
  const reason = String(best.exitReason || '');
  const isLeanStop =
    reason === 'model_lean_stop' ||
    reason === 'model_lean_flip' ||
    reason === 'model_dip_stop' ||
    reason === 'model_rapid_adverse';
    // model_stagnation uses the regular sit-out — it's a time/thesis exit, not a
    // knife-catch stop, so the longer lean-stop cooldown doesn't apply.
  const cd = isLeanStop
    ? Number.isFinite(cdLean) && cdLean > 0
      ? cdLean
      : cdTp
    : cdTp;
  if (!Number.isFinite(cd) || cd <= 0) return { ok: true };
  const elapsed = Number(now) - bestAt;
  if (elapsed < cd) {
    const remainSec = Math.max(1, Math.ceil((cd - elapsed) / 1000));
    return {
      ok: false,
      reason: `Waiting: ${sym} model sit-out after ${reason} (~${remainSec}s left) — avoids chop reopen.`,
    };
  }
  return { ok: true };
}

/**
 * After ANY model close (TP/BE/cut/…), pause ALL new entries briefly so we don't
 * hop ETH→BTC in the same regime the same second.
 */
function checkModelGlobalPostExitCooldown({
  trades,
  cooldownMs,
  now = Date.now(),
} = {}) {
  const cd = Number(cooldownMs);
  if (!Number.isFinite(cd) || cd <= 0) return { ok: true };
  let best = null;
  let bestAt = -Infinity;
  for (const t of trades || []) {
    if (!t || String(t.strategy || '').toLowerCase() !== 'model') continue;
    if (t.status && String(t.status) !== 'closed') continue;
    if (!isModelPostExitCooldownReason(t.exitReason)) continue;
    const at = Number(t.closedAt);
    const score = Number.isFinite(at) ? at : -Infinity;
    if (score >= bestAt) {
      bestAt = score;
      best = t;
    }
  }
  if (!best || !Number.isFinite(bestAt)) return { ok: true };
  const elapsed = Number(now) - bestAt;
  if (elapsed < cd) {
    const remainSec = Math.max(1, Math.ceil((cd - elapsed) / 1000));
    const sym = String(best.symbol || '?').toUpperCase();
    const reason = String(best.exitReason || 'exit');
    return {
      ok: false,
      reason:
        `Waiting: global sit-out after ${sym} ${reason} (~${remainSec}s left) — ` +
        `lets the regime settle before any new entry.`,
    };
  }
  return { ok: true };
}

/** Entry-tiered settle TP/stale exits (default on). Off → stop + hold to settlement only. */
function isSettleTieredExitsEnabled(config = {}) {
  const v = config.settleTieredExits;
  if (v === false || v === 0 || v === '0') return false;
  const s = String(v == null ? 'on' : v).toLowerCase();
  return !(s === 'off' || s === 'false' || s === 'no');
}

/**
 * Single source of truth for settle entry → TP / stale-green table.
 * Dashboard reads this via /api/bot/config; settleExitPlan uses the same rows.
 * Edit here when changing tiers — UI updates automatically on next config load.
 */
const SETTLE_EXIT_TIERS = [
  {
    minEntry: 90,
    maxEntry: 99,
    targetCents: null,
    staleMinutesLeft: null,
    tier: 'hold',
    entryLabel: '≥90¢',
    aimLabel: 'hold to settle',
    staleLabel: '—',
  },
  {
    minEntry: 85,
    maxEntry: 89,
    targetCents: 96,
    staleMinutesLeft: 2,
    tier: 'high',
    entryLabel: '85–89¢',
    aimLabel: '96¢',
    staleLabel: '≤2m left',
  },
  {
    minEntry: 80,
    maxEntry: 84,
    targetCents: 94,
    staleMinutesLeft: 2.5,
    tier: 'mid',
    entryLabel: '80–84¢',
    aimLabel: '94¢',
    staleLabel: '≤2.5m left',
  },
  {
    minEntry: 75,
    maxEntry: 79,
    targetCents: 93,
    staleMinutesLeft: 3,
    tier: 'low',
    entryLabel: '75–79¢',
    aimLabel: '93¢',
    staleLabel: '≤3m left',
  },
  // Late / deep entries: lower absolute TPs so we bank +10–18¢ instead of chasing 92.
  {
    minEntry: 70,
    maxEntry: 74,
    targetCents: 88,
    staleMinutesLeft: 2.5,
    tier: 'late',
    entryLabel: '70–74¢ (late)',
    aimLabel: '88¢',
    staleLabel: '≤2.5m left',
  },
  {
    minEntry: 1,
    maxEntry: 69,
    targetCents: 85,
    staleMinutesLeft: 4,
    tier: 'deep',
    entryLabel: '<70¢ (late)',
    aimLabel: '85¢',
    staleLabel: '≤4m left',
  },
];

/**
 * After bid tags 90¢, if this many minutes or fewer remain until close, skip
 * TP / stuck / stale and hold to settlement. Stop-loss still applies.
 * With more than 3:30 left after tagging 90, tier exits can still bank.
 */
const SETTLE_TOUCHED90_HOLD_MINUTES = 3.5;
/** Settle weak-ticket confirm: once held bid tags this, lean-switch exit turns off. */
const SETTLE_WEAK_CONFIRM_CENTS = 80;

/** After a live IOC miss, skip that coin+side this long before retrying (default 3.5s). */
const ENTRY_MISS_COOLDOWN_MS = 3_500;

function entryMissKey(symbol, side = null) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  const s = String(side || '').toLowerCase();
  if (s === 'yes' || s === 'no') return `${sym}:${s}`;
  // No side → legacy whole-coin key (tests / clear-all helpers).
  return sym;
}

function isYesNoSide(side) {
  const s = String(side || '').toLowerCase();
  return s === 'yes' || s === 'no';
}

/** Human label for post-stop review (trade log / activity). */
function stopVerdictLabel(verdict) {
  const v = String(verdict || '');
  if (v === 'prevented_loss') return 'Stop helped — prevented further loss';
  if (v === 'missed_opportunity') return 'Missed opportunity — would have recovered';
  if (v === 'mixed') return 'Stop outcome unclear';
  if (v === 'pending') return 'Checking after stop…';
  return '';
}

/**
 * Official Kalshi result after a stop: if our side won settlement we missed the
 * bounce; if it lost we avoided riding to 0.
 */
function classifyStopVerdictFromResult(side, result) {
  const s = String(side || '').toLowerCase();
  const r = String(result || '').toLowerCase();
  if ((s !== 'yes' && s !== 'no') || (r !== 'yes' && r !== 'no')) return null;
  return s === r ? 'missed_opportunity' : 'prevented_loss';
}

/**
 * Bid path after a stop when no official result yet.
 * Continued weakness vs exit → prevented; recovery to/above entry → missed.
 */
function classifyStopVerdictFromBids({
  entryCents,
  exitCents,
  postMinBid = null,
  postMaxBid = null,
  lastBid = null,
} = {}) {
  const entry = Math.round(Number(entryCents));
  const exit = Math.round(Number(exitCents));
  const minB = Number.isFinite(Number(postMinBid)) ? Math.round(Number(postMinBid)) : null;
  const maxB = Number.isFinite(Number(postMaxBid)) ? Math.round(Number(postMaxBid)) : null;
  const last = Number.isFinite(Number(lastBid)) ? Math.round(Number(lastBid)) : null;
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return null;

  if (last != null) {
    if (last <= exit - 2) return 'prevented_loss';
    if (last >= entry) return 'missed_opportunity';
  }
  if (minB != null && minB <= exit - 5) return 'prevented_loss';
  if (maxB != null && maxB >= entry) return 'missed_opportunity';
  if (last != null || minB != null || maxB != null) return 'mixed';
  return null;
}

/** Retrospect lookback for strategy-mode light (red=edge / green=settle). */
const STRATEGY_RETRO_SHORT_MS = 2 * 60 * 60 * 1000;
const STRATEGY_RETRO_LONG_MS = 12 * 60 * 60 * 1000;
const STRATEGY_RETRO_MIN_TRADES = 3;
/** Sample bucketing only (not applied as open-window knobs). */
const STRATEGY_RETRO_LATE_CUTOFF_MINUTES = 5.5;
const STRATEGY_RETRO_MID_CEILING_MINUTES = 8.5;
/** Edge: never buy above this ask (¢). */
const EDGE_MAX_ENTRY_DEFAULT_CENTS = 95;
/** Model: never buy richer than this (leaves a little room to 100). */
const MODEL_MAX_ENTRY_DEFAULT_CENTS = 88;
/** Model: never buy cheaper than this (normal floor). 65¢ OK only with low-ask conviction. */
const MODEL_MIN_ENTRY_DEFAULT_CENTS = 65;
/** Absolute floor even when the call is “perfect.” */
const MODEL_PERFECT_MIN_ENTRY_DEFAULT_CENTS = 65;
/** Asks at/below this need near-certain direction (under the 70¢ half-stake line). */
const MODEL_LOW_ASK_CEILING_CENTS_DEFAULT = 69;
/** Min engine conf for low-ask (≤69¢) entries. 0 = off (use normal min conf only). */
const MODEL_LOW_ASK_MIN_CONFIDENCE_DEFAULT = 0;
/** Live favor pts required for low-ask conviction (UP ≥ DOWN + N). */
const MODEL_LOW_ASK_LIVE_FAVOR_DEFAULT = 4;
/** Held-side live prob % required for low-ask conviction. */
const MODEL_LOW_ASK_HELD_PROB_DEFAULT = 72;
/** Min Kalshi ask (¢) that marks a clear market favorite. 0 = off. */
const MODEL_KALSHI_FAVORITE_CENTS_DEFAULT = 75;

/**
 * When one Kalshi ask is clearly rich (≥ threshold) and the other is the
 * cheap complement, that rich side is the market favorite. Engine lean must
 * not chase the longshot while the book is priced this skewed.
 */
function modelKalshiFavoriteCents(config = {}) {
  const n = Number(config.modelKalshiFavoriteCents);
  if (Number.isFinite(n) && n <= 0) return 0;
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return MODEL_KALSHI_FAVORITE_CENTS_DEFAULT;
}

function modelKalshiFavoriteSide(market, config = {}) {
  const floor = modelKalshiFavoriteCents(config);
  if (!(floor > 0) || !market) return null;
  const yesAsk = Number(market.yes_ask);
  let noAsk = Number(market.no_ask);
  if (!Number.isFinite(noAsk) || noAsk < 1 || noAsk > 99) {
    const yesBid = Number(market.yes_bid);
    if (Number.isFinite(yesBid) && yesBid >= 1 && yesBid <= 99) {
      noAsk = 100 - yesBid;
    }
  }
  const yesOk = Number.isFinite(yesAsk) && yesAsk >= 1 && yesAsk <= 99;
  const noOk = Number.isFinite(noAsk) && noAsk >= 1 && noAsk <= 99;
  if (!yesOk && !noOk) return null;
  const yesRich = yesOk && yesAsk >= floor;
  const noRich = noOk && noAsk >= floor;
  // Clear favorite: only one side is rich.
  if (yesRich && !noRich) return 'yes';
  if (noRich && !yesRich) return 'no';
  return null;
}

/**
 * Block chasing the cheap longshot while Kalshi clearly prices the other
 * side ≥ favorite floor (default 75¢).
 */
function modelKalshiFavoriteGate({ market, side, priceCents, config = {} } = {}) {
  const favorite = modelKalshiFavoriteSide(market, config);
  if (!favorite) return { ok: true, skipped: true };
  const want = String(side || '').toLowerCase();
  if (want !== 'yes' && want !== 'no') return { ok: true, skipped: true };
  if (want === favorite) return { ok: true, favorite };
  const floor = modelKalshiFavoriteCents(config);
  const ask = Math.round(Number(priceCents));
  return {
    ok: false,
    favorite,
    reason:
      `Kalshi prices ${favorite.toUpperCase()} ≥${floor}¢ favorite — ` +
      `not chasing ${want.toUpperCase()}` +
      (Number.isFinite(ask) ? ` @ ${ask}¢` : '') +
      ' longshot',
  };
}

/** Default model-entry cutoff. It must sit outside the 2-minute late-exit zone. */
const MODEL_MIN_MINUTES_TO_OPEN_DEFAULT = 2.5;
/** Confidence required to allow entries below the normal min. */
const MODEL_PERFECT_CONFIDENCE_DEFAULT = 80;
/** Lean strength (|probUp−50|) required for perfect-entry exception. */
const MODEL_PERFECT_LEAN_DEFAULT = 15;
/** Model confidence floor default. */
const MODEL_MIN_CONFIDENCE_DEFAULT = 55;
/** Trail off peak — unused by simplified Model exits (kept for config compat). */
const MODEL_TRAIL_CENTS_DEFAULT = 0;
/** Soft lean margin — 52/48 counts as mushy for stagnation (was 2). */
const MODEL_SOFT_LEAN_MARGIN_DEFAULT = 3;
/** Soft dip (−N¢ + lean fade). 0 = off — price stops were hurting more than helping. */
const MODEL_MAX_ADVERSE_CENTS_DEFAULT = 0;
/** Hard cliff (−N¢ from entry). 0 = off — MODEL losses use stagnation + hard floor. */
const MODEL_HARD_ADVERSE_CENTS_DEFAULT = 0;
/** Paper fill ceiling on adverse exits. 0 = off (book live bid). */
const MODEL_MAX_LOSS_CENTS_DEFAULT = 0;
/**
 * Legacy rich-floor knob (default off). Hard floor 55 applies to all tickets
 * including 78+/80/85. Setting this below the hard floor can optionally allow
 * more room on very rich entries; values above hard floor are ignored.
 */
const MODEL_RICH_STOP_FLOOR_CENTS_DEFAULT = 0;
/** Absolute bid floor for all tickets — bid ≤ this stops immediately. */
const MODEL_HARD_STOP_FLOOR_CENTS_DEFAULT = 55;
/** Min entry ask − hard floor required to open (blocks 57¢ tickets when floor is 55). */
const MODEL_MIN_ROOM_TO_FLOOR_CENTS_DEFAULT = 10;
/** @deprecated mid-band folded into hard floor; kept for saved configs. */
const MODEL_MID_RICH_STOP_FLOOR_CENTS_DEFAULT = MODEL_HARD_STOP_FLOOR_CENTS_DEFAULT;
const MODEL_MID_RICH_ENTRY_MIN_CENTS_DEFAULT = 72;
const MODEL_MID_RICH_ENTRY_MAX_CENTS_DEFAULT = 77;
/** Rich (68¢) floor applies once entry is at least this (78¢ still uses hard 55). */
const MODEL_RICH_STOP_ENTRY_MIN_CENTS_DEFAULT = 80;
/** Prefer rich-floor widen when engine conf is at least this (or entry already rich). */
const MODEL_RICH_STOP_MIN_CONFIDENCE_DEFAULT = 70;
/** Asks at/above this → tighter spread + higher conf (rich tickets gap hard). */
const MODEL_RICH_ASK_CENTS_DEFAULT = 78;
/** Max ask−bid for rich asks (tighter than normal). */
const MODEL_RICH_MAX_SPREAD_CENTS_DEFAULT = 2;
/** Min confidence for rich asks (floors the global min). */
const MODEL_RICH_MIN_CONFIDENCE_DEFAULT = 55;
/** Edge: final-N-minute cash-out allows up to this much position PnL loss (¢). */
const EDGE_PRE_CLOSE_SMALL_LOSS_DEFAULT_CENTS = 75;
const EDGE_PRE_CLOSE_MINUTES_DEFAULT = 5;
/** Edge: after this many minutes held, stop rises to breakeven (entry). 0 = off. */
const EDGE_BREAKEVEN_AFTER_MINUTES_DEFAULT = 3;

/**
 * Live exits that must keep selling until flat — not a one-shot GTC that can
 * sit unfilled while the signal fades. Includes stop + MODEL/edge cash-outs.
 */
function isForceRetryExitReason(reason) {
  const r = String(reason || '').toLowerCase();
  return (
    r === 'stop_loss' ||
    r === 'take_profit' ||
    r === 'breakeven' ||
    r === 'model_against' ||
    r === 'model_stagnation' ||
    r === 'model_rapid_adverse' ||
    r === 'model_late_exit' ||
    r === 'model_pre_close' ||
    r === 'model_lean_stop' ||
    r === 'model_lean_flip' ||
    r === 'near_certain' ||
    r === 'pre_close_bank' ||
    r === 'pre_close_small_loss' ||
    r === 'settle_stale' ||
    r === 'settle_stuck' ||
    r === 'settle_weak_switch' ||
    r === 'reversal_signal' ||
    r === 'signal_flip'
  );
}

function settleMinutesLeftAtOpen(trade) {
  const opened = Number(trade && trade.openedAt);
  const close = Number(trade && trade.windowCloseTime);
  if (!Number.isFinite(opened) || !Number.isFinite(close) || close <= opened) return null;
  return (close - opened) / 60000;
}

function isSettleClosedTrade(trade) {
  if (!trade || trade.status !== 'closed') return false;
  return isSettleTrade(trade) || String(trade.strategy || '').toLowerCase() === 'settle';
}

function summarizeSettleWindowSample(trades) {
  let wins = 0;
  let losses = 0;
  let netPnlCents = 0;
  let stopLike = 0;
  let late = [];
  let mid = [];
  for (const t of trades) {
    const pnl = Number(t.pnlCents) || 0;
    netPnlCents += pnl;
    if (pnl > 0) wins += 1;
    else losses += 1;
    const reason = String(t.exitReason || '');
    if (reason === 'stop_loss' || reason === 'settle_weak_switch') stopLike += 1;
    const mins = settleMinutesLeftAtOpen(t);
    if (mins == null) continue;
    if (mins <= STRATEGY_RETRO_LATE_CUTOFF_MINUTES) late.push(pnl);
    else if (mins <= STRATEGY_RETRO_MID_CEILING_MINUTES) mid.push(pnl);
  }
  const n = trades.length;
  const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
  return {
    sampleSize: n,
    wins,
    losses,
    netPnlCents,
    winRatePct: n ? +((wins / n) * 100).toFixed(1) : null,
    stopLikeRatePct: n ? +((stopLike / n) * 100).toFixed(1) : null,
    lateCount: late.length,
    midCount: mid.length,
    lateAvgPnlCents: avg(late),
    midAvgPnlCents: avg(mid),
  };
}

/**
 * Map retrospect light → strategy mode (red=edge, green=settle).
 */
function strategyModeForLight(light) {
  const L = String(light || '').toLowerCase();
  if (L === 'red' || L === 'edge') return 'edge';
  if (L === 'green' || L === 'settle') return 'settle';
  return null;
}

/** Minutes of 1m candles used for live regime scoring. */
const MARKET_REGIME_WINDOW_MINUTES = 15;
/** Median 15m range % above this → choppy/active → prefer edge. */
const MARKET_REGIME_EDGE_RANGE_PCT = 0.35;
/** Path efficiency at/below this (net/range) → two-way chop → edge. */
const MARKET_REGIME_EDGE_EFFICIENCY_MAX = 0.4;
/** Median 15m range % at/below this → quiet → prefer settle (with one-sidedness). */
const MARKET_REGIME_SETTLE_RANGE_PCT = 0.22;
/** Path efficiency at/above this → one-sided → settle. */
const MARKET_REGIME_SETTLE_EFFICIENCY_MIN = 0.55;
const MARKET_REGIME_MIN_SYMBOLS = 2;

/**
 * Score one symbol's last ~15 one-minute candles.
 * rangePct = (high−low)/mid · 100
 * efficiency = |close−open| / (high−low)  (1 = one-sided, ~0 = round-trip chop)
 */
function scoreSymbolFifteenMinuteWindow(candles, { now = Date.now() } = {}) {
  const rows = (Array.isArray(candles) ? candles : []).filter(
    (c) => c && Number.isFinite(Number(c.high)) && Number.isFinite(Number(c.low))
  );
  if (rows.length < 8) return null;
  const cutoff = Number(now) - MARKET_REGIME_WINDOW_MINUTES * 60 * 1000;
  const window = rows.filter((c) => {
    const t = Number(c.time);
    return !Number.isFinite(t) || t >= cutoff;
  });
  const use = window.length >= 8 ? window : rows.slice(-MARKET_REGIME_WINDOW_MINUTES);
  if (use.length < 8) return null;

  let high = -Infinity;
  let low = Infinity;
  for (const c of use) {
    high = Math.max(high, Number(c.high));
    low = Math.min(low, Number(c.low));
  }
  const open = Number(use[0].open != null ? use[0].open : use[0].close);
  const close = Number(use[use.length - 1].close);
  if (![high, low, open, close].every((x) => Number.isFinite(x) && x > 0)) return null;
  if (high < low) return null;

  const mid = (high + low) / 2;
  const range = high - low;
  const rangePct = mid > 0 ? (range / mid) * 100 : 0;
  const netPct = mid > 0 ? (Math.abs(close - open) / mid) * 100 : 0;
  const efficiency = range > 0 ? Math.min(1, Math.abs(close - open) / range) : 1;

  // Minute-close direction flips — extra chop signal.
  let flips = 0;
  let prevSign = 0;
  for (let i = 1; i < use.length; i += 1) {
    const a = Number(use[i - 1].close);
    const b = Number(use[i].close);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) continue;
    const sign = Math.sign(b - a);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) flips += 1;
    if (sign !== 0) prevSign = sign;
  }
  const flipRate = use.length > 1 ? flips / (use.length - 1) : 0;

  return {
    rangePct: +rangePct.toFixed(4),
    netPct: +netPct.toFixed(4),
    efficiency: +efficiency.toFixed(4),
    flipRate: +flipRate.toFixed(4),
    candleCount: use.length,
  };
}

function median(nums) {
  const a = (nums || []).filter((n) => Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Live Coinbase regime across symbols → red/edge (volatile/chop) or green/settle (calm + one-sided).
 */
function scoreMarketRegime(candlesBySymbol, { now = Date.now() } = {}) {
  const perSymbol = {};
  const ranges = [];
  const effs = [];
  const flips = [];
  for (const [sym, candles] of Object.entries(candlesBySymbol || {})) {
    const scored = scoreSymbolFifteenMinuteWindow(candles, { now });
    if (!scored) continue;
    perSymbol[sym] = scored;
    ranges.push(scored.rangePct);
    effs.push(scored.efficiency);
    flips.push(scored.flipRate);
  }
  const n = ranges.length;
  if (n < MARKET_REGIME_MIN_SYMBOLS) {
    return {
      ready: false,
      light: 'neutral',
      suggestedMode: null,
      reason: `Need ≥${MARKET_REGIME_MIN_SYMBOLS} symbols with ~15m candle history (have ${n}).`,
      symbolCount: n,
      perSymbol,
      medianRangePct: null,
      medianEfficiency: null,
      medianFlipRate: null,
    };
  }

  const medianRangePct = +median(ranges).toFixed(4);
  const medianEfficiency = +median(effs).toFixed(4);
  const medianFlipRate = +median(flips).toFixed(4);

  let light = 'neutral';
  let reason = '';

  const volatile =
    medianRangePct >= MARKET_REGIME_EDGE_RANGE_PCT ||
    medianEfficiency <= MARKET_REGIME_EDGE_EFFICIENCY_MAX ||
    medianFlipRate >= 0.45;
  const calmOneSided =
    medianRangePct <= MARKET_REGIME_SETTLE_RANGE_PCT &&
    medianEfficiency >= MARKET_REGIME_SETTLE_EFFICIENCY_MIN;

  if (volatile && !calmOneSided) {
    light = 'red';
    reason =
      `Markets look active/choppy over the last ${MARKET_REGIME_WINDOW_MINUTES}m ` +
      `(median range ${medianRangePct.toFixed(2)}%, path efficiency ${medianEfficiency.toFixed(2)}) → prefer edge.`;
  } else if (calmOneSided && !volatile) {
    light = 'green';
    reason =
      `Markets look calm and one-sided over the last ${MARKET_REGIME_WINDOW_MINUTES}m ` +
      `(median range ${medianRangePct.toFixed(2)}%, path efficiency ${medianEfficiency.toFixed(2)}) → prefer settle.`;
  } else if (volatile && calmOneSided) {
    // Conflicting signals — lean edge if range is elevated.
    if (medianRangePct >= MARKET_REGIME_EDGE_RANGE_PCT) {
      light = 'red';
      reason =
        `Mixed regime but range is elevated (${medianRangePct.toFixed(2)}%) → prefer edge.`;
    } else {
      light = 'green';
      reason =
        `Mixed regime but path is one-sided (efficiency ${medianEfficiency.toFixed(2)}) → prefer settle.`;
    }
  } else {
    reason =
      `Mixed 15m regime (range ${medianRangePct.toFixed(2)}%, efficiency ${medianEfficiency.toFixed(2)}) — leave mode as-is.`;
  }

  return {
    ready: true,
    light,
    suggestedMode: strategyModeForLight(light),
    reason,
    symbolCount: n,
    perSymbol,
    medianRangePct,
    medianEfficiency,
    medianFlipRate,
  };
}

/**
 * Retrospect strategy-mode light: prefer live 15m market regime (volatile→edge,
 * calm one-sided→settle). Falls back to recent settle-trade health when candles
 * are thin or regime is mixed.
 */
function recommendSettleOpenWindow(
  trades,
  { now = Date.now(), currentMode = null, candlesBySymbol = null } = {}
) {
  const modeNow = String(currentMode || '').toLowerCase();
  const currentStrategyMode = modeNow === 'edge' || modeNow === 'settle' ? modeNow : null;

  const regime = candlesBySymbol ? scoreMarketRegime(candlesBySymbol, { now }) : null;
  if (regime && regime.ready && (regime.light === 'red' || regime.light === 'green')) {
    return {
      light: regime.light,
      suggestedMode: regime.suggestedMode,
      currentStrategyMode,
      lookbackHours: null,
      reason: regime.reason,
      stats: null,
      regime,
    };
  }

  const all = (Array.isArray(trades) ? trades : []).filter(isSettleClosedTrade);
  const pickSince = (ms) => all.filter((t) => Number(t.closedAt) >= now - ms);
  let lookbackHours = 2;
  let sample = pickSince(STRATEGY_RETRO_SHORT_MS);
  if (sample.length < STRATEGY_RETRO_MIN_TRADES) {
    lookbackHours = 12;
    sample = pickSince(STRATEGY_RETRO_LONG_MS);
  }
  const stats = summarizeSettleWindowSample(sample);

  if (stats.sampleSize < STRATEGY_RETRO_MIN_TRADES) {
    const baseReason =
      regime && regime.reason
        ? `${regime.reason} Also need ≥${STRATEGY_RETRO_MIN_TRADES} closed settle trades for trade-book fallback (have ${stats.sampleSize}).`
        : `Need ≥${STRATEGY_RETRO_MIN_TRADES} closed settle trades in the last ${lookbackHours}h (have ${stats.sampleSize}).`;
    return {
      light: 'neutral',
      suggestedMode: null,
      currentStrategyMode,
      lookbackHours,
      reason: baseReason,
      stats,
      regime,
    };
  }

  let light = 'neutral';
  let reason = '';

  if (stats.midCount >= 2 && stats.lateCount >= 2) {
    const midAvg = stats.midAvgPnlCents;
    const lateAvg = stats.lateAvgPnlCents;
    if (midAvg != null && lateAvg != null && midAvg > lateAvg + 5) {
      light = 'green';
      reason =
        `Settle trade-book: mid-window opens beat late over ${lookbackHours}h ` +
        `(avg $${(midAvg / 100).toFixed(2)} vs $${(lateAvg / 100).toFixed(2)}) → prefer settle.`;
    } else if (midAvg != null && lateAvg != null && lateAvg > midAvg + 5) {
      light = 'red';
      reason =
        `Settle trade-book: late opens beat mid-window over ${lookbackHours}h ` +
        `(avg $${(lateAvg / 100).toFixed(2)} vs $${(midAvg / 100).toFixed(2)}) → prefer edge.`;
    }
  }

  if (light === 'neutral') {
    const stopRate = stats.stopLikeRatePct != null ? stats.stopLikeRatePct : 0;
    const net = stats.netPnlCents;
    if (net < 0 || stopRate >= 45) {
      light = 'red';
      reason =
        `Settle trade-book is rough over ${lookbackHours}h ` +
        `(net $${(net / 100).toFixed(2)}, stop/weak ${stopRate.toFixed(0)}%) → prefer edge.`;
    } else if (net > 0 && (stats.winRatePct == null || stats.winRatePct >= 55) && stopRate < 40) {
      light = 'green';
      reason =
        `Settle trade-book is healthy over ${lookbackHours}h ` +
        `(net $${(net / 100).toFixed(2)}, win ${stats.winRatePct ?? '—'}%) → prefer settle.`;
    } else {
      reason =
        (regime && regime.reason ? `${regime.reason} ` : '') +
        `Settle trade-book mixed over ${lookbackHours}h (net $${(net / 100).toFixed(2)}, ` +
        `stop/weak ${stopRate.toFixed(0)}%) — leave mode as-is.`;
    }
  }

  return {
    light,
    suggestedMode: strategyModeForLight(light),
    currentStrategyMode,
    lookbackHours,
    reason,
    stats,
    regime,
  };
}

/**
 * Closed-trade P&L buckets for the last N clock hours (local), oldest → newest.
 */
function buildHourlyPnlBuckets(trades, { hours = 6, now = Date.now() } = {}) {
  const n = Math.max(1, Math.min(24, Math.floor(Number(hours) || 6)));
  const end = Number(now);
  const hourMs = 60 * 60 * 1000;
  const currentHourStart = Math.floor(end / hourMs) * hourMs;
  const buckets = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const hourStartMs = currentHourStart - i * hourMs;
    const d = new Date(hourStartMs);
    const label = d.toLocaleString(undefined, { hour: 'numeric' });
    buckets.push({
      hourStartMs,
      hourEndMs: hourStartMs + hourMs,
      label,
      pnlCents: 0,
      trades: 0,
    });
  }
  const rangeStart = buckets[0].hourStartMs;
  for (const t of trades || []) {
    if (!t || t.status !== 'closed') continue;
    const at = Number(t.closedAt);
    if (!Number.isFinite(at) || at < rangeStart || at > end) continue;
    const idx = Math.floor((at - rangeStart) / hourMs);
    if (idx < 0 || idx >= buckets.length) continue;
    buckets[idx].pnlCents += Number(t.pnlCents) || 0;
    buckets[idx].trades += 1;
  }
  return buckets;
}

function settleExitTiersForDashboard() {
  return SETTLE_EXIT_TIERS.map((t) => ({
    entryLabel: t.entryLabel,
    aimLabel: t.aimLabel,
    staleLabel: t.staleLabel,
    tier: t.tier,
    targetCents: t.targetCents,
    staleMinutesLeft: t.staleMinutesLeft,
  }));
}

/**
 * Entry-tiered settle exits: target bid depends on fill price; if that target
 * is not reached by `staleMinutesLeft` remaining, bank a green bid instead of
 * sitting for settlement. Tiers live in SETTLE_EXIT_TIERS (keep dashboard in sync).
 */
function settleExitPlan(entryPriceCents) {
  const entry = Math.round(Number(entryPriceCents));
  if (!Number.isFinite(entry) || entry < 1) {
    return { targetCents: null, staleMinutesLeft: null, tier: 'invalid' };
  }
  for (const t of SETTLE_EXIT_TIERS) {
    if (entry >= t.minEntry && entry <= t.maxEntry) {
      return {
        targetCents: t.targetCents,
        staleMinutesLeft: t.staleMinutesLeft,
        tier: t.tier,
        entry,
      };
    }
  }
  const late = SETTLE_EXIT_TIERS[SETTLE_EXIT_TIERS.length - 1];
  return {
    targetCents: late.targetCents,
    staleMinutesLeft: late.staleMinutesLeft,
    tier: late.tier,
    entry,
  };
}

// Settings that can be safely edited at runtime (via the API/dashboard)
// without a restart. Deliberately excludes `mode` — switching paper/live
// stays an env-var + restart decision, so a UI can never silently flip on
// real trading.
const EDITABLE_NUMERIC_FIELDS = [
  'edgeThresholdPct',
  'minConfidence',
  'stopLossCents',
  'takeProfitCents',
  'nearCertainExitCents',
  'minEntryCents',
  'maxEntryCents',
  'edgePreCloseSmallLossCents',
  'edgePreCloseMinutes',
  'edgeBreakevenAfterMinutes',
  'minMinutesToOpen',
  'stopRecoveryCents',
  'stopRecoveryMaxMinutes',
  'peerCascadeMaxMinutes',
  'postStopMaxOneMinutes',
  'postStopSameSideCooldownMinutes',
  'settlePostStopSameSideCooldownMinutes',
  'settlePostStaleSameSideCooldownMinutes',
  'settleEntryMinCents',
  'settleEntryMaxCents',
  'settleNoEntryMinCents',
  'settleStopLossCents',
  'settleMinMinutesToOpen',
  'settleMaxMinutesToOpen',
  'settleLateEntryMinutes',
  'settleLateEntryMinCents',
  'settleRichAskFloorCents',
  'settleMinUpsideCents',
  'settleStuckHoldMinutes',
  'modelMinConfidence',
  'modelMaxEntryCents',
  'modelMinEntryCents',
  'modelLowAskMinConfidence',
  'modelLowAskCeilingCents',
  'modelLowAskLiveFavorPts',
  'modelLowAskHeldProbMin',
  'modelKalshiFavoriteCents',
  'modelLowPriceMaxCents',
  'modelLowPriceStakeQuarters',
  'modelConfirmCrossCents',
  'modelConfirmMaxExtensionCents',
  'modelConfirmMinContinueCents',
  'modelPerfectMinEntryCents',
  'modelPerfectConfidence',
  'modelPerfectLeanPts',
  'modelMinTpCents',
  'modelBankGreenCents',
  'modelNearTargetBankCents',
  'modelSettleCloseLossCents',
  'modelSettleCloseMinutes',
  'modelLateBarrierMinutes',
  'modelPreCloseForceMinutes',
  'modelLateExtendMinConfidence',
  'modelMomentumStallSeconds',
  'modelMomentumPullbackCents',
  'modelLiveLeanMarginPct',
  'modelExtremeLiveLeanExitPct',
  'modelEntryLiveLeanMarginPct',
  'modelMinEntryLeanPct',
  'modelSoftLeanMarginPct',
  'modelSignalDominanceMin',
  'modelTrailCents',
  'modelMaxAdverseCents',
  'modelHardAdverseCents',
  'modelMaxLossCents',
  'modelHardStopFloorCents',
  'modelMinRoomToFloorCents',
  'modelRichStopFloorCents',
  'modelMidRichStopFloorCents',
  'modelRichStopEntryMinCents',
  'modelRichStopMinConfidence',
  'modelSideSwitchConfirmMs',
  'modelSideSwitchConfirmTicks',
  'modelDumpPullbackCents',
  'modelFastRedCents',
  'modelStagnationSeconds',
  'modelStagnationMinProgressCents',
  'modelRapidAdverseCents',
  'modelBeChaseSeconds',
  'modelLeanDecayDropPts',
  'modelLeanDecayStallSeconds',
  'modelLeanDecayFloor',
  'modelLeanStopBarrierCents',
  'modelLeanStopPaceDrawdownPct',
  'modelLeanStopPaceMinSampleSeconds',
  'modelLeanStopPaceArmCents',
  'modelLeanStopMinAdverseCents',
  'modelRichAskCents',
  'modelRichMaxSpreadCents',
  'modelRichMinConfidence',
  'modelMinHoldSeconds',
  'modelPostExitCooldownSeconds',
  'modelPostExitCooldownMinutes',
  'modelGlobalPostExitCooldownSeconds',
  'modelPostLeanStopCooldownMinutes',
  'modelLeanAgainstBeSeconds',
  'modelOpenGraceMs',
  'modelMaxEntrySpreadCents',
  'modelMinMinutesToOpen',
  'modelAutoSwitchLowAvailDollars',
  'modelAutoSwitchMinLeadDollars',
  'modelAutoSwitchCooldownMinutes',
  'stakeDollars',
  'maxOpenPositions',
  'skimPercent',
  'skimFixedDollars',
  'insuranceCapDollars',
  'insuranceFloorDollars',
  'insuranceOverflowDollars',
  'paperStartingBalanceDollars',
  'dailyLossLimitDollars',
];

// ─────────────────────────────────────────────────────────────────────────────
// DAILY LOSS LIMIT — change this number to adjust the default kill-switch level.
// Set to 0 in config to disable entirely.
// ─────────────────────────────────────────────────────────────────────────────
const DAILY_LOSS_LIMIT_DEFAULT_DOLLARS = 5.00;

/** Default arm ($10) / floor ($6) for insurance hysteresis; soft fill ceiling ($15). */
const INSURANCE_ARM_DEFAULT = 10;
const INSURANCE_FLOOR_DEFAULT = 6;
const INSURANCE_OVERFLOW_DEFAULT = 15;
/** Auto-switch live MODEL setup when Available is low and a shadow is climbing. */
const MODEL_AUTO_SWITCH_LOW_AVAIL_DEFAULT = 20;
const MODEL_AUTO_SWITCH_MIN_LEAD_DEFAULT = 5;
const MODEL_AUTO_SWITCH_COOLDOWN_MINUTES_DEFAULT = 60;

/**
 * Resolve arm/floor cents. Floor must be strictly below arm — clamp if not.
 */
function insuranceArmFloorCents(settings = {}) {
  const armDollars = Number.isFinite(Number(settings.insuranceCapDollars))
    ? Number(settings.insuranceCapDollars)
    : INSURANCE_ARM_DEFAULT;
  let floorDollars = Number.isFinite(Number(settings.insuranceFloorDollars))
    ? Number(settings.insuranceFloorDollars)
    : INSURANCE_FLOOR_DEFAULT;
  const armCents = Math.max(0, Math.round(armDollars * 100));
  let floorCents = Math.max(0, Math.round(floorDollars * 100));
  if (floorCents >= armCents) {
    floorCents = armCents >= 100 ? armCents - 100 : Math.max(0, armCents - 1);
  }
  return { armCents, floorCents };
}

/** Soft ceiling for the 20% win skim (cents). Fund may sit above via manual seed. */
function insuranceOverflowCents(settings = {}) {
  const dollars = Number.isFinite(Number(settings.insuranceOverflowDollars))
    ? Number(settings.insuranceOverflowDollars)
    : INSURANCE_OVERFLOW_DEFAULT;
  return Math.max(0, Math.round(dollars * 100));
}

/** Sticky ready: arm on ≥ arm, disarm below floor, else keep prior flag. */
function syncInsuranceReady(balanceCents, ready, armCents, floorCents) {
  const bal = Number(balanceCents) || 0;
  if (bal >= armCents) return true;
  if (bal < floorCents) return false;
  return !!ready;
}

/** Floor for settle stop — blocks accidental 1–2¢ stops from UI fat-fingers. */
const SETTLE_STOP_LOSS_MIN_CENTS = 8;
/** Ceiling for settle stop — widest ride through wicks (UI max −60¢). */
const SETTLE_STOP_LOSS_MAX_CENTS = 60;
const SETTLE_STOP_LOSS_DEFAULT_CENTS = 50;

function normalizeSettleStopLossCents(config) {
  if (!config || typeof config !== 'object') return config;
  let n = Number(config.settleStopLossCents);
  if (!Number.isFinite(n)) n = SETTLE_STOP_LOSS_DEFAULT_CENTS;
  config.settleStopLossCents = Math.max(
    SETTLE_STOP_LOSS_MIN_CENTS,
    Math.min(SETTLE_STOP_LOSS_MAX_CENTS, Math.round(n))
  );
  return config;
}

/** Clamp config knobs so floor stays strictly below arm; normalize overflow. */
function normalizeInsuranceThresholds(config) {
  if (!config || typeof config !== 'object') return config;
  let arm = Number(config.insuranceCapDollars);
  let floor = Number(config.insuranceFloorDollars);
  let overflow = Number(config.insuranceOverflowDollars);
  if (!Number.isFinite(arm) || arm < 0) arm = INSURANCE_ARM_DEFAULT;
  if (!Number.isFinite(floor) || floor < 0) floor = INSURANCE_FLOOR_DEFAULT;
  if (!Number.isFinite(overflow) || overflow < 0) overflow = INSURANCE_OVERFLOW_DEFAULT;
  if (floor >= arm) {
    floor = arm >= 1 ? arm - 1 : 0;
  }
  // Overflow is a soft fill ceiling — keep it at least at arm so hysteresis still makes sense.
  if (overflow < arm) overflow = arm;
  config.insuranceCapDollars = arm;
  config.insuranceFloorDollars = floor;
  config.insuranceOverflowDollars = overflow;
  return config;
}

/**
 * Cents the held-side bid must bounce above the stop-exit before same-side
 * re-entry. 0 disables the gate. Unset/invalid → ~40% of the stop distance
 * (min 5¢) — a recovery check, not a timer.
 */
function stopRecoveryCentsRequired(config = {}) {
  const configured = Number(config.stopRecoveryCents);
  if (Number.isFinite(configured) && configured <= 0) return 0;
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured);
  return Math.max(5, Math.round((Number(config.stopLossCents) || 10) * 0.4));
}

/** Market session end for a trade (live ledger or backtest). */
function tradeWindowCloseMs(trade) {
  if (!trade) return NaN;
  const raw = trade.windowCloseTime ?? trade.closeTime;
  let stored = Number(raw);
  if ((!Number.isFinite(stored) || stored <= 0) && raw != null && raw !== '') {
    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed) && parsed > 0) stored = parsed;
  }
  if (Number.isFinite(stored) && stored > 0) return stored;
  const opened = Number(trade.openedAt);
  if (Number.isFinite(opened) && opened > 0) return opened + 15 * 60 * 1000;
  return NaN;
}

/** True once the stopped trade's 15m window has ended — recovery gate clears. */
function isPostStopRecoverySessionExpired(lastStopTrade, now = Date.now()) {
  const windowEnd = tradeWindowCloseMs(lastStopTrade);
  return Number.isFinite(windowEnd) && Number(now) >= windowEnd;
}

/**
 * After a stop-loss, require the *stopped coin's* bid to bounce before new
 * entries (any coin) — prevents instant cascade / loss strings while price
 * is still running against the stopped side **within the same window**.
 *
 * Thesis favor (engine still likes the stopped side) only gates knife-catch
 * re-entry on that same coin + same side. Peer coins (and opposite-side on
 * the stopped coin) unlock once the bounce clears — otherwise a flipped
 * thesis freezes *all* trading until the stopped coin re-favors a side the
 * market already rejected. Call `checkPostStopPeerCascade` *before* this
 * bounce check so cascading peers block everyone first.
 *
 * Same-coin same-side also gets a short sit-out after stop (`sameSideCooldownMs`,
 * default 2m from `closedAt`) even when bounce + thesis would allow — stops the
 * stop→instant re-entry→stop loop. Cooldown is from closedAt only (not cleared
 * by session/max-age); peers / opposite side are unaffected.
 *
 * Primary expiry: once the stopped trade's window closes (`windowCloseTime`),
 * recovery no longer blocks any new entries (next window / other coins).
 * Optional `maxAgeMs` + `closedAt` remains as a backup cap within long windows.
 *
 * `lastClosedForSymbol` should be the stop-loss trade (usually the latest stop).
 */
function checkPostStopRecovery({
  lastClosedForSymbol,
  side,
  priceCents,
  window,
  recoveryCents,
  symbol = '',
  forCandidateSymbol = null,
  forCandidateSide = null,
  maxAgeMs = 0,
  sameSideCooldownMs,
  now = Date.now(),
}) {
  const last = lastClosedForSymbol;
  // Gate uses the stopped trade's side (not necessarily the candidate side).
  if (!last || last.exitReason !== 'stop_loss') {
    return { ok: true };
  }

  // Same-side sit-out from closedAt — before session/max-age clear bounce gating.
  const cooldownMs =
    sameSideCooldownMs === undefined
      ? Math.round(POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES * 60 * 1000)
      : Number(sameSideCooldownMs);
  const sameSideCooldown = checkPostStopSameSideCooldown({
    lastStopTrade: last,
    forCandidateSymbol: forCandidateSymbol != null ? forCandidateSymbol : symbol || last.symbol,
    forCandidateSide: forCandidateSide != null ? forCandidateSide : side || last.side,
    cooldownMs,
    now,
  });
  if (!sameSideCooldown.ok) return sameSideCooldown;

  if (!recoveryCents || recoveryCents <= 0) return { ok: true };

  if (isPostStopRecoverySessionExpired(last, now)) {
    return { ok: true };
  }

  const closedAt = Number(last.closedAt);
  const ageCap = Number(maxAgeMs);
  if (
    Number.isFinite(ageCap) &&
    ageCap > 0 &&
    Number.isFinite(closedAt) &&
    Number(now) - closedAt >= ageCap
  ) {
    return { ok: true };
  }

  const stopSide = last.side;
  // `side` arg is the side we're quoting for recovery — should match stopSide.
  const checkSide = stopSide || side;
  const exit = Number(last.exitPriceCents);
  if (!Number.isFinite(exit)) return { ok: true };

  const needBid = Math.min(99, exit + recoveryCents);
  const price = Number(priceCents);
  const stoppedLabel = symbol || last.symbol || '';
  const candidateSym = forCandidateSymbol || null;
  const otherNote = candidateSym
    ? ` before any new entry on ${candidateSym}`
    : ' before any new entry';

  if (!Number.isFinite(price) || price < needBid) {
    return {
      ok: false,
      reason:
        `Waiting: ${stoppedLabel} ${String(checkSide).toUpperCase()} stopped @ ${exit}¢ — need ${stoppedLabel} bid ≥ ${needBid}¢ ` +
        `(+${recoveryCents}¢ bounce)${otherNote} (same-window cascade protection).`,
    };
  }

  // Bounce cleared. Thesis favor only for same-coin same-side knife-catch —
  // do not hold ETH/BTC/etc hostage waiting for SOL YES to become favored again.
  const stoppedSym = String(stoppedLabel || last.symbol || '').toUpperCase();
  const candSym = candidateSym != null ? String(candidateSym).toUpperCase() : stoppedSym;
  const candSide = forCandidateSide != null ? forCandidateSide : checkSide;
  const isSameCoinSameSide =
    candSym === stoppedSym && String(candSide).toLowerCase() === String(checkSide).toLowerCase();

  if (isSameCoinSameSide && window) {
    const up = Number(window.probabilityUp);
    const down = Number(window.probabilityDown);
    const favored =
      checkSide === 'yes'
        ? Number.isFinite(up) && Number.isFinite(down) && up >= down
        : Number.isFinite(up) && Number.isFinite(down) && down >= up;
    if (!favored) {
      return {
        ok: false,
        reason:
          `Waiting: ${stoppedLabel} bid recovered after stop, but engine no longer favors ` +
          `${String(checkSide).toUpperCase()} — skipping knife-catch on ${stoppedLabel}.`,
      };
    }
  }

  return { ok: true };
}

/** Minutes after a stop before recovery gating expires (0 = never by age). */
function stopRecoveryMaxAgeMs(config = {}) {
  const mins = Number(config.stopRecoveryMaxMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  // One Kalshi 15m window — bounce-or-expire, don't freeze across many cycles.
  return 15 * 60 * 1000;
}

/** Default / hard-max minutes for the peer-cascade calm gate (not full session). */
const PEER_CASCADE_DEFAULT_MINUTES = 3;
const PEER_CASCADE_HARD_MAX_MINUTES = 5;

/** Default minutes for post-stop max-1 concurrent open cap (then maxOpenPositions). */
const POST_STOP_MAX_ONE_DEFAULT_MINUTES = 1.5;

/** Default minutes for same-coin same-side sit-out after a stop (knife-catch delay). */
const POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES = 2;
/** Settle default is longer — late-bank knife-catch strings are especially toxic. */
const SETTLE_POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES = 2.5;

/**
 * How long after a stop the bot caps concurrent opens at 1 (even if
 * maxOpenPositions is higher). `postStopMaxOneMinutes: 0` disables the cap.
 * Unset/invalid → 1.5 minutes from the stop's closedAt (openedAt fallback).
 */
function postStopMaxOneAgeMs(config = {}) {
  const mins = Number(config.postStopMaxOneMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  return Math.round(POST_STOP_MAX_ONE_DEFAULT_MINUTES * 60 * 1000);
}

/**
 * Same-coin same-side sit-out after stop_loss (from closedAt). Blocks knife-catch
 * re-entry even when bounce + thesis would allow. `0` disables.
 * Settle mode: settlePostStopSameSideCooldownMinutes (default 2.5m) so a dump
 * cannot reopen the same side every few seconds. Edge: postStopSameSideCooldownMinutes (default 2m).
 */
function postStopSameSideCooldownMs(config = {}) {
  if (isSettleStrategyMode(config)) {
    const settleMins = Number(config.settlePostStopSameSideCooldownMinutes);
    if (Number.isFinite(settleMins) && settleMins <= 0) return 0;
    if (Number.isFinite(settleMins) && settleMins > 0) return Math.round(settleMins * 60 * 1000);
    return Math.round(SETTLE_POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES * 60 * 1000);
  }
  const mins = Number(config.postStopSameSideCooldownMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  return Math.round(POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES * 60 * 1000);
}

/**
 * Block same-symbol + same-side re-entry for `cooldownMs` after stop closedAt.
 * Peers and opposite side are unaffected. Missing closedAt fails open.
 */
function checkPostStopSameSideCooldown({
  lastStopTrade,
  forCandidateSymbol = null,
  forCandidateSide = null,
  cooldownMs = 0,
  now = Date.now(),
}) {
  return checkSameSideExitCooldown({
    lastTrade: lastStopTrade,
    exitReasons: ['stop_loss'],
    forCandidateSymbol,
    forCandidateSide,
    cooldownMs,
    now,
    reasonVerb: 'stopped',
  });
}

/**
 * Same-coin same-side sit-out after listed exit reasons (stop, settle_stale, …).
 * Blocks reopen churn (e.g. stale → reopen → stale in the same final minutes).
 */
function checkSameSideExitCooldown({
  lastTrade,
  exitReasons = ['stop_loss'],
  forCandidateSymbol = null,
  forCandidateSide = null,
  cooldownMs = 0,
  now = Date.now(),
  reasonVerb = 'exited',
}) {
  const maxMs = Number(cooldownMs);
  if (!Number.isFinite(maxMs) || maxMs <= 0) return { ok: true };
  if (!lastTrade || !exitReasons.includes(lastTrade.exitReason)) return { ok: true };

  const closedAt = Number(lastTrade.closedAt);
  if (!Number.isFinite(closedAt)) return { ok: true };

  const prevSym = String(lastTrade.symbol || '').toUpperCase();
  const candSym = String(forCandidateSymbol || '').toUpperCase();
  const prevSide = String(lastTrade.side || '').toLowerCase();
  const candSide = String(forCandidateSide || '').toLowerCase();
  if (!prevSym || !candSym || candSym !== prevSym || candSide !== prevSide) {
    return { ok: true };
  }

  if (Number(now) - closedAt >= maxMs) return { ok: true };

  const mins = maxMs / 60000;
  const minsLabel = Number.isInteger(mins) ? String(mins) : String(Math.round(mins * 10) / 10);
  const sideLabel = String(lastTrade.side || '').toUpperCase();
  const why = lastTrade.exitReason === 'stop_loss' ? 'stopped' : reasonVerb;
  return {
    ok: false,
    reason:
      `Waiting: ${lastTrade.symbol} ${sideLabel} ${why} (${lastTrade.exitReason}) — same-side sit-out ~${minsLabel}m ` +
      `before re-entry.`,
  };
}

/** Default minutes to sit out same side after settle_stale / settle take_profit. */
const SETTLE_POST_STALE_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES = 3;

/** Min time in trade before settle_stale may fire (avoids instant churn in final minutes). */
const SETTLE_STALE_MIN_HOLD_MS = 90_000;

/** Default: after this long parked near entry / small-green, bank or scratch (0 = off). */
const SETTLE_STUCK_HOLD_DEFAULT_MINUTES = 3;

function settleStuckHoldMs(config = {}) {
  const mins = Number(config.settleStuckHoldMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) {
    return Math.min(12, Math.max(1, mins)) * 60 * 1000;
  }
  return SETTLE_STUCK_HOLD_DEFAULT_MINUTES * 60 * 1000;
}

function settlePostStaleSameSideCooldownMs(config = {}) {
  const mins = Number(config.settlePostStaleSameSideCooldownMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  return Math.round(SETTLE_POST_STALE_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES * 60 * 1000);
}

/**
 * True while the latest closed trade is a stop_loss and we are still inside
 * the post-stop max-1 window. Missing timestamps fail open (no sticky cap).
 */
function isPostStopMaxOneActive(lastStopTrade, config = {}, now = Date.now()) {
  if (!lastStopTrade || lastStopTrade.exitReason !== 'stop_loss') return false;
  const maxAgeMs = postStopMaxOneAgeMs(config);
  if (maxAgeMs <= 0) return false;
  const ref = stopTradeReferenceMs(lastStopTrade);
  if (!Number.isFinite(ref)) return false;
  return now - ref < maxAgeMs;
}

/**
 * Peer-cascade calm gate must always age out quickly (shorter than bounce recovery).
 * Optional `peerCascadeMaxMinutes`; else min(stopRecoveryMaxMinutes, 3), default 3.
 * Always clamped to a hard max of 5 minutes — never a sticky full-window freeze.
 * Unlike bounce recovery, 0 / unset recovery max does NOT disable this cap.
 */
function peerCascadeMaxAgeMs(config = {}) {
  const dedicated = Number(config.peerCascadeMaxMinutes);
  let mins;
  if (Number.isFinite(dedicated) && dedicated > 0) {
    mins = dedicated;
  } else {
    const recoveryMins = Number(config.stopRecoveryMaxMinutes);
    if (Number.isFinite(recoveryMins) && recoveryMins > 0) {
      mins = Math.min(recoveryMins, PEER_CASCADE_DEFAULT_MINUTES);
    } else {
      mins = PEER_CASCADE_DEFAULT_MINUTES;
    }
  }
  mins = Math.min(Math.max(mins, 0.1), PEER_CASCADE_HARD_MAX_MINUTES);
  return Math.round(mins * 60 * 1000);
}

/** Stop timestamp for age gates — prefer closedAt, fall back to openedAt. */
function stopTradeReferenceMs(trade) {
  if (!trade) return NaN;
  const closed = Number(trade.closedAt);
  if (Number.isFinite(closed) && closed > 0) return closed;
  const opened = Number(trade.openedAt);
  if (Number.isFinite(opened) && opened > 0) return opened;
  return NaN;
}

/**
 * After a stop-loss, cryptos often cascade / whipsaw. Block ALL new entries
 * (any side, any coin) briefly while a majority of peer short windows are
 * still moving against the side that just stopped — same-window protection.
 *
 * Clears when: peers calm, stopped trade's session ends, or max age elapses
 * (default 3m, hard max 5m). Missing timestamps fail open so this cannot
 * freeze forever. Call before bounce recovery so cascading peers block
 * everyone even when the stopped coin has not bounced yet.
 */
function checkPostStopPeerCascade({
  lastStopTrade,
  candidateSide, // kept for API compat; gates apply regardless of side
  predictions,
  seriesBySymbol,
  minConfidence = 50,
  maxAgeMs = peerCascadeMaxAgeMs(),
  now = Date.now(),
}) {
  if (!lastStopTrade || lastStopTrade.exitReason !== 'stop_loss') return { ok: true };
  void candidateSide;

  if (isPostStopRecoverySessionExpired(lastStopTrade, now)) {
    return { ok: true };
  }

  const ageCap = Number(maxAgeMs);
  const requestedAgeCap =
    Number.isFinite(ageCap) && ageCap > 0 ? ageCap : peerCascadeMaxAgeMs();
  // Never let callers stretch cascade beyond the hard max (sticky freezes).
  const effectiveAgeCap = Math.min(
    requestedAgeCap,
    PEER_CASCADE_HARD_MAX_MINUTES * 60 * 1000
  );
  const stoppedAt = stopTradeReferenceMs(lastStopTrade);
  if (!Number.isFinite(stoppedAt)) {
    // No closedAt/openedAt — cannot bound the wait; fail open.
    return { ok: true };
  }
  const ageMs = Number(now) - stoppedAt;
  if (ageMs >= effectiveAgeCap) {
    return { ok: true };
  }

  if (!predictions || !seriesBySymbol) return { ok: true };

  const stoppedSym = lastStopTrade.symbol;
  const stopSide = String(lastStopTrade.side || '').toUpperCase();
  const peers = Object.keys(seriesBySymbol).filter(
    (sym) => sym !== stoppedSym && predictions[sym] && predictions[sym].ready
  );
  const peered = [];
  const adverse = [];
  for (const sym of peers) {
    const w5 = predictions[sym].windows && predictions[sym].windows.w5;
    if (!w5) continue;
    if (Number(w5.confidence) < Number(minConfidence)) continue;
    peered.push(sym);
    const against =
      lastStopTrade.side === 'yes'
        ? Number(w5.probabilityDown) > Number(w5.probabilityUp)
        : Number(w5.probabilityUp) > Number(w5.probabilityDown);
    if (against) adverse.push(sym);
  }
  if (peered.length === 0) return { ok: true };

  const need = Math.ceil(peered.length / 2);
  if (adverse.length >= need) {
    const remainMin = Math.max(1, Math.ceil((effectiveAgeCap - ageMs) / 60000));
    return {
      ok: false,
      reason:
        `Waiting: after ${stoppedSym} ${stopSide} stop — peers still cascading (same window); ` +
        `no new entries until calm, session end, or ~${remainMin}m max.`,
    };
  }
  return { ok: true };
}

/**
 * Profit split for skimMode === 'insurance':
 *   40% → Personal Wallet (locked paycheck — NEVER spent on entries or losses)
 *   20% → Insurance Fund (builds until insuranceOverflowDollars soft ceiling)
 *   40% → Active Bankroll (Available Cash)
 * Soft overflow: while fund ≥ overflow, the 20% skim stays in Available instead
 * (wallet still 40%). Partial fills up to the ceiling; remainder → Available.
 * Fund does not auto-empty at the ceiling — it stays as cushion.
 * Losses: sticky hysteresis — arm at insuranceCapDollars ($10), stay usable
 *         down to insuranceFloorDollars ($6). Absorb only while insuranceReady;
 *         below floor, disarm until balance ≥ arm again.
 * Invariant: Personal Wallet (reserveCents) is append-only — this function
 * never returns a lower reserve than it was given.
 */
function applyProfitBuckets({
  pnlCents,
  reserveCents = 0,
  insuranceCents = 0,
  insuranceReady = false,
  settings = {},
  rebuildInsurance = true,
}) {
  const pnl = Number(pnlCents) || 0;
  const lockedReserve = Math.max(0, Math.round(Number(reserveCents) || 0));
  let nextReserve = lockedReserve;
  let nextInsurance = Number(insuranceCents) || 0;
  const out = {
    reserveCents: nextReserve,
    insuranceCents: nextInsurance,
    skimmedCents: 0,
    insuranceAddedCents: 0,
    insuranceOverflowCents: 0,
    insuranceDrawnCents: 0,
    insuranceReleasedCents: 0,
    insuranceReady: !!insuranceReady,
  };

  const { armCents, floorCents } = insuranceArmFloorCents(settings);
  const overflowCapCents = insuranceOverflowCents(settings);

  if (settings.skimMode !== 'insurance') {
    if (pnl <= 0) {
      out.reserveCents = lockedReserve;
      return out;
    }
    if (settings.skimMode === 'off') {
      out.reserveCents = lockedReserve;
      return out;
    }
    let skimmed = 0;
    if (settings.skimMode === 'fixed') {
      skimmed = Math.min(Math.round(Number(settings.skimFixedDollars || 0) * 100), pnl);
    } else {
      skimmed = Math.round(pnl * (Number(settings.skimPercent) || 0) / 100);
    }
    out.skimmedCents = skimmed;
    out.reserveCents = lockedReserve + skimmed;
    return out;
  }

  let ready = syncInsuranceReady(nextInsurance, !!insuranceReady, armCents, floorCents);

  if (pnl < 0) {
    // Absorb uses sticky ready (not balance >= arm), so $7–$9.99 still pays.
    // Wallet is never drawn — only Insurance (when ready).
    if (ready && nextInsurance > 0) {
      const loss = -pnl;
      const drawn = Math.min(nextInsurance, loss);
      nextInsurance -= drawn;
      out.insuranceDrawnCents = drawn;
      out.insuranceCents = nextInsurance;
    }
    out.reserveCents = lockedReserve;
    out.insuranceReady = syncInsuranceReady(nextInsurance, ready, armCents, floorCents);
    return out;
  }
  if (pnl === 0) {
    out.reserveCents = lockedReserve;
    out.insuranceReady = ready;
    return out;
  }

  const wallet = Math.round(pnl * 0.4);
  // Take up to 20% into insurance when rebuilding, stopping at the soft overflow
  // ceiling. Arm threshold does not clip contributions; overflow does.
  // Remainder of the 20% stays in Available (not wallet).
  const desiredAdd = rebuildInsurance ? Math.round(pnl * 0.2) : 0;
  const room = Math.max(0, overflowCapCents - nextInsurance);
  const insuranceAdd = Math.min(desiredAdd, room);
  const overflowAdd = desiredAdd - insuranceAdd;
  nextInsurance += insuranceAdd;

  out.skimmedCents = wallet;
  out.insuranceAddedCents = insuranceAdd;
  out.insuranceOverflowCents = overflowAdd;
  out.reserveCents = lockedReserve + wallet;
  out.insuranceCents = nextInsurance;
  out.insuranceReady = syncInsuranceReady(nextInsurance, ready, armCents, floorCents);
  return out;
}

const EDITABLE_STRING_FIELDS = {
  symbol: (v) => {
    const s = String(v || '').toUpperCase();
    if (s === 'AUTO') return 'AUTO';
    return SERIES_BY_SYMBOL[s] ? s : null;
  },
  strategyMode: (v) =>
    (['edge', 'settle', 'model'].includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null),
  settleTieredExits: (v) => parseOnOffField(v, true),
  halfStakeNear: (v) => parseOnOffField(v, true),
  secondOpenRequiresGreen: (v) => parseOnOffField(v, true),
  tradeDoge: (v) => parseOnOffField(v, false),
  tradeNear: (v) => parseOnOffField(v, false),
  autoTradeSymbols: (v) => {
    const list = resolveAutoTradeSymbols({ autoTradeSymbols: v });
    return list.length ? list.join(',') : DEFAULT_AUTO_TRADE_SYMBOLS.join(',');
  },
  activeSetupId: (v) => {
    const s = String(v || '').toLowerCase();
    if (!s) return null;
    return MODEL_SETUPS.some((x) => x.id === s) ? s : null;
  },
  modelInvertSide: (v) => parseOnOffField(v, false),
  modelAutoSwitchSetup: (v) => parseOnOffField(v, false),
  // Silent paper books for non-live setups. Off = freeze (knobs / what-if stay).
  modelShadowBooks: (v) => parseOnOffField(v, false),
  skimMode: (v) => (['insurance', 'percent', 'fixed', 'off'].includes(v) ? v : null),
  stakingStrategy: (v) => (['fixed', 'halve-after-win'].includes(v) ? v : null),
};

// Runtime pause/resume toggle between paper and live, kept in its own
// small file separate from general settings so it's easy to audit or
// manually reset by just deleting one file. This is deliberately checked
// against `liveAuthorized` every time it's loaded, never trusted blindly —
// see loadModeState below.
function loadModeState() {
  try {
    if (fs.existsSync(MODE_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(MODE_STATE_PATH, 'utf8')).mode;
    }
  } catch {
    // fall through
  }
  return null;
}

function saveModeState(mode) {
  try {
    writeJsonAtomic(MODE_STATE_PATH, { mode });
  } catch (err) {
    console.error('[bot] failed to persist mode state:', err.message);
  }
}

function loadRunState() {
  try {
    if (fs.existsSync(RUN_STATE_PATH)) return JSON.parse(fs.readFileSync(RUN_STATE_PATH, 'utf8'));
  } catch {
    // A missing or corrupt runtime state simply starts the bot enabled.
  }
  return { isRunning: true, runningSince: Date.now() };
}

function saveRunState(state) {
  try {
    writeJsonAtomic(RUN_STATE_PATH, state);
  } catch (err) {
    console.error('[bot] failed to persist run state:', err.message);
  }
}

function loadConfigOverrides() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      // Stale saved settings from before a defaults bump — ignore knobs so
      // the new code defaults apply once, then the next boot/save rewrites.
      if (data.settingsVersion !== SETTINGS_DEFAULTS_VERSION) {
        console.log(
          `[bot] settings defaults v${SETTINGS_DEFAULTS_VERSION} — ignoring stale saved knobs (was v${data.settingsVersion ?? 'none'})`
        );
        return { settingsVersion: SETTINGS_DEFAULTS_VERSION };
      }
      return data;
    }
  } catch (err) {
    console.error('[bot] failed to load saved config, using defaults/env:', err.message);
  }
  return { settingsVersion: SETTINGS_DEFAULTS_VERSION };
}

function collectConfigOverrides(config) {
  const overrides = { settingsVersion: SETTINGS_DEFAULTS_VERSION };
  for (const field of EDITABLE_NUMERIC_FIELDS) overrides[field] = config[field];
  for (const field of Object.keys(EDITABLE_STRING_FIELDS)) overrides[field] = config[field];
  return overrides;
}

function saveConfigOverrides(overrides) {
  try {
    writeJsonAtomic(CONFIG_PATH, overrides);
  } catch (err) {
    console.error('[bot] failed to persist config:', err.message);
  }
}

function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      const data = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      if (data.reserveCents == null) data.reserveCents = 0;
      if (data.insuranceCents == null) data.insuranceCents = 0;
      if (data.insuranceReady == null) data.insuranceReady = false;
      if (data.insuranceDepositedCents == null) data.insuranceDepositedCents = 0;
      if (data.retainedClosedPnlCents == null) data.retainedClosedPnlCents = 0;
      if (data.periodStartTime == null) data.periodStartTime = Date.now();
      if (!Array.isArray(data.activityLog)) data.activityLog = [];
      return data;
    }
  } catch (err) {
    console.error('[bot] failed to load ledger, starting fresh:', err.message);
  }
  return {
    trades: [],
    reserveCents: 0,
    insuranceCents: 0,
    insuranceReady: false,
    insuranceDepositedCents: 0,
    retainedClosedPnlCents: 0,
    periodStartTime: Date.now(),
    activityLog: [],
  };
}

function saveLedger(ledger) {
  try {
    writeJsonAtomic(LEDGER_PATH, ledger);
  } catch (err) {
    // Non-fatal — on some hosts (e.g. free-tier Render) disk is ephemeral
    // across deploys anyway, so this is best-effort durability only.
    console.error('[bot] failed to persist ledger:', err.message);
  }
}

/**
 * Permanent trade history — survives the 12h live-ledger rotation.
 * Newest first. Never cleared by rotation (only by explicit paper reset).
 */
function loadTradeLog() {
  try {
    if (fs.existsSync(TRADE_LOG_PATH)) {
      const data = JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
      if (Array.isArray(data)) return data;
      if (Array.isArray(data.trades)) return data.trades;
    }
  } catch (err) {
    console.error('[bot] failed to load trade log:', err.message);
  }
  return [];
}

function saveTradeLog(trades) {
  try {
    writeJsonAtomic(TRADE_LOG_PATH, {
      updatedAt: new Date().toISOString(),
      count: trades.length,
      trades,
    });
  } catch (err) {
    console.error('[bot] failed to persist trade log:', err.message);
  }
}

function emptyShadowLedger() {
  return {
    trades: [],
    reserveCents: 0,
    insuranceCents: 0,
    insuranceReady: false,
    insuranceDepositedCents: 0,
    retainedClosedPnlCents: 0,
    periodStartTime: Date.now(),
    activityLog: [],
  };
}

function loadShadowBooks() {
  try {
    if (fs.existsSync(SHADOW_BOOKS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SHADOW_BOOKS_PATH, 'utf8'));
      if (data && data.books && typeof data.books === 'object') return data.books;
    }
  } catch (err) {
    console.error('[bot] failed to load shadow books:', err.message);
  }
  return Object.create(null);
}

function saveShadowBooks(books) {
  try {
    const out = Object.create(null);
    for (const [id, book] of Object.entries(books || {})) {
      if (!book || typeof book !== 'object') continue;
      out[id] = {
        setupId: id,
        ledger: book.ledger || emptyShadowLedger(),
        lastDecision: book.lastDecision || '',
        confirmGates: book.confirmGates || {},
        confirmArmed: Array.isArray(book.confirmArmed)
          ? book.confirmArmed
          : book.confirmArmed instanceof Set
            ? [...book.confirmArmed]
            : [],
        confirmArmedFlag: !!book.confirmArmedFlag,
        confirmStarted: Number(book.confirmStarted) || Date.now(),
        entryMissUntil: book.entryMissUntil || {},
        entryMissStreak: book.entryMissStreak || {},
        entryMissSessionClose: book.entryMissSessionClose || {},
      };
    }
    writeJsonAtomic(SHADOW_BOOKS_PATH, {
      updatedAt: new Date().toISOString(),
      books: out,
    });
  } catch (err) {
    console.error('[bot] failed to persist shadow books:', err.message);
  }
}

function summarizeShadowLedger(ledger, startingDollars = 100, settings = {}) {
  return summarizeLedgerCapital(ledger, startingDollars, settings);
}

/** Replay skim buckets so shadow avail matches live wallet/insurance rules. */
function rebuildLedgerSkimFromTrades(ledger, settings = {}) {
  if (!ledger || !Array.isArray(ledger.trades)) return ledger;
  let reserveCents = 0;
  let insuranceCents = 0;
  let insuranceReady = false;
  const closed = ledger.trades
    .filter((t) => t && t.status === 'closed')
    .sort((a, b) => (Number(a.closedAt) || 0) - (Number(b.closedAt) || 0));
  for (const t of closed) {
    const flow = applyProfitBuckets({
      pnlCents: Number(t.pnlCents) || 0,
      reserveCents,
      insuranceCents,
      insuranceReady,
      settings,
      rebuildInsurance: true,
    });
    reserveCents = flow.reserveCents;
    insuranceCents = flow.insuranceCents;
    insuranceReady = flow.insuranceReady;
  }
  ledger.reserveCents = reserveCents;
  ledger.insuranceCents = insuranceCents;
  ledger.insuranceReady = insuranceReady;
  return ledger;
}

function summarizeLedgerCapital(ledger, startingDollars = 100, settings = {}) {
  const trades = Array.isArray(ledger && ledger.trades) ? ledger.trades : [];
  const closed = trades.filter((t) => t && t.status === 'closed');
  const open = trades.filter((t) => t && t.status === 'open');
  const pnlCents = closed.reduce((sum, t) => sum + (Number(t.pnlCents) || 0), 0);
  const wins = closed.filter((t) => (Number(t.pnlCents) || 0) > 0).length;
  const openExposureCents = open.reduce(
    (sum, t) => sum + (Number(t.entryPriceCents) || 0) * (Number(t.contracts) || 0),
    0
  );
  const startingCents = Math.max(0, Math.round(Number(startingDollars) * 100) || 0);
  const insuranceDepositedCents = Number(ledger && ledger.insuranceDepositedCents) || 0;

  let reserveCents = 0;
  let insuranceCents = 0;
  let insuranceReady = false;
  const closedChrono = [...closed].sort(
    (a, b) => (Number(a.closedAt) || 0) - (Number(b.closedAt) || 0)
  );
  for (const t of closedChrono) {
    const flow = applyProfitBuckets({
      pnlCents: Number(t.pnlCents) || 0,
      reserveCents,
      insuranceCents,
      insuranceReady,
      settings,
      rebuildInsurance: true,
    });
    reserveCents = flow.reserveCents;
    insuranceCents = flow.insuranceCents;
    insuranceReady = flow.insuranceReady;
  }

  const paperTotalCents = startingCents + pnlCents + insuranceDepositedCents;
  const paperAvailableCents = Math.max(
    0,
    paperTotalCents - reserveCents - insuranceCents - openExposureCents
  );
  return {
    pnlCents,
    trades: closed.length,
    wins,
    winRatePct: closed.length ? +((wins / closed.length) * 100).toFixed(1) : null,
    openCount: open.length,
    openSymbols: open
      .map((t) => String(t.symbol || '').toUpperCase())
      .filter(Boolean)
      .join(','),
    startingCents,
    paperTotalCents,
    reserveCents,
    insuranceCents,
    insuranceDepositedCents,
    insuranceReady,
    openExposureCents,
    paperAvailableCents,
  };
}

function upsertTradeLog(entry) {
  if (!entry || !entry.id) return;
  const trades = loadTradeLog();
  const idx = trades.findIndex((t) => t.id === entry.id);
  if (idx >= 0) {
    trades[idx] = { ...trades[idx], ...entry, updatedAt: Date.now() };
  } else {
    trades.unshift({ ...entry, updatedAt: Date.now() });
  }
  if (trades.length > TRADE_LOG_MAX) trades.length = TRADE_LOG_MAX;
  saveTradeLog(trades);
}

function clearTradeLog({ archive = true, keepTrades = null } = {}) {
  const existing = loadTradeLog();
  if (archive && existing.length) {
    try {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const fileName = `trade-log-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeJsonAtomic(path.join(ARCHIVE_DIR, fileName), {
        archivedAt: new Date().toISOString(),
        trades: existing,
      });
    } catch (err) {
      console.error('[bot] failed to archive trade log before clear:', err.message);
    }
  }
  const kept = Array.isArray(keepTrades) ? keepTrades : [];
  saveTradeLog(kept);
}

/** Newest-first closed trades (non-shadow), capped for paper-reset retention. */
function pickRecentClosedTradeSamples(trades, keep = PAPER_RESET_KEEP_SAMPLES) {
  const n = Math.max(0, Math.floor(Number(keep) || 0));
  if (n <= 0) return [];
  const closed = (Array.isArray(trades) ? trades : [])
    .filter((t) => t && t.status === 'closed' && !t.shadow)
    .slice()
    .sort((a, b) => {
      const ta = Number(a.closedAt) || Number(a.openedAt) || 0;
      const tb = Number(b.closedAt) || Number(b.openedAt) || 0;
      return tb - ta;
    });
  const out = [];
  const seen = new Set();
  for (const t of closed) {
    const id = String(t.id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

/** Rebuild bot probability-bucket calibration from a closed-trade sample. */
function rebuildCalibrationFromTrades(trades) {
  const buckets = {};
  for (const trade of trades || []) {
    if (!trade || trade.status !== 'closed') continue;
    if (trade.engineProbability == null) continue;
    const bucketKey = String(Math.min(90, Math.floor(Number(trade.engineProbability) / 10) * 10));
    if (!Number.isFinite(Number(bucketKey))) continue;
    if (!buckets[bucketKey]) buckets[bucketKey] = { trades: 0, wins: 0 };
    buckets[bucketKey].trades += 1;
    if (Number(trade.pnlCents) > 0) buckets[bucketKey].wins += 1;
  }
  return { buckets };
}

/**
 * Watches Kalshi's rolling KXBTC15M market, compares the engine's own
 * probability estimate against Kalshi's live implied odds, and opens a
 * position when there's a meaningful edge — closing it either when the
 * user's stop-loss triggers (odds on the held side fall to the configured
 * cents threshold) or when the market itself settles.
 *
 * Runs in one of two modes, controlled entirely by config the caller passes
 * in — this module never decides on its own to go live:
 *   - paper: everything is simulated against live Kalshi prices, no real
 *     order is ever sent.
 *   - live: real orders are placed via the provided KalshiClient.
 */
class TradingBot {
  constructor({ kalshiClient, config }) {
    this.client = kalshiClient;
    this.config = {
      symbol: 'AUTO',
      // 'settle' | 'edge' | 'model' (engine UP/DOWN → YES/NO by window schedule).
      strategyMode: 'model',
      edgeThresholdPct: 1, // minimum probability-point edge vs Kalshi to bother trading
      minConfidence: 55, // engine confidence (0-100) required to act (Edge tab)
      stopLossCents: 23, // exit if held bid falls this many cents below entry
      takeProfitCents: 15, // exit if held bid rises this many cents above entry (see final-5 override)
      nearCertainExitCents: 97, // if held bid reaches this, bank it — don't wait on settlement for the last few ¢
      minEntryCents: 40, // never buy a side cheaper than this — blocks longshot lottery tickets
      maxEntryCents: EDGE_MAX_ENTRY_DEFAULT_CENTS, // edge: never buy richer than this
      edgePreCloseSmallLossCents: EDGE_PRE_CLOSE_SMALL_LOSS_DEFAULT_CENTS,
      edgePreCloseMinutes: EDGE_PRE_CLOSE_MINUTES_DEFAULT,
      edgeBreakevenAfterMinutes: EDGE_BREAKEVEN_AFTER_MINUTES_DEFAULT,
      minMinutesToOpen: 3, // don't open when fewer than this many minutes remain in the window
      // Model tab: window schedule + locked lean; confidence floor; max entry 88¢.
      modelMinConfidence: MODEL_MIN_CONFIDENCE_DEFAULT,
      modelMaxEntryCents: MODEL_MAX_ENTRY_DEFAULT_CENTS,
      modelMinEntryCents: MODEL_MIN_ENTRY_DEFAULT_CENTS,
      modelLowAskMinConfidence: MODEL_LOW_ASK_MIN_CONFIDENCE_DEFAULT,
      modelLowAskCeilingCents: MODEL_LOW_ASK_CEILING_CENTS_DEFAULT,
      modelLowAskLiveFavorPts: MODEL_LOW_ASK_LIVE_FAVOR_DEFAULT,
      modelLowAskHeldProbMin: MODEL_LOW_ASK_HELD_PROB_DEFAULT,
      modelKalshiFavoriteCents: MODEL_KALSHI_FAVORITE_CENTS_DEFAULT,
      modelLowPriceMaxCents: MODEL_UNCERTAIN_MAX_PRICE_CENTS_DEFAULT,
      modelLowPriceStakeQuarters: MODEL_LOW_PRICE_STAKE_QUARTERS_DEFAULT,
      modelConfirmCrossCents: MODEL_CONFIRM_CROSS_CENTS_DEFAULT,
      modelConfirmMaxExtensionCents: MODEL_CONFIRM_MAX_EXTENSION_CENTS_DEFAULT,
      modelConfirmMinContinueCents: MODEL_CONFIRM_MIN_CONTINUE_CENTS_DEFAULT,
      modelInvertSide: 'off', // fade: lock UP→buy NO, DOWN→buy YES
      modelPerfectMinEntryCents: MODEL_PERFECT_MIN_ENTRY_DEFAULT_CENTS,
      modelPerfectConfidence: MODEL_PERFECT_CONFIDENCE_DEFAULT,
      modelPerfectLeanPts: MODEL_PERFECT_LEAN_DEFAULT,
      modelMinTpCents: MODEL_MIN_TP_CENTS_DEFAULT,
      modelBankGreenCents: MODEL_BANK_GREEN_CENTS_DEFAULT,
      modelNearTargetBankCents: MODEL_NEAR_TARGET_BANK_CENTS_DEFAULT,
      modelSettleCloseLossCents: MODEL_SETTLE_CLOSE_UNLESS_LOSS_CENTS_DEFAULT,
      modelSettleCloseMinutes: MODEL_SETTLE_CLOSE_MINUTES_DEFAULT,
      modelLateBarrierMinutes: MODEL_LATE_BARRIER_MINUTES_DEFAULT,
      modelPreCloseForceMinutes: MODEL_PRE_CLOSE_FORCE_MINUTES_DEFAULT,
      modelLateExtendMinConfidence: MODEL_LATE_EXTEND_MIN_CONFIDENCE_DEFAULT,
      modelMomentumStallSeconds: MODEL_MOMENTUM_STALL_MS_DEFAULT / 1000,
      modelMomentumPullbackCents: MODEL_MOMENTUM_PULLBACK_CENTS_DEFAULT,
      modelStagnationSeconds: MODEL_STAGNATION_SECONDS_DEFAULT,
      modelStagnationMinProgressCents: MODEL_STAGNATION_MIN_PROGRESS_CENTS_DEFAULT,
      modelRapidAdverseCents: MODEL_RAPID_ADVERSE_CENTS_DEFAULT,
      modelBeChaseSeconds: MODEL_BE_CHASE_SECONDS_DEFAULT,
      modelLiveLeanMarginPct: MODEL_LIVE_LEAN_MARGIN_DEFAULT,
      modelExtremeLiveLeanExitPct: MODEL_EXTREME_LIVE_LEAN_EXIT_PCT_DEFAULT,
      modelEntryLiveLeanMarginPct: MODEL_ENTRY_LIVE_LEAN_MARGIN_DEFAULT,
      modelMinEntryLeanPct: MODEL_MIN_ENTRY_LEAN_PCT_DEFAULT,
      modelSoftLeanMarginPct: MODEL_SOFT_LEAN_MARGIN_DEFAULT,
      modelSignalDominanceMin: MODEL_SIGNAL_DOMINANCE_MIN_DEFAULT,
      modelTrailCents: MODEL_TRAIL_CENTS_DEFAULT,
      modelMaxAdverseCents: MODEL_MAX_ADVERSE_CENTS_DEFAULT,
      modelHardAdverseCents: MODEL_HARD_ADVERSE_CENTS_DEFAULT,
      modelMaxLossCents: MODEL_MAX_LOSS_CENTS_DEFAULT,
      modelHardStopFloorCents: MODEL_HARD_STOP_FLOOR_CENTS_DEFAULT,
      modelMinRoomToFloorCents: MODEL_MIN_ROOM_TO_FLOOR_CENTS_DEFAULT,
      modelLeanStopBarrierCents: MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT,
      modelLeanStopPaceDrawdownPct: MODEL_LEAN_STOP_PACE_DRAWDOWN_PCT_DEFAULT,
      modelLeanStopPaceMinSampleSeconds: MODEL_LEAN_STOP_PACE_MIN_SAMPLE_MS_DEFAULT / 1000,
      modelLeanStopPaceArmCents: MODEL_LEAN_STOP_PACE_ARM_CENTS_DEFAULT,
      modelRichStopFloorCents: MODEL_RICH_STOP_FLOOR_CENTS_DEFAULT,
      modelMidRichStopFloorCents: MODEL_MID_RICH_STOP_FLOOR_CENTS_DEFAULT,
      modelRichStopEntryMinCents: MODEL_RICH_STOP_ENTRY_MIN_CENTS_DEFAULT,
      modelRichStopMinConfidence: MODEL_RICH_STOP_MIN_CONFIDENCE_DEFAULT,
      modelRichAskCents: MODEL_RICH_ASK_CENTS_DEFAULT,
      modelRichMaxSpreadCents: MODEL_RICH_MAX_SPREAD_CENTS_DEFAULT,
      modelRichMinConfidence: MODEL_RICH_MIN_CONFIDENCE_DEFAULT,
      modelMinHoldSeconds: MODEL_MIN_HOLD_MS_DEFAULT / 1000,
      modelPostExitCooldownSeconds: MODEL_POST_EXIT_COOLDOWN_MS_DEFAULT / 1000,
      modelPostExitCooldownMinutes: MODEL_POST_EXIT_COOLDOWN_MS_DEFAULT / 60000,
      modelGlobalPostExitCooldownSeconds: MODEL_GLOBAL_POST_EXIT_COOLDOWN_MS_DEFAULT / 1000,
      modelPostLeanStopCooldownMinutes: MODEL_POST_LEAN_STOP_COOLDOWN_MS_DEFAULT / 60000,
      modelLeanAgainstBeSeconds: MODEL_LEAN_AGAINST_BE_MS_DEFAULT / 1000,
      modelOpenGraceMs: MODEL_OPEN_GRACE_MS_DEFAULT,
      modelMaxEntrySpreadCents: MODEL_MAX_ENTRY_SPREAD_CENTS_DEFAULT,
      modelMinMinutesToOpen: MODEL_MIN_MINUTES_TO_OPEN_DEFAULT,
      // After stop-loss: require this many ¢ of bid bounce before re-entry (0 = off).
      // Null/unset uses stopRecoveryCentsRequired() (~40% of stop, min 5¢).
      stopRecoveryCents: 6,
      // Clear the whole post-stop recovery gate this many minutes after the stop
      // (even if the bid never bounced). 0 = never expire by age. Default 15.
      stopRecoveryMaxMinutes: 15,
      // Peer-cascade calm gate max wait (minutes). Short post-stop protection;
      // default 3, hard-clamped to 5 — never a sticky full-session freeze.
      peerCascadeMaxMinutes: 3,
      // After a stop, cap concurrent opens at 1 for this many minutes (from
      // closedAt), then normal maxOpenPositions applies. 0 = disable max-1.
      postStopMaxOneMinutes: 1.5,
      // Same-coin same-side sit-out after stop_loss (from closedAt), even when
      // bounce + thesis would allow knife-catch. 0 = off. Default 2 minutes.
      postStopSameSideCooldownMinutes: 2,
      // Settle strategy: buy ask in [min,max]¢; tiered target/stale exit by entry
      // (see settleExitPlan), else hold to official settlement.
      settleEntryMinCents: 80,
      settleEntryMaxCents: 94, // includes ≥90¢ hold-to-settle through 94¢
      // NO can enter from this floor (default matches primary min when min is 80).
      settleNoEntryMinCents: 80,
      // Default 50¢; UI max 60¢ — ride reversible wicks; hard gaps can still fill worse.
      settleStopLossCents: SETTLE_STOP_LOSS_DEFAULT_CENTS,
      // Reject asks with less upside to 100 than this. Independent of stop. 0 = off.
      settleMinUpsideCents: 6, // allows 94¢ (6¢ to 100); 95¢+ still blocked
      settleMinMinutesToOpen: 0.5, // still need a little time; 0 = allow until last seconds
      settleMaxMinutesToOpen: 8.5, // don't open too early in the 15m window
      // Settle same-side sit-out after stop (knife-catch delay).
      settlePostStopSameSideCooldownMinutes: 2.5,
      // After settle_stale / settle TP: don't reopen same coin+side for a few minutes.
      settlePostStaleSameSideCooldownMinutes: 3,
      // Late fallback: if nothing in primary band and ≤ this many min left, allow down to late min.
      settleLateEntryMinutes: 2.5,
      settleLateEntryMinCents: 70,
      // Entry-tiered TP/stale (settleExitPlan). 'off' = stop + hold to settlement only.
      settleTieredExits: 'on',
      // After this many minutes parked flat (±1¢) or small-green (+2..+5¢ under target), exit.
      // 0 = off. Does not apply to ≥90¢ hold-to-settle tier.
      settleStuckHoldMinutes: 3,
      // AUTO settle: prefer asks below this before 95¢+ “almost certain” tickets.
      settleRichAskFloorCents: 95,
      stakeDollars: 3, // how much money to risk per trade; contracts are computed from this at entry time
      // Settle NEAR only: risk half stake (thinner book / choppier). Other coins full size.
      halfStakeNear: 'on',
      stakingStrategy: 'fixed', // 'fixed' | 'halve-after-win' — see _computeNextStake for the logic
      maxOpenPositions: 1, // Core: one ticket at a time
      // With ≥1 open: only allow another if an existing hold is green (bid ≥ entry).
      // Model ignores this — windows + confirm gate decide.
      secondOpenRequiresGreen: 'on',
      // AUTO universe — which coins may open (default BTC/ETH). Editable in settings.
      autoTradeSymbols: DEFAULT_AUTO_TRADE_SYMBOLS.join(','),
      activeSetupId: 'core',
      modelAutoSwitchSetup: 'off',
      modelShadowBooks: 'off',
      modelAutoSwitchLowAvailDollars: MODEL_AUTO_SWITCH_LOW_AVAIL_DEFAULT,
      modelAutoSwitchMinLeadDollars: MODEL_AUTO_SWITCH_MIN_LEAD_DEFAULT,
      modelAutoSwitchCooldownMinutes: MODEL_AUTO_SWITCH_COOLDOWN_MINUTES_DEFAULT,
      // Legacy opt-in flags (kept in sync from autoTradeSymbols when saved).
      tradeDoge: 'off',
      tradeNear: 'off',
      skimMode: 'insurance', // 'insurance' | 'percent' | 'fixed' | 'off'
      skimPercent: 50, // used when skimMode === 'percent'
      skimFixedDollars: 5, // used when skimMode === 'fixed'
      // Insurance fund (skimMode === 'insurance'): 20% fund / 40% wallet / 40% bankroll
      // Hysteresis: arm at insuranceCapDollars, stay usable down to insuranceFloorDollars.
      // Soft fill ceiling: insuranceOverflowDollars — excess 20% skim → Available.
      insuranceCapDollars: INSURANCE_ARM_DEFAULT,
      insuranceFloorDollars: INSURANCE_FLOOR_DEFAULT,
      insuranceOverflowDollars: INSURANCE_OVERFLOW_DEFAULT,
      dailyLossLimitDollars: DAILY_LOSS_LIMIT_DEFAULT_DOLLARS, // kill-switch: halt new entries when day P&L hits this loss
      paperStartingBalanceDollars: 100, // trading bankroll (also the capital backing paper trades)
      mode: 'paper', // 'paper' | 'live'
      liveAuthorized: false,
      ...config,
      ...loadConfigOverrides(), // saved runtime edits win over env/defaults, except `mode`/`liveAuthorized`
    };
    normalizeInsuranceThresholds(this.config);
    normalizeSettleStopLossCents(this.config);
    if (this.config.symbol !== 'AUTO' && !isKalshiTradeEnabled(this.config.symbol, this.config)) {
      console.warn(
        `[bot] ${this.config.symbol} is opted out of trading — switching symbol to AUTO`
      );
      this.config.symbol = 'AUTO';
    }
    // `liveAuthorized` is a fixed ceiling for this process's lifetime — it
    // must only ever come from the server's own startup env-var gate.
    this.config.liveAuthorized = config.liveAuthorized === true;

    // The actual active mode CAN be toggled at runtime (paper<->live) via
    // the dashboard, but only ever within the ceiling above. If a previous
    // pause/resume choice was persisted, respect it — but only when we're
    // currently authorized; a stale "live" file from a differently
    // configured previous boot can never silently take effect.
    const persistedMode = loadModeState();
    if (this.config.liveAuthorized && persistedMode === 'paper') {
      this.config.mode = 'paper'; // an intentional pause was saved — respect it
    } else if (this.config.liveAuthorized) {
      this.config.mode = config.mode; // no saved pause, or saved 'live' — use the boot-time value
    } else {
      this.config.mode = 'paper'; // not authorized at all — always paper, full stop
    }

    this.ledger = loadLedger();
    this.calibration = loadCalibration();
    this.lastError = null;
    this.lastDecision = 'Waiting for a prediction cycle.';
    // Live Kalshi strikes for the prediction engine (distance-to-target + session key).
    // Filled as markets are fetched; server merges these into buildPredictions.
    this._engineStrikeTargets = Object.create(null);
    // Symbol → timestamp until which we demote after a live entry fill miss
    // (try other cryptos first, then allow retry). Streak resets when that
    // coin's Kalshi session ends (or on a successful fill / any close).
    this._entryMissUntil = Object.create(null);
    this._entryMissStreak = Object.create(null);
    this._entryMissSessionClose = Object.create(null);
    // Model confirm gate: ticker:side → { seenBelow, armed, crossAsk, peakAsk, lastAsk, closeTime }
    this._modelConfirmGates = Object.create(null);
    // Per-market direction: wait after a lean flip before bidding (time-left scaled).
    this._modelSideSwitchGates = Object.create(null);
    // Per-symbol: confirm only after THAT coin completes a MODEL buy+sell opened
    // in this process (leftover settles / other coins must not arm it).
    this._modelConfirmArmedSymbols = new Set();
    this._modelConfirmProcessStartedAt = Date.now();
    // Legacy flag kept for tests / status; prefer _modelConfirmArmedSymbols.
    this._modelConfirmGateArmed = false;
    const runState = loadRunState();
    this.isRunning = runState.isRunning !== false;
    this.runningSince = this.isRunning ? (Number(runState.runningSince) || Date.now()) : null;
    this.liveBalanceCents = null;
    this.livePortfolioValueCents = null;
    this.liveBalanceUpdatedAt = null;
    // Last post-stop protection gate logged to activity (dedupe poll spam).
    this._lastProtectionGateKey = null;
    this._lastProtectionGateSymbol = null;
    // Serialize manage/settle so watchdog + cycle can't double-sell the same leg.
    this._tradeLock = Promise.resolve();
    this._tradeLockDepth = 0;
    this._tradeLockInner = Promise.resolve();
    this._shadowBooks = loadShadowBooks();
    this._rebuildAllShadowLedgerSkim();
    this._inShadow = false;
    this._shadowDirty = false;
    this._setupAvailSnapshots = Object.create(null);
    this._lastAutoSetupSwitchAt = 0;
    this._lastAutoSwitchNote = null;
    this._inRunCycle = false;
    this._lastLiveMarket = Object.create(null);
    this._lastLiveMarketAt = Object.create(null);
    this._loadKalshiSeriesCacheFromDisk();
    this._removeInvalidPaperTrades();
    this._seedTradeLogFromLedger();
    this._repairRetainedClosedPnlFromTradeLog();
    // Always flush the effective settings so a reboot reloads exactly what
    // this process is running (env defaults and/or last dashboard save).
    saveConfigOverrides(collectConfigOverrides(this.config));
    saveRunState({ isRunning: this.isRunning, runningSince: this.runningSince });
  }

  /** One-time backfill so existing ledger trades appear in the permanent log. */
  _seedTradeLogFromLedger() {
    const log = loadTradeLog();
    if (log.length > 0) return;
    const fromLedger = (this.ledger.trades || []).filter((t) => t && t.id);
    if (!fromLedger.length) return;
    saveTradeLog(fromLedger.map((t) => ({ ...t, updatedAt: Date.now() })));
    console.log(`[bot] seeded permanent trade log with ${fromLedger.length} existing ledger trade(s)`);
  }

  /**
   * Runtime pause/resume between paper and live. Switching TO live is only
   * ever allowed if this.config.liveAuthorized is true (set once at server
   * startup from the KALSHI_LIVE_TRADING + KALSHI_LIVE_TRADING_CONFIRM env
   * vars) — this method can never raise that ceiling, only operate within
   * it. Switching to paper is always allowed, as an immediate safety valve.
   */
  setMode(requestedMode) {
    if (requestedMode !== 'paper' && requestedMode !== 'live') {
      return { ok: false, message: `Invalid mode '${requestedMode}'.` };
    }
    if (requestedMode === 'live' && !this.config.liveAuthorized) {
      return {
        ok: false,
        message:
          'Live trading is not authorized on this server. Set KALSHI_LIVE_TRADING=true and ' +
          'KALSHI_LIVE_TRADING_CONFIRM=I_UNDERSTAND_THE_RISK as environment variables (plus valid ' +
          'Kalshi credentials) and restart — this cannot be enabled from the dashboard alone.',
      };
    }
    this.config.mode = requestedMode;
    saveModeState(requestedMode);
    this._logActivity(`Switched to ${requestedMode} mode.`, { kind: 'mode' });
    this._persist();
    return { ok: true, mode: this.config.mode };
  }

  setRunning(requestedRunning) {
    if (typeof requestedRunning !== 'boolean') return { ok: false, message: 'running must be true or false.' };
    this.isRunning = requestedRunning;
    this.runningSince = requestedRunning ? Date.now() : null;
    saveRunState({ isRunning: this.isRunning, runningSince: this.runningSince });
    this.lastDecision = requestedRunning ? 'Bot started; it will evaluate new entries on the next server cycle.' : 'Bot stopped; no new positions will be opened.';
    this._logActivity(this.lastDecision, { kind: requestedRunning ? 'start' : 'stop' });
    this._persist();
    return { ok: true, isRunning: this.isRunning, runningSince: this.runningSince, message: this.lastDecision };
  }

  /**
   * Runtime-editable settings update (e.g. from the dashboard's settings
   * panel). Silently ignores any field not recognized as editable — in
   * particular, `mode` can never be changed this way.
   */
  updateConfig(partial) {
    const applied = {};
    for (const field of EDITABLE_NUMERIC_FIELDS) {
      if (partial[field] == null) continue;
      const num = Number(partial[field]);
      if (Number.isNaN(num)) continue;
      this.config[field] = num;
      applied[field] = num;
    }
    for (const [field, validate] of Object.entries(EDITABLE_STRING_FIELDS)) {
      if (partial[field] == null) continue;
      const value = validate(partial[field]);
      if (value == null) continue;
      this.config[field] = value;
      applied[field] = value;
    }
    normalizeInsuranceThresholds(this.config);
    normalizeSettleStopLossCents(this.config);
    // Model: no sub-floor "perfect" longshots — perfect floor tracks min entry slider.
    if (applied.modelMinEntryCents != null) {
      const minE = Number(this.config.modelMinEntryCents);
      if (Number.isFinite(minE) && minE > 0) {
        this.config.modelPerfectMinEntryCents = minE;
        applied.modelPerfectMinEntryCents = minE;
      }
    }
    if (applied.settleStopLossCents != null) {
      applied.settleStopLossCents = this.config.settleStopLossCents;
    }
    if (applied.autoTradeSymbols != null) {
      const enabled = resolveAutoTradeSymbols(this.config);
      this.config.tradeDoge = enabled.includes('DOGE') ? 'on' : 'off';
      this.config.tradeNear = enabled.includes('NEAR') ? 'on' : 'off';
      applied.tradeDoge = this.config.tradeDoge;
      applied.tradeNear = this.config.tradeNear;
    }
    if (this.config.symbol !== 'AUTO' && !isKalshiTradeEnabled(this.config.symbol, this.config)) {
      this.config.symbol = 'AUTO';
      applied.symbol = 'AUTO';
    }
    if (applied.insuranceCapDollars != null) applied.insuranceCapDollars = this.config.insuranceCapDollars;
    if (applied.insuranceFloorDollars != null) applied.insuranceFloorDollars = this.config.insuranceFloorDollars;
    if (applied.insuranceOverflowDollars != null) {
      applied.insuranceOverflowDollars = this.config.insuranceOverflowDollars;
    }
    saveConfigOverrides(collectConfigOverrides(this.config));
    return { applied, config: this.config };
  }

  applyModelSetup(setupId) {
    const setup = modelSetupById(setupId);
    if (!setup) return { ok: false, message: `Unknown setup '${setupId}'.` };

    const prevId = String(this.config.activeSetupId || 'core');
    const switching = prevId !== setup.id;
    let broughtAvailLabel = '';

    if (switching) {
      // Live Kalshi inventory is tied to the live ledger — don't orphan fills.
      const liveOpens = this.openTrades.filter((t) => this._isLiveTrade(t));
      if (this.config.mode === 'live' && liveOpens.length) {
        return {
          ok: false,
          message:
            `Close ${liveOpens.length} live Kalshi position(s) before switching setups — ` +
            `otherwise the old book would keep the inventory while knobs change.`,
        };
      }

      // Park the current live book as the previous setup's shadow (keeps its scarred avail).
      const prevSetup = modelSetupById(prevId);
      if (prevSetup) {
        this._ensureShadowBook(prevSetup);
        this._captureShadowBook(prevSetup);
      }

      // Promote the chosen setup's shadow bankroll into live (not the old scarred ledger).
      const incoming = this._shadowBooks && this._shadowBooks[setup.id];
      if (incoming && incoming.ledger) {
        const startDollars = Number(this.config.paperStartingBalanceDollars);
        const start = Number.isFinite(startDollars) && startDollars > 0 ? startDollars : 100;
        const cap = summarizeLedgerCapital(incoming.ledger, start, this.config);
        broughtAvailLabel = ` · brought shadow avail $${((cap.paperAvailableCents || 0) / 100).toFixed(2)}`;
        this.ledger = incoming.ledger;
        this.lastDecision = incoming.lastDecision || '';
        this.lastError = null;
        this._modelConfirmGates = incoming.confirmGates || Object.create(null);
        this._modelConfirmArmedSymbols = new Set(
          Array.isArray(incoming.confirmArmed) ? incoming.confirmArmed : []
        );
        this._modelConfirmGateArmed = !!incoming.confirmArmedFlag;
        this._modelConfirmProcessStartedAt = Number(incoming.confirmStarted) || Date.now();
        this._entryMissUntil = incoming.entryMissUntil || Object.create(null);
        this._entryMissStreak = incoming.entryMissStreak || Object.create(null);
        this._entryMissSessionClose = incoming.entryMissSessionClose || Object.create(null);
        this._stoppedSymbolsThisCycle = new Set(
          Array.isArray(incoming.stoppedThisCycle) ? incoming.stoppedThisCycle : []
        );
        this._lastProtectionGateKey = incoming.protectionKey || null;
        this._lastProtectionGateSymbol = incoming.protectionSymbol || null;
      } else {
        // No shadow history yet — clean bankroll, not the previous setup's losses.
        this.ledger = emptyShadowLedger();
        this.lastError = null;
        this._modelConfirmGates = Object.create(null);
        this._modelConfirmArmedSymbols = new Set();
        this._modelConfirmGateArmed = false;
        this._modelConfirmProcessStartedAt = Date.now();
        this._entryMissUntil = Object.create(null);
        this._entryMissStreak = Object.create(null);
        this._entryMissSessionClose = Object.create(null);
        this._stoppedSymbolsThisCycle = new Set();
        this._lastProtectionGateKey = null;
        this._lastProtectionGateSymbol = null;
        broughtAvailLabel = ' · fresh bankroll (no shadow history yet)';
      }

      // Live owns this setup now — don't keep a duplicate shadow of the same book.
      this._resetShadowBook(setup.id);
    }

    const result = this.updateConfig(modelSetupConfigPatch(setup));
    const prevLabel = (modelSetupById(prevId) && modelSetupById(prevId).label) || prevId;
    this.lastDecision = switching
      ? `Switched live book to “${setup.label}” (from “${prevLabel}”)${broughtAvailLabel}. ` +
        `Prior book is parked as shadow. Knobs: ${setup.autoTradeSymbols}, conf ${setup.modelMinConfidence}%, TP +${setup.modelBankGreenCents}¢, max ${setup.maxOpenPositions}.`
      : `Applied MODEL setup “${setup.label}” (${setup.autoTradeSymbols}, conf ${setup.modelMinConfidence}%, TP +${setup.modelBankGreenCents}¢, max ${setup.maxOpenPositions}).`;
    this._logActivity(this.lastDecision, { kind: 'settings' });
    this._persist();
    this._persistShadowBooks();
    return {
      ok: true,
      setup,
      ...result,
      message: this.lastDecision,
      setups: this._modelSetupScoreboard(),
    };
  }

  _modelSetupScoreboard() {
    const log = loadTradeLog();
    const active = String(this.config.activeSetupId || 'core');
    const startingDollars = Number(this.config.paperStartingBalanceDollars);
    const start = Number.isFinite(startingDollars) && startingDollars > 0 ? startingDollars : 100;
    const liveCapital = this._capitalStatus();
    const skimSettings = this.config;
    // Live card knobs must match Decision — catalog defaults lie if env/slider drifted.
    const liveKnobOverlay = {
      autoTradeSymbols: this.config.autoTradeSymbols,
      modelMinConfidence: this.config.modelMinConfidence,
      modelEntryLiveLeanMarginPct: this.config.modelEntryLiveLeanMarginPct,
      modelSignalDominanceMin: this.config.modelSignalDominanceMin,
      modelBankGreenCents: this.config.modelBankGreenCents,
      modelMinTpCents: this.config.modelMinTpCents,
      modelMaxLossCents: this.config.modelMaxLossCents,
      modelHardStopFloorCents: this.config.modelHardStopFloorCents,
      modelRichStopFloorCents: this.config.modelRichStopFloorCents,
      maxOpenPositions: this.config.maxOpenPositions,
      modelConfirmCrossCents: this.config.modelConfirmCrossCents,
      modelDumpPullbackCents: this.config.modelDumpPullbackCents,
      modelFastRedCents: this.config.modelFastRedCents,
      modelMinEntryCents: this.config.modelMinEntryCents,
      modelLeanStopBarrierCents: this.config.modelLeanStopBarrierCents,
    };
    return scoreModelSetupsAgainstLog(log).map((row) => {
      const live = row.id === active;
      const display = live ? { ...row, ...liveKnobOverlay } : row;
      const book = !live && row.id !== 'all-logged' && this._shadowBooks
        ? this._shadowBooks[row.id]
        : null;
      const emptyShadow = summarizeLedgerCapital(emptyShadowLedger(), start, skimSettings);
      const shadow =
        row.id === 'all-logged' || live
          ? null
          : {
              ...(book ? summarizeLedgerCapital(book.ledger, start, skimSettings) : emptyShadow),
              lastDecision: (book && book.lastDecision) || '',
            };
      const liveBook = live
        ? {
            paperAvailableCents: liveCapital.paperAvailableCents,
            reserveCents: liveCapital.reserveCents,
            insuranceCents: liveCapital.insuranceCents,
            insuranceReady: liveCapital.insuranceReady,
            insuranceDepositedCents: liveCapital.insuranceDepositedCents,
            paperTotalCents: liveCapital.paperTotalCents,
            openExposureCents: liveCapital.openExposureCents,
            pnlCents:
              (liveCapital.paperTotalCents || 0) -
              (liveCapital.startingCents || 0) -
              (liveCapital.insuranceDepositedCents || 0),
          }
        : null;
      const cap = live ? liveBook : shadow;
      const prevAvail = this._setupAvailSnapshots ? this._setupAvailSnapshots[row.id] : null;
      const availDeltaCents =
        cap && cap.paperAvailableCents != null && prevAvail != null
          ? cap.paperAvailableCents - prevAvail
          : null;
      return {
        ...display,
        active: live,
        shadow,
        live: liveBook,
        availDeltaCents,
      };
    });
  }

  _snapshotSetupAvails(scoreboard) {
    if (!this._setupAvailSnapshots) this._setupAvailSnapshots = Object.create(null);
    for (const row of scoreboard || []) {
      if (!row || row.id === 'all-logged') continue;
      const cap = row.active ? row.live : row.shadow;
      if (cap && cap.paperAvailableCents != null) {
        this._setupAvailSnapshots[row.id] = cap.paperAvailableCents;
      }
    }
  }

  _modelAutoSwitchEnabled() {
    const v = String(this.config.modelAutoSwitchSetup == null ? 'off' : this.config.modelAutoSwitchSetup).toLowerCase();
    return !(v === 'off' || v === 'false' || v === '0' || v === 'no');
  }

  _modelShadowBooksEnabled() {
    const v = String(this.config.modelShadowBooks == null ? 'off' : this.config.modelShadowBooks).toLowerCase();
    return !(v === 'off' || v === 'false' || v === '0' || v === 'no');
  }

  /**
   * When live Available is low, switch to a shadow setup whose Available is
   * climbing and beats live by a margin. Off by default (modelAutoSwitchSetup).
   */
  _maybeAutoSwitchModelSetup() {
    if (!this._modelAutoSwitchEnabled()) {
      this._lastAutoSwitchNote = null;
      return null;
    }
    if (!isModelStrategyMode(this.config)) return null;

    const scoreboard = this._modelSetupScoreboard();
    const activeRow = scoreboard.find((r) => r.active);
    if (!activeRow || !activeRow.live) {
      this._snapshotSetupAvails(scoreboard);
      return null;
    }

    const liveAvail = Number(activeRow.live.paperAvailableCents) || 0;
    const lowThresholdCents = Math.max(
      0,
      Math.round((Number(this.config.modelAutoSwitchLowAvailDollars) || MODEL_AUTO_SWITCH_LOW_AVAIL_DEFAULT) * 100)
    );
    const minLeadCents = Math.max(
      0,
      Math.round((Number(this.config.modelAutoSwitchMinLeadDollars) || MODEL_AUTO_SWITCH_MIN_LEAD_DEFAULT) * 100)
    );
    const cooldownMs =
      Math.max(0, Number(this.config.modelAutoSwitchCooldownMinutes) || MODEL_AUTO_SWITCH_COOLDOWN_MINUTES_DEFAULT) *
      60_000;

    if (liveAvail >= lowThresholdCents) {
      this._lastAutoSwitchNote = `Live avail $${(liveAvail / 100).toFixed(2)} — above $${(lowThresholdCents / 100).toFixed(2)} switch floor.`;
      this._snapshotSetupAvails(scoreboard);
      return null;
    }
    if (this._lastAutoSetupSwitchAt && Date.now() - this._lastAutoSetupSwitchAt < cooldownMs) {
      const mins = Math.ceil((cooldownMs - (Date.now() - this._lastAutoSetupSwitchAt)) / 60000);
      this._lastAutoSwitchNote = `Live avail low — auto-switch cooling down (~${mins}m).`;
      this._snapshotSetupAvails(scoreboard);
      return null;
    }

    let best = null;
    for (const row of scoreboard) {
      if (!row || row.active || row.id === 'all-logged' || !row.shadow) continue;
      const avail = Number(row.shadow.paperAvailableCents) || 0;
      if (avail < liveAvail + minLeadCents) continue;
      if (!row.shadow.trades && !row.shadow.openCount) continue;
      const prev = this._setupAvailSnapshots ? this._setupAvailSnapshots[row.id] : null;
      if (prev == null) continue;
      const delta = avail - prev;
      if (delta <= 0) continue;
      if (!best || avail > best.avail || (avail === best.avail && delta > best.delta)) {
        best = { id: row.id, label: row.label, avail, delta, liveAvail };
      }
    }

    this._snapshotSetupAvails(scoreboard);

    if (!best) {
      this._lastAutoSwitchNote =
        liveAvail < lowThresholdCents
          ? `Live avail $${(liveAvail / 100).toFixed(2)} low — no shadow climbing with +$${(minLeadCents / 100).toFixed(2)} lead yet.`
          : null;
      return null;
    }

    this._lastAutoSetupSwitchAt = Date.now();
    const result = this.applyModelSetup(best.id);
    const msg =
      `Auto-switched to “${best.label}”: live avail $${(best.liveAvail / 100).toFixed(2)} → shadow $${(best.avail / 100).toFixed(2)} (+$${(best.delta / 100).toFixed(2)}).`;
    this.lastDecision = msg;
    this._logActivity(msg, { kind: 'settings', autoSwitch: true, setupId: best.id });
    this._lastAutoSwitchNote = msg;
    return { switched: true, to: best.id, message: msg, ...result };
  }

  _rebuildAllShadowLedgerSkim() {
    if (!this._shadowBooks) return;
    let dirty = false;
    for (const book of Object.values(this._shadowBooks)) {
      if (!book || !book.ledger) continue;
      rebuildLedgerSkimFromTrades(book.ledger, this.config);
      dirty = true;
    }
    if (dirty) this._shadowDirty = true;
  }

  /**
   * Red/green strategy-mode suggestion from recent closed settle trades.
   * Does not change config — use applySettleWindowRecommendation().
   */
  getSettleWindowRecommendation({ now = Date.now() } = {}) {
    const permanentLog = loadTradeLog();
    const ledgerClosed = (this.ledger.trades || []).filter((t) => t && t.status === 'closed');
    const byId = new Map();
    for (const t of permanentLog) {
      if (t && t.id) byId.set(t.id, t);
    }
    for (const t of ledgerClosed) {
      if (t && t.id && !byId.has(t.id)) byId.set(t.id, t);
    }
    let candlesBySymbol = null;
    if (typeof this.getMarketCandles === 'function') {
      try {
        candlesBySymbol = this.getMarketCandles();
      } catch (err) {
        console.warn('[bot] getMarketCandles failed:', err.message);
      }
    }
    return recommendSettleOpenWindow([...byId.values()], {
      now,
      currentMode: this.config.strategyMode,
      candlesBySymbol,
    });
  }

  /**
   * Apply red→edge / green→settle.
   * Pass `{ light: 'red'|'green'|'edge'|'settle' }` to force even when neutral.
   */
  applySettleWindowRecommendation({ light: forceLight = null } = {}) {
    const rec = this.getSettleWindowRecommendation();
    const forced = String(forceLight || '').toLowerCase();
    const chosenLight =
      forced === 'red' || forced === 'green'
        ? forced
        : forced === 'edge'
          ? 'red'
          : forced === 'settle'
            ? 'green'
            : rec.light === 'green' || rec.light === 'red'
              ? rec.light
              : null;
    if (!chosenLight) {
      return {
        ok: false,
        message:
          rec.reason ||
          'No green/red suggestion — use Apply edge or Apply settle to force.',
        recommendation: rec,
      };
    }
    const mode = strategyModeForLight(chosenLight);
    if (!mode) {
      return { ok: false, message: 'Unknown strategy mode.', recommendation: rec };
    }
    const result = this.updateConfig({ strategyMode: mode });
    const manual = forced === 'red' || forced === 'green' || forced === 'edge' || forced === 'settle';
    const msg =
      `Applied strategy ${chosenLight.toUpperCase()} → ${mode}` +
      (manual ? ' (manual)' : '') +
      '.' +
      (rec.reason ? ` ${rec.reason}` : '');
    this.lastDecision = msg;
    this._logActivity(msg, { kind: 'strategy-mode' });
    this._persist();
    return {
      ok: true,
      message: msg,
      recommendation: this.getSettleWindowRecommendation(),
      applied: result.applied,
      config: this.config,
      forced: manual,
      light: chosenLight,
      strategyMode: mode,
    };
  }

  resetPaperState() {
    if (this.config.mode !== 'paper') {
      return { ok: false, message: 'Paper history can only be reset while the bot is in paper mode.' };
    }
    // Keep the newest closed samples so calibration isn't wiped to empty.
    const keepN = PAPER_RESET_KEEP_SAMPLES;
    const merged = pickRecentClosedTradeSamples(
      [...(this.ledger.trades || []), ...loadTradeLog()],
      keepN
    );
    const kept = pickRecentClosedTradeSamples(merged, keepN);

    this.ledger = {
      trades: [],
      reserveCents: 0,
      insuranceCents: 0,
      insuranceReady: false,
      insuranceDepositedCents: 0,
      retainedClosedPnlCents: 0,
      periodStartTime: Date.now(),
      activityLog: [],
    };
    this.calibration = rebuildCalibrationFromTrades(kept);
    this.lastError = null;
    const keptMsg =
      kept.length > 0
        ? ` Kept last ${kept.length} closed trade${kept.length === 1 ? '' : 's'} for calibration.`
        : '';
    this.lastDecision =
      `Paper P&L, reserve, and open book were reset.${keptMsg}`;
    clearTradeLog({ archive: true, keepTrades: kept });
    this._clearAllShadowBooks();
    this._logActivity(this.lastDecision, { kind: 'reset', keptSamples: kept.length });
    this._persist();
    this._persistShadowBooks();
    saveCalibration(this.calibration);
    return {
      ok: true,
      message: this.lastDecision,
      keptSamples: kept.length,
      keepTarget: keepN,
    };
  }

  /**
   * Remember a live Kalshi strike so the next prediction cycle can score
   * distance-to-target (and reset signal accumulators on ticker change).
   */
  _noteEngineStrike(symbol, market) {
    if (!market || !symbol) return;
    const sym = String(symbol).toUpperCase();
    const price = Number(marketStrikePrice(market));
    let closeTime = parseMarketCloseMs(market);
    if (!Number.isFinite(closeTime) && market.close_time) {
      closeTime = new Date(market.close_time).getTime();
    }
    if (!Number.isFinite(price) || price <= 0) return;
    if (!Number.isFinite(closeTime)) return;
    if (!this._engineStrikeTargets) this._engineStrikeTargets = Object.create(null);
    this._engineStrikeTargets[sym] = {
      price,
      closeTime,
      ticker: market.ticker || null,
      source: 'kalshi',
      updatedAt: Date.now(),
    };
  }

  /** Strikes for buildPredictions — drops expired windows. */
  getEngineStrikeTargets() {
    const out = {};
    const now = Date.now();
    for (const [sym, row] of Object.entries(this._engineStrikeTargets || {})) {
      if (!row) continue;
      const close = Number(row.closeTime);
      const price = Number(row.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (Number.isFinite(close) && close + 60_000 < now) continue;
      out[sym] = {
        price,
        closeTime: close,
        ticker: row.ticker || null,
        source: row.source || 'kalshi',
      };
    }
    return out;
  }

  /**
   * External seed / top-up into the Insurance Fund (user's own money).
   * Does not pull from Available or Wallet — credits insurance + deposited capital
   * so Available and Net P&L stay honest while Total Equity rises by the deposit.
   */
  depositInsurance(dollars) {
    const amount = Number(dollars);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, message: 'Deposit amount must be a positive number of dollars.' };
    }
    if (amount > 500) {
      return { ok: false, message: 'Max $500 per deposit. Split larger seeds into multiple adds.' };
    }
    const cents = Math.round(amount * 100);
    if (cents < 1) {
      return { ok: false, message: 'Amount rounds to less than 1¢.' };
    }

    this.ledger.insuranceCents = (Number(this.ledger.insuranceCents) || 0) + cents;
    this.ledger.insuranceDepositedCents = (Number(this.ledger.insuranceDepositedCents) || 0) + cents;

    const { armCents, floorCents } = insuranceArmFloorCents(this.config);
    this.ledger.insuranceReady = syncInsuranceReady(
      this.ledger.insuranceCents,
      !!this.ledger.insuranceReady,
      armCents,
      floorCents
    );

    const msg = `Insurance seeded +$${(cents / 100).toFixed(2)} (manual).`;
    this.lastDecision = msg;
    this._logActivity(msg, { kind: 'insurance', pnlCents: cents });
    this._persist();

    return {
      ok: true,
      message: msg,
      insuranceCents: this.ledger.insuranceCents,
      insuranceDepositedCents: this.ledger.insuranceDepositedCents,
      insuranceReady: !!this.ledger.insuranceReady,
      capital: this._capitalStatus(),
    };
  }

  _logActivity(message, meta = {}) {
    if (!this.ledger.activityLog) this.ledger.activityLog = [];
    this.ledger.activityLog.unshift({
      at: Date.now(),
      message: String(message || ''),
      kind: meta.kind || 'info',
      symbol: meta.symbol || null,
      side: meta.side || null,
      pnlCents: meta.pnlCents != null ? meta.pnlCents : null,
      tradeId: meta.tradeId || null,
    });
    if (this.ledger.activityLog.length > 100) this.ledger.activityLog.length = 100;
  }

  /** True when lastDecision is a post-stop protection wait (cascade / bounce / etc.). */
  _isProtectionGateReason(message) {
    const s = String(message || '');
    if (!/^Waiting:/i.test(s)) return false;
    return /peers still cascading|bounce|knife-catch|same-side sit-out|max 1 open until post-stop|same-window cascade protection|after \S+ .+ stop/i.test(
      s
    );
  }

  _protectionGateKey(message) {
    const s = String(message || '');
    if (/peers still cascading/i.test(s)) return 'peer-cascade';
    if (/same-side sit-out/i.test(s)) return 'same-side-cooldown';
    if (/knife-catch/i.test(s)) return 'knife-catch';
    if (/max 1 open until post-stop/i.test(s)) return 'post-stop-max1';
    if (/bounce|need .+ bid\s*≥|need .+ bid >=/i.test(s)) return 'stop-recovery';
    if (/after \S+ .+ stop/i.test(s)) return 'post-stop-gate';
    return 'post-stop-gate';
  }

  _protectionGateLabel(key) {
    switch (key) {
      case 'peer-cascade':
        return 'peer-cascade';
      case 'stop-recovery':
        return 'stop-recovery';
      case 'knife-catch':
        return 'knife-catch';
      case 'same-side-cooldown':
        return 'same-side-cooldown';
      case 'post-stop-max1':
        return 'post-stop max-1';
      default:
        return 'post-stop protection';
    }
  }

  /** Gates that only block one coin/side — other coins must not "clear" them. */
  _isSymbolScopedProtectionGate(key) {
    return (
      key === 'same-side-cooldown' ||
      key === 'stop-recovery' ||
      key === 'knife-catch'
    );
  }

  /**
   * Log protection gate use/clear once per transition (not every cycle).
   * Pass the Waiting reason when blocked; null to clear+announce; false to clear silently.
   * For symbol-scoped gates, pass `{ fromSymbol }` so another coin's pass doesn't
   * spam "cleared" every 5s while e.g. HYPE is still in same-side sit-out.
   */
  _noteProtectionGate(reasonOrNull, { fromSymbol = null } = {}) {
    if (reasonOrNull === false) {
      this._lastProtectionGateKey = null;
      this._lastProtectionGateSymbol = null;
      return;
    }
    const sym = fromSymbol ? String(fromSymbol).toUpperCase() : null;
    const reason = reasonOrNull == null ? '' : String(reasonOrNull);
    if (this._isProtectionGateReason(reason)) {
      const key = this._protectionGateKey(reason);
      if (
        key === this._lastProtectionGateKey &&
        (!this._isSymbolScopedProtectionGate(key) ||
          sym == null ||
          sym === this._lastProtectionGateSymbol)
      ) {
        return;
      }
      this._lastProtectionGateKey = key;
      this._lastProtectionGateSymbol = this._isSymbolScopedProtectionGate(key) ? sym : null;
      const label = this._protectionGateLabel(key);
      this._logActivity(`Protection used (${label}): ${reason}`, { kind: 'gate' });
      this._persist();
      return;
    }
    if (!this._lastProtectionGateKey) return;
    // Symbol-scoped: only the blocked coin clearing (or a silent open) may announce clear.
    if (
      this._isSymbolScopedProtectionGate(this._lastProtectionGateKey) &&
      this._lastProtectionGateSymbol &&
      sym &&
      sym !== this._lastProtectionGateSymbol
    ) {
      return;
    }
    const label = this._protectionGateLabel(this._lastProtectionGateKey);
    this._lastProtectionGateKey = null;
    this._lastProtectionGateSymbol = null;
    this._logActivity(`Protection cleared (${label}) — entries allowed again.`, { kind: 'gate' });
    this._persist();
  }

  get openTrades() {
    return this.ledger.trades.filter((t) => t.status === 'open');
  }

  _openExposureCents() {
    return this.openTrades.reduce((sum, trade) => sum + (Number(trade.entryPriceCents) || 0) * (Number(trade.contracts) || 0), 0);
  }

  _capitalStatus() {
    const closedPnlCents = this.ledger.trades
      .filter((trade) => trade.status === 'closed')
      .reduce((sum, trade) => sum + (Number(trade.pnlCents) || 0), 0);
    // PnL from closed trades archived by 12h rotation — must stay in the bankroll
    // or Available collapses while Wallet/Insurance skim from those wins remains.
    const retainedClosedPnlCents = Number(this.ledger.retainedClosedPnlCents) || 0;
    const openExposureCents = this._openExposureCents();
    const startingCents = Math.round(this.config.paperStartingBalanceDollars * 100);
    const reserveCents = this.ledger.reserveCents || 0;
    const insuranceCents = this.ledger.insuranceCents || 0;
    const insuranceDepositedCents = this.ledger.insuranceDepositedCents || 0;
    // External insurance seeds expand total capital so Available is not diluted.
    const paperTotalCents =
      startingCents + retainedClosedPnlCents + closedPnlCents + insuranceDepositedCents;
    return {
      startingCents,
      paperTotalCents,
      reserveCents,
      insuranceCents,
      insuranceDepositedCents,
      retainedClosedPnlCents,
      insuranceCapCents: insuranceArmFloorCents(this.config).armCents,
      insuranceFloorCents: insuranceArmFloorCents(this.config).floorCents,
      insuranceOverflowCents: insuranceOverflowCents(this.config),
      insuranceReady: !!this.ledger.insuranceReady,
      openExposureCents,
      paperAvailableCents: Math.max(0, paperTotalCents - reserveCents - insuranceCents - openExposureCents),
    };
  }

  /**
   * Cash the bot may spend on a *new* entry: Available only (never Wallet /
   * Insurance). Live also caps at Kalshi cash so we don't overdraft the API.
   * Insurance may still absorb *losses* when armed — that is separate.
   * Personal Wallet is never spendable here (or anywhere else).
   */
  _tradingSpendableCents() {
    const capital = this._capitalStatus();
    const available = Math.max(0, Math.round(Number(capital.paperAvailableCents) || 0));
    if (this.config.mode === 'live' && Number.isFinite(this.liveBalanceCents)) {
      return Math.max(0, Math.min(available, Math.round(this.liveBalanceCents)));
    }
    return available;
  }

  /** Pause new entries permanently until the user starts the bot again. */
  _haltTrading(reason) {
    if (this._inShadow) return false;
    const msg = String(reason || 'Bot stopped.');
    this.lastError = msg;
    this.lastDecision = msg;
    if (!this.isRunning) {
      this._persist();
      return true;
    }
    this.isRunning = false;
    this.runningSince = null;
    saveRunState({ isRunning: false, runningSince: null });
    this._logActivity(msg, { kind: 'halt' });
    this._persist();
    return true;
  }

  /**
   * Daily loss limit kill-switch. Scans today's closed trades (net P&L after
   * fees) and halts new entries for the rest of the calendar day if the
   * configured limit is breached. Resets automatically at midnight UTC.
   * Returns { ok: true } when trading can continue, { ok: false, reason } when halted.
   */
  _checkDailyLossLimit() {
    if (this._inShadow) return { ok: true };
    const limitDollars = Number(this.config.dailyLossLimitDollars);
    if (!Number.isFinite(limitDollars) || limitDollars <= 0) return { ok: true };
    const limitCents = Math.round(limitDollars * 100);

    // Determine start-of-today in UTC ms.
    const now = Date.now();
    const todayStartMs = (() => {
      const d = new Date(now);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    })();

    // If already halted today, stay halted without re-scanning every cycle.
    if (
      this._dailyLossHaltedAt &&
      this._dailyLossHaltedAt >= todayStartMs
    ) {
      const lostDollars = (Math.abs(this._dailyLossCents || 0) / 100).toFixed(2);
      return {
        ok: false,
        reason: `🛑 Daily loss limit: −$${lostDollars} reached −$${limitDollars.toFixed(2)} — new trades halted for today.`,
      };
    }

    // Sum net P&L (after fees) for all trades closed today.
    const trades = this.ledger && Array.isArray(this.ledger.trades) ? this.ledger.trades : [];
    let dayPnlCents = 0;
    for (const t of trades) {
      if (!t || t.status !== 'closed') continue;
      const closedAt = Number(t.closedAt);
      if (!Number.isFinite(closedAt) || closedAt < todayStartMs) continue;
      dayPnlCents += Number(t.pnlCents) || 0;
    }

    if (dayPnlCents <= -limitCents) {
      this._dailyLossHaltedAt = now;
      this._dailyLossCents = dayPnlCents;
      const lostDollars = (Math.abs(dayPnlCents) / 100).toFixed(2);
      const msg = `🛑 DAILY LOSS LIMIT HIT: −$${lostDollars} (limit −$${limitDollars.toFixed(2)}) — NEW TRADES HALTED for the rest of today.`;
      console.warn(`[bot] ${msg}`);
      this._logActivity(msg, { kind: 'halt' });
      this._persist();
      return { ok: false, reason: msg };
    }

    // Clear any stale halt from a previous day.
    if (this._dailyLossHaltedAt && this._dailyLossHaltedAt < todayStartMs) {
      this._dailyLossHaltedAt = null;
      this._dailyLossCents = null;
    }
    return { ok: true };
  }

  /**
   * New entries must fit in Available. If cash is temporarily insufficient,
   * wait for funds instead of permanently stopping the bot. Wallet and
   * Insurance Fund remain unavailable for entries.
   */
  _assertEntryFundedFromAvailable(entryCostCents, label = '') {
    const cost = Math.round(Number(entryCostCents) || 0);
    if (!(cost > 0)) return true;
    const capital = this._capitalStatus();
    const available = Math.max(0, Math.round(Number(capital.paperAvailableCents) || 0));
    const spendable = this._tradingSpendableCents();
    if (cost <= spendable) return true;
    const wallet = Math.max(0, Math.round(Number(capital.reserveCents) || 0));
    const insurance = Math.max(0, Math.round(Number(capital.insuranceCents) || 0));
    const liveBit =
      this.config.mode === 'live' && Number.isFinite(this.liveBalanceCents)
        ? ` · Kalshi cash $${(this.liveBalanceCents / 100).toFixed(2)}`
        : '';
    const waitMessage =
      `Waiting for funds: need $${(cost / 100).toFixed(2)} from Available ` +
        `(have $${(available / 100).toFixed(2)}${liveBit}). ` +
        `Wallet $${(wallet / 100).toFixed(2)} + Insurance $${(insurance / 100).toFixed(2)} stay locked` +
        (label ? ` — ${label}` : '') +
        '. New entries will resume automatically once funded.';
    this.lastError = waitMessage;
    this.lastDecision = waitMessage;
    return false;
  }

  _removeInvalidPaperTrades() {
    const initialCount = this.ledger.trades.length;
    this.ledger.trades = this.ledger.trades.filter((trade) => {
      // A malformed paper entry never represented a real order or money at
      // risk, so removing it is safer and more truthful than showing a fake
      // open position with a `null` entry price.
      if (trade.mode !== 'paper' || trade.status !== 'open') return true;
      return Number.isFinite(trade.entryPriceCents)
        && trade.entryPriceCents >= 1
        && trade.entryPriceCents <= 99
        && (trade.side === 'yes' || trade.side === 'no');
    });
    const removed = initialCount - this.ledger.trades.length;
    if (removed > 0) {
      this.lastError = `Removed ${removed} invalid paper trade${removed === 1 ? '' : 's'} with no valid entry quote.`;
      this._persist();
    }
  }

  _persist() {
    if (this._inShadow) {
      this._shadowDirty = true;
      return;
    }
    saveLedger(this.ledger);
    if (isPrimaryBotRole()) {
      try {
        publishPrimaryCoordination({
          openTrades: this.openTrades,
          instanceId: botInstanceId(),
        });
      } catch (err) {
        console.warn('[bot] coordination publish failed:', err.message);
      }
    }
  }

  _armPendingForceExit(trade, reason) {
    if (!trade) return;
    trade.pendingForceExit = reason;
    if (!Number.isFinite(Number(trade.pendingForceExitSince))) {
      trade.pendingForceExitSince = Date.now();
    }
  }

  _upsertTradeLog(entry) {
    if (this._inShadow) return;
    upsertTradeLog(entry);
  }

  _ensureShadowBook(setup) {
    const id = setup && setup.id;
    if (!id) return null;
    if (!this._shadowBooks) this._shadowBooks = Object.create(null);
    let book = this._shadowBooks[id];
    if (!book || typeof book !== 'object') {
      book = {
        setupId: id,
        ledger: emptyShadowLedger(),
        lastDecision: '',
        confirmGates: Object.create(null),
        confirmArmed: [],
        confirmArmedFlag: false,
        confirmStarted: Date.now(),
        entryMissUntil: Object.create(null),
        entryMissStreak: Object.create(null),
        entryMissSessionClose: Object.create(null),
      };
      this._shadowBooks[id] = book;
    }
    if (!book.ledger || !Array.isArray(book.ledger.trades)) book.ledger = emptyShadowLedger();
    if (!Array.isArray(book.ledger.activityLog)) book.ledger.activityLog = [];
    if (!book.confirmGates || typeof book.confirmGates !== 'object') {
      book.confirmGates = Object.create(null);
    }
    if (!book.entryMissUntil) book.entryMissUntil = Object.create(null);
    if (!book.entryMissStreak) book.entryMissStreak = Object.create(null);
    if (!book.entryMissSessionClose) book.entryMissSessionClose = Object.create(null);
    return book;
  }

  _resetShadowBook(setupId) {
    const id = String(setupId || '');
    if (!id || !this._shadowBooks) return;
    delete this._shadowBooks[id];
    this._shadowDirty = true;
  }

  _clearAllShadowBooks() {
    this._shadowBooks = Object.create(null);
    this._shadowDirty = true;
  }

  _persistShadowBooks() {
    if (this._inShadow) {
      this._shadowDirty = true;
      return;
    }
    saveShadowBooks(this._shadowBooks || {});
    this._shadowDirty = false;
  }

  _snapshotLiveBook() {
    return {
      config: this.config,
      ledger: this.ledger,
      lastDecision: this.lastDecision,
      lastError: this.lastError,
      confirmGates: this._modelConfirmGates,
      confirmArmed: this._modelConfirmArmedSymbols,
      confirmArmedFlag: this._modelConfirmGateArmed,
      confirmStarted: this._modelConfirmProcessStartedAt,
      entryMissUntil: this._entryMissUntil,
      entryMissStreak: this._entryMissStreak,
      entryMissSessionClose: this._entryMissSessionClose,
      stoppedThisCycle: this._stoppedSymbolsThisCycle,
      protectionKey: this._lastProtectionGateKey,
      protectionSymbol: this._lastProtectionGateSymbol,
    };
  }

  _installShadowBook(setup, { resetStopped = false } = {}) {
    const book = this._ensureShadowBook(setup);
    this.config = {
      ...this.config,
      ...modelSetupConfigPatch(setup),
      mode: 'paper',
    };
    this.ledger = book.ledger;
    this.lastDecision = book.lastDecision || '';
    this.lastError = null;
    this._modelConfirmGates = book.confirmGates || Object.create(null);
    this._modelConfirmArmedSymbols = new Set(
      Array.isArray(book.confirmArmed) ? book.confirmArmed : []
    );
    this._modelConfirmGateArmed = !!book.confirmArmedFlag;
    this._modelConfirmProcessStartedAt = Number(book.confirmStarted) || Date.now();
    this._entryMissUntil = book.entryMissUntil || Object.create(null);
    this._entryMissStreak = book.entryMissStreak || Object.create(null);
    this._entryMissSessionClose = book.entryMissSessionClose || Object.create(null);
    this._stoppedSymbolsThisCycle = resetStopped
      ? new Set()
      : new Set(Array.isArray(book.stoppedThisCycle) ? book.stoppedThisCycle : []);
    this._lastProtectionGateKey = book.protectionKey || null;
    this._lastProtectionGateSymbol = book.protectionSymbol || null;
    return book;
  }

  _captureShadowBook(setup) {
    const book = this._ensureShadowBook(setup);
    book.ledger = this.ledger;
    book.lastDecision = this.lastDecision || '';
    book.confirmGates = this._modelConfirmGates || Object.create(null);
    book.confirmArmed = this._modelConfirmArmedSymbols
      ? [...this._modelConfirmArmedSymbols]
      : [];
    book.confirmArmedFlag = !!this._modelConfirmGateArmed;
    book.confirmStarted = Number(this._modelConfirmProcessStartedAt) || Date.now();
    book.entryMissUntil = this._entryMissUntil || Object.create(null);
    book.entryMissStreak = this._entryMissStreak || Object.create(null);
    book.entryMissSessionClose = this._entryMissSessionClose || Object.create(null);
    book.stoppedThisCycle = this._stoppedSymbolsThisCycle
      ? [...this._stoppedSymbolsThisCycle]
      : [];
    book.protectionKey = this._lastProtectionGateKey || null;
    book.protectionSymbol = this._lastProtectionGateSymbol || null;
    this._shadowDirty = true;
    return book;
  }

  _restoreLiveBook(snap) {
    if (!snap) return;
    this.config = snap.config;
    this.ledger = snap.ledger;
    this.lastDecision = snap.lastDecision;
    this.lastError = snap.lastError;
    this._modelConfirmGates = snap.confirmGates;
    this._modelConfirmArmedSymbols = snap.confirmArmed;
    this._modelConfirmGateArmed = snap.confirmArmedFlag;
    this._modelConfirmProcessStartedAt = snap.confirmStarted;
    this._entryMissUntil = snap.entryMissUntil;
    this._entryMissStreak = snap.entryMissStreak;
    this._entryMissSessionClose = snap.entryMissSessionClose;
    this._stoppedSymbolsThisCycle = snap.stoppedThisCycle;
    this._lastProtectionGateKey = snap.protectionKey;
    this._lastProtectionGateSymbol = snap.protectionSymbol;
  }

  async _withShadowBook(setup, fn, { resetStopped = false } = {}) {
    if (!setup || this._inShadow) return;
    const snap = this._snapshotLiveBook();
    this._inShadow = true;
    try {
      this._installShadowBook(setup, { resetStopped });
      await fn();
      this._captureShadowBook(setup);
    } catch (err) {
      console.error(`[bot] shadow ${setup.id} failed:`, err && err.message ? err.message : err);
      try {
        this._captureShadowBook(setup);
      } catch {
        // keep going — live book must always be restored
      }
    } finally {
      this._restoreLiveBook(snap);
      this._inShadow = false;
    }
  }

  /**
   * Silent paper books for every named MODEL setup except the live one.
   * Same Kalshi quotes; own ledger / knobs / max slots. Never places live orders.
   */
  async _runShadowBooks(predictions, { openNew = false } = {}) {
    if (this._inShadow) return;
    if (!isModelStrategyMode(this.config)) return;
    if (!this._modelShadowBooksEnabled()) return;
    const active = String(this.config.activeSetupId || 'core');
    for (const setup of MODEL_SETUPS) {
      if (!setup || setup.id === active) continue;
      await this._withShadowBook(
        setup,
        async () => {
          await this._manageOpenPositionsUnlocked(predictions);
          try {
            await this._reviewPendingStopVerdicts();
          } catch (err) {
            console.error(`[bot] shadow ${setup.id} stop review failed:`, err.message);
          }
          if (!openNew || !this.isRunning || !predictions) return;
          if (this.openTrades.length >= this._effectiveMaxOpenPositions()) return;
          const ranked =
            this.config.symbol === 'AUTO'
              ? await this._findModelOpportunities(predictions)
              : [await this._evaluateSymbolForModel(this.config.symbol, predictions)].filter(
                  Boolean
                );
          await this._openModelRanked(ranked);
        },
        { resetStopped: openNew }
      );
    }
    if (this._shadowDirty) this._persistShadowBooks();
  }

  async _finishModelShadowCycle(predictions) {
    if (this._inShadow) return;
    if (!isModelStrategyMode(this.config)) return;
    if (this._modelShadowBooksEnabled()) {
      await this._withTradeLock(() =>
        this._runShadowBooks(predictions, { openNew: this.isRunning && !!predictions })
      );
      if (!this._setupAvailSnapshots || !Object.keys(this._setupAvailSnapshots).length) {
        this._snapshotSetupAvails(this._modelSetupScoreboard());
      }
      this._maybeAutoSwitchModelSetup();
    }
  }

  /**
   * Every 12 hours, archives all CLOSED trades from this period to
   * data/archive/bot-ledger-<period>.json and clears them from the live
   * ledger, so win/loss stats and streaks reflect a rolling recent window
   * rather than growing forever — while the prior 12 hours of trade
   * history stays available in the archive file.
   *
   * Deliberately never touches: any still-OPEN trade, reserveCents, or
   * insuranceCents. Closed PnL is folded into retainedClosedPnlCents so
   * Available/Wallet math stays correct after the trades leave the ledger.
   */
  _maybeRotateLedger(now) {
    if (this._inShadow) return;
    if (now - this.ledger.periodStartTime < ROTATION_PERIOD_MS) return;

    const closedTrades = this.ledger.trades.filter((t) => t.status === 'closed');
    const stillOpen = this.ledger.trades.filter((t) => t.status === 'open');

    if (closedTrades.length > 0) {
      const archivedPnl = closedTrades.reduce((sum, t) => sum + (Number(t.pnlCents) || 0), 0);
      this.ledger.retainedClosedPnlCents =
        (Number(this.ledger.retainedClosedPnlCents) || 0) + archivedPnl;
      try {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        const archive = {
          periodStart: new Date(this.ledger.periodStartTime).toISOString(),
          periodEnd: new Date(now).toISOString(),
          reserveCentsAtRotation: this.ledger.reserveCents,
          insuranceCentsAtRotation: this.ledger.insuranceCents,
          retainedClosedPnlCentsAfter: this.ledger.retainedClosedPnlCents,
          trades: closedTrades,
        };
        const fileName = `bot-ledger-${new Date(this.ledger.periodStartTime).toISOString().replace(/[:.]/g, '-')}.json`;
        fs.writeFileSync(path.join(ARCHIVE_DIR, fileName), JSON.stringify(archive, null, 2));
        console.log(`[bot] archived ${closedTrades.length} closed trades from the last 12h to data/archive/${fileName}`);
        pruneArchiveFiles({ now });
      } catch (err) {
        console.error('[bot] failed to archive ledger before rotation:', err.message);
      }
    }

    this.ledger.trades = stillOpen; // keep any still-open trade, drop settled history
    this.ledger.periodStartTime = now;
    this._persist();
  }

  /**
   * Repair bankrolls that already rotated: Wallet/Insurance kept skim from
   * wiped trades, but closed PnL was dropped — Available looked artificially low.
   * Rebuild retained from permanent trade log minus what's still on the ledger.
   */
  _repairRetainedClosedPnlFromTradeLog() {
    if (this._inShadow) return false;
    const existing = Number(this.ledger.retainedClosedPnlCents);
    if (Number.isFinite(existing) && existing !== 0) return false;
    const reserve = Number(this.ledger.reserveCents) || 0;
    const insurance = Number(this.ledger.insuranceCents) || 0;
    if (reserve <= 0 && insurance <= 0) return false;

    const log = loadTradeLog();
    if (!log.length) return false;
    const onLedger = new Set(
      (this.ledger.trades || []).filter((t) => t && t.id).map((t) => String(t.id))
    );
    let logClosedPnl = 0;
    let archivedPnl = 0;
    for (const t of log) {
      if (!t || String(t.status) !== 'closed') continue;
      const pnl = Number(t.pnlCents) || 0;
      logClosedPnl += pnl;
      if (!onLedger.has(String(t.id))) archivedPnl += pnl;
    }
    if (archivedPnl === 0) return false;
    this.ledger.retainedClosedPnlCents = archivedPnl;
    console.log(
      `[bot] repaired retainedClosedPnlCents=$${(archivedPnl / 100).toFixed(2)} ` +
        `(trade-log closed $${(logClosedPnl / 100).toFixed(2)}; was missing after ledger rotation)`
    );
    this._persist();
    return true;
  }

  // Picks whichever engine window most closely matches the time actually
  // left on Kalshi's current 15-minute contract.
  _pickWindow(windows, minutesRemaining) {
    const candidates = [
      { key: 'w5', minutes: 5 },
      { key: 'w10', minutes: 10 },
      { key: 'w15', minutes: 15 },
    ];
    let best = candidates[0];
    let bestDiff = Infinity;
    for (const c of candidates) {
      const diff = Math.abs(c.minutes - minutesRemaining);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = c;
      }
    }
    return windows[best.key];
  }

  /**
   * Determines how much to stake on the NEXT trade, per the configured
   * strategy:
   *   - 'fixed': always the configured stakeDollars (unchanged behavior).
   *   - 'halve-after-win': half of the most recent CLOSED trade's own
   *     invested amount if that trade was a win; otherwise resets back to
   *     the base configured stakeDollars. Deliberately based on the
   *     trade's own invested amount (trade.stakeDollars) — NOT reduced by
   *     whatever was skimmed from its profit afterward, since skimming
   *     happens on the profit side and never touches the principal that
   *     was actually risked.
   */
  _computeNextStake() {
    if (this.config.stakingStrategy !== 'halve-after-win') {
      return this.config.stakeDollars;
    }
    const lastClosed = this._mostRecentClosedTrade();
    if (!lastClosed) return this.config.stakeDollars; // no history yet — start at the base stake
    if (lastClosed.pnlCents > 0) {
      return Math.max(0.5, lastClosed.stakeDollars / 2); // halve after a win, never quite to zero
    }
    return this.config.stakeDollars; // reset to base after a loss
  }

  /**
   * Stake for this entry.
   * Model: optional half stake under MODEL_HALF_STAKE_UNDER_CENTS (0 = off).
   * Settle:
   * - Ask &lt; 80¢: ¼ normal (all coins)
   * - Else NEAR: ½ normal when halfStakeNear is on
   * - Else 3rd concurrent open (touched-90 bonus slot): ½ normal
   * Under-80 quarter wins over NEAR/3rd — no stacking to ⅛.
   * Edge mode: always full (unless caller forces settle sizing).
   */
  _stakeDollarsForEntry(
    priceCents,
    { settle = false, symbol = null, thirdSlot = false, modelUncertain = false, model = false } = {}
  ) {
    const base = Number(this._computeNextStake());
    const safeBase = Number.isFinite(base) && base > 0 ? base : Number(this.config.stakeDollars) || 3;
    const p = Number(priceCents);
    if (model) {
      if (modelIsHalfStakeAsk(p)) {
        return Math.max(0.5, +(safeBase * 0.5).toFixed(2));
      }
      return safeBase;
    }
    if (modelUncertain) {
      return Math.max(0.5, +(safeBase * 0.5).toFixed(2));
    }
    if (!settle) return safeBase;
    if (Number.isFinite(p) && p < 80) {
      return Math.max(0.5, +(safeBase / 4).toFixed(2));
    }
    const nearHalf = String(this.config.halfStakeNear == null ? 'on' : this.config.halfStakeNear).toLowerCase();
    const nearHalfOn = !(nearHalf === 'off' || nearHalf === 'false' || nearHalf === '0' || nearHalf === 'no');
    const halfNear = nearHalfOn && String(symbol || '').toUpperCase() === 'NEAR';
    if (thirdSlot || halfNear) {
      return Math.max(0.5, +(safeBase / 2).toFixed(2));
    }
    return safeBase;
  }

  _hasTouched90Open() {
    return this.openTrades.some((t) => t && t.settleTouched90 === true);
  }

  /**
   * Soft cap: while any open has tagged 90¢, allow up to 3 (even if maxOpen is 2).
   * Otherwise respect maxOpenPositions.
   */
  _effectiveMaxOpenPositions() {
    const base = Number(this.config.maxOpenPositions);
    const cap = Number.isFinite(base) && base >= 1 ? Math.floor(base) : 2;
    if (isSettleStrategyMode(this.config) && this._hasTouched90Open()) {
      return Math.max(cap, 3);
    }
    return cap;
  }

  _computeSkim(pnlCents) {
    if (pnlCents <= 0 || this.config.skimMode === 'off') return 0;
    if (this.config.skimMode === 'insurance') {
      return Math.round(pnlCents * 0.4); // wallet share only (display helper)
    }
    if (this.config.skimMode === 'fixed') {
      return Math.min(Math.round(this.config.skimFixedDollars * 100), pnlCents);
    }
    // percent
    return Math.round(pnlCents * (this.config.skimPercent / 100));
  }

  /**
   * Wins (insurance mode): 40% Wallet + 20% Insurance + 40% bankroll on every
   * win from the start, until the soft overflow ceiling ($15). Excess 20% →
   * Available. Arm at $10 (sticky ready); stay usable down to $6 floor.
   * Until armed, losses hit Available; while ready, Insurance absorbs first.
   * Personal Wallet is append-only — never spent on entries or losses.
   */
  _applyReserveFlow(trade) {
    const pnlCents = Number(trade.pnlCents) || 0;
    const beforeWallet = Math.max(0, Math.round(Number(this.ledger.reserveCents) || 0));

    const flow = applyProfitBuckets({
      pnlCents,
      reserveCents: beforeWallet,
      insuranceCents: this.ledger.insuranceCents || 0,
      insuranceReady: !!this.ledger.insuranceReady,
      settings: this.config,
      rebuildInsurance: true, // keep building until soft overflow ceiling
    });
    // Hard lock: wallet can only stay flat or grow — never shrink.
    this.ledger.reserveCents = Math.max(beforeWallet, Math.round(Number(flow.reserveCents) || 0));
    this.ledger.insuranceCents = flow.insuranceCents;
    this.ledger.insuranceReady = !!flow.insuranceReady;
    trade.skimmedCents = flow.skimmedCents;
    trade.insuranceAddedCents = flow.insuranceAddedCents;
    trade.insuranceOverflowCents = flow.insuranceOverflowCents;
    trade.insuranceDrawnCents = flow.insuranceDrawnCents;
    trade.insuranceReleasedCents = flow.insuranceReleasedCents;
    // Legacy field name — insurance draw only; wallet is never drawn.
    trade.reserveDrawnCents = 0;
  }

  _withTradeLock(fn) {
    // Reentrant: shadow books run under the lock, then _openPosition also
    // takes it. Nesting on the same chain deadlocks the event loop.
    if (this._tradeLockDepth > 0) {
      const nested = this._tradeLockInner.then(() => fn(), () => fn());
      this._tradeLockInner = nested.then(
        () => undefined,
        (err) => {
          console.error('[bot] nested trade-lock task failed:', err && err.message ? err.message : err);
        }
      );
      return nested;
    }
    const run = this._tradeLock.then(
      () => this._runTradeLocked(fn),
      () => this._runTradeLocked(fn)
    );
    this._tradeLock = run.then(
      () => undefined,
      (err) => {
        console.error('[bot] trade-lock task failed:', err && err.message ? err.message : err);
      }
    );
    return run;
  }

  async _runTradeLocked(fn) {
    this._tradeLockDepth = 1;
    this._tradeLockInner = Promise.resolve();
    try {
      return await fn();
    } finally {
      this._tradeLockDepth = 0;
    }
  }

  _isLiveTrade(trade) {
    return Boolean(trade && (trade.mode === 'live' || trade.liveOrderId));
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _parseFpCount(raw) {
    if (raw == null || raw === '') return null;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  }

  _orderFillCount(order) {
    if (!order || typeof order !== 'object') return 0;
    // Prefer Kalshi's canonical fixed-point fields, then legacy integer / alias names.
    // Create Order V2 uses `fill_count`; Get Order uses `fill_count_fp`.
    // Do not treat 0 as "missing" — only skip null/undefined/''.
    const candidates = [
      order.fill_count_fp,
      order.fillCountFp,
      order.fills_count_fp,
      order.fillsCountFp,
      order.fill_count,
      order.fillCount,
      order.fills_count,
      order.fillsCount,
      order.filled_count,
      order.filledCount,
      order.quantity_filled,
      order.quantityFilled,
    ];
    for (const raw of candidates) {
      const n = this._parseFpCount(raw);
      if (n != null) return n;
    }
    // Fallback: initial − remaining when fill_* was omitted entirely.
    const initial = this._parseFpCount(
      order.initial_count_fp ??
        order.initialCountFp ??
        order.initial_count ??
        order.initialCount
    );
    const remaining = this._parseFpCount(
      order.remaining_count_fp ??
        order.remainingCountFp ??
        order.remaining_count ??
        order.remainingCount
    );
    if (initial != null && remaining != null && initial >= remaining) {
      return initial - remaining;
    }
    return 0;
  }

  _unwrapOrderPayload(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.order && typeof data.order === 'object') return data.order;
    if (Array.isArray(data.orders) && data.orders[0] && typeof data.orders[0] === 'object') {
      return data.orders[0];
    }
    return data;
  }

  _extractOrderId(payload) {
    const order = this._unwrapOrderPayload(payload) || payload;
    if (!order || typeof order !== 'object') return null;
    return (
      order.order_id ||
      order.orderId ||
      (payload && payload.order_id) ||
      (payload && payload.orderId) ||
      null
    );
  }

  _inferOrderBookSide(order, heldSide, action) {
    const raw = String(order?.side ?? order?.book_side ?? order?.bookSide ?? '').toLowerCase();
    if (raw === 'bid' || raw === 'ask') return raw;
    if (heldSide && action) {
      try {
        return bookSideFromLegacy(heldSide, action);
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  /**
   * Pick raw vs 100-raw for held-outcome cents when Kalshi's average_fill_price
   * is ambiguous (sometimes YES dollars, sometimes the complement). Prefer the
   * candidate closer to a known intended limit (sell/buy price).
   */
  _disambiguateFillCents(rawCents, intendedPriceCents) {
    const clampCents = (c) => Math.max(1, Math.min(99, Math.round(c)));
    const raw = clampCents(rawCents);
    const intended = Math.round(Number(intendedPriceCents));
    if (!Number.isFinite(intended) || intended < 1 || intended > 99) return raw;
    const complement = clampCents(100 - raw);
    const rawDist = Math.abs(raw - intended);
    const compDist = Math.abs(complement - intended);
    return compDist < rawDist ? complement : raw;
  }

  /**
   * Kalshi fees on an order, in cents (taker + maker, or V2 average_fee_paid × fills).
   */
  _orderFeesCents(order) {
    if (!order || typeof order !== 'object') return 0;
    const taker = Number.parseFloat(
      order.taker_fees_dollars ?? order.takerFeesDollars ?? NaN
    );
    const maker = Number.parseFloat(
      order.maker_fees_dollars ?? order.makerFeesDollars ?? NaN
    );
    let fees = 0;
    if (Number.isFinite(taker) && taker > 0) fees += taker;
    if (Number.isFinite(maker) && maker > 0) fees += maker;
    if (fees > 0) return Math.max(0, Math.round(fees * 100));

    const avgFee = Number.parseFloat(
      order.average_fee_paid ?? order.averageFeePaid ?? NaN
    );
    const filled = this._orderFillCount(order);
    if (Number.isFinite(avgFee) && avgFee > 0 && filled > 0) {
      return Math.max(0, Math.round(avgFee * filled * 100));
    }
    return 0;
  }

  /**
   * Standard Kalshi taker fee estimate (cents): ceil(0.07 × C × P × (1−P) × 100).
   * Used when the order payload omits fee fields so cash P&L still tracks Kalshi.
   */
  _estimateTakerFeesCents(priceCents, contracts) {
    const C = Math.max(0, Math.floor(Number(contracts) || 0));
    const cents = Math.round(Number(priceCents) || 0);
    if (C < 1 || cents < 1 || cents > 99) return 0;
    const P = cents / 100;
    const dollars = 0.07 * C * P * (1 - P);
    return Math.max(0, Math.ceil(dollars * 100 - 1e-9));
  }

  /**
   * Prefer fees reported on the order; otherwise estimate taker fees from fill price/size.
   */
  _resolveOrderFeesCents(order, priceCents, contracts) {
    const reported = this._orderFeesCents(order);
    if (reported > 0) return reported;
    const filled = this._orderFillCount(order);
    const n = filled > 0 ? filled : Math.max(0, Math.floor(Number(contracts) || 0));
    return this._estimateTakerFeesCents(priceCents, n);
  }

  /**
   * Cash-aligned trade PnL in cents: (exit − entry) × contracts − fees.
   * Kalshi's per-trade UI often shows gross price PnL; cash / available moves fee-net.
   * pnlGrossCents is stored separately on the trade for display.
   */
  _netPnlCents(entryCents, exitCents, contracts, entryFeesCents = 0, exitFeesCents = 0) {
    const n = Math.max(0, Math.floor(Number(contracts) || 0));
    const entry = Number(entryCents) || 0;
    const exit = Number(exitCents) || 0;
    const fees =
      Math.max(0, Math.round(Number(entryFeesCents) || 0)) +
      Math.max(0, Math.round(Number(exitFeesCents) || 0));
    return (exit - entry) * n - fees;
  }

  _grossPnlCents(entryCents, exitCents, contracts) {
    const n = Math.max(0, Math.floor(Number(contracts) || 0));
    const entry = Number(entryCents) || 0;
    const exit = Number(exitCents) || 0;
    return (exit - entry) * n;
  }

  /**
   * Average fill price for the held outcome (YES/NO cents).
   * Prefer average_fill_price (limit-disambiguated). Fill-cost dollars are a
   * fallback only when avg is missing — and only when the implied cents agree
   * with the intended limit (~10¢). Preferring cost first caused:
   *   - XRP false +$10: taker_fill_cost_dollars="0.00" on maker buys → 1¢ entry
   *   - ETH under-count: cost near the limit hid average_fill_price improvement
   */
  _orderAvgFillPriceCents(order, heldSide, action, intendedPriceCents = null) {
    if (!order) return null;
    const filled = this._orderFillCount(order);
    const clampCents = (c) => Math.max(1, Math.min(99, Math.round(c)));

    const avgDollars = Number.parseFloat(
      order.average_fill_price ?? order.averageFillPrice ?? NaN
    );
    if (Number.isFinite(avgDollars) && avgDollars > 0) {
      return this._disambiguateFillCents(avgDollars * 100, intendedPriceCents);
    }

    // Fallback: sum taker+maker fill cost (skip zero — maker fills often send
    // taker_fill_cost_dollars="0.00", which must not become 1¢).
    let costDollars = 0;
    let hasPositiveCost = false;
    for (const raw of [
      order.taker_fill_cost_dollars ?? order.takerFillCostDollars,
      order.maker_fill_cost_dollars ?? order.makerFillCostDollars,
    ]) {
      const n = Number.parseFloat(raw ?? NaN);
      if (Number.isFinite(n) && n > 0) {
        costDollars += n;
        hasPositiveCost = true;
      }
    }
    if (hasPositiveCost && filled > 0) {
      const costCents = clampCents((costDollars * 100) / filled);
      const intended = Math.round(Number(intendedPriceCents));
      if (Number.isFinite(intended) && intended >= 1 && intended <= 99) {
        if (Math.abs(costCents - intended) > 10) {
          // Misleading cost with no average_fill_price — refuse rather than
          // invent a far-from-limit price (XRP-style blowups).
          return null;
        }
      }
      return costCents;
    }

    const yesDollars = Number.parseFloat(order.yes_price_dollars ?? order.yesPriceDollars ?? NaN);
    const noDollars = Number.parseFloat(order.no_price_dollars ?? order.noPriceDollars ?? NaN);
    if (heldSide === 'yes' && Number.isFinite(yesDollars)) {
      return clampCents(yesDollars * 100);
    }
    if (heldSide === 'no' && Number.isFinite(noDollars)) {
      return clampCents(noDollars * 100);
    }
    const yes = Number(order.yes_price ?? order.yesPrice);
    const no = Number(order.no_price ?? order.noPrice);
    if (heldSide === 'yes' && Number.isFinite(yes) && yes > 0) return clampCents(yes);
    if (heldSide === 'no' && Number.isFinite(no) && no > 0) return clampCents(no);
    return null;
  }

  /**
   * Guard buy fill cents vs the limit we sent. A far-below-limit avg (e.g. 59¢
   * after buying at 81¢+) is almost always a parse/complement glitch — keep the limit.
   */
  _sanityCheckEntryFillCents(fillCents, limitCents) {
    const fill = Math.round(Number(fillCents));
    const limit = Math.round(Number(limitCents));
    if (!Number.isFinite(fill) || !Number.isFinite(limit) || limit < 1 || limit > 99) {
      return fillCents;
    }
    if (fill >= 1 && fill <= 99 && Math.abs(fill - limit) <= 12) return fill;
    const complement = Math.max(1, Math.min(99, 100 - fill));
    if (Math.abs(complement - limit) < Math.abs(fill - limit)) {
      console.warn(
        `[bot] entry fill ${fill}¢ looks like complement mis-parse (limit ${limit}¢) — using ${complement}¢`
      );
      return complement;
    }
    if (Math.abs(fill - limit) > 12) {
      console.warn(
        `[bot] entry fill ${fill}¢ far from buy limit ${limit}¢ — using limit`
      );
      return limit;
    }
    return fill;
  }

  /**
   * Guard against average_fill_price complement mis-parse on exits.
   * Stop: exit >> entry while sellLimit <= entry → closer-to-limit interpretation.
   * TP / bank / near-certain: exit << entry while sellLimit >= entry → reject bad parse.
   */
  _sanityCheckExitFillCents(exitPx, sellPriceCents, entryPriceCents, reason) {
    const exit = Math.round(Number(exitPx));
    const sellLimit = Math.round(Number(sellPriceCents));
    const entry = Math.round(Number(entryPriceCents));
    if (!Number.isFinite(exit) || !Number.isFinite(sellLimit) || !Number.isFinite(entry)) {
      return exitPx;
    }

    const closerToLimit = () => {
      const complement = Math.max(1, Math.min(99, 100 - exit));
      const exitDist = Math.abs(exit - sellLimit);
      const compDist = Math.abs(complement - sellLimit);
      const chosen = compDist < exitDist ? complement : sellLimit;
      return chosen;
    };

    const profitReasons = new Set([
      'take_profit',
      'pre_close_bank',
      'pre_close_small_loss',
      'near_certain',
      'settle_stale',
      'settle_stuck',
    ]);
    if (profitReasons.has(reason)) {
      const impliedLoss = entry - exit;
      if (impliedLoss > 15 && sellLimit >= entry) {
        const fixed = closerToLimit();
        console.warn(
          `[bot] exit fill ${exit}¢ looks like fill-price mis-parse on ${reason} ` +
            `(entry ${entry}¢, sell limit ${sellLimit}¢) — using ${fixed}¢`
        );
        return fixed;
      }
      return exit;
    }

    if (reason === 'stop_loss') {
      const impliedGain = exit - entry;
      if (impliedGain > 15 && sellLimit <= entry) {
        const fixed = closerToLimit();
        console.warn(
          `[bot] exit fill ${exit}¢ looks like fill-price mis-parse on stop_loss ` +
            `(entry ${entry}¢, sell limit ${sellLimit}¢) — using ${fixed}¢`
        );
        return fixed;
      }
    }
    return exit;
  }

  async _fetchOrderSnapshot(orderId) {
    const data = await this.client.getOrder(orderId);
    return this._unwrapOrderPayload(data);
  }

  /**
   * After cancel/timeout, keep re-fetching briefly so a late-matching fill
   * (or a cancel that raced an execution) still lands in the ledger.
   */
  async _recoverOrderFillsAfterCancel(orderId, { priorOrder = null, attempts = 3, delayMs = 400 } = {}) {
    let bestOrder = priorOrder;
    let bestFilled = this._orderFillCount(priorOrder);
    // Create/IOC seed already final (remaining 0) — nothing to recover; GET often 404s.
    if (priorOrder) {
      const remaining = this._parseFpCount(
        priorOrder.remaining_count_fp ??
          priorOrder.remainingCountFp ??
          priorOrder.remaining_count ??
          priorOrder.remainingCount
      );
      if (remaining === 0) {
        return { filled: bestFilled, order: bestOrder };
      }
    }
    let sawNotFound = false;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const snap = await this._fetchOrderSnapshot(orderId);
        if (snap) {
          const filled = this._orderFillCount(snap);
          if (filled > bestFilled || !bestOrder) {
            bestOrder = snap;
            bestFilled = filled;
          }
          const status = String(snap.status || '').toLowerCase();
          if (
            filled > 0 ||
            status === 'canceled' ||
            status === 'cancelled' ||
            status === 'executed' ||
            status === 'filled' ||
            status === 'complete' ||
            status === 'completed'
          ) {
            // Still take one more peek when empty+canceled so a post-cancel
            // fill_count update can land; otherwise stop early when filled.
            if (filled > 0 || i === attempts - 1) break;
          }
        }
      } catch (err) {
        const notFound =
          Number(err && err.status) === 404 || /HTTP 404\b/.test(String(err && err.message));
        if (notFound) {
          // Canceled IOC / already-gone orders 404 on GET — not actionable.
          if (!sawNotFound) {
            sawNotFound = true;
            console.warn(
              `[bot] getOrder ${orderId} gone after cancel (404) — using create/seed fill count ${bestFilled}`
            );
          }
          break;
        }
        console.warn(`[bot] getOrder ${orderId} post-cancel recovery failed:`, err.message);
      }
      if (i < attempts - 1) await this._sleep(delayMs);
    }
    if (bestFilled > 0 && this._orderFillCount(priorOrder) < bestFilled) {
      console.warn(
        `[bot] fill recovery: order ${orderId} shows ${bestFilled} filled after cancel/timeout ` +
          `(was ${this._orderFillCount(priorOrder)}) — will ledger the fill`
      );
    } else if (bestFilled > 0 && !priorOrder) {
      console.warn(
        `[bot] fill recovery: order ${orderId} shows ${bestFilled} filled after cancel/timeout — will ledger the fill`
      );
    }
    return { filled: bestFilled, order: bestOrder };
  }

  /**
   * Poll Kalshi until the order is filled enough, or give up and cancel.
   * Always re-checks fills after cancel so a race cannot orphan Kalshi inventory.
   * Returns { ok, filled, avgPriceCents, order, recovered }.
   */
  async _awaitOrderFill(
    orderId,
    { minFill = 1, attempts = 6, delayMs = 350, seedOrder = null, heldSide = null, action = null } = {}
  ) {
    let lastOrder = seedOrder ? this._unwrapOrderPayload(seedOrder) || seedOrder : null;
    let bestFilled = this._orderFillCount(lastOrder);
    if (bestFilled >= minFill && lastOrder) {
      return {
        ok: true,
        filled: bestFilled,
        avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
        order: lastOrder,
        recovered: false,
      };
    }

    // Create Order V2 returns the post-match state immediately. For IOC, unfilled
    // size is already canceled → remaining_count "0.00". Trust that and skip
    // getOrder: canceled IOC ids often 404 on GET /portfolio/orders/{id}.
    if (lastOrder) {
      const remaining = this._parseFpCount(
        lastOrder.remaining_count_fp ??
          lastOrder.remainingCountFp ??
          lastOrder.remaining_count ??
          lastOrder.remainingCount
      );
      const status = String(lastOrder.status || '').toLowerCase();
      const seedTerminal =
        remaining === 0 ||
        status === 'canceled' ||
        status === 'cancelled' ||
        status === 'executed' ||
        status === 'filled' ||
        status === 'complete' ||
        status === 'completed';
      if (seedTerminal) {
        return {
          ok: bestFilled >= minFill,
          filled: bestFilled,
          avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
          order: lastOrder,
          recovered: false,
        };
      }
    }

    let sawNotFound = false;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const snap = await this._fetchOrderSnapshot(orderId);
        if (snap) {
          lastOrder = snap;
          const status = String(lastOrder.status || '').toLowerCase();
          const filled = this._orderFillCount(lastOrder);
          if (filled > bestFilled) bestFilled = filled;
          // Never invent a fill count from status alone — that desyncs the ledger
          // from Kalshi inventory when fill_* fields are missing or misnamed.
          if (filled >= minFill) {
            return {
              ok: true,
              filled,
              avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
              order: lastOrder,
              recovered: false,
            };
          }
          if (status === 'canceled' || status === 'cancelled') {
            // Terminal cancel (not necessarily ours): still treat any partial
            // fills as inventory we own. Not a "recovery" unless we timed out.
            return {
              ok: filled >= minFill,
              filled,
              avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
              order: lastOrder,
              recovered: false,
            };
          }
          if (
            (status === 'executed' ||
              status === 'filled' ||
              status === 'complete' ||
              status === 'completed') &&
            filled > 0
          ) {
            return {
              ok: filled >= minFill,
              filled,
              avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
              order: lastOrder,
              recovered: false,
            };
          }
        }
      } catch (err) {
        const notFound =
          Number(err && err.status) === 404 || /HTTP 404\b/.test(String(err && err.message));
        if (notFound) {
          if (!sawNotFound) {
            sawNotFound = true;
            console.warn(
              `[bot] getOrder ${orderId} not found (IOC often evaporates) — using create seed / recovery`
            );
          }
        } else {
          console.warn(`[bot] getOrder ${orderId} poll failed:`, err.message);
        }
      }
      await this._sleep(delayMs);
    }

    let canceled = false;
    try {
      await this.client.cancelOrder(orderId);
      canceled = true;
    } catch (err) {
      // Cancel often fails when the order already fully filled — that is OK;
      // recovery getOrder below must still pick up the fill.
      const notFound =
        Number(err && err.status) === 404 || /HTTP 404\b/.test(String(err && err.message));
      if (!notFound) {
        console.warn(`[bot] cancelOrder ${orderId} failed:`, err.message);
      }
    }

    // Give the matching engine a beat, then re-fetch (possibly multiple times).
    await this._sleep(delayMs);
    const recovered = await this._recoverOrderFillsAfterCancel(orderId, {
      priorOrder: lastOrder,
      attempts: 3,
      delayMs,
    });
    const filled = Math.max(bestFilled, recovered.filled);
    const order = recovered.order || lastOrder;
    const wasRecovery =
      canceled &&
      filled > 0 &&
      (bestFilled < filled || bestFilled < minFill);
    if (wasRecovery) {
      console.warn(
        `[bot] fill recovery: order ${orderId} filled ${filled} after poll timeout` +
          (canceled ? '/cancel' : '') +
          ' — recording inventory'
      );
    }
    return {
      ok: filled >= minFill,
      filled,
      avgPriceCents: this._orderAvgFillPriceCents(order, heldSide, action),
      order,
      recovered: wasRecovery || (filled > 0 && bestFilled < minFill),
    };
  }

  /**
   * After a live sell partially fills, book the sold contracts as a closed
   * ledger row and shrink the still-open trade so inventory matches Kalshi.
   */
  _bookPartialLiveExit(trade, soldContracts, exitPriceCents, reason, orderId, exitFeesCents = 0) {
    const sold = Math.max(0, Math.min(Math.floor(Number(soldContracts) || 0), trade.contracts));
    if (sold < 1) return;
    const remaining = trade.contracts - sold;
    const entry = Number(trade.entryPriceCents) || 0;
    const exitPx = Math.max(1, Math.min(99, Math.round(Number(exitPriceCents))));
    const entryFeesTotal = Math.max(0, Math.round(Number(trade.entryFeesCents) || 0));
    // Pro-rate entry fees across the sold slice when shrinking the open trade.
    const entryFeesSlice =
      trade.contracts > 0 ? Math.round((entryFeesTotal * sold) / (sold + remaining || sold)) : 0;
    const exitFees = Math.max(0, Math.round(Number(exitFeesCents) || 0));
    const feesCents = entryFeesSlice + exitFees;
    const closedSlice = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-partial-${sold}`,
      mode: trade.mode,
      symbol: trade.symbol,
      ticker: trade.ticker,
      side: trade.side,
      contracts: sold,
      stakeDollars: +((sold * entry) / 100).toFixed(2),
      entryPriceCents: entry,
      floorStrike: trade.floorStrike,
      openedAt: trade.openedAt,
      windowCloseTime: trade.windowCloseTime,
      engineProbability: trade.engineProbability,
      engineConfidence: trade.engineConfidence,
      status: 'closed',
      closedAt: Date.now(),
      exitPriceCents: exitPx,
      exitReason: reason,
      entryFeesCents: entryFeesSlice,
      exitFeesCents: exitFees,
      feesCents,
      pnlGrossCents: this._grossPnlCents(entry, exitPx, sold),
      pnlCents: this._netPnlCents(entry, exitPx, sold, entryFeesSlice, exitFees),
      liveOrderId: trade.liveOrderId || null,
      liveExitOrderId: orderId || null,
      partialExitOf: trade.id,
    };
    this._applyReserveFlow(closedSlice);
    this.ledger.trades.unshift(closedSlice);
    if (this.ledger.trades.length > 200) this.ledger.trades.length = 200;

    trade.contracts = remaining;
    trade.stakeDollars = +((remaining * entry) / 100).toFixed(2);
    trade.entryFeesCents = Math.max(0, entryFeesTotal - entryFeesSlice);

    const feeNote =
      feesCents > 0 ? ` · fees $${(feesCents / 100).toFixed(2)}` : '';
    this.lastDecision =
      `Partial exit ${trade.symbol} ${String(trade.side).toUpperCase()}: sold ${sold} @ ${exitPx}¢ ` +
      `(cash P&L $${(closedSlice.pnlCents / 100).toFixed(2)}${feeNote}); ${remaining} still open.`;
    this._logActivity(this.lastDecision, {
      kind: 'close',
      symbol: trade.symbol,
      side: trade.side,
      pnlCents: closedSlice.pnlCents,
      tradeId: closedSlice.id,
    });
    this._upsertTradeLog({
      id: closedSlice.id,
      mode: closedSlice.mode,
      symbol: closedSlice.symbol,
      ticker: closedSlice.ticker,
      side: closedSlice.side,
      contracts: closedSlice.contracts,
      stakeDollars: closedSlice.stakeDollars,
      entryPriceCents: closedSlice.entryPriceCents,
      exitPriceCents: closedSlice.exitPriceCents,
      floorStrike: closedSlice.floorStrike,
      openedAt: closedSlice.openedAt,
      closedAt: closedSlice.closedAt,
      windowCloseTime: closedSlice.windowCloseTime,
      engineProbability: closedSlice.engineProbability,
      engineConfidence: closedSlice.engineConfidence,
      status: 'closed',
      exitReason: closedSlice.exitReason,
      pnlCents: closedSlice.pnlCents,
      pnlGrossCents: closedSlice.pnlGrossCents || 0,
      feesCents: closedSlice.feesCents || 0,
      entryFeesCents: closedSlice.entryFeesCents || 0,
      exitFeesCents: closedSlice.exitFeesCents || 0,
      skimmedCents: closedSlice.skimmedCents || 0,
      insuranceAddedCents: closedSlice.insuranceAddedCents || 0,
      insuranceDrawnCents: closedSlice.insuranceDrawnCents || 0,
      partialExitOf: trade.id,
    });
    this._upsertTradeLog({
      id: trade.id,
      mode: trade.mode,
      symbol: trade.symbol,
      ticker: trade.ticker,
      side: trade.side,
      contracts: trade.contracts,
      stakeDollars: trade.stakeDollars,
      entryPriceCents: trade.entryPriceCents,
      entryFeesCents: trade.entryFeesCents || 0,
      floorStrike: trade.floorStrike,
      openedAt: trade.openedAt,
      windowCloseTime: trade.windowCloseTime,
      engineProbability: trade.engineProbability,
      engineConfidence: trade.engineConfidence,
      status: 'open',
    });
    this._persist();
  }

  /**
   * Close a position in the ledger. For live early exits, places a sell and
   * confirms fill BEFORE marking closed. Official Kalshi settlement (reason
   * `settled`) never sends a sell — the exchange pays 0/100 itself.
   * Returns true if the trade was closed, false if left open (e.g. sell failed).
   */
  async _closePosition(trade, exitPriceCents, reason, opts = {}) {
    if (!trade || trade.status !== 'open') return false;
    if (trade._closing) return false;
    trade._closing = true;

    let bookedExit = Number(exitPriceCents);
    try {
      const entryPx = Number(trade.entryPriceCents);
      if (
        reason === 'breakeven' &&
        Number.isFinite(entryPx) &&
        Number.isFinite(bookedExit) &&
        !modelBreakevenExitAllowed(trade, bookedExit)
      ) {
        this.lastDecision =
          `Blocked fake breakeven on ${trade.symbol}: bid ${Math.round(bookedExit)}¢ is below entry ${Math.round(entryPx)}¢ — holding.`;
        return false;
      }
      if (
        reason === 'take_profit' &&
        Number.isFinite(entryPx) &&
        Number.isFinite(bookedExit) &&
        bookedExit < entryPx
      ) {
        this.lastDecision =
          `Blocked fake take_profit on ${trade.symbol}: bid ${Math.round(bookedExit)}¢ is below entry ${Math.round(entryPx)}¢ — holding.`;
        return false;
      }
      // Model: never book TAKE_PROFIT under minTp on first signal — but when
      // pendingForceExit is armed (IOC miss) or stall-bank while green, sell at bid.
      if (
        reason === 'take_profit' &&
        isModelTrade(trade) &&
        !opts.forcePendingExit &&
        !opts.stallBank &&
        !modelTakeProfitMeetsFloor(trade, bookedExit, this.config)
      ) {
        const minTp = modelMinTpCents(this.config);
        const green = Number.isFinite(entryPx) && Number.isFinite(bookedExit)
          ? Math.round(bookedExit - entryPx)
          : null;
        this.lastDecision =
          `Blocked micro take_profit on ${trade.symbol}: ` +
          `${Number.isFinite(entryPx) ? Math.round(entryPx) : '?'}→` +
          `${Number.isFinite(bookedExit) ? Math.round(bookedExit) : '?'}¢` +
          (green != null ? ` (+${green}¢)` : '') +
          ` — need ≥+${minTp}¢ green (or ≥${MODEL_RICH_BANK_CENTS_DEFAULT}¢). Holding.`;
        return false;
      }
      const isLive = this._isLiveTrade(trade);
      // Official Kalshi settlement pays 0/100 — never send a live sell at those prices.
      const skipLiveSell = opts.skipLiveSell === true || reason === 'settled';

      if (isLive && !skipLiveSell) {
        const baseSellPrice = Math.round(
          Number(opts.liveSellPriceCents != null ? opts.liveSellPriceCents : bookedExit)
        );
        if (!Number.isFinite(baseSellPrice) || baseSellPrice < 1 || baseSellPrice > 99) {
          this.lastError =
            `Live exit blocked for ${trade.symbol}: refusing sell at ${baseSellPrice}¢ (must be 1–99). Position left open.`;
          console.error('[bot]', this.lastError);
          if (isForceRetryExitReason(reason)) {
            trade.pendingForceExit = reason;
            if (!Number.isFinite(Number(trade.pendingForceExitSince))) {
              trade.pendingForceExitSince = Date.now();
            }
            this.lastDecision =
              `${reason} sell blocked (no valid bid) — will retry next cycle until flat.`;
            this._logActivity(this.lastDecision, {
              kind: 'close',
              symbol: trade.symbol,
              side: trade.side,
              tradeId: trade.id,
            });
            this._persist();
          }
          return false;
        }

        // Cash-outs / stops: up to 4 IOC sells in one call (−1¢ each, re-quote bid)
        // so a miss does not leave inventory sitting until the signal clears.
        const forceRetry = isForceRetryExitReason(reason);
        const escalated = opts.escalated === true;
        const maxAttempts = forceRetry ? (escalated ? 6 : 4) : 2;
        let lastErr = null;
        let soldOk = false;
        let workingBase = baseSellPrice;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (attempt > 0) {
            try {
              const mkt = await this._getMarketBounded(trade.ticker, 1500);
              const liveBid = mkt ? this._heldSideBidCents(trade, mkt) : null;
              if (Number.isFinite(liveBid) && liveBid >= 1 && liveBid <= 99) {
                workingBase = Math.round(liveBid);
              }
            } catch {
              /* keep prior base */
            }
            await this._sleep(70);
          }
          const sellPrice = Math.max(1, Math.min(99, workingBase - attempt));
          bookedExit = sellPrice;
          if (attempt > 0) {
            console.warn(
              `[bot] ${reason} sell retry ${attempt + 1}/${maxAttempts} at ${sellPrice}¢ ` +
                `on ${trade.ticker} (${trade.contracts} contracts)`
            );
          }
          try {
            const order = await this.client.createOrder({
              ticker: trade.ticker,
              side: trade.side,
              action: 'sell',
              count: trade.contracts,
              priceCents: sellPrice,
              timeInForce: 'immediate_or_cancel',
            });
            const orderId = this._extractOrderId(order);
            if (!orderId) throw new Error('sell response missing order_id');
            const fill = await this._awaitOrderFill(orderId, {
              minFill: trade.contracts,
              attempts: forceRetry ? 3 : 6,
              delayMs: forceRetry ? 120 : 350,
              seedOrder: order,
              heldSide: trade.side,
              action: 'sell',
            });
            const filled = Math.max(0, Number(fill.filled) || 0);
            if (fill.recovered) {
              console.warn(
                `[bot] exit fill recovery on ${trade.ticker}: sell order ${orderId} filled ${filled} after timeout/cancel`
              );
            }
            if (filled > 0 && filled < trade.contracts) {
              const avgPartial = this._orderAvgFillPriceCents(
                fill.order,
                trade.side,
                'sell',
                sellPrice
              );
              let exitPx = Number.isFinite(avgPartial) ? avgPartial : sellPrice;
              exitPx = this._sanityCheckExitFillCents(
                exitPx,
                sellPrice,
                trade.entryPriceCents,
                reason
              );
              this._bookPartialLiveExit(
                trade,
                filled,
                exitPx,
                reason,
                orderId,
                this._resolveOrderFeesCents(fill.order, exitPx, filled)
              );
              lastErr = new Error(
                `sell partially filled (got ${filled}/${filled + trade.contracts}, status ${
                  fill.order && fill.order.status
                }) — remainder left open`
              );
              break;
            }
            if (!fill.ok || filled < trade.contracts) {
              throw new Error(
                `sell not fully filled (got ${filled}/${trade.contracts}, status ${
                  fill.order && fill.order.status
                })`
              );
            }
            let avg = this._orderAvgFillPriceCents(fill.order, trade.side, 'sell', sellPrice);
            if (Number.isFinite(avg)) {
              avg = this._sanityCheckExitFillCents(
                avg,
                sellPrice,
                trade.entryPriceCents,
                reason
              );
              bookedExit = avg;
            } else bookedExit = sellPrice;
            trade.liveExitOrderId = orderId;
            trade.exitFeesCents = this._resolveOrderFeesCents(
              fill.order,
              bookedExit,
              trade.contracts
            );
            soldOk = true;
            break;
          } catch (err) {
            lastErr = err;
            console.error(
              `[bot] live exit attempt ${attempt + 1}/${maxAttempts} (${reason}) on ${trade.ticker}: ${err.message}`
            );
          }
        }

        if (!soldOk) {
          const msg = (lastErr && lastErr.message) || 'sell failed';
          this.lastError = `Failed live exit (${reason}) on ${trade.ticker}: ${msg}. Position left OPEN.`;
          console.error('[bot]', this.lastError);
          if (forceRetry) {
            this._armPendingForceExit(trade, reason);
            this.lastDecision =
              `${reason} sell missed — forcing retry every cycle until flat.`;
            this._logActivity(this.lastDecision, {
              kind: 'close',
              symbol: trade.symbol,
              side: trade.side,
              tradeId: trade.id,
            });
            this._persist();
          }
          return false;
        }
      }

      delete trade.pendingForceExit;
      delete trade.pendingForceExitSince;
      trade.status = 'closed';
      trade.closedAt = Date.now();
      trade.exitPriceCents = bookedExit;
      trade.exitReason = reason;
      const exitProb = opts.exitHeldProb ?? trade._liveExitHeldProb;
      if (exitProb != null && Number.isFinite(Number(exitProb))) {
        trade.modelExitHeldProb = +Number(exitProb).toFixed(1);
      }
      delete trade._liveExitHeldProb;
      // Clear miss cooldown/streak for this coin once we're done with the ticket.
      this._clearEntryMiss(trade.symbol, trade.side);
      // MODEL: after a full exit, require a fresh under-50¢ print before rebuy (YES or NO).
      this._resetModelConfirmGatesForTrade(trade);
      if (reason === 'stop_loss' && trade.symbol) {
        if (!this._stoppedSymbolsThisCycle) this._stoppedSymbolsThisCycle = new Set();
        this._stoppedSymbolsThisCycle.add(String(trade.symbol).toUpperCase());
        trade.stopVerdictPending = true;
        trade.stopVerdict = 'pending';
        trade.stopPostMinBidCents = null;
        trade.stopPostMaxBidCents = null;
      }
      // Weak-switch is the same knife-catch risk as a stop — block same-cycle reopen.
      if (reason === 'settle_weak_switch' && trade.symbol) {
        if (!this._stoppedSymbolsThisCycle) this._stoppedSymbolsThisCycle = new Set();
        this._stoppedSymbolsThisCycle.add(String(trade.symbol).toUpperCase());
      }
      // Model BE/TP/lean exits do NOT lock the coin for the whole 15m cycle —
      // preemptive bank → ~30s sit-out → confirm-gate rebuy is the scalp loop.
      // Same-second reopen is handled by checkModelPostExitCooldown.
      const entryFees = Math.max(0, Math.round(Number(trade.entryFeesCents) || 0));
      const exitFees = Math.max(0, Math.round(Number(trade.exitFeesCents) || 0));
      trade.feesCents = entryFees + exitFees;
      trade.pnlGrossCents = this._grossPnlCents(
        trade.entryPriceCents,
        bookedExit,
        trade.contracts
      );
      trade.pnlCents = this._netPnlCents(
        trade.entryPriceCents,
        bookedExit,
        trade.contracts,
        entryFees,
        exitFees
      );

      this._applyReserveFlow(trade);
      this._recordCalibration(trade);

      const feeNote =
        trade.feesCents > 0 ? ` · fees $${(trade.feesCents / 100).toFixed(2)}` : '';
      const grossNote =
        trade.feesCents > 0 && trade.pnlGrossCents !== trade.pnlCents
          ? ` · gross $${(trade.pnlGrossCents / 100).toFixed(2)}`
          : '';
      let decision = `Closed ${trade.symbol} ${String(trade.side).toUpperCase()} via ${reason} at ${bookedExit}¢ (cash P&L $${(trade.pnlCents / 100).toFixed(2)}${grossNote}${feeNote}).`;
      if (trade.insuranceDrawnCents > 0) {
        decision += ` Insurance absorbed $${(trade.insuranceDrawnCents / 100).toFixed(2)}.`;
      }
      if (trade.skimmedCents > 0) {
        decision += ` Wallet +$${(trade.skimmedCents / 100).toFixed(2)}.`;
      }
      if (trade.insuranceAddedCents > 0) {
        decision += ` Insurance +$${(trade.insuranceAddedCents / 100).toFixed(2)}.`;
      }
      if (trade.insuranceOverflowCents > 0) {
        decision += ` Insurance full — $${(trade.insuranceOverflowCents / 100).toFixed(2)} → available.`;
      }
      if (trade.insuranceReleasedCents > 0) {
        decision += ` Insurance released $${(trade.insuranceReleasedCents / 100).toFixed(2)} → bankroll.`;
      }
      this.lastDecision = decision;
      this._logActivity(this.lastDecision, {
        kind: 'close',
        symbol: trade.symbol,
        side: trade.side,
        pnlCents: trade.pnlCents,
        tradeId: trade.id,
      });
      this._upsertTradeLog({
        id: trade.id,
        mode: trade.mode,
        symbol: trade.symbol,
        ticker: trade.ticker,
        side: trade.side,
        contracts: trade.contracts,
        stakeDollars: trade.stakeDollars,
        entryPriceCents: trade.entryPriceCents,
        exitPriceCents: trade.exitPriceCents,
        floorStrike: trade.floorStrike,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        windowCloseTime: trade.windowCloseTime,
        engineProbability: trade.engineProbability,
        engineConfidence: trade.engineConfidence,
        status: 'closed',
        exitReason: trade.exitReason,
        pnlCents: trade.pnlCents,
        pnlGrossCents: trade.pnlGrossCents || 0,
        feesCents: trade.feesCents || 0,
        entryFeesCents: trade.entryFeesCents || 0,
        exitFeesCents: trade.exitFeesCents || 0,
        skimmedCents: trade.skimmedCents || 0,
        insuranceAddedCents: trade.insuranceAddedCents || 0,
        insuranceDrawnCents: trade.insuranceDrawnCents || 0,
        insuranceOverflowCents: trade.insuranceOverflowCents || 0,
        insuranceReleasedCents: trade.insuranceReleasedCents || 0,
        stopVerdictPending: trade.stopVerdictPending === true,
        stopVerdict: trade.stopVerdict || undefined,
        stopPostMinBidCents: trade.stopPostMinBidCents,
        stopPostMaxBidCents: trade.stopPostMaxBidCents,
      });
    this._persist();
      return true;
    } finally {
      if (trade.status === 'open') trade._closing = false;
      else delete trade._closing;
    }
  }

  /**
   * After stop_loss: watch the same ticker until Kalshi posts a result (or the
   * window is long past) and stamp whether the stop prevented a worse loss or
   * missed a recovery. Updates ledger + permanent trade log.
   */
  async _reviewPendingStopVerdicts() {
    const log = loadTradeLog();
    const pending = (log || []).filter(
      (t) =>
        t &&
        t.status === 'closed' &&
        t.exitReason === 'stop_loss' &&
        t.stopVerdictPending === true &&
        t.ticker
    );
    if (!pending.length) return;

    let touched = false;
    for (const row of pending.slice(0, 8)) {
      // Cache-only — never open a Kalshi GET just for post-stop analytics.
      let market = null;
      if (this.client && typeof this.client.getCachedMarket === 'function') {
        market = this.client.getCachedMarket(row.ticker, 120_000);
      }
      if (!market && this._lastLiveMarket) {
        for (const m of Object.values(this._lastLiveMarket)) {
          if (m && String(m.ticker) === String(row.ticker)) {
            market = m;
            break;
          }
        }
      }
      const sideBid = market ? this._heldSideBidCents(row, market) : null;
      if (Number.isFinite(sideBid)) {
        const prevMin = Number(row.stopPostMinBidCents);
        const prevMax = Number(row.stopPostMaxBidCents);
        row.stopPostMinBidCents = Number.isFinite(prevMin)
          ? Math.min(prevMin, sideBid)
          : sideBid;
        row.stopPostMaxBidCents = Number.isFinite(prevMax)
          ? Math.max(prevMax, sideBid)
          : sideBid;
      }

      const result = market && market.result ? String(market.result).toLowerCase() : '';
      let verdict = classifyStopVerdictFromResult(row.side, result);
      let detail = null;
      if (verdict) {
        detail =
          verdict === 'prevented_loss'
            ? `Session settled ${result.toUpperCase()} — holding would have paid 0¢`
            : `Session settled ${result.toUpperCase()} — holding would have paid 100¢`;
      } else {
        const closeAt = Number(row.windowCloseTime);
        const closedAt = Number(row.closedAt) || 0;
        const now = Date.now();
        const pastClose = Number.isFinite(closeAt) && now >= closeAt + 45_000;
        const waitedLong = now - closedAt >= 12 * 60 * 1000;
        if (pastClose || waitedLong) {
          verdict = classifyStopVerdictFromBids({
            entryCents: row.entryPriceCents,
            exitCents: row.exitPriceCents,
            postMinBid: row.stopPostMinBidCents,
            postMaxBid: row.stopPostMaxBidCents,
            lastBid: sideBid,
          });
          if (!verdict) verdict = 'mixed';
          detail =
            verdict === 'prevented_loss'
              ? `Bid kept falling after stop (low ${row.stopPostMinBidCents ?? '—'}¢)`
              : verdict === 'missed_opportunity'
                ? `Bid recovered after stop (high ${row.stopPostMaxBidCents ?? '—'}¢)`
                : 'No clear post-stop signal before session ended';
        }
      }

      if (!verdict) {
        // Still waiting — persist updated extremes only.
        this._syncStopReviewFields(row, { pending: true });
        touched = true;
        continue;
      }

      this._applyStopVerdict(row, verdict, detail);
      touched = true;
    }
    if (touched) this._persist();
  }

  _syncStopReviewFields(row, { pending = true } = {}) {
    const ledgerTrade = (this.ledger.trades || []).find((t) => t && t.id === row.id);
    if (ledgerTrade) {
      ledgerTrade.stopPostMinBidCents = row.stopPostMinBidCents;
      ledgerTrade.stopPostMaxBidCents = row.stopPostMaxBidCents;
      if (pending) {
        ledgerTrade.stopVerdictPending = true;
        ledgerTrade.stopVerdict = ledgerTrade.stopVerdict || 'pending';
      }
    }
    this._upsertTradeLog({
      id: row.id,
      stopVerdictPending: pending,
      stopVerdict: pending ? row.stopVerdict || 'pending' : row.stopVerdict,
      stopPostMinBidCents: row.stopPostMinBidCents,
      stopPostMaxBidCents: row.stopPostMaxBidCents,
      stopVerdictDetail: row.stopVerdictDetail,
    });
  }

  _applyStopVerdict(row, verdict, detail) {
    row.stopVerdict = verdict;
    row.stopVerdictPending = false;
    row.stopVerdictDetail = detail || stopVerdictLabel(verdict);
    row.stopVerdictAt = Date.now();

    const ledgerTrade = (this.ledger.trades || []).find((t) => t && t.id === row.id);
    if (ledgerTrade) {
      ledgerTrade.stopVerdict = verdict;
      ledgerTrade.stopVerdictPending = false;
      ledgerTrade.stopVerdictDetail = row.stopVerdictDetail;
      ledgerTrade.stopVerdictAt = row.stopVerdictAt;
      ledgerTrade.stopPostMinBidCents = row.stopPostMinBidCents;
      ledgerTrade.stopPostMaxBidCents = row.stopPostMaxBidCents;
    }

    this._upsertTradeLog({
      id: row.id,
      stopVerdict: verdict,
      stopVerdictPending: false,
      stopVerdictDetail: row.stopVerdictDetail,
      stopVerdictAt: row.stopVerdictAt,
      stopPostMinBidCents: row.stopPostMinBidCents,
      stopPostMaxBidCents: row.stopPostMaxBidCents,
    });

    const msg = `Stop review ${row.symbol || ''} ${String(row.side || '').toUpperCase()}: ${row.stopVerdictDetail}`;
    this._logActivity(msg, {
      kind: 'info',
      symbol: row.symbol,
      side: row.side,
      tradeId: row.id,
      pnlCents: row.pnlCents,
    });
  }

  /**
   * Resolve settlement payout for a trade that has reached its window end.
   * Prefer Kalshi's official result (no live sell — exchange settles).
   * Live without a result yet: sell at the bid if still tradable, else wait.
   * Paper may use price-vs-strike when result hasn't landed.
   */
  async _settleClosedWindow(trade, predictions, market) {
    const result = market && market.result ? String(market.result).toLowerCase() : '';
    if (result === 'yes' || result === 'no') {
      const settleCents = result === trade.side ? 100 : 0;
      // Official settlement — never place a 0¢/100¢ sell order.
      await this._closePosition(trade, settleCents, 'settled', { skipLiveSell: true });
      return;
    }

    const isLive = this._isLiveTrade(trade);
    const marketDone = this._isMarketSettledStatus(market);
    const sideBid = this._heldSideBidCents(trade, market);

    // Live without an official result: sell at a real bid if still tradable, else wait.
    // Never invent a 0/100 payout or scratch the ledger while inventory may still exist.
    if (isLive) {
      if (!marketDone && Number.isFinite(sideBid) && sideBid >= 1 && sideBid <= 99) {
        await this._closePosition(trade, sideBid, 'settled_timeout', {
          liveSellPriceCents: sideBid,
        });
        return;
      }
      this.lastDecision =
        `Waiting: ${trade.symbol} past close but Kalshi result/quote not ready for a safe live exit.`;
      return;
    }

    const strike =
      trade.floorStrike != null
        ? Number(trade.floorStrike)
        : marketStrikePrice(market);
    const livePrice =
      predictions &&
      predictions[trade.symbol] &&
      Number.isFinite(predictions[trade.symbol].price)
        ? predictions[trade.symbol].price
        : null;

    if (Number.isFinite(strike) && Number.isFinite(livePrice)) {
      const settledUp = livePrice >= strike;
      const won = trade.side === 'yes' ? settledUp : !settledUp;
      await this._closePosition(trade, won ? 100 : 0, 'settled', { skipLiveSell: true });
      this.lastDecision =
        `Settled ${trade.symbol} ${String(trade.side).toUpperCase()} via price-vs-strike ` +
        `(${livePrice} vs ${strike}) — Kalshi result not yet posted.`;
      return;
    }

    const fallback = Number.isFinite(sideBid) ? sideBid : trade.entryPriceCents;
    await this._closePosition(trade, Number.isFinite(fallback) ? fallback : trade.entryPriceCents, 'settled_timeout', {
      skipLiveSell: true,
    });
  }

  _tradeCloseDeadline(trade) {
    return tradeWindowCloseMs(trade);
  }

  _marketCloseMs(market) {
    if (!market || !market.close_time) return NaN;
    const ms = new Date(market.close_time).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : NaN;
  }

  _isMarketSettledStatus(market) {
    const status = market && market.status ? String(market.status).toLowerCase() : '';
    // Kalshi lifecycle: closed → determined → finalized (legacy docs also said settled).
    return status === 'closed' || status === 'settled' || status === 'determined' || status === 'finalized';
  }

  /**
   * True when this trade's own session is over. Uses OR of every signal —
   * never wait on a still-"active" Kalshi payload if our saved close already passed.
   */
  _isTradePastDeadline(trade, market, now = Date.now()) {
    const storedClose = this._tradeCloseDeadline(trade);
    const marketClose = this._marketCloseMs(market);
    const openedAt = Number(trade.openedAt);
    const maxAgeMs = 16.5 * 60 * 1000;
    const tooOld = Number.isFinite(openedAt) && now - openedAt >= maxAgeMs;
    const pastStored = Number.isFinite(storedClose) && now >= storedClose;
    const pastMarket = Number.isFinite(marketClose) && now >= marketClose;
    return pastStored || pastMarket || this._isMarketSettledStatus(market) || tooOld;
  }

  _sideBidCents(market, side) {
    if (!market) return null;
    if (side === 'yes') {
      if (Number.isFinite(market.yes_bid)) return market.yes_bid;
      if (Number.isFinite(market.no_ask)) return Math.max(1, Math.min(99, 100 - market.no_ask));
      return null;
    }
    if (side === 'no') {
      if (Number.isFinite(market.no_bid)) return market.no_bid;
      if (Number.isFinite(market.yes_ask)) return Math.max(1, Math.min(99, 100 - market.yes_ask));
      return null;
    }
    return null;
  }

  _heldSideBidCents(trade, market) {
    return this._sideBidCents(market, trade && trade.side);
  }

  /** True when an open hold’s live bid is ≥ entry (flat/green). */
  async _isOpenHoldingGreen(trade) {
    if (!trade || trade.status !== 'open') return false;
    const entry = Number(trade.entryPriceCents);
    if (!Number.isFinite(entry)) return false;
    try {
      const market = await this._getMarketBounded(trade.ticker, 2000);
      const bid = this._heldSideBidCents(trade, market);
      return bid != null && Number.isFinite(bid) && bid >= entry;
    } catch {
      return false;
    }
  }

  _loadKalshiSeriesCacheFromDisk() {
    try {
      const raw = JSON.parse(fs.readFileSync(KALSHI_SERIES_CACHE_PATH, 'utf8'));
      const now = Date.now();
      for (const [series, row] of Object.entries(raw || {})) {
        if (!row || !row.market) continue;
        const at = Number(row.at);
        if (!Number.isFinite(at) || now - at > 20 * 60_000) continue;
        const market = normalizeMarketPrices(row.market);
        if (!market || !market.ticker) continue;
        this._lastLiveMarket[series] = market;
        this._lastLiveMarketAt[series] = at;
        if (marketHasUsableTwoSidedQuote(market) && this.client) {
          if (!this.client._marketByTickerCache) this.client._marketByTickerCache = new Map();
          this.client._marketByTickerCache.set(String(market.ticker), { at, market });
        }
      }
    } catch {
      // no disk cache yet
    }
  }

  _storeLiveMarketSeries(seriesTicker, market) {
    if (!seriesTicker || !market || this._inShadow) return;
    if (!this._lastLiveMarket) this._lastLiveMarket = Object.create(null);
    if (!this._lastLiveMarketAt) this._lastLiveMarketAt = Object.create(null);
    const norm = normalizeMarketPrices(market);
    if (!norm || !norm.ticker) return;
    const at = Date.now();
    this._lastLiveMarket[seriesTicker] = norm;
    this._lastLiveMarketAt[seriesTicker] = at;
    if (marketHasUsableTwoSidedQuote(norm) && this.client?._marketByTickerCache) {
      if (!this.client._marketByTickerCache) this.client._marketByTickerCache = new Map();
      this.client._marketByTickerCache.set(String(norm.ticker), { at, market: norm });
    }
    try {
      let disk = {};
      try {
        disk = JSON.parse(fs.readFileSync(KALSHI_SERIES_CACHE_PATH, 'utf8'));
      } catch {
        disk = {};
      }
      disk[seriesTicker] = { market: norm, at };
      writeJsonAtomic(KALSHI_SERIES_CACHE_PATH, disk);
    } catch {
      // ignore persist errors
    }
  }

  /** Memory → Kalshi list cache → disk. No HTTP when rate-limited. */
  async _resolveMarketFromKalshiCache(seriesTicker, minMsLeft, { limited = false } = {}) {
    const quoted = (m) => marketHasUsableTwoSidedQuote(normalizeMarketPrices(m));
    const pickFloor = limited ? 0 : minMsLeft;

    const mem = this._lastLiveMarket && this._lastLiveMarket[seriesTicker];
    if (mem && quoted(mem)) {
      return normalizeMarketPrices(mem);
    }

    let markets = null;
    if (this.client && typeof this.client.peekOpenMarkets === 'function') {
      markets = this.client.peekOpenMarkets(seriesTicker);
    }
    if (!markets && this.client && typeof this.client.getOpenMarkets === 'function') {
      markets = await this.client.getOpenMarkets(seriesTicker, 20);
    }
    if (Array.isArray(markets) && markets.length) {
      const picked =
        pickLiveOpenMarket(markets, Date.now(), pickFloor) ||
        pickLiveOpenMarket(markets, Date.now(), 0);
      if (picked && quoted(picked)) {
        this._storeLiveMarketSeries(seriesTicker, picked);
        return normalizeMarketPrices(picked);
      }
    }

    if (mem && mem.ticker && this.client && typeof this.client.getCachedMarket === 'function') {
      const hit = this.client.getCachedMarket(mem.ticker, 120_000);
      if (hit && quoted(hit)) {
        const merged = normalizeMarketPrices({ ...mem, ...hit });
        this._storeLiveMarketSeries(seriesTicker, merged);
        return merged;
      }
    }

    if (mem) return normalizeMarketPrices(mem);
    return null;
  }

  /**
   * Current tradeable Kalshi 15m market for a series (soonest still-live close).
   * Throttled hard — re-listing KXBTC15M every 5s tick was tripping Kalshi 429s.
   */
  async _fetchLiveMarket(seriesTicker, minMsLeft = 1500) {
    if (!seriesTicker || !this.client) return null;
    if (this._inShadow) {
      const cached = this._lastLiveMarket && this._lastLiveMarket[seriesTicker];
      return cached || null;
    }
    if (!this._lastLiveMarket) this._lastLiveMarket = Object.create(null);
    if (!this._lastLiveMarketAt) this._lastLiveMarketAt = Object.create(null);

    const limited =
      typeof this.client.isPublicRateLimited === 'function' && this.client.isPublicRateLimited();

    if (limited) {
      return this._resolveMarketFromKalshiCache(seriesTicker, minMsLeft, { limited: true });
    }

    const refreshMs = KALSHI_SERIES_REFRESH_MS;
    const staleCapMs = KALSHI_SERIES_STALE_CAP_MS;
    const cached = this._lastLiveMarket[seriesTicker];
    const cacheAge = Date.now() - (Number(this._lastLiveMarketAt[seriesTicker]) || 0);
    const cachedClose = cached ? parseMarketCloseMs(cached) : NaN;
    const quoted = (m) => marketHasUsableTwoSidedQuote(normalizeMarketPrices(m));
    const windowLive =
      cached &&
      Number.isFinite(cachedClose) &&
      cachedClose > Date.now() + Math.max(500, minMsLeft);

    if (cached && quoted(cached) && cacheAge < staleCapMs && windowLive && cacheAge < refreshMs) {
      return normalizeMarketPrices(cached);
    }

    let found = null;
    if (typeof this.client.getLiveOpenMarket === 'function') {
      try {
        found = await this.client.getLiveOpenMarket(seriesTicker, { minMsLeft, limit: 20 });
      } catch (_) {
        found = null;
      }
    }
    if (found) {
      if (
        found.ticker &&
        typeof this.client.getMarket === 'function' &&
        !quoted(found) &&
        !(
          typeof this.client.isPublicRateLimited === 'function' && this.client.isPublicRateLimited()
        )
      ) {
        try {
          const q = await this._getMarketBounded(found.ticker, 3500);
          if (quoted(q)) found = { ...found, ...q };
        } catch (_) {
          /* keep list row */
        }
      }
      if (quoted(found)) {
        this._storeLiveMarketSeries(seriesTicker, found);
      }
      return normalizeMarketPrices(found);
    }

    const fallback = await this._resolveMarketFromKalshiCache(seriesTicker, minMsLeft, { limited: false });
    if (fallback && quoted(fallback)) return fallback;
    // Don't fall back to the old session's market when its window has already
    // closed — that causes the bot to evaluate/bid into a closed market.
    if (cached && quoted(cached) && windowLive) return normalizeMarketPrices(cached);
    return null;
  }

  /** One pass over tradeable series — serial, stops on 429. */
  async _prefetchKalshiForSymbols(symbols, minMsLeft = 5000) {
    if (this._inShadow || !Array.isArray(symbols) || !symbols.length) return;
    const series = [
      ...new Set(
        symbols
          .map((s) => SERIES_BY_SYMBOL[String(s || '').toUpperCase()])
          .filter(Boolean)
      ),
    ];
    for (const st of series) {
      await this._fetchLiveMarket(st, minMsLeft);
      if (
        this.client &&
        typeof this.client.isPublicRateLimited === 'function' &&
        this.client.isPublicRateLimited()
      ) {
        break;
      }
    }
  }

  _liveMarketWaitReason(symbol, seriesTicker) {
    const st = seriesTicker || SERIES_BY_SYMBOL[String(symbol || '').toUpperCase()];
    const limited =
      this.client &&
      typeof this.client.isPublicRateLimited === 'function' &&
      this.client.isPublicRateLimited();
    if (limited) {
      const remMs =
        typeof this.client.publicRateLimitRemainingMs === 'function'
          ? this.client.publicRateLimitRemainingMs()
          : 0;
      const sec = remMs > 0 ? Math.max(1, Math.ceil(remMs / 1000)) : 'a few';
      if (!this._seriesHasUsableCachedQuote(st)) {
        const hasRow =
          (st && this._lastLiveMarket && this._lastLiveMarket[st]) ||
          (st &&
            this.client &&
            typeof this.client.peekOpenMarkets === 'function' &&
            (this.client.peekOpenMarkets(st) || []).length);
        if (!hasRow) {
          return `Waiting: ${symbol} — Kalshi rate limit (~${sec}s), no cached quote yet.`;
        }
        return `Waiting: ${symbol} — Kalshi rate limit (~${sec}s), cached row lacks bid/ask.`;
      }
      return `Waiting: ${symbol} — Kalshi rate limit (~${sec}s), using cached quote.`;
    }
    return `Waiting: ${symbol} 15m window rolling over (new ticker not listed yet).`;
  }

  /**
   * Second (and further) opens only when at least one existing open is green,
   * or (settle) any open has tagged 90¢ — that latch unlocks a temporary 3rd slot.
   * First open always allowed. Off via secondOpenRequiresGreen: 'off'.
   */
  async _canOpenAdditionalPosition() {
    if (this.openTrades.length === 0) return { ok: true };
    const flag = String(this.config.secondOpenRequiresGreen ?? 'on').toLowerCase();
    if (flag === 'off' || flag === 'false' || flag === 'no' || flag === '0') {
      return { ok: true };
    }
    if (isSettleStrategyMode(this.config) && this._hasTouched90Open()) {
      return { ok: true, touched90: true };
    }
    for (const t of this.openTrades) {
      if (await this._isOpenHoldingGreen(t)) {
        return { ok: true, greenSymbol: t.symbol };
      }
    }
    const held = this.openTrades.map((t) => t.symbol).join(', ');
    return {
      ok: false,
      reason:
        `Waiting: already holding ${held} — only open another when an existing position is green (bid ≥ entry).`,
    };
  }

  /**
   * Live entry ask for a side — used to re-quote before IOC.
   * Returns null when the book can't be read so callers don't +1¢ a stale plan price.
   */
  async _refreshLiveEntryAskCents(ticker, side) {
    try {
      const market = await this._getMarketBounded(ticker, 2000);
      if (!market) return null;
      if (side === 'yes') {
        const ask = Number(market.yes_ask);
        return Number.isFinite(ask) && ask >= 1 && ask <= 99 ? ask : null;
      }
      if (Number.isFinite(market.no_ask) && market.no_ask >= 1 && market.no_ask <= 99) {
        return market.no_ask;
      }
      const yesBid = Number(market.yes_bid);
      if (Number.isFinite(yesBid)) {
        const noAsk = 100 - yesBid;
        if (noAsk >= 1 && noAsk <= 99) return noAsk;
      }
    } catch (err) {
      console.warn(`[bot] entry re-quote ${ticker} failed:`, err.message);
    }
    return null;
  }

  /** Normalize + merge ticker cache (cache-only during 429 — safe to call while limited). */
  async _hydrateMarketQuote(market, timeoutMs = 3500) {
    if (!market || typeof market !== 'object') return null;
    let merged = normalizeMarketPrices(market);
    const usable = (m) => marketHasUsableTwoSidedQuote(normalizeMarketPrices(m));
    if (usable(merged)) return merged;
    const ticker = merged.ticker;
    if (!ticker || typeof this._getMarketBounded !== 'function') return usable(merged) ? merged : null;
    try {
      const hit = await this._getMarketBounded(ticker, timeoutMs);
      if (hit && typeof hit === 'object') {
        merged = normalizeMarketPrices({ ...merged, ...hit });
      }
    } catch (_) {
      /* cache-only during cooldown */
    }
    return usable(merged) ? merged : null;
  }

  _seriesHasUsableCachedQuote(seriesTicker) {
    const st = String(seriesTicker || '');
    if (!st) return false;
    const mem = this._lastLiveMarket && this._lastLiveMarket[st];
    if (mem && marketHasUsableTwoSidedQuote(normalizeMarketPrices(mem))) return true;
    const peek =
      this.client &&
      typeof this.client.peekOpenMarkets === 'function' &&
      this.client.peekOpenMarkets(st);
    if (Array.isArray(peek)) {
      for (const m of peek) {
        if (marketHasUsableTwoSidedQuote(normalizeMarketPrices(m))) return true;
      }
    }
    if (mem && mem.ticker && this.client && typeof this.client.getCachedMarket === 'function') {
      const hit = this.client.getCachedMarket(mem.ticker, 120_000);
      if (hit && marketHasUsableTwoSidedQuote(normalizeMarketPrices(hit))) return true;
    }
    return false;
  }

  async _getMarketBounded(ticker, timeoutMs = 4000) {
    if (!ticker || !this.client || typeof this.client.getMarket !== 'function') return null;
    const peek = (maxAgeMs) =>
      typeof this.client.getCachedMarket === 'function'
        ? this.client.getCachedMarket(ticker, maxAgeMs)
        : null;
    const limited =
      typeof this.client.isPublicRateLimited === 'function' && this.client.isPublicRateLimited();
    // Shadow sims must not burn Kalshi quota — cache / live-cycle snapshot only.
    if (this._inShadow) {
      const hit = peek(Infinity);
      if (hit) return hit;
      if (this._lastLiveMarket) {
        for (const m of Object.values(this._lastLiveMarket)) {
          if (m && String(m.ticker) === String(ticker)) return m;
        }
      }
      return null;
    }
    // During 429 cooldown: cache only — never queue another GET behind the gate.
    if (limited) {
      const hit = peek(120_000);
      if (hit) return hit;
      if (this._lastLiveMarket) {
        for (const m of Object.values(this._lastLiveMarket)) {
          if (m && String(m.ticker) === String(ticker)) return normalizeMarketPrices(m);
        }
      }
      return null;
    }
    const fresh = peek(20_000);
    if (fresh) return fresh;

    let timer = null;
    try {
      return await Promise.race([
        this.client.getMarket(ticker),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(peek(60_000) || null), timeoutMs);
        }),
      ]);
    } catch (err) {
      const fallback = peek(60_000);
      if (fallback) return fallback;
      console.warn(`[bot] getMarket ${ticker}:`, err && err.message ? err.message : err);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Close any trade whose own window is already over. Safe to call on a
   * tight timer independent of prediction compute — this is what stops
   * open positions from "freezing" into the next 15m dashboard session.
   */
  async forceSettleOverdue(predictions) {
    return this._withTradeLock(() => this._forceSettleOverdueUnlocked(predictions));
  }

  async _forceSettleOverdueUnlocked(predictions) {
    const now = Date.now();
    let settled = 0;
    for (const trade of [...this.openTrades]) {
      if (trade.status !== 'open') continue;
      const deadline = this._tradeCloseDeadline(trade);
      const openedAt = Number(trade.openedAt);
      const due =
        (Number.isFinite(deadline) && now >= deadline) ||
        (Number.isFinite(openedAt) && now - openedAt >= 16.5 * 60 * 1000);
      if (!due) continue;

      console.warn(
        `[bot] force-settle overdue ${trade.symbol} ${String(trade.side).toUpperCase()} ` +
          `${trade.ticker} (saved close ${Number.isFinite(deadline) ? new Date(deadline).toISOString() : 'n/a'})`
      );
      let market = null;
      try {
        market = await this._getMarketBounded(trade.ticker, 1000);
      } catch (err) {
        console.warn(`[bot] overdue settle fetch ${trade.ticker}: ${err.message}`);
      }
      try {
        const before = trade.status;
        await this._settleClosedWindow(trade, predictions, market);
        if (before === 'open' && trade.status === 'closed') settled += 1;
      } catch (err) {
        console.error(`[bot] overdue settle failed ${trade.ticker}:`, err.message);
        if (trade.status === 'open' && !this._isLiveTrade(trade)) {
          try {
            await this._closePosition(
              trade,
              Number.isFinite(trade.entryPriceCents) ? trade.entryPriceCents : 50,
              'settled_timeout',
              { skipLiveSell: true }
            );
            settled += 1;
          } catch (closeErr) {
            console.error(`[bot] emergency scratch failed ${trade.ticker}:`, closeErr.message);
          }
        }
      }
    }
    return settled;
  }

  async _manageOpenTrade(trade, predictions) {
    const now = Date.now();
    const storedClose = this._tradeCloseDeadline(trade);
    const pastSavedClose = Number.isFinite(storedClose) && now >= storedClose;
    const tooOld =
      Number.isFinite(Number(trade.openedAt)) && now - Number(trade.openedAt) >= 16.5 * 60 * 1000;

    // Once THIS trade's window is over, settle this cycle. Never sit through
    // the next dashboard session waiting on a hung Kalshi fetch.
    if (pastSavedClose || tooOld) {
      let market = null;
      try {
        market = await this._getMarketBounded(trade.ticker, 1000);
      } catch (err) {
        console.warn(`[bot] market fetch for settle ${trade.ticker}: ${err.message}`);
      }
      await this._settleClosedWindow(trade, predictions, market);
      return;
    }

    let market = null;
    try {
      market = await this._getMarketBounded(trade.ticker, 4000);
    } catch (err) {
      console.warn(`[bot] market fetch ${trade.ticker}:`, err && err.message ? err.message : err);
      market = null;
    }

    if (!market) return;

    if (trade.symbol) this._noteEngineStrike(trade.symbol, market);

    if (this._isTradePastDeadline(trade, market, now)) {
      await this._settleClosedWindow(trade, predictions, market);
      return;
    }

    const heldSideBidCents = this._heldSideBidCents(trade, market);
    // Peak held bid: settle (weak-ticket) + model (trail before dumps).
    if (
      (isSettleTrade(trade) || isModelTrade(trade)) &&
      heldSideBidCents != null &&
      Number.isFinite(heldSideBidCents) &&
      heldSideBidCents >= 1 &&
      heldSideBidCents <= 99
    ) {
      const prevPeak = Number(trade.peakHeldBidCents);
      const entryPeak = Number(trade.entryPriceCents);
      const base = Number.isFinite(prevPeak) ? prevPeak : Number.isFinite(entryPeak) ? entryPeak : heldSideBidCents;
      const nextPeak = Math.max(base, heldSideBidCents);
      if (!Number.isFinite(prevPeak) || nextPeak > prevPeak) {
        trade.peakHeldBidCents = nextPeak;
        trade.peakHeldBidAt = now;
        this._persist();
      } else if (!Number.isFinite(Number(trade.peakHeldBidAt))) {
        trade.peakHeldBidAt = now;
      }
    }
    // For stop/TP timing use the earliest known close so we don't hold into the next session.
    const closeCandidates = [storedClose, this._marketCloseMs(market)].filter((t) => Number.isFinite(t) && t > 0);
    const closeTime = closeCandidates.length ? Math.min(...closeCandidates) : NaN;

    if (!Number.isFinite(closeTime)) {
      if (market.result) {
        await this._settleClosedWindow(trade, predictions, market);
      }
      return;
    }

    const minutesRemaining = (closeTime - now) / 60000;

    // Early warning exit: if the engine's own 0-5 minute signal has
    // flipped to favor the opposite side of what we're holding — even by
    // a small margin — get out now rather than waiting for Kalshi's own
    // odds to grind all the way down to the stop-loss threshold. Only
    // meaningful once the actual Kalshi window has 5 minutes or less left
    // — that's what the 0-5 min window's prediction is actually about,
    // and checking it any earlier (e.g. with 12 minutes still on the
    // clock) doesn't correspond to what that window is predicting.
    const inFinalFiveMinutes = minutesRemaining <= 5;
    // Last 30s–60s: stop holding for settlement — you're just waiting on Kalshi.
    const inPreCloseTakeProfitWindow = minutesRemaining <= 1;
    const shortWindow = inFinalFiveMinutes && predictions && predictions[trade.symbol] && predictions[trade.symbol].ready
      ? predictions[trade.symbol].windows.w5
      : null;
    const signalFlipped =
      shortWindow &&
      ((trade.side === 'yes' && shortWindow.probabilityDown > shortWindow.probabilityUp) ||
        (trade.side === 'no' && shortWindow.probabilityUp > shortWindow.probabilityDown));

    // Final-5 confidence hold: ride settlement only before the last minute.
    // Inside the last ~60s (and at near-certain bids), take the money instead.
    const heldFavoredByShortWindow =
      shortWindow &&
      shortWindow.confidence >= this.config.minConfidence &&
      ((trade.side === 'yes' && shortWindow.probabilityUp >= shortWindow.probabilityDown) ||
        (trade.side === 'no' && shortWindow.probabilityDown >= shortWindow.probabilityUp));
    const holdThroughForConfidence =
      inFinalFiveMinutes && !inPreCloseTakeProfitWindow && heldFavoredByShortWindow;

    // Stronger early-warning exit: if BOTH of the next two windows (5-10
    // and 10-15 min out) strongly agree the price is heading the opposite
    // way from our held position — not just a marginal >50% flip, but a
    // real majority on both — that's a much more serious reversal signal
    // than a single-window flip, so it's checked at ANY point in the
    // trade's life, not gated to the final 5 minutes.
    const REVERSAL_THRESHOLD_PCT = 65;
    const assetPred = predictions && predictions[trade.symbol] && predictions[trade.symbol].ready
      ? predictions[trade.symbol]
      : null;
    const w10 = assetPred ? assetPred.windows.w10 : null;
    const w15 = assetPred ? assetPred.windows.w15 : null;
    const heldIsYes = trade.side === 'yes';
    const w10AgainstUs = w10 && (heldIsYes ? w10.probabilityDown : w10.probabilityUp) >= REVERSAL_THRESHOLD_PCT;
    const w15AgainstUs = w15 && (heldIsYes ? w15.probabilityDown : w15.probabilityUp) >= REVERSAL_THRESHOLD_PCT;
    const strongReversalSignal = w10AgainstUs && w15AgainstUs;

    const stopLevel = this._stopLevelCents(trade, now);
    const takeProfitLevel = this._takeProfitLevelCents(trade);
    // ~97¢ = market basically sure — don't sit for settlement lag over 3¢.
    const nearCertainExitCents = Number.isFinite(Number(this.config.nearCertainExitCents))
      ? Number(this.config.nearCertainExitCents)
      : 97;
    const nearCertainHit =
      heldSideBidCents != null &&
      Number.isFinite(nearCertainExitCents) &&
      nearCertainExitCents > 0 &&
      heldSideBidCents >= nearCertainExitCents &&
      Number.isFinite(trade.entryPriceCents) &&
      heldSideBidCents > trade.entryPriceCents;

    const takeProfitHit =
      heldSideBidCents != null &&
      takeProfitLevel != null &&
      heldSideBidCents >= takeProfitLevel &&
      Number.isFinite(trade.entryPriceCents) &&
      heldSideBidCents > trade.entryPriceCents;

    // Breakeven in the last 5 minutes when confidence is NOT high in our
    // favor: lock even-or-better instead of gambling settlement.
    const canExitEven =
      inFinalFiveMinutes &&
      !holdThroughForConfidence &&
      heldSideBidCents != null &&
      heldSideBidCents >= trade.entryPriceCents;

    // Failed exit on THIS position: retry every cycle until flat — never open
    // a second contract on the same window (backup = force-retry lane).
    if (trade.pendingForceExit) {
      let forceReason = String(trade.pendingForceExit);
      const entryPx = Number(trade.entryPriceCents);
      const stuckSince = Number(trade.pendingForceExitSince);
      const stuckMs = Number.isFinite(stuckSince) ? now - stuckSince : 0;
      const escalated = stuckMs >= FORCE_EXIT_ESCALATE_MS_DEFAULT;
      // Stale BE force-retry while truly red can never fill (fake-BE guard).
      // Promote to model_against so we actually cut instead of looping to settlement.
      if (
        forceReason === 'breakeven' &&
        isModelTrade(trade) &&
        heldSideBidCents != null &&
        Number.isFinite(heldSideBidCents) &&
        !modelBreakevenExitAllowed(trade, heldSideBidCents)
      ) {
        forceReason = 'model_against';
        this._armPendingForceExit(trade, forceReason);
      }
      // TP miss while already red → cut at bid (don't wait for +7¢ that won't come back).
      if (
        forceReason === 'take_profit' &&
        isModelTrade(trade) &&
        heldSideBidCents != null &&
        Number.isFinite(entryPx) &&
        heldSideBidCents < entryPx
      ) {
        forceReason = 'model_against';
        this._armPendingForceExit(trade, forceReason);
      }
      if (
        heldSideBidCents != null &&
        Number.isFinite(heldSideBidCents) &&
        heldSideBidCents >= 1 &&
        heldSideBidCents <= 99
      ) {
        await this._closePosition(trade, heldSideBidCents, forceReason, {
          liveSellPriceCents: heldSideBidCents,
          forcePendingExit: true,
          escalated,
        });
      } else {
        this.lastDecision =
          `Pending ${forceReason} exit on ${trade.symbol}: waiting for a tradable bid (1–99¢).`;
      }
      return;
    }

    // Model: hold while direction is firm (model still with us). When lean turns
    // or post-fill direction fails → BE/cut quickly; only firm holds ride reds
    // toward max-loss / pace near the hard floor.
    // Final 5m: high possibility may extend; low possibility exits immediately.
    if (isModelTrade(trade)) {
      const picked = assetPred ? pickModelWindow(assetPred, minutesRemaining) : null;
      const entry = Number(trade.entryPriceCents);
      const bidOk =
        heldSideBidCents != null &&
        Number.isFinite(heldSideBidCents) &&
        heldSideBidCents >= 1 &&
        heldSideBidCents <= 99;
      const minTp = modelMinTpCents(this.config);
      const bankGreen = modelBankGreenCents(this.config);
      const nearTargetBank = modelNearTargetBankCents(this.config);
      const flatOrGreen =
        bidOk && Number.isFinite(entry) && entry >= 1 && heldSideBidCents >= entry;
      const greenCents =
        flatOrGreen && Number.isFinite(entry) ? Math.round(heldSideBidCents - entry) : 0;
      let isBankableGreen = flatOrGreen && greenCents >= Math.max(1, minTp || 0);
      let isDecentGreen = flatOrGreen && bankGreen > 0 && greenCents >= bankGreen;
      const exactlyFlat =
        bidOk && Number.isFinite(entry) && Math.round(heldSideBidCents) === Math.round(entry);
      const nearFlat = bidOk && modelNearFlatCents(trade, heldSideBidCents);
      const scratchFlat = exactlyFlat || nearFlat;
      const underwater = bidOk && Number.isFinite(entry) && entry >= 1 && heldSideBidCents < entry;
      const adverseCents =
        underwater && Number.isFinite(entry) ? Math.round(entry - heldSideBidCents) : 0;
      const faded = trade.modelInverted === true;
      const againstLocked =
        picked &&
        picked.direction &&
        modelDirectionAgainstHeld(picked.direction, trade.side);
      const liveAgainst =
        picked &&
        picked.window &&
        modelLiveLeanAgainstHeld(picked.window, trade.side, modelLiveLeanMarginPct(this.config));
      const liveFavors =
        picked &&
        picked.window &&
        modelLiveLeanStillFavors(picked.window, trade.side, modelSoftLeanMarginPct(this.config));
      const minConf = Number.isFinite(Number(this.config.modelMinConfidence))
        ? Number(this.config.modelMinConfidence)
        : MODEL_MIN_CONFIDENCE_DEFAULT;
      const liveHeldProb = picked && picked.window
        ? modelHeldSideProb(picked.window, trade.side)
        : null;
      // Stamp exit lean on the trade every cycle so _closePosition always has the latest value.
      if (Number.isFinite(liveHeldProb)) {
        trade._liveExitHeldProb = +Number(liveHeldProb).toFixed(1);
      }
      const entryHeldProbRaw = Number(trade.modelEntryHeldProb);
      const entryHeldProb = Number.isFinite(entryHeldProbRaw)
        ? entryHeldProbRaw
        : Number(trade.engineProbability);
      const engineTurning =
        picked &&
        picked.window &&
        modelEngineHardAgainst({
          window: picked.window,
          direction: picked.direction,
          side: trade.side,
          minConf,
          config: this.config,
        });
      const engineSoftTurning =
        picked &&
        picked.window &&
        modelEngineTurningAgainst({
          window: picked.window,
          direction: picked.direction,
          side: trade.side,
          minConf,
          entryHeldProb,
          config: this.config,
        });
      const engineClearlyWithUs =
        picked &&
        picked.window &&
        modelEngineClearlyWithUs({
          window: picked.window,
          direction: picked.direction,
          side: trade.side,
          entryHeldProb,
          config: this.config,
        });
      const weakConf =
        picked &&
        picked.window &&
        Number.isFinite(picked.window.confidence) &&
        picked.window.confidence < minConf;
      // Fade holds are *supposed* to sit against the lock — don't BE-scratch
      // just because the signal still points the original way.
      // Follow: hard lean-turning always exits; soft "not clearly with us" only after open grace
      // (ask→bid haircut looks red for the first seconds — don't knife that).
      const openedAt = Number(trade.openedAt);
      const heldMs = Number.isFinite(openedAt) ? now - openedAt : Infinity;
      const openGraceMs = modelOpenGraceMs(this.config);
      const inOpenGrace = openGraceMs > 0 && heldMs < openGraceMs;
      const leanExit = faded
        ? !!weakConf
        : !!(
            engineSoftTurning ||
            (!inOpenGrace && picked && picked.window && !engineClearlyWithUs)
          );

      const minHold = modelMinHoldMs(this.config);
      const heldLongEnough = minHold <= 0 || heldMs >= minHold;
      const bankHoldMs = minHold > 0 ? Math.min(minHold, 30_000) : 0;
      const heldForBank = bankHoldMs <= 0 || heldMs >= bankHoldMs;

      // Entry is at ask; mark is bid. Only count red beyond the entry spread haircut.
      const entryBidStamp = Number(trade.modelEntryBidCents);
      const entrySpreadStamp = Number(trade.modelEntrySpreadCents);
      const entrySpread = Number.isFinite(entrySpreadStamp)
        ? Math.max(0, Math.round(entrySpreadStamp))
        : Number.isFinite(entry) && Number.isFinite(entryBidStamp)
          ? Math.max(0, Math.round(entry - entryBidStamp))
          : 0;
      const trueAdverse =
        underwater && Number.isFinite(adverseCents)
          ? Math.max(0, adverseCents - entrySpread)
          : 0;
      const econUnderwater = trueAdverse > 0;

      const peak = Number(trade.peakHeldBidCents);
      const peakAt = Number(trade.peakHeldBidAt);
      const pullback =
        bidOk && Number.isFinite(peak) ? Math.max(0, Math.round(peak - heldSideBidCents)) : 0;
      const stallMs = modelMomentumStallMs(this.config);
      const stallPullback = modelMomentumPullbackCents(this.config);
      const peakAgeMs = Number.isFinite(peakAt) ? now - peakAt : Infinity;
      const momentumStalled =
        (stallPullback > 0 && pullback >= stallPullback) ||
        (stallMs > 0 && peakAgeMs >= stallMs);
      const armCents = modelTrailArmCents(this.config);
      const armed = flatOrGreen && greenCents >= armCents;
      const priceStalled = momentumStalled;
      const upwardMomentum = modelUpwardMomentumEvidence(trade, {
        greenCents,
        heldSideBidCents,
        peakHeldBidCents: peak,
        peakHeldBidAt: peakAt,
        now,
        config: this.config,
        beChaseMode: !armed,
      });
      if (armed && upwardMomentum) {
        trade.modelArmHadMomentum = true;
      }
      if (!armed || underwater) {
        delete trade.modelArmHadMomentum;
      }
      let momentumRun = faded ? !momentumStalled : !!(liveFavors && !momentumStalled);

      // Fade TP is −N¢ on the lean/current side (YES if UP, NO if DOWN),
      // not +N¢ on the faded ticket. Sell is still the held contract.
      const signalSide =
        trade.modelSignalSide ||
        (faded ? flipKalshiSide(trade.side) : trade.side);
      const signalBid = this._sideBidCents(market, signalSide);
      const signalOk =
        signalBid != null &&
        Number.isFinite(signalBid) &&
        signalBid >= 1 &&
        signalBid <= 99;
      const signalEntry = Number(trade.modelSignalEntryCents);
      let fadeSignalDrop = 0;
      if (faded && signalOk && Number.isFinite(signalEntry) && signalEntry >= 1) {
        const prevTrough = Number(trade.troughSignalBidCents);
        const baseTrough = Number.isFinite(prevTrough) ? prevTrough : Math.min(signalEntry, signalBid);
        const nextTrough = Math.min(baseTrough, signalBid);
        if (!Number.isFinite(prevTrough) || nextTrough < prevTrough) {
          trade.troughSignalBidCents = nextTrough;
          trade.troughSignalBidAt = now;
          this._persist();
        } else if (!Number.isFinite(Number(trade.troughSignalBidAt))) {
          trade.troughSignalBidAt = now;
        }
        fadeSignalDrop = modelSignalDropCents(signalEntry, signalBid);
        // Lean-side −N¢ is the thesis, but TAKE_PROFIT must be real ¢ on the
        // held ticket. Don't overwrite held green with a signal-drop flag —
        // that was booking 54→50 / 65→38 as "TP".
        const trough = Number(trade.troughSignalBidCents);
        const troughAt = Number(trade.troughSignalBidAt);
        const bounce = Number.isFinite(trough) ? Math.max(0, Math.round(signalBid - trough)) : 0;
        const troughAgeMs = Number.isFinite(troughAt) ? now - troughAt : Infinity;
        const signalStalled =
          (stallPullback > 0 && bounce >= stallPullback) ||
          (stallMs > 0 && troughAgeMs >= stallMs);
        momentumRun = !signalStalled;
      }

      if (bidOk && heldSideBidCents >= MODEL_RICH_BANK_CENTS_DEFAULT) {
        await this._closePosition(trade, heldSideBidCents, 'take_profit', {
          liveSellPriceCents: heldSideBidCents,
        });
        return;
      }

      const modelFirm = !!(picked && picked.window && engineClearlyWithUs);
      const againstBeDelay = modelLeanAgainstBeMs(this.config);
      const againstBeReady = !inOpenGrace && heldMs >= openGraceMs + againstBeDelay;
      const modelHardAgainst =
        !faded && bidOk && picked && picked.window && engineTurning;
      const leanStaleScratch =
        !faded &&
        picked &&
        picked.window &&
        modelLeanStaleForScratch(picked.window, trade.side, engineClearlyWithUs, this.config);

      const tryModelBreakevenScratch = async () => {
        if (!modelBreakevenExitAllowed(trade, heldSideBidCents)) {
          // Never arm a BE force-retry that the guard will reject forever.
          delete trade.pendingForceExit;
          return false;
        }
        const beFill = this.config.mode === 'paper' ? entry : heldSideBidCents;
        const closed = await this._closePosition(trade, beFill, 'breakeven', {
          liveSellPriceCents: heldSideBidCents,
        });
        if (!closed && this._isLiveTrade(trade) && trade.status === 'open') {
          trade.pendingForceExit = 'breakeven';
          if (!Number.isFinite(Number(trade.pendingForceExitSince))) {
            trade.pendingForceExitSince = Date.now();
          }
          this.lastDecision =
            `BE scratch missed on ${trade.symbol} — retrying every cycle until flat.`;
          this._logActivity(this.lastDecision, {
            kind: 'close',
            symbol: trade.symbol,
            side: trade.side,
            tradeId: trade.id,
          });
          this._persist();
        }
        return closed;
      };

      /** Hard lean against + red: sell the bid (loss cut). Not labeled breakeven. */
      const tryModelAgainstCut = async (exitReason = 'model_against') => {
        const reason = String(exitReason || 'model_against');
        const cutFill = heldSideBidCents;
        const closed = await this._closePosition(trade, cutFill, reason, {
          liveSellPriceCents: heldSideBidCents,
        });
        if (!closed && this._isLiveTrade(trade) && trade.status === 'open') {
          trade.pendingForceExit = reason;
          if (!Number.isFinite(Number(trade.pendingForceExitSince))) {
            trade.pendingForceExitSince = Date.now();
          }
          this.lastDecision =
            `Model cut (${reason}) missed on ${trade.symbol} — retrying every cycle until flat.`;
          this._logActivity(this.lastDecision, {
            kind: 'close',
            symbol: trade.symbol,
            side: trade.side,
            tradeId: trade.id,
          });
          this._persist();
        }
        return closed;
      };

      const exitModelAgainst = async () => {
        if (flatOrGreen || nearFlat) {
          if (isBankableGreen && heldForBank) {
            await this._closePosition(trade, heldSideBidCents, 'take_profit', {
              liveSellPriceCents: heldSideBidCents,
            });
          } else {
            await tryModelBreakevenScratch();
          }
          return true;
        }
        if (underwater || econUnderwater) {
          await tryModelAgainstCut();
          return true;
        }
        return false;
      };

      const modelDeteriorating =
        !faded &&
        !!(
          modelHardAgainst ||
          leanStaleScratch ||
          // Soft turning only counts when lean is actually mushy/against —
          // a 3pt drift from 90→87 while still 87/13 must NOT force cuts.
          (engineSoftTurning && leanStaleScratch)
        );

      // Soft/50-50 no longer instant-cuts — stagnation + hard flip own mushy thesis.
      const peakProgress = modelPeakProgressCents(trade, peak);

      const rapidAdverse = modelRapidAdverseExitReady({
        trueAdverseCents: trueAdverse,
        modelAgainst: modelDeteriorating,
        inOpenGrace,
        config: this.config,
      });
      if (bidOk && rapidAdverse.ready) {
        this.lastDecision =
          `Rapid adverse −${rapidAdverse.adverse}¢ (≥${rapidAdverse.need}¢) + model decaying on ${trade.symbol} — cutting.`;
        await tryModelAgainstCut('model_rapid_adverse');
        return;
      }

      // Stagnation: held long enough with no peak progress toward TP + model decaying.
      // Time alone never exits — must also show thesis deterioration.
      const stagnation = modelStagnationExitReady({
        heldMs,
        peakProgressCents: peakProgress,
        modelDeteriorating,
        config: this.config,
      });
      if (bidOk && stagnation.ready) {
        this.lastDecision =
          `Stagnation ${stagnation.needSec}s with only +${stagnation.peakProgress}¢ peak + model decaying on ${trade.symbol} — exiting.`;
        if (underwater || econUnderwater) {
          await tryModelAgainstCut('model_stagnation');
        } else if (isBankableGreen && heldForBank) {
          await this._closePosition(trade, heldSideBidCents, 'take_profit', {
            liveSellPriceCents: heldSideBidCents,
          });
        } else if (upwardMomentum) {
          this.lastDecision =
            `Stagnation thesis soft on ${trade.symbol} but bid still rising — holding (no BE scratch).`;
          this._persist();
        } else if (scratchFlat || flatOrGreen) {
          await tryModelBreakevenScratch();
        } else {
          await tryModelAgainstCut('model_stagnation');
        }
        return;
      }

      // BE chase: crossed bid≥entry → N seconds to reach +3¢ or scratch.
      // Never scratches while the model is still firm — that was the "easy BE".
      const beChase = modelBeChaseExitReady(trade, {
        nearFlat,
        flatOrGreen,
        peakProgressCents: peakProgress,
        now,
        config: this.config,
        upwardEvidence: upwardMomentum,
      });
      if (beChase.started || beChase.reset || beChase.achieved || beChase.holdingRise) {
        this._persist();
      }
      if (
        bidOk &&
        againstBeReady &&
        beChase.ready &&
        flatOrGreen &&
        !upwardMomentum &&
        modelDeteriorating
      ) {
        this.lastDecision =
          `BE chase ${beChase.needSec}s expired (peak +${beChase.peakProgress}¢, need +${beChase.needProgress}¢) + lean decaying on ${trade.symbol} — scratching.`;
        if (await tryModelBreakevenScratch()) return;
      }
      if (bidOk && beChase.ready && flatOrGreen && !modelDeteriorating) {
        this.lastDecision =
          `BE chase ${beChase.needSec}s up on ${trade.symbol} but model still firm — holding (no easy BE).`;
        trade.holdReason = this.lastDecision;
        this._persist();
      }

      // Strong lean rotting (99/1 → 85/15): cut if no recovery — smaller loss beats cliff.
      if (bidOk && picked && picked.window && !faded) {
        const decay = modelLeanDecayCutState(trade, picked.window, trade.side, now, this.config);
        if (decay.inDecayZone && decay.cutReady) {
          const up = Number(picked.window.probabilityUp);
          const down = Number(picked.window.probabilityDown);
          const leanTxt =
            Number.isFinite(up) && Number.isFinite(down)
              ? `${Math.round(up)}/${Math.round(down)} (peak ${Math.round(decay.peakLean)})`
              : 'lean n/a';
          this.lastDecision =
            `Lean decay ${leanTxt} on ${trade.symbol} — no recovery, cashing out.`;
          if (underwater || econUnderwater) {
            await tryModelAgainstCut();
            return;
          }
          if (isBankableGreen && heldForBank) {
            await this._closePosition(trade, heldSideBidCents, 'take_profit', {
              liveSellPriceCents: heldSideBidCents,
            });
            return;
          }
          if (scratchFlat || flatOrGreen) {
            await tryModelBreakevenScratch();
            return;
          }
          await tryModelAgainstCut();
          return;
        }
      }

      if (modelHardAgainst && againstBeReady) {
        if (await exitModelAgainst()) return;
      }

      // Soft/50-50 lean no longer instant-BE or MODEL_AGAINST — stagnation owns mushy thesis.
      // (leanStaleScratch still feeds modelDeteriorating for the stagnation check above.)

      // Bid-led dump: only act when hard lean against (firm holds ignore price slides).
      const dumpPullback = modelDumpPullbackCents(this.config);
      if (!faded && bidOk && dumpPullback > 0 && pullback >= dumpPullback) {
        if (modelHardAgainst && againstBeReady) {
          if (await exitModelAgainst()) return;
        } else if (isBankableGreen && heldForBank) {
          await this._closePosition(trade, heldSideBidCents, 'take_profit', {
            liveSellPriceCents: heldSideBidCents,
          });
          return;
        }
      }

      // ── Pre-settle cash-outs (avoid SETTLED 0/100 wipeouts) ─────────────
      // Defaults: force exit in last 1m; barrier at 2m; settle-close from 2.5m.
      // High-possibility extend can ride the barrier, but never the last minute.
      const lateBarrierMins = modelLateBarrierMinutes(this.config);
      const settleCloseMins = modelSettleCloseMinutes(this.config);
      const preCloseForceMins = modelPreCloseForceMinutes(this.config);
      const settleCloseThresh = Number.isFinite(Number(this.config.modelSettleCloseLossCents))
        ? Number(this.config.modelSettleCloseLossCents)
        : MODEL_SETTLE_CLOSE_UNLESS_LOSS_CENTS_DEFAULT;
      const inLateBarrier = lateBarrierMins > 0 && minutesRemaining <= lateBarrierMins;
      const inSettleClose = settleCloseMins > 0 && minutesRemaining <= settleCloseMins;
      const inPreCloseForce = preCloseForceMins > 0 && minutesRemaining <= preCloseForceMins;
      const canExtendLate = !!(
        inLateBarrier &&
        !inPreCloseForce &&
        picked &&
        picked.window &&
        modelLateExtendOk(picked.window, trade.side, this.config)
      );

      const exitModelPreSettle = async (forceReason) => {
        if (!bidOk) return false;
        if (flatOrGreen || nearFlat) {
          if (isBankableGreen && heldForBank) {
            await this._closePosition(trade, heldSideBidCents, 'take_profit', {
              liveSellPriceCents: heldSideBidCents,
            });
          } else if (scratchFlat || flatOrGreen) {
            await tryModelBreakevenScratch();
          } else {
            await this._closePosition(trade, heldSideBidCents, forceReason, {
              liveSellPriceCents: heldSideBidCents,
            });
          }
          return true;
        }
        const redCents = underwater ? adverseCents : 0;
        // Deep red beyond thresh: only force in the final minute (never settle at 0).
        if (redCents > settleCloseThresh && !inPreCloseForce) return false;
        const closed = await this._closePosition(trade, heldSideBidCents, forceReason, {
          liveSellPriceCents: heldSideBidCents,
        });
        if (!closed && this._isLiveTrade(trade) && trade.status === 'open') {
          this._armPendingForceExit(trade, forceReason);
          this._persist();
        }
        return true;
      };

      if (bidOk && inPreCloseForce) {
        await exitModelPreSettle('model_pre_close');
        return;
      }
      if (bidOk && inLateBarrier && !canExtendLate) {
        await exitModelPreSettle('model_late_exit');
        return;
      }
      if (canExtendLate) {
        this.lastDecision =
          `Holding ${trade.symbol} into final ${lateBarrierMins}m — high possibility ` +
          `(conf ${Number.isFinite(picked.window.confidence) ? Math.round(picked.window.confidence) : '?'}%, lean with us).`;
        // Fall through: still allow TP / lean rules while extending.
      } else if (bidOk && inSettleClose) {
        const redCents = underwater ? adverseCents : 0;
        if (redCents <= settleCloseThresh || flatOrGreen || nearFlat) {
          await exitModelPreSettle('model_late_exit');
          return;
        }
      }

      // Target hit — bank at slider green (after open grace; no 30s wait once at target).
      const tpHoldOk = heldForBank || heldMs >= openGraceMs + againstBeDelay;
      if (bidOk && isDecentGreen && tpHoldOk) {
        await this._closePosition(trade, heldSideBidCents, 'take_profit', {
          liveSellPriceCents: heldSideBidCents,
        });
        return;
      }

      const stallBank = modelStallBankReady(trade, {
        greenCents,
        peakProgressCents: peakProgress,
        priceStalled,
        upwardMomentum,
        armed,
        window: picked && picked.window ? picked.window : null,
        side: trade.side,
        config: this.config,
      });
      const stallBankHoldOk =
        heldForBank ||
        (stallBank.ready &&
          stallBank.why === 'nearTarget' &&
          heldMs >= openGraceMs + againstBeDelay);

      // Trail armed (+3¢): bank at bid when stalled — especially near +TP target.
      if (bidOk && stallBank.ready && stallBankHoldOk && flatOrGreen && greenCents >= 1) {
        this.lastDecision =
          stallBank.why === 'nearTarget'
            ? `Stall at +${stallBank.nearTargetBank ?? nearTargetBank}¢ near-target (peak +${stallBank.peakProg}¢, TP +${stallBank.bankGreen}¢) on ${trade.symbol} — banking +${greenCents}¢ at bid.`
            : `Stall after momentum run on ${trade.symbol} — banking +${greenCents}¢ at bid.`;
        await this._closePosition(trade, heldSideBidCents, 'take_profit', {
          liveSellPriceCents: heldSideBidCents,
          stallBank: true,
        });
        return;
      }
      if (bidOk && stallBank.heldByLean) {
        const holdMsg =
          `Holding ${trade.symbol} +${greenCents}¢ — stall but lean still firm; riding to +${bankGreen}¢ TP.`;
        trade.holdReason = holdMsg;
        this.lastDecision = holdMsg;
        this._persist();
        return;
      }
      if (bidOk && armed && upwardMomentum && greenCents < nearTargetBank) {
        const holdMsg =
          `Holding ${trade.symbol} +${greenCents}¢ (peak ${Number.isFinite(peak) ? peak : heldSideBidCents}¢) — ` +
          `momentum up; riding toward +${bankGreen}¢ TP (stall bank at +${nearTargetBank}¢+).`;
        trade.holdReason = holdMsg;
        this.lastDecision = holdMsg;
        this._persist();
        return;
      }
      if (bidOk && armed && !priceStalled && greenCents >= armCents) {
        const stallSec = stallMs > 0 ? Math.round(stallMs / 1000) : 0;
        const holdMsg =
          `Holding ${trade.symbol} +${greenCents}¢ (peak ${Number.isFinite(peak) ? peak : heldSideBidCents}¢) — ` +
          `TP at +${bankGreen}¢; stall ${stallSec}s banks at bid (peak +${peakProgress}¢).`;
        trade.holdReason = holdMsg;
        this.lastDecision = holdMsg;
        return;
      }

      // Weak-conf lean-exit leftover: only real bankable green (never micro TP / soft BE).
      // Soft mush + flat → hold for stagnation, not instant breakeven.
      if (bidOk && leanExit && heldLongEnough && isBankableGreen && heldForBank) {
        await this._closePosition(trade, heldSideBidCents, 'take_profit', {
          liveSellPriceCents: heldSideBidCents,
        });
        return;
      }

      const up = picked && picked.window ? Number(picked.window.probabilityUp) : NaN;
      const down = picked && picked.window ? Number(picked.window.probabilityDown) : NaN;
      const leanTxt =
        Number.isFinite(up) && Number.isFinite(down)
          ? `${up.toFixed(0)}/${down.toFixed(0)} ${
              liveAgainst ? 'AGAINST' : liveFavors ? 'with us' : 'soft'
            }`
          : 'lean n/a';
      const pxTxt = bidOk
        ? underwater
          ? `${Math.round(entry)}→${Math.round(heldSideBidCents)} (−${adverseCents}¢)`
          : exactlyFlat
            ? `flat ${Math.round(entry)}¢`
            : `+${greenCents}¢ (peak ${Number.isFinite(peak) ? peak : Math.round(heldSideBidCents)}¢)`
        : 'no bid';
      let why;
      if (!bidOk) why = 'no usable bid yet';
      else if (faded) why = 'fade hold — engine-against does not stop this ticket';
      else if (picked && picked.window) {
        const decayHint = modelLeanDecayCutState(
          trade,
          picked.window,
          trade.side,
          now,
          this.config
        );
        if (decayHint.inDecayZone && decayHint.cutReady)
          why = `lean decay ${Math.round(decayHint.peakLean)}→${Math.round(decayHint.heldProb)} (${leanTxt}) — cut armed`;
        else if (decayHint.inDecayZone)
          why = `lean decay ${Math.round(decayHint.peakLean)}→${Math.round(decayHint.heldProb)} (${leanTxt}) — cut if no recovery`;
      }
      if (!why && engineTurning && underwater)
        why = `hard lean against (${leanTxt}) — BE/cut on red`;
      else if (!why && engineTurning && flatOrGreen)
        why = `hard lean against (${leanTxt}) — banking before dump`;
      else if (!why && modelHardAgainst && !againstBeReady)
        why = `hard lean against (${leanTxt}) — BE/cut after open grace + ${Math.round(againstBeDelay / 1000)}s`;
      else if (!why && underwater && modelFirm)
        why = `model still firm (${leanTxt}) — holding (no price stop)`;
      else if (!why && underwater && leanStaleScratch)
        why = `soft/50-50 lean (${leanTxt}) + red — hold for stagnation / hard flip (no soft cut)`;
      else if (!why && leanStaleScratch && scratchFlat)
        why = `50/50/soft lean (${leanTxt}) — hold for stagnation (soft BE off)`;
      else if (!why && (inSettleClose || inLateBarrier))
        why = `nearing settle (${minutesRemaining.toFixed(1)}m left) — cash-out armed`;
      else if (!why && !armed && flatOrGreen && !liveFavors)
        why = `lean soft — waiting stagnation (${leanTxt})`;
      else if (!why && !armed && flatOrGreen) why = `green but under trail arm (need +${armCents}¢)`;
      else if (!why) why = `holding — model firm (${leanTxt})`;
      const holdMsg = `Holding ${trade.symbol} ${String(trade.side || '').toUpperCase()} ${pxTxt} — ${why}.`;
      trade.holdReason = holdMsg;
      this.lastDecision = holdMsg;
      return;
    }

    if (heldSideBidCents != null && stopLevel != null && heldSideBidCents <= stopLevel) {
      // Trigger on the live bid. Paper books the stop level (entry − drop).
      // Live sells at the real bid — markets don't owe you the stop price.
      // Edge hold-timer BE stop: treat as breakeven when stop has risen to entry.
      const entry = Number(trade.entryPriceCents);
      const beStop =
        !isSettleTrade(trade) &&
        Number.isFinite(entry) &&
        stopLevel >= entry;
      const stopFill = this.config.mode === 'paper' ? stopLevel : heldSideBidCents;
      await this._closePosition(trade, stopFill, beStop ? 'breakeven' : 'stop_loss', {
        liveSellPriceCents: heldSideBidCents,
      });
      return;
    }

    // Settle strategy: stop (above); weak-ticket lean-switch; optional entry-tiered
    // TP/stale/stuck; else hold for official settlement — no edge signal-flip exits
    // once the ticket has confirmed (≥80¢ peak).
    if (isSettleTrade(trade)) {
      const peakRaw = Number(trade.peakHeldBidCents);
      const entryRaw = Number(trade.entryPriceCents);
      const peak =
        Number.isFinite(peakRaw) && peakRaw > 0
          ? peakRaw
          : Number.isFinite(entryRaw)
            ? entryRaw
            : null;
      const weakTicket = peak == null || peak < SETTLE_WEAK_CONFIRM_CENTS;
      if (
        weakTicket &&
        heldSideBidCents != null &&
        Number.isFinite(heldSideBidCents) &&
        (strongReversalSignal || signalFlipped)
      ) {
        await this._closePosition(trade, heldSideBidCents, 'settle_weak_switch', {
          liveSellPriceCents: heldSideBidCents,
        });
        return;
      }

      if (!isSettleTieredExitsEnabled(this.config)) return;
      const plan = settleExitPlan(trade.entryPriceCents);
      const entry = Number(trade.entryPriceCents);
      const bidOk =
        heldSideBidCents != null &&
        Number.isFinite(heldSideBidCents) &&
        heldSideBidCents >= 1 &&
        heldSideBidCents <= 99;

      // Once bid tags 90¢ and ≤3:30 left → hold to settle (ignore TP/stuck/stale).
      // Stop-loss above still applies. With >3:30 left after tagging 90, tier exits may bank.
      if (bidOk && heldSideBidCents >= 90) {
        trade.settleTouched90 = true;
      }
      const holdToSettleAfter90 =
        trade.settleTouched90 === true &&
        Number.isFinite(minutesRemaining) &&
        minutesRemaining <= SETTLE_TOUCHED90_HOLD_MINUTES;
      const skipEarlyExits = plan.tier === 'hold' || holdToSettleAfter90;

      // Tier TP when not in the post-90 hold window (and not a ≥90 hold-tier entry).
      if (
        !skipEarlyExits &&
        bidOk &&
        plan.targetCents != null &&
        heldSideBidCents >= plan.targetCents &&
        heldSideBidCents > entry
      ) {
        const fill =
          this.config.mode === 'paper'
            ? Math.min(99, Math.max(plan.targetCents, heldSideBidCents))
            : heldSideBidCents;
        await this._closePosition(trade, fill, 'take_profit', {
          liveSellPriceCents: heldSideBidCents,
        });
        return;
      }

      // ≥90 hold tier, or tagged 90 with ≤3:30 left: no stuck/stale — ride settlement.
      if (skipEarlyExits) return;

      // Track "parked at/under entry" for stuck exits (hold tier skips these).
      // NOTE: Number(null)===0 is finite — never treat null/0 as a valid "since" stamp
      // or nearMs becomes ~epoch and breakeven fires on the next tick (BNB 30s BE).
      const stuckMs = settleStuckHoldMs(this.config);
      if (bidOk && stuckMs > 0 && Number.isFinite(entry)) {
        const nearSinceRaw = Number(trade._settleNearEntrySince);
        const nearSinceOk = Number.isFinite(nearSinceRaw) && nearSinceRaw > 1e12;
        // Flat = at entry or 1¢ under — not green (+1 was falsely "flat" before).
        const nearFlat = heldSideBidCents >= entry - 1 && heldSideBidCents <= entry;
        if (nearFlat) {
          if (!nearSinceOk) trade._settleNearEntrySince = now;
        } else {
          trade._settleNearEntrySince = undefined;
        }
        const openedAt = Number(trade.openedAt);
        const heldMs = Number.isFinite(openedAt) ? now - openedAt : 0;
        const nearSince = Number(trade._settleNearEntrySince);
        const nearMs =
          nearFlat && Number.isFinite(nearSince) && nearSince > 1e12 ? now - nearSince : 0;

        // Small green (+1..+5¢) parked under target for stuckMs → bank it.
        const underTarget =
          plan.targetCents == null || heldSideBidCents < plan.targetCents;
        const smallGreen =
          heldSideBidCents >= entry + 1 && heldSideBidCents <= entry + 5;
        if (heldMs >= stuckMs && underTarget && smallGreen) {
          await this._closePosition(trade, heldSideBidCents, 'settle_stuck', {
            liveSellPriceCents: heldSideBidCents,
          });
          return;
        }
        // Truly flat (≤ entry) for stuckMs continuous + held long enough → scratch.
        if (heldMs >= stuckMs && nearMs >= stuckMs && heldSideBidCents <= entry) {
          await this._closePosition(trade, heldSideBidCents, 'breakeven', {
            liveSellPriceCents: heldSideBidCents,
          });
          return;
        }
      }

      const openedAt = Number(trade.openedAt);
      const heldLongEnough =
        !Number.isFinite(openedAt) || now - openedAt >= SETTLE_STALE_MIN_HOLD_MS;
      if (
        bidOk &&
        heldLongEnough &&
        plan.staleMinutesLeft != null &&
        minutesRemaining <= plan.staleMinutesLeft &&
        heldSideBidCents >= entry &&
        (plan.targetCents == null || heldSideBidCents < plan.targetCents)
      ) {
        // Target not reached in time — bank green rather than wait on settle lag.
        // Min hold blocks open→stale→reopen churn in the final minutes.
        await this._closePosition(trade, heldSideBidCents, 'settle_stale', {
          liveSellPriceCents: heldSideBidCents,
        });
        return;
      }
      return;
    }

    if (nearCertainHit) {
      const fill =
        this.config.mode === 'paper'
          ? Math.min(99, Math.max(nearCertainExitCents, heldSideBidCents))
          : heldSideBidCents;
      await this._closePosition(trade, fill, 'near_certain', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (strongReversalSignal && heldSideBidCents != null) {
      await this._closePosition(trade, heldSideBidCents, 'reversal_signal', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (signalFlipped && heldSideBidCents != null) {
      await this._closePosition(trade, heldSideBidCents, 'signal_flip', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (takeProfitHit && !holdThroughForConfidence) {
      const tpFill = this.config.mode === 'paper' ? takeProfitLevel : heldSideBidCents;
      await this._closePosition(trade, tpFill, 'take_profit', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (
      inPreCloseTakeProfitWindow &&
      heldSideBidCents != null &&
      Number.isFinite(trade.entryPriceCents) &&
      heldSideBidCents > trade.entryPriceCents
    ) {
      // ~30s–60s left and already green: bank it rather than await settle.
      await this._closePosition(trade, heldSideBidCents, 'pre_close_bank', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (
      (() => {
        const preMins = Number(this.config.edgePreCloseMinutes);
        const maxLoss = Number(this.config.edgePreCloseSmallLossCents);
        const minsOk = Number.isFinite(preMins) && preMins > 0 && minutesRemaining <= preMins;
        const lossCap = Number.isFinite(maxLoss) && maxLoss > 0 ? maxLoss : 0;
        if (!minsOk || lossCap <= 0) return false;
        if (
          heldSideBidCents == null ||
          !Number.isFinite(heldSideBidCents) ||
          !Number.isFinite(trade.entryPriceCents)
        ) {
          return false;
        }
        const contracts = Math.max(0, Math.floor(Number(trade.contracts) || 0));
        if (contracts < 1) return false;
        const estPnl = (heldSideBidCents - trade.entryPriceCents) * contracts;
        return estPnl >= -lossCap;
      })()
    ) {
      // Final minutes: cash out flat/green/tiny-red up to $0.75 position loss.
      await this._closePosition(trade, heldSideBidCents, 'pre_close_small_loss', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (canExitEven) {
      await this._closePosition(trade, heldSideBidCents, 'breakeven', {
        liveSellPriceCents: heldSideBidCents,
      });
    }
  }

  /**
   * Manage open trades only (no new entries). Safe to call when prediction
   * compute failed — settlement must not depend on a healthy Coinbase cycle.
   */
  async manageOpenPositions(predictions) {
    return this._withTradeLock(() => this._manageOpenPositionsUnlocked(predictions));
  }

  async _manageOpenPositionsUnlocked(predictions) {
    this._maybeRotateLedger(Date.now());
    for (const trade of [...this.openTrades]) {
      try {
        await this._manageOpenTrade(trade, predictions);
      } catch (err) {
        console.error(`[bot] manage open ${trade.symbol} ${trade.ticker} failed:`, err.message);
        const now = Date.now();
        if (this._isTradePastDeadline(trade, null, now) && trade.status === 'open') {
          try {
            // Paper can scratch; live inventory must not be ledger-closed without a fill/result.
            if (this._isLiveTrade(trade)) {
              console.warn(`[bot] live ${trade.ticker} past deadline but manage failed — leaving open`);
            } else {
              await this._closePosition(
                trade,
                Number.isFinite(trade.entryPriceCents) ? trade.entryPriceCents : 50,
                'settled_timeout',
                { skipLiveSell: true }
              );
            }
          } catch (closeErr) {
            console.error(`[bot] emergency close failed for ${trade.ticker}:`, closeErr.message);
          }
        }
      }
    }
    // Shadows settle on the prediction cycle. The 4s watchdog is live-only so
    // six shadow books cannot queue getMarket behind a 429 cooldown.
  }

  /**
   * Stop / take-profit are relative to this trade's entry:
   *   stop level = max(1, entry − stopLossCents)
   *   TP level   = min(99, entry + takeProfitCents)
   * Edge: after edgeBreakevenAfterMinutes held, stop rises to entry (breakeven).
   */
  _stopLevelCents(trade, now = Date.now()) {
    const entry = Number(trade.entryPriceCents);
    if (!Number.isFinite(entry) || entry < 1) return null;

    // Model holds to settle / lean-flip only — no hard stop.
    if (isModelTrade(trade)) return null;

    if (!isSettleTrade(trade)) {
      const beAfter = Number(this.config.edgeBreakevenAfterMinutes);
      const openedAt = Number(trade.openedAt);
      if (
        Number.isFinite(beAfter) &&
        beAfter > 0 &&
        Number.isFinite(openedAt) &&
        now - openedAt >= beAfter * 60 * 1000
      ) {
        return Math.round(entry);
      }
    }

    const drop = isSettleTrade(trade)
      ? Number(this.config.settleStopLossCents)
      : Number(this.config.stopLossCents);
    if (!Number.isFinite(drop) || drop <= 0) return null;
    return Math.max(1, Math.round(entry - drop));
  }

  _takeProfitLevelCents(trade) {
    // Model does not take profit early — ride lean / settlement.
    if (isModelTrade(trade)) return null;
    const entry = Number(trade.entryPriceCents);
    const rise = Number(this.config.takeProfitCents);
    if (!Number.isFinite(entry) || entry < 1 || !Number.isFinite(rise) || rise <= 0) return null;
    return Math.min(99, Math.round(entry + rise));
  }

  _hasOpenOnSymbol(symbol) {
    return this.openTrades.some((t) => t.symbol === symbol);
  }

  _hasOpenOnTicker(ticker) {
    return Boolean(ticker) && this.openTrades.some((t) => t.ticker === ticker);
  }

  /**
   * Backup bot only: if primary is stuck on a force-retry exit (e.g. TP miss),
   * place the sell on Kalshi. Primary ledger stays authoritative — primary
   * should detect flat inventory on the next cycle and book the close.
   */
  async _runBackupRescue() {
    if (!isBackupBotRole()) return;
    if (this.config.mode !== 'live' || !this.client.hasCredentials) return;
    const coord = loadCoordination();
    const candidates = backupRescueCandidates(coord, { config: this.config });
    if (!candidates.length) return;

    for (const row of candidates) {
      const stub = coordinationTradeStub(row);
      if (!stub || !Number.isFinite(stub.contracts) || stub.contracts <= 0) continue;
      let market = null;
      try {
        market = await this._getMarketBounded(stub.ticker, 2500);
      } catch (err) {
        noteBackupRescueAttempt({
          tradeId: row.id,
          ticker: row.ticker,
          reason: row.pendingForceExit,
          ok: false,
          detail: err.message,
        });
        continue;
      }
      const bid = market ? this._heldSideBidCents(stub, market) : null;
      if (!Number.isFinite(bid) || bid < 1 || bid > 99) {
        noteBackupRescueAttempt({
          tradeId: row.id,
          ticker: row.ticker,
          reason: row.pendingForceExit,
          ok: false,
          detail: 'no tradable bid',
        });
        continue;
      }
      const reason = String(row.pendingForceExit || 'take_profit');
      let soldOk = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const sellPrice = Math.max(1, Math.min(99, Math.round(bid) - attempt));
        try {
          const order = await this.client.createOrder({
            ticker: stub.ticker,
            side: stub.side,
            action: 'sell',
            count: stub.contracts,
            priceCents: sellPrice,
            timeInForce: 'immediate_or_cancel',
          });
          const orderId = this._extractOrderId(order);
          if (!orderId) throw new Error('sell response missing order_id');
          const fill = await this._awaitOrderFill(orderId, {
            minFill: stub.contracts,
            attempts: 3,
            delayMs: 120,
            seedOrder: order,
            heldSide: stub.side,
            action: 'sell',
          });
          const filled = Math.max(0, Number(fill.filled) || 0);
          if (filled > 0) {
            soldOk = true;
            this.lastDecision =
              `Backup rescue: sold ${stub.symbol} ${String(stub.side).toUpperCase()} ` +
              `${filled}@${sellPrice}¢ (${reason}) for stuck primary exit.`;
            this._logActivity(this.lastDecision, {
              kind: 'close',
              symbol: stub.symbol,
              side: stub.side,
              tradeId: row.id,
            });
            break;
          }
        } catch (err) {
          lastErr = err;
        }
      }
      noteBackupRescueAttempt({
        tradeId: row.id,
        ticker: row.ticker,
        reason,
        ok: soldOk,
        detail: soldOk ? 'filled' : (lastErr && lastErr.message) || 'sell missed',
      });
    }
  }

  async _openPosition({
    symbol,
    ticker,
    side,
    priceCents,
    floorStrike,
    closeTime,
    engineProbability,
    engineConfidence,
    strategy = 'edge',
    entryAttempts = null,
    modelWindowKey = null,
    modelDirection = null,
    uncertain = false,
    modelInverted = false,
    modelSignalSide = null,
    modelSignalEntryCents = null,
    modelEntryHeldProb = null,
    modelEntryNetDominance = null,
    modelEntryBidCents = null,
    modelEntrySpreadCents = null,
  }) {
    // A paper trade must obey the same price rules as a live order. Without
    // this guard an empty Kalshi quote could be stored as `null` and then
    // appear in the dashboard as e.g. "BTC @ NO null".
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) {
      this.lastError = `Skipped ${symbol} ${side || 'unknown'} entry: no valid Kalshi quote is available.`;
      return false;
    }
    if (isBackupBotRole()) {
      this.lastDecision = 'Backup bot: entries disabled — rescue-only mode.';
      return false;
    }
    const coord = loadCoordination();
    const backupGate = checkBackupEntryAllowed({
      coord,
      ticker,
      symbol,
      windowCloseTime: closeTime,
    });
    if (!backupGate.ok) {
      this.lastDecision = backupGate.reason;
      return false;
    }
    const isModel = strategy === 'model';
    // Model reduced stake: hard cutoff — ask under 70¢ uses half stake.
    let modelQuarter = isModel && modelIsHalfStakeAsk(priceCents);
    const symKey = String(symbol || '').toUpperCase();
    // Never reopen a coin that exited earlier in this same cycle (same-second knife-catch).
    if (this._stoppedSymbolsThisCycle && this._stoppedSymbolsThisCycle.has(symKey)) {
      this.lastDecision =
        `Skipped ${symbol}: exited earlier this cycle — no same-turn reopen.`;
      return false;
    }
    // Hard same-side sit-out after stop (belt-and-suspenders vs evaluate-time gate).
    // Model skips Edge/Settle sit-outs; same-cycle block above covers knife-catch.
    if (!isModel) {
      const lastStop = this._lastStopLossTrade();
      if (lastStop) {
        const sitOut = checkPostStopSameSideCooldown({
          lastStopTrade: lastStop,
          forCandidateSymbol: symbol,
          forCandidateSide: side,
          cooldownMs: postStopSameSideCooldownMs(this.config),
          now: Date.now(),
        });
        if (!sitOut.ok) {
          this.lastDecision = sitOut.reason;
          this._noteProtectionGate(sitOut.reason, { fromSymbol: symbol });
          return false;
        }
      }
      // Same sit-out after settle_weak_switch (BNB 10:11 reopen loop).
      const lastClosedAny = this._mostRecentClosedTrade();
      if (lastClosedAny && lastClosedAny.exitReason === 'settle_weak_switch') {
        const weakSit = checkSameSideExitCooldown({
          lastTrade: lastClosedAny,
          exitReasons: ['settle_weak_switch'],
          forCandidateSymbol: symbol,
          forCandidateSide: side,
          cooldownMs: postStopSameSideCooldownMs(this.config),
          now: Date.now(),
          reasonVerb: 'weak-switched',
        });
        if (!weakSit.ok) {
          this.lastDecision = weakSit.reason;
          this._noteProtectionGate(weakSit.reason, { fromSymbol: symbol });
          return false;
        }
      }
    }
    const closeAt = Number(closeTime);
    if (!Number.isFinite(closeAt) || closeAt <= Date.now() + 5000) {
      this.lastError = `Skipped ${symbol} ${side || 'unknown'} entry: market close time is missing or already ending.`;
      return false;
    }
    const isSettle = strategy === 'settle';
    // Bonus 3rd while a hold has tagged 90¢ — half stake (not stacked with NEAR ½).
    const thirdSlot = isSettle && this.openTrades.length >= 2 && this._hasTouched90Open();
    const minutesLeft = (closeAt - Date.now()) / 60000;
    if (isModel) {
      const minMinutesToOpen = modelEntryCutoffMinutes(this.config);
      if (minMinutesToOpen > 0 && minutesLeft < minMinutesToOpen) {
        this.lastDecision =
          `Skipped ${symbol}: only ${minutesLeft.toFixed(1)} min left (model: no new entries in last ${minMinutesToOpen}m).`;
        return false;
      }
    } else {
      const minMinutesToOpen = isSettle
        ? Number.isFinite(Number(this.config.settleMinMinutesToOpen))
          ? Number(this.config.settleMinMinutesToOpen)
          : 0.5
        : Number.isFinite(Number(this.config.minMinutesToOpen))
          ? Number(this.config.minMinutesToOpen)
          : 3;
      if (minMinutesToOpen > 0 && minutesLeft < minMinutesToOpen) {
        this.lastDecision =
          `Skipped ${symbol}: only ${minutesLeft.toFixed(1)} min left (min ${minMinutesToOpen} to open).`;
        return false;
      }
    }
    if (isSettle) {
      const maxMinutes = Number(this.config.settleMaxMinutesToOpen);
      if (Number.isFinite(maxMinutes) && maxMinutes > 0 && minutesLeft > maxMinutes) {
        this.lastDecision =
          `Skipped ${symbol}: ${minutesLeft.toFixed(1)} min left (settle mode only opens with ≤ ${maxMinutes} min left).`;
        return false;
      }
      if (!isSettleEntryPriceCents(priceCents, this.config, minutesLeft, side)) {
        const band = settleSideEntryBand(this.config, side, minutesLeft);
        this.lastDecision =
          `Skipped ${symbol} ${String(side || '').toUpperCase()} @ ${priceCents}¢: outside settle band ${band.min}–${band.max}¢` +
          (band.late ? ' (late fallback)' : '') +
          '.';
        return false;
      }
      const richFloor = settleRichAskFloorCents(this.config);
      const minUpside = settleMinUpsideCents(this.config);
      const upside = 100 - priceCents;
      if (priceCents >= richFloor || (minUpside > 0 && upside < minUpside)) {
        this.lastDecision =
          `Skipped ${symbol} settle @ ${priceCents}¢: not enough upside` +
          ` (need <${richFloor}¢ and ≥${minUpside}¢ to 100) — trying other cryptos.`;
        return false;
      }
    } else if (isModel) {
      const perfectFloor = Number.isFinite(Number(this.config.modelPerfectMinEntryCents))
        ? Number(this.config.modelPerfectMinEntryCents)
        : MODEL_PERFECT_MIN_ENTRY_DEFAULT_CENTS;
      const maxEntry = Number.isFinite(Number(this.config.modelMaxEntryCents))
        ? Number(this.config.modelMaxEntryCents)
        : MODEL_MAX_ENTRY_DEFAULT_CENTS;
      if (maxEntry > 0 && priceCents > maxEntry) {
        this.lastDecision =
          `Skipped ${symbol} ${String(side || '').toUpperCase()} @ ${priceCents}¢: above model max entry ${maxEntry}¢.`;
        return false;
      }
      // Absolute floor; 25–44¢ only reaches here via evaluate's perfect-call exception.
      if (perfectFloor > 0 && priceCents < perfectFloor) {
        this.lastDecision =
          `Skipped ${symbol} ${String(side || '').toUpperCase()} @ ${priceCents}¢: below model perfect floor ${perfectFloor}¢.`;
        return false;
      }
    } else {
      const minEntry = Number(this.config.minEntryCents);
      if (Number.isFinite(minEntry) && minEntry > 0 && priceCents < minEntry) {
        this.lastDecision =
          `Skipped ${symbol} ${String(side || '').toUpperCase()} @ ${priceCents}¢: below min entry ${minEntry}¢ (longshot ban).`;
        return false;
      }
    }
    // Max positions is a concurrency cap across coins — stacking two opens
    // on the same symbol (or ticker) just doubles correlated exposure.
    if (this._hasOpenOnSymbol(symbol) || this._hasOpenOnTicker(ticker)) {
      this.lastDecision = `Skipped ${symbol}: already have an open position on this coin/market.`;
      return false;
    }
    // Each Kalshi contract costs `priceCents` cents and pays out $1 if it
    // wins, so buying (stakeDollars * 100 / priceCents) contracts risks
    // approximately stakeDollars. Always at least 1 contract.
    let stakeDollars = this._stakeDollarsForEntry(priceCents, {
      settle: isSettle,
      symbol,
      thirdSlot,
      model: isModel,
      modelUncertain: modelQuarter,
    });
    const contracts = Math.max(1, Math.floor((stakeDollars * 100) / priceCents));
    const entryCostCents = contracts * priceCents;
    if (
      !this._assertEntryFundedFromAvailable(
        entryCostCents,
        `${symbol} ${String(side || '').toUpperCase()} @ ${priceCents}¢`
      )
    ) {
      return false;
    }
    const trade = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      mode: this._inShadow ? 'paper' : this.config.mode,
      strategy: isSettle ? 'settle' : isModel ? 'model' : 'edge',
      symbol,
      ticker,
      side, // 'yes' | 'no'
      contracts,
      stakeDollars: +(entryCostCents / 100).toFixed(2), // actual dollars risked, given rounding to whole contracts
      entryPriceCents: priceCents,
      floorStrike,
      openedAt: Date.now(),
      windowCloseTime: closeAt,
      engineProbability,
      engineConfidence,
      status: 'open',
      ...(isSettle || isModel
        ? {
            peakHeldBidCents: Math.round(
              isModel && Number.isFinite(Number(modelEntryBidCents))
                ? Number(modelEntryBidCents)
                : priceCents
            ),
            peakHeldBidAt: Date.now(),
          }
        : {}),
      ...(isModel
        ? {
            modelWindowKey: modelWindowKey || null,
            modelDirection: modelDirection || null,
            ...(modelInverted || isModelInvertSide(this.config) ? { modelInverted: true } : {}),
            ...(modelSignalSide ? { modelSignalSide } : {}),
            ...(Number.isFinite(Number(modelSignalEntryCents))
              ? { modelSignalEntryCents: Math.round(Number(modelSignalEntryCents)) }
              : {}),
            ...(Number.isFinite(Number(modelEntryHeldProb))
              ? { modelEntryHeldProb: +Number(modelEntryHeldProb).toFixed(1) }
              : {}),
            ...(Number.isFinite(Number(modelEntryNetDominance))
              ? { modelEntryNetDominance: +Number(modelEntryNetDominance).toFixed(2) }
              : {}),
            ...(Number.isFinite(Number(modelEntryBidCents))
              ? { modelEntryBidCents: Math.round(Number(modelEntryBidCents)) }
              : {}),
            ...(Number.isFinite(Number(modelEntrySpreadCents))
              ? { modelEntrySpreadCents: Math.round(Number(modelEntrySpreadCents)) }
              : {}),
            ...(modelQuarter ? { modelUncertain: true } : {}),
          }
        : {}),
    };
    if (this._inShadow) {
      trade.mode = 'paper';
      trade.shadow = true;
      trade.shadowSetupId = String(this.config.activeSetupId || '') || null;
    }

    if (this.config.mode === 'live' && !this._inShadow) {
      // MODEL default 4 IOC tries; settle/edge default 2. Re-quote + chase ask.
      // Pass entryAttempts to override (cap 5).
      let filled = 0;
      let fill = null;
      let orderId = null;
      let workingPrice = priceCents;
      let lastErr = null;
      let freshAsk = null;
      const rawAttempts = Number(entryAttempts);
      const maxEntryAttempts =
        Number.isFinite(rawAttempts) && rawAttempts > 0
          ? Math.min(5, Math.floor(rawAttempts))
          : isModel
            ? 4
            : 2;

      for (let attempt = 0; attempt < maxEntryAttempts; attempt++) {
        if (attempt > 0) await this._sleep(50);

        let liveMarket = null;
        try {
          liveMarket = await this._getMarketBounded(ticker, 2000);
        } catch {
          liveMarket = null;
        }
        freshAsk = await this._refreshLiveEntryAskCents(ticker, side);
        const band = isSettle ? settleSideEntryBand(this.config, side, minutesLeft) : null;
        const richFloor = isSettle ? settleRichAskFloorCents(this.config) : 100;
        const ceiling = isSettle
          ? Math.min(99, richFloor - 1, Math.max(band?.max ?? priceCents, priceCents) + 2)
          : isModel
            ? Math.min(99, priceCents + 6)
            : Math.min(99, priceCents + 2);
        if (Number.isFinite(freshAsk)) {
          // MODEL: cross at ask+1 on first try (then +2…) — IOC at exact ask often misses.
          const chaseBump = isModel ? attempt + 1 : attempt;
          const chase = Math.min(99, Math.round(freshAsk) + chaseBump);
          workingPrice = Math.min(ceiling, Math.max(priceCents, freshAsk, chase));
        } else {
          workingPrice = Math.min(
            ceiling,
            Math.max(1, Math.round(priceCents) + attempt + (isModel ? 1 : 0))
          );
        }
        workingPrice = Math.max(1, Math.min(99, Math.round(workingPrice)));

        if (isSettle) {
          const upside = 100 - workingPrice;
          const minUpside = settleMinUpsideCents(this.config);
          if (
            workingPrice >= richFloor ||
            (minUpside > 0 && upside < minUpside) ||
            !isSettleEntryPriceCents(workingPrice, this.config, minutesLeft, side)
          ) {
            if (attempt === maxEntryAttempts - 1) {
              this._noteEntryMiss(symbol, null, closeAt, side);
              this.lastError =
                `Skipped ${symbol} ${String(side).toUpperCase()} live entry: live ask ${freshAsk != null ? freshAsk + '¢' : 'n/a'} can't cross inside settle band ` +
                `(would need ${workingPrice}¢). Focusing on other cryptos.`;
              this.lastDecision = this.lastError;
              this._logActivity(this.lastDecision, {
                kind: 'open',
                symbol,
                side,
                strategy: trade.strategy,
              });
              return false;
            }
            continue;
          }
        }

        // Re-check the hard 70¢ half-stake cutoff on the live working ask.
        const liveQuarter = isModel && modelIsHalfStakeAsk(workingPrice);
        let attemptContracts = Math.max(
          1,
          Math.floor(
            (this._stakeDollarsForEntry(workingPrice, {
              settle: isSettle,
              symbol,
              thirdSlot,
              model: isModel,
              modelUncertain: liveQuarter,
            }) *
              100) /
              workingPrice
          )
        );
        const bookAskSize =
          liveMarket &&
          (side === 'yes'
            ? Number(liveMarket.yes_ask_size)
            : Number(liveMarket.no_ask_size) ||
              (Number.isFinite(Number(liveMarket.yes_bid_size))
                ? Number(liveMarket.yes_bid_size)
                : NaN));
        if (Number.isFinite(bookAskSize) && bookAskSize >= 1 && bookAskSize < attemptContracts) {
          console.warn(
            `[bot] sizing ${symbol} entry down ${attemptContracts}→${bookAskSize} to visible ask size`
          );
          attemptContracts = Math.max(1, Math.floor(bookAskSize));
        }
        const attemptCost = attemptContracts * workingPrice;
        if (!this._assertEntryFundedFromAvailable(attemptCost, `${symbol} live entry @ ${workingPrice}¢`)) {
          return false;
        }
        trade.contracts = attemptContracts;
        trade.entryPriceCents = workingPrice;
        trade.stakeDollars = +(attemptCost / 100).toFixed(2);

      try {
        const order = await this.client.createOrder({
          ticker,
          side,
          action: 'buy',
          count: trade.contracts,
            priceCents: workingPrice,
            timeInForce: 'immediate_or_cancel',
          });
          orderId = this._extractOrderId(order);
          if (!orderId) {
            lastErr = new Error('createOrder returned no order_id');
            console.error(`[bot] Live entry on ${symbol} returned no order_id`);
            continue;
          }
          fill = await this._awaitOrderFill(orderId, {
            minFill: 1,
            attempts: 3,
            delayMs: 100,
            seedOrder: order,
            heldSide: side,
            action: 'buy',
          });
          filled = Math.max(0, Number(fill.filled) || 0);
          if (filled < 1) {
            const lastChance = await this._recoverOrderFillsAfterCancel(orderId, {
              priorOrder: fill.order,
              attempts: 2,
              delayMs: 120,
            });
            if (lastChance.filled > 0) {
              filled = lastChance.filled;
              fill.order = lastChance.order || fill.order;
              fill.recovered = true;
              console.warn(
                `[bot] fill recovery: live entry ${symbol} order ${orderId} had ${filled} fills on final getOrder — recording trade`
              );
            }
          }
          if (filled >= 1) break;
          lastErr = new Error(`no fill (0/${trade.contracts})`);
          console.warn(
            `[bot] Live entry try ${attempt + 1}/${maxEntryAttempts} on ${symbol} did not fill @ ${workingPrice}¢ (IOC; ask ${freshAsk}¢)`
          );
      } catch (err) {
          lastErr = err;
          console.error(`[bot] Live entry try ${attempt + 1}/${maxEntryAttempts} failed:`, err.message);
        }
      }

      if (filled < 1) {
        const miss = this._noteEntryMiss(symbol, null, closeAt, side);
        const coolMs = Number(miss.cooldownMs) || ENTRY_MISS_COOLDOWN_MS;
        const coolLabel =
          coolMs < 60_000
            ? `~${Math.max(1, Math.round(coolMs / 1000))}s`
            : `~${Math.max(1, Math.round(coolMs / 60000))}m`;
        this.lastError =
          `Live entry on ${symbol} ${String(side).toUpperCase()} did not fill` +
          (lastErr ? ` (${lastErr.message})` : '') +
          ` — skipping this ${String(side).toUpperCase()} ${coolLabel} (miss #${miss.streak}); other cryptos/sides still open.`;
        this.lastDecision = this.lastError;
        this._logActivity(this.lastDecision, {
          kind: 'open',
          symbol,
          side,
          strategy: trade.strategy,
        });
        console.error('[bot]', this.lastError);
        return false;
      }
      this._clearEntryMiss(symbol, side);
      if (fill && fill.recovered) {
        console.warn(
          `[bot] entry fill recovery on ${symbol}: order ${orderId} filled ${filled}/${trade.contracts} after timeout/cancel — ledgered`
        );
      }
      if (filled < trade.contracts) {
        trade.contracts = filled;
        trade.stakeDollars = +((trade.contracts * workingPrice) / 100).toFixed(2);
      }
      let avg = this._orderAvgFillPriceCents(fill && fill.order, side, 'buy', workingPrice);
      if (Number.isFinite(avg)) {
        avg = this._sanityCheckEntryFillCents(avg, workingPrice);
        trade.entryPriceCents = avg;
        trade.stakeDollars = +((trade.contracts * avg) / 100).toFixed(2);
      }
      // Settle: never book an entry far outside the band from a bad fill parse.
      if (isSettle && Number.isFinite(trade.entryPriceCents)) {
        const minsLeftNow = (closeAt - Date.now()) / 60000;
        const band = settleEffectiveEntryBand(this.config, minsLeftNow);
        const chaseCeiling = Math.min(97, band.max + 2);
        if (trade.entryPriceCents < band.min || trade.entryPriceCents > chaseCeiling) {
          console.warn(
            `[bot] settle entry fill ${trade.entryPriceCents}¢ outside band — booking limit ${workingPrice}¢`
          );
          trade.entryPriceCents = workingPrice;
          trade.stakeDollars = +((trade.contracts * workingPrice) / 100).toFixed(2);
        }
      }
      trade.entryFeesCents = this._resolveOrderFeesCents(
        fill && fill.order,
        trade.entryPriceCents,
        trade.contracts
      );
      if (isModel && modelIsHalfStakeAsk(trade.entryPriceCents)) {
        modelQuarter = true;
        trade.modelUncertain = true;
      }
      trade.liveOrderId = orderId;
      this._clearEntryMiss(symbol, side);
    }

    if (isModel) {
      const postDir = this._modelRecheckEntryDirection({
        symbol,
        side,
        direction: modelDirection,
        windowKey: modelWindowKey,
        entryHeldProb:
          Number.isFinite(Number(modelEntryHeldProb))
            ? Number(modelEntryHeldProb)
            : Number(engineProbability),
        windowCloseTime: closeAt,
      });
      trade.modelEntryFirmAtOpen = postDir.firm === true;
      if (!postDir.ok) trade.modelFillAgainst = true;
    }

    // Serialize ledger commit so parallel settle dual-entry can't clobber
    // persist or overshoot maxOpen / paper capital.
    return this._withTradeLock(() => {
      if (this._hasOpenOnSymbol(symbol) || this._hasOpenOnTicker(ticker)) {
        this.lastDecision = `Skipped ${symbol}: already have an open position on this coin/market.`;
        return false;
      }
      if (this.openTrades.length >= this._effectiveMaxOpenPositions()) {
        this.lastDecision =
          `Skipped ${symbol}: max open positions reached during dual-entry commit.`;
        if (trade.liveOrderId) {
          console.warn(
            `[bot] live fill on ${symbol} after max-open — ledgering anyway to avoid orphan`
          );
        } else {
          return false;
        }
      }
      if (this.config.mode === 'paper' || this.config.mode === 'live') {
        const cost = Math.round(Number(trade.stakeDollars) * 100);
        if (
          !this._assertEntryFundedFromAvailable(
            cost,
            `${symbol} commit`
          )
        ) {
          if (trade.liveOrderId) {
            console.warn(
              `[bot] live fill on ${symbol} but Available cannot fund — ledgering anyway to avoid orphan`
            );
          } else {
            return false;
          }
        }
      }

    this.ledger.trades.unshift(trade);
    if (this.ledger.trades.length > 200) this.ledger.trades.length = 200;
      this._noteProtectionGate(false); // open implies gate no longer blocking
      if (isSettle) {
        const minsLeftNow = (closeAt - Date.now()) / 60000;
        const eff = settleEffectiveEntryBand(this.config, minsLeftNow);
        const primary = settleEntryBand(this.config);
        const lateNote =
          eff.late && trade.entryPriceCents < primary.min ? ' · late fallback' : '';
        const sized = this._stakeDollarsForEntry(trade.entryPriceCents, {
          settle: true,
          symbol,
          thirdSlot,
        });
        const baseStake = Number(this._computeNextStake());
        let sizeNote = '';
        if (thirdSlot && trade.entryPriceCents >= 80) {
          sizeNote = ' · half stake (3rd)';
        } else if (Number.isFinite(sized) && Number.isFinite(baseStake) && sized < baseStake - 0.001) {
          const ratio = sized / baseStake;
          sizeNote = ratio <= 0.3 ? ' · quarter stake' : ' · half stake';
        }
        this.lastDecision =
          `Opened ${symbol} ${side.toUpperCase()} settle position at ${trade.entryPriceCents}¢` +
          ` (hold to settlement${lateNote}${sizeNote}).`;
      } else if (isModel) {
        const sizeNote = modelQuarter ? ' · half stake' : '';
        this.lastDecision =
          `Opened ${symbol} ${side.toUpperCase()} model position at ${trade.entryPriceCents}¢` +
          `${sizeNote} (confidence ${engineConfidence}%).`;
      } else {
        this.lastDecision =
          `Opened ${symbol} ${side.toUpperCase()} ${this.config.mode} position at ${trade.entryPriceCents}¢` +
          ` (confidence ${engineConfidence}%).`;
      }
      this._logActivity(this.lastDecision, {
        kind: 'open',
        symbol,
        side,
        strategy: trade.strategy,
        tradeId: trade.id,
      });
      this._upsertTradeLog({
        id: trade.id,
        mode: trade.mode,
        strategy: trade.strategy,
        symbol: trade.symbol,
        ticker: trade.ticker,
        side: trade.side,
        contracts: trade.contracts,
        stakeDollars: trade.stakeDollars,
        entryPriceCents: trade.entryPriceCents,
        entryFeesCents: trade.entryFeesCents || 0,
        floorStrike: trade.floorStrike,
        openedAt: trade.openedAt,
        windowCloseTime: trade.windowCloseTime,
        engineProbability: trade.engineProbability,
        engineConfidence: trade.engineConfidence,
        status: 'open',
      });
    this._persist();
      return true;
    });
  }

  /**
   * After a live fill miss, hard-skip that coin+side briefly (default 7s) so we
   * don't spam the same thin book every cycle — then retry. Flat cooldown
   * (no escalating ladder). Streak still tracks misses for ranking demotion.
   * YES miss does not block NO on the same coin (and vice versa).
   * Streak + cooldown reset when that coin's session ends (close time), on a
   * successful fill of that side, or when any open on that coin closes/settles.
   */
  _noteEntryMiss(symbol, cooldownMs = null, sessionCloseMs = null, side = null) {
    if (!symbol) return { streak: 0, cooldownMs: 0, sessionCloseMs: null };
    const key = entryMissKey(symbol, side);
    if (!key) return { streak: 0, cooldownMs: 0, sessionCloseMs: null };
    this._expireEntryMissIfSessionEnded(symbol, Date.now(), null, side);
    if (!this._entryMissStreak) this._entryMissStreak = Object.create(null);
    if (!this._entryMissUntil) this._entryMissUntil = Object.create(null);
    if (!this._entryMissSessionClose) this._entryMissSessionClose = Object.create(null);
    const streak = (this._entryMissStreak[key] || 0) + 1;
    this._entryMissStreak[key] = streak;
    const ms =
      Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : ENTRY_MISS_COOLDOWN_MS;
    this._entryMissUntil[key] = Date.now() + ms;
    const close = Number(sessionCloseMs);
    if (Number.isFinite(close) && close > 0) {
      this._entryMissSessionClose[key] = close;
    }
    return { streak, cooldownMs: ms, sessionCloseMs: this._entryMissSessionClose[key] };
  }

  _clearEntryMiss(symbol, side = null) {
    if (!symbol) return;
    const sym = String(symbol).toUpperCase();
    if (!this._entryMissUntil && !this._entryMissStreak && !this._entryMissSessionClose) return;
    const keys = isYesNoSide(side) ? [entryMissKey(sym, side)] : [sym, `${sym}:yes`, `${sym}:no`];
    for (const key of keys) {
      if (!key) continue;
      if (this._entryMissUntil) delete this._entryMissUntil[key];
      if (this._entryMissStreak) delete this._entryMissStreak[key];
      if (this._entryMissSessionClose) delete this._entryMissSessionClose[key];
    }
  }

  /**
   * Drop miss streak/cooldown when the Kalshi session that caused the miss
   * has ended, or when we see a different session close time (new window).
   */
  _expireEntryMissIfSessionEnded(symbol, now = Date.now(), currentSessionCloseMs = null, side = null) {
    if (!symbol) return false;
    const sym = String(symbol).toUpperCase();
    const keys = isYesNoSide(side) ? [entryMissKey(sym, side)] : [sym, `${sym}:yes`, `${sym}:no`];
    let cleared = false;
    for (const key of keys) {
      if (!key) continue;
      const stored = this._entryMissSessionClose && Number(this._entryMissSessionClose[key]);
      if (Number.isFinite(stored) && stored > 0 && now >= stored) {
        if (this._entryMissUntil) delete this._entryMissUntil[key];
        if (this._entryMissStreak) delete this._entryMissStreak[key];
        if (this._entryMissSessionClose) delete this._entryMissSessionClose[key];
        cleared = true;
        continue;
      }
      const cur = Number(currentSessionCloseMs);
      if (
        Number.isFinite(stored) &&
        stored > 0 &&
        Number.isFinite(cur) &&
        cur > 0 &&
        cur !== stored
      ) {
        if (this._entryMissUntil) delete this._entryMissUntil[key];
        if (this._entryMissStreak) delete this._entryMissStreak[key];
        if (this._entryMissSessionClose) delete this._entryMissSessionClose[key];
        cleared = true;
      }
    }
    return cleared;
  }

  _entryMissCooldownMs(symbol, side = null) {
    this._expireEntryMissIfSessionEnded(symbol, Date.now(), null, side);
    if (!this._entryMissUntil || !symbol) return 0;
    const key = entryMissKey(symbol, side);
    if (!key) return 0;
    const until = this._entryMissUntil[key];
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, until - Date.now());
  }

  _hasRecentEntryMiss(symbol, currentSessionCloseMs = null, side = null) {
    this._expireEntryMissIfSessionEnded(symbol, Date.now(), currentSessionCloseMs, side);
    if (!this._entryMissUntil || !symbol) return false;
    // Side-specific: only that YES/NO is cooling.
    if (isYesNoSide(side)) {
      const key = entryMissKey(symbol, side);
      const until = this._entryMissUntil[key];
      if (!Number.isFinite(until)) return false;
      if (Date.now() >= until) {
        delete this._entryMissUntil[key];
        return false;
      }
      return true;
    }
    // No side: true if either side (or legacy whole-coin key) is cooling.
    const sym = String(symbol).toUpperCase();
    for (const key of [sym, `${sym}:yes`, `${sym}:no`]) {
      const until = this._entryMissUntil[key];
      if (!Number.isFinite(until)) continue;
      if (Date.now() >= until) {
        delete this._entryMissUntil[key];
        continue;
      }
      return true;
    }
    return false;
  }

  _entryMissStreakFor(symbol, side = null) {
    if (!this._entryMissStreak || !symbol) return 0;
    if (isYesNoSide(side)) {
      return this._entryMissStreak[entryMissKey(symbol, side)] || 0;
    }
    const sym = String(symbol).toUpperCase();
    return (
      (this._entryMissStreak[sym] || 0) +
      (this._entryMissStreak[`${sym}:yes`] || 0) +
      (this._entryMissStreak[`${sym}:no`] || 0)
    );
  }

  _entryMissCooldownSymbols() {
    if (!this._entryMissUntil) return [];
    const now = Date.now();
    const out = [];
    for (const key of Object.keys(this._entryMissUntil)) {
      const sym = String(key).split(':')[0];
      this._expireEntryMissIfSessionEnded(sym, now);
    }
    for (const [key, until] of Object.entries(this._entryMissUntil || {})) {
      if (Number.isFinite(until) && until > now) {
        // Show "HYPE YES" when side-keyed so Decision makes NO-vs-YES clear.
        const parts = String(key).split(':');
        out.push(parts.length === 2 ? `${parts[0]} ${parts[1].toUpperCase()}` : parts[0]);
      } else if (this._entryMissUntil) delete this._entryMissUntil[key];
    }
    return out;
  }

  /**
   * predictions: the full result object from buildPredictions() — i.e. has
   * both .BTC and .XRP, each with .windows.w5/w10/w15. The bot trades
   * whichever one matches this.config.symbol, but will still manage
   * (monitor/close) any already-open position even if you've since switched
   * symbols, so a switch never orphans an open trade.
   */
  async runCycle(predictions) {
    this._inRunCycle = true;
    this._cyclePredictions = predictions || null;
    try {
    this._stoppedSymbolsThisCycle = new Set();
    this._maybeRotateLedger(Date.now());

    const hasOpenInventory = Array.isArray(this.openTrades) && this.openTrades.length > 0;
    // Live balance only when trading or managing inventory — never poll Kalshi idle.
    if (
      this.config.mode === 'live' &&
      this.client.hasCredentials &&
      (this.isRunning || hasOpenInventory) &&
      (!this.liveBalanceUpdatedAt || Date.now() - this.liveBalanceUpdatedAt > 15000)
    ) {
      try {
        const balance = await this.client.getBalance();
        this.liveBalanceCents = Number(balance.balance);
        this.livePortfolioValueCents = Number(balance.portfolio_value);
        this.liveBalanceUpdatedAt = Date.now();
      } catch (err) {
        this.lastError = `Unable to refresh live balance: ${err.message}`;
      }
    }

    // --- first, manage every currently open trade by its own ticker,
    // regardless of what symbol is currently selected to trade next ---
    await this.manageOpenPositions(predictions);
    await this._reviewPendingStopVerdicts();
    if (isBackupBotRole()) {
      await this._runBackupRescue();
    }

    try {
    if (!this.isRunning) {
      this.lastDecision = 'Bot is stopped; it will continue monitoring any already-open positions but will not open new ones.';
      return;
    }
    const dailyLimitCheck = this._checkDailyLossLimit();
    if (!dailyLimitCheck.ok) {
      this.lastDecision = dailyLimitCheck.reason;
      return;
    }
    if (isBackupBotRole()) {
      this.lastDecision =
        this.lastDecision && /backup rescue/i.test(this.lastDecision)
          ? this.lastDecision
          : 'Backup bot: monitoring primary — no new entries.';
      return;
    }
    // Don't burn Kalshi GETs or open risk if Available can't fund even one contract.
    // This is a temporary wait, not a permanent halt: a later deposit, settlement,
    // or refreshed Kalshi balance can make the next cycle eligible again.
    {
      const minEntry = isModelStrategyMode(this.config)
        ? Number(this.config.modelMinEntryCents) || MODEL_MIN_ENTRY_DEFAULT_CENTS
        : Number(this.config.minEntryCents) || 40;
      const floorCents = Math.max(1, Math.round(minEntry) || 65);
      if (this._tradingSpendableCents() < floorCents) {
        const capital = this._capitalStatus();
        const waitMessage =
          `Waiting for funds: Available $${((Number(capital.paperAvailableCents) || 0) / 100).toFixed(2)} ` +
            `can't fund a new contract (need ≥${floorCents}¢). ` +
            `Wallet $${((Number(capital.reserveCents) || 0) / 100).toFixed(2)} + ` +
            `Insurance $${((Number(capital.insuranceCents) || 0) / 100).toFixed(2)} stay locked. ` +
            `New entries will resume automatically once funded.`;
        this.lastError = waitMessage;
        this.lastDecision = waitMessage;
        return;
      }
    }
    if (this.openTrades.length >= this._effectiveMaxOpenPositions()) return;
    if (!predictions) return;

    // One open is fine; a second only if something already held is green.
    // A 3rd settle open is allowed while any hold has tagged 90¢ (half stake).
    // Model skips the green gate — windows decide; maxOpenPositions still caps.
    const settleMode = isSettleStrategyMode(this.config);
    const modelMode = isModelStrategyMode(this.config);
    if (this.openTrades.length >= 1 && !modelMode) {
      const extra = await this._canOpenAdditionalPosition();
      if (!extra.ok) {
        this.lastDecision = extra.reason;
        return;
      }
    }

    // After a stop, don't stack a second leg while the wound is still fresh —
    // briefly cap at 1 open (postStopMaxOneMinutes, default 1.5m), then
    // normal maxOpenPositions applies again. Other gates still apply.
    // Model ignores post-stop max-1 — no Edge protection rules.
    const preferOtherThan = modelMode ? null : this._lastStopLossSymbol();
    const maxOneActive = !modelMode && isPostStopMaxOneActive(this._lastStopLossTrade(), this.config);
    if (preferOtherThan && this.openTrades.length >= 1 && maxOneActive) {
      const mins = Number(this.config.postStopMaxOneMinutes);
      const minsLabel = Number.isFinite(mins) && mins > 0 ? mins : POST_STOP_MAX_ONE_DEFAULT_MINUTES;
      this.lastDecision =
        `Waiting: after ${preferOtherThan} stop — max 1 open until post-stop calm (${minsLabel}m) (avoids loss strings).`;
      this._noteProtectionGate(this.lastDecision);
      return;
    }
    if (this._lastProtectionGateKey === 'post-stop-max1') {
      this._noteProtectionGate(null);
    }

    // After a stop-loss, scan other coins first instead of immediately
    // rebuying the same one that just stopped (even if it still ranks highest).
    const scanAllAfterStop =
      preferOtherThan != null &&
      (this.config.symbol === 'AUTO' || preferOtherThan === this.config.symbol);

    let opportunity;
    if (settleMode) {
      const ranked =
        this.config.symbol === 'AUTO' || scanAllAfterStop
          ? await this._rankSettleOpportunities(predictions, { preferOtherThan })
          : [await this._evaluateSymbolForSettle(this.config.symbol, predictions)].filter(Boolean);
      await this._openSettleRanked(ranked, { preferOtherThan });
      return;
    }

    if (modelMode) {
      // Fill up to maxOpen with ranked MODEL opportunities in one cycle
      // (several coins can correlate near the same time). Late cutoff is
      // per-opportunity — one coin near settle must not freeze the others.
      const ranked =
        this.config.symbol === 'AUTO'
          ? await this._findModelOpportunities(predictions)
          : [await this._evaluateSymbolForModel(this.config.symbol, predictions)].filter(Boolean);
      await this._openModelRanked(ranked);
      return;
    }

    opportunity =
      this.config.symbol === 'AUTO' || scanAllAfterStop
        ? await this._findBestOpportunity(predictions, { preferOtherThan })
        : await this._evaluateSymbolForEdge(this.config.symbol, predictions);

    if (!opportunity) return;

    if (preferOtherThan && opportunity.symbol !== preferOtherThan) {
      this.lastDecision =
        `Post-stop: chose ${opportunity.symbol} over recently stopped ${preferOtherThan} ` +
        `(checking other cryptos first).`;
    }

    await this._openPosition({
      symbol: opportunity.symbol,
      ticker: opportunity.market.ticker,
      side: opportunity.side,
      priceCents: opportunity.priceCents,
      floorStrike: marketStrikePrice(opportunity.market) ?? opportunity.market.floor_strike,
      closeTime: opportunity.closeTime,
      engineProbability: opportunity.side === 'yes' ? opportunity.window.probabilityUp : opportunity.window.probabilityDown,
      engineConfidence: opportunity.window.confidence,
      strategy: 'edge',
    });
    } finally {
      await this._finishModelShadowCycle(predictions);
    }
    } finally {
      this._inRunCycle = false;
    }
  }

  _settleOppToOpenArgs(opp, entryAttempts = 2) {
    return {
      symbol: opp.symbol,
      ticker: opp.market.ticker,
      side: opp.side,
      priceCents: opp.priceCents,
      floorStrike: marketStrikePrice(opp.market) ?? opp.market.floor_strike,
      closeTime: opp.closeTime,
      engineProbability: opp.side === 'yes' ? opp.window.probabilityUp : opp.window.probabilityDown,
      engineConfidence: opp.window.confidence,
      strategy: 'settle',
      entryAttempts,
    };
  }

  /**
   * Settle AUTO opens: with an empty book and ≥2 free slots, IOC the top 2
   * candidates in parallel (2 tries each) so a slow miss on #1 doesn't age
   * #2's book. Then fill remaining slots sequentially. One slot / already
   * holding → sequential only (second-green / 3rd-slot rules still apply).
   */
  async _openSettleRanked(ranked, { preferOtherThan = null } = {}) {
    if (!ranked || ranked.length === 0) return;
    const slotsFree = () =>
      Math.max(0, this._effectiveMaxOpenPositions() - this.openTrades.length);

    const tryOne = async (opp, attempts) => {
      if (preferOtherThan && opp.symbol !== preferOtherThan && ranked[0] === opp) {
        this.lastDecision =
          `Post-stop: chose ${opp.symbol} over recently stopped ${preferOtherThan} ` +
          `(checking other cryptos first).`;
      }
      return this._openPosition(this._settleOppToOpenArgs(opp, attempts));
    };

    let i = 0;
    // Parallel top-2 only from an empty book (avoids half-stake 3rd-slot races).
    if (this.openTrades.length === 0 && slotsFree() >= 2 && ranked.length >= 2) {
      const a = ranked[0];
      const b = ranked[1];
      this.lastDecision =
        `Settle dual-entry: trying ${a.symbol} + ${b.symbol} in parallel.`;
      this._logActivity(this.lastDecision, {
        kind: 'open',
        symbol: `${a.symbol}+${b.symbol}`,
        strategy: 'settle',
      });
      await Promise.all([tryOne(a, 2), tryOne(b, 2)]);
      i = 2;
    }

    for (; i < ranked.length; i++) {
      if (slotsFree() <= 0) return;
      if (this.openTrades.length >= 1) {
        const extra = await this._canOpenAdditionalPosition();
        if (!extra.ok) {
          this.lastDecision = extra.reason;
          return;
        }
      }
      await tryOne(ranked[i], 2);
    }
  }

  /**
   * Most recent closed trade by closedAt (not array order).
   * Ledger unshifts on open, so a newer coin that TP'd can sit in front of an
   * older coin that just stopped — `.find(closed)` would miss the stop.
   */
  _mostRecentClosedTrade({ exitReasons = null } = {}) {
    let best = null;
    let bestAt = -Infinity;
    for (const t of this.ledger.trades || []) {
      if (!t || t.status !== 'closed') continue;
      if (exitReasons && !exitReasons.includes(t.exitReason)) continue;
      const at = Number(t.closedAt);
      const score = Number.isFinite(at) ? at : -Infinity;
      if (score >= bestAt) {
        bestAt = score;
        best = t;
      }
    }
    return best;
  }

  /** Most recent stop_loss by closedAt; else null. */
  _lastStopLossTrade() {
    return this._mostRecentClosedTrade({ exitReasons: ['stop_loss'] });
  }

  /** Most recent closed trade's symbol if it was a stop-loss; else null. */
  _lastStopLossSymbol() {
    const last = this._lastStopLossTrade();
    return last && last.symbol ? last.symbol : null;
  }

  /**
   * After a stop (while it remains the latest closed trade), gate new entries:
   * session expiry → allow; max-age → allow; peers cascading → block all;
   * stopped-coin bounce not met → block all; same-coin same-side thesis → knife-catch only.
   */
  async _stoppedCoinRecoveryGate(candidateSymbol, candidateSide, candidatePriceCents, candidateWindow, predictions) {
    const lastStop = this._lastStopLossTrade();
    if (!lastStop) return { ok: true };

    // Settle needs these too — without same-side sit-out the bot knife-catches
    // the same 85–95¢ print after every stop (see SOL 12:57–12:59 loss string).

    const now = Date.now();
    const maxAgeMs = stopRecoveryMaxAgeMs(this.config);
    const sameSideCooldownMs = postStopSameSideCooldownMs(this.config);

    // Same-side sit-out from closedAt — independent of bounce / session / max-age.
    const sameSideCheck = checkPostStopSameSideCooldown({
      lastStopTrade: lastStop,
      forCandidateSymbol: candidateSymbol,
      forCandidateSide: candidateSide,
      cooldownMs: sameSideCooldownMs,
      now,
    });
    if (!sameSideCheck.ok) return sameSideCheck;

    // 1) Session window ended → allow (never freeze into the next 15m).
    if (isPostStopRecoverySessionExpired(lastStop, now)) {
      return { ok: true };
    }

    // 2) Max-age backup within a long window → allow.
    const closedAt = Number(lastStop.closedAt);
    if (
      maxAgeMs > 0 &&
      Number.isFinite(closedAt) &&
      now - closedAt >= maxAgeMs
    ) {
      return { ok: true };
    }

    // 3) Peers still cascading → block EVERY candidate until calm / session / short max age.
    const peerCheck = checkPostStopPeerCascade({
      lastStopTrade: lastStop,
      candidateSide,
      predictions,
      seriesBySymbol: SERIES_BY_SYMBOL,
      minConfidence: this.config.minConfidence,
      maxAgeMs: peerCascadeMaxAgeMs(this.config),
      now,
    });
    if (!peerCheck.ok) return peerCheck;

    const recoveryCents = stopRecoveryCentsRequired(this.config);
    if (recoveryCents <= 0) return { ok: true };

    let priceCents = candidatePriceCents;
    let window = candidateWindow;

    // Always quote the *stopped* side on the *stopped* coin for the bounce check.
    if (candidateSymbol !== lastStop.symbol || candidateSide !== lastStop.side) {
      const seriesTicker = SERIES_BY_SYMBOL[lastStop.symbol];
      const stoppedPred = predictions && predictions[lastStop.symbol];
      if (!seriesTicker) return { ok: true };
      if (!stoppedPred || !stoppedPred.ready) {
        return {
          ok: false,
          reason:
            `Waiting: after ${lastStop.symbol} stop — need ${lastStop.symbol} prediction ready ` +
            `before any new entry on ${candidateSymbol}.`,
        };
      }
      try {
        const market = await this._fetchLiveMarket(seriesTicker, 5000);
        if (!market) {
          return {
            ok: false,
            reason:
              `Waiting: after ${lastStop.symbol} stop — no live ${lastStop.symbol} quote for recovery ` +
              `check before entering ${candidateSymbol}.`,
          };
        }
        const nowMs = Date.now();
        const yesBid = Number(market.yes_bid);
        const yesAsk = Number(market.yes_ask);
        priceCents = lastStop.side === 'yes' ? yesAsk : 100 - yesBid;
        if (!Number.isFinite(priceCents)) {
          return {
            ok: false,
            reason:
              `Waiting: after ${lastStop.symbol} stop — ${lastStop.symbol} ${String(lastStop.side).toUpperCase()} ` +
              `quote unavailable for recovery check.`,
          };
        }
        const closeTime = new Date(market.close_time).getTime();
        const minutesRemaining = Math.max(0.1, (closeTime - nowMs) / 60000);
        window = this._pickWindow(stoppedPred.windows, minutesRemaining) || stoppedPred.windows.w5;
      } catch (err) {
        return {
          ok: false,
          reason:
            `Waiting: after ${lastStop.symbol} stop — recovery quote failed (${err.message}) ` +
            `before entering ${candidateSymbol}.`,
        };
      }
    }

    // 5–6) Bounce required for everyone; knife-catch only same-coin same-side.
    // sameSideCooldownMs passed so checkPostStopRecovery stays consistent (already
    // enforced above; remaining bounce/thesis gates still apply).
    return checkPostStopRecovery({
      lastClosedForSymbol: lastStop,
      side: lastStop.side,
      priceCents,
      window,
      recoveryCents,
      symbol: lastStop.symbol,
      forCandidateSymbol: candidateSymbol,
      forCandidateSide: candidateSide,
      maxAgeMs,
      sameSideCooldownMs,
      now,
    });
  }

  /**
   * Fetches the current open market for one symbol and checks whether
   * there's a large enough edge (and enough confidence) to be worth
   * trading. Returns an opportunity descriptor, or null if there's nothing
   * worth acting on (or the market/prediction data isn't available).
   */
  async _evaluateSymbolForEdge(symbol, predictions) {
    if (!isKalshiTradeEnabled(symbol, this.config)) {
      this.lastDecision = `Waiting: ${symbol} is opted out of trading.`;
      return null;
    }

    if (this._hasOpenOnSymbol(symbol)) {
      this.lastDecision = `Waiting: already holding an open ${symbol} position (one open per coin).`;
      return null;
    }

    const assetPrediction = predictions[symbol];
    if (!assetPrediction || !assetPrediction.ready) {
      this.lastDecision = `Waiting: ${symbol} prediction data is still seeding.`;
      return null;
    }

    const seriesTicker = SERIES_BY_SYMBOL[symbol];
    if (!seriesTicker) {
      this.lastDecision = `Waiting: ${symbol} has no supported Kalshi market.`;
      return null;
    }

    let market;
    try {
      market = await this._fetchLiveMarket(seriesTicker, 5000);
    } catch (err) {
      this.lastError = `Failed to fetch Kalshi market for ${seriesTicker}: ${err.message}`;
      console.error('[bot]', this.lastError);
      return null;
    }
    if (!market) {
      this.lastDecision = this._liveMarketWaitReason(symbol, seriesTicker);
      return null;
    }
    market = (await this._hydrateMarketQuote(market, 3500)) || normalizeMarketPrices(market);
    this._noteEngineStrike(symbol, market);
    if (this._hasOpenOnTicker(market.ticker)) {
      this.lastDecision = `Waiting: already holding an open position on ${market.ticker}.`;
      return null;
    }

    const now = Date.now();
    const closeTime = new Date(market.close_time).getTime();
    if (closeTime <= now) {
      this.lastDecision = `Waiting: the available ${symbol} market is already closed.`;
      return null;
    }

    const minutesRemaining = Math.max(0.1, (closeTime - now) / 60000);
    const minMinutesToOpen = Number.isFinite(Number(this.config.minMinutesToOpen))
      ? Number(this.config.minMinutesToOpen)
      : 3;
    if (minMinutesToOpen > 0 && minutesRemaining < minMinutesToOpen) {
      this.lastDecision =
        `Waiting: ${symbol} window has only ${minutesRemaining.toFixed(1)} min left (need ≥ ${minMinutesToOpen} to open — avoids freeze-into-settle).`;
      return null;
    }
    const window = this._pickWindow(assetPrediction.windows, minutesRemaining);
    if (!window || window.confidence < this.config.minConfidence) {
      const confidence = window && Number.isFinite(window.confidence) ? window.confidence : 'unavailable';
      this.lastDecision = `Waiting: ${symbol} ${window ? window.window : 'current'} confidence is ${confidence}% (minimum ${this.config.minConfidence}%).`;
      return null;
    }

    const yesBid = Number(market.yes_bid);
    const yesAsk = Number(market.yes_ask);
    if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid < 1 || yesAsk > 99 || yesBid > yesAsk) {
      this.lastError = `Skipped ${symbol}: Kalshi has no usable two-sided quote yet.`;
      return null;
    }

    const kalshiImpliedYesPct = (yesBid + yesAsk) / 2;
    const edge = window.probabilityUp - kalshiImpliedYesPct;
    if (Math.abs(edge) < this.config.edgeThresholdPct) {
      this.lastDecision = `Waiting: ${symbol} confidence ${window.confidence}% passes, but edge is ${Math.abs(edge).toFixed(1)} points (minimum ${this.config.edgeThresholdPct}).`;
      return null;
    }

    const side = edge > 0 ? 'yes' : 'no';
    const priceCents = side === 'yes' ? yesAsk : 100 - yesBid;
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) {
      this.lastError = `Skipped ${symbol}: selected ${side.toUpperCase()} price is unavailable.`;
      return null;
    }
    if (this._hasRecentEntryMiss(symbol, closeTime, side)) {
      this.lastDecision =
        `Waiting: ${symbol} ${side.toUpperCase()} fill-miss cool-down (~${Math.round(ENTRY_MISS_COOLDOWN_MS / 1000)}s) — trying other cryptos/sides.`;
      return null;
    }
    const minEntry = Number(this.config.minEntryCents);
    if (Number.isFinite(minEntry) && minEntry > 0 && priceCents < minEntry) {
      this.lastDecision =
        `Waiting: ${symbol} ${side.toUpperCase()} is ${priceCents}¢ — below min entry ${minEntry}¢ (skipping longshots even if confidence is high).`;
      return null;
    }
    const maxEntry = Number(this.config.maxEntryCents);
    if (Number.isFinite(maxEntry) && maxEntry > 0 && priceCents > maxEntry) {
      this.lastDecision =
        `Waiting: ${symbol} ${side.toUpperCase()} is ${priceCents}¢ — above max entry ${maxEntry}¢.`;
      return null;
    }

    // Post-stop: peers calm + stopped-coin bounce (knife-catch only same-coin).
    const recoveryCheck = await this._stoppedCoinRecoveryGate(
      symbol,
      side,
      priceCents,
      window,
      predictions
    );
    if (!recoveryCheck.ok) {
      this.lastDecision = recoveryCheck.reason;
      this._noteProtectionGate(recoveryCheck.reason, { fromSymbol: symbol });
      return null;
    }
    this._noteProtectionGate(null, { fromSymbol: symbol });

    return {
      symbol,
      market,
      window,
      side,
      priceCents,
      closeTime,
      edge: Math.abs(edge),
      // Ranking score for AUTO mode: edge weighted by how much the engine
      // trusts the call — a huge edge the engine itself isn't confident in
      // ranks below a smaller edge it's very sure about.
      rankScore: Math.abs(edge) * (window.confidence / 100),
    };
  }

  /**
   * Confirm gate stays off for a symbol until that symbol completes a MODEL
   * buy+sell that was opened in this process.
   */
  _hasCompletedModelRoundTrip(symbol = null) {
    if (!symbol) return this._modelConfirmGateArmed === true;
    const sym = String(symbol || '').toUpperCase();
    return !!(this._modelConfirmArmedSymbols && this._modelConfirmArmedSymbols.has(sym));
  }

  /**
   * After a MODEL close of a trade opened this run, arm confirm for that coin
   * and wipe per-market gate state so rebuy needs a fresh under-cross print.
   */
  _resetModelConfirmGatesForTrade(trade) {
    if (!trade || !isModelTrade(trade)) return;
    const symbol = String(trade.symbol || '').toUpperCase();
    const openedAt = Number(trade.openedAt);
    const startedAt = Number(this._modelConfirmProcessStartedAt) || 0;
    const openedThisRun = Number.isFinite(openedAt) && openedAt >= startedAt;
    if (openedThisRun && symbol) {
      if (!this._modelConfirmArmedSymbols) this._modelConfirmArmedSymbols = new Set();
      this._modelConfirmArmedSymbols.add(symbol);
      this._modelConfirmGateArmed = true;
    }
    if (!this._modelConfirmGates) return;
    const ticker = String(trade.ticker || '');
    for (const key of Object.keys(this._modelConfirmGates)) {
      const k = String(key);
      if (ticker && k.startsWith(`${ticker}:`)) {
        delete this._modelConfirmGates[key];
        continue;
      }
      // Fallback keys that used symbol when ticker was missing.
      if (symbol && (k.startsWith(`${symbol}:`) || k.includes(`:${symbol.toLowerCase()}:`))) {
        delete this._modelConfirmGates[key];
      }
    }
  }

  /**
   * After MODEL lean flips (UP↔DOWN), wait for confirmation before bidding.
   * Confirm length scales with minutes left — more time → longer wait.
   * First lean of a window enters immediately (no prior side to switch from).
   */
  _checkModelSideSwitchConfirm({
    ticker,
    symbol,
    direction,
    minutesRemaining,
    closeTime,
  } = {}) {
    const dir = String(direction || '').toUpperCase();
    if (dir !== 'UP' && dir !== 'DOWN') {
      return { ok: false, reason: `Waiting: ${symbol} has no usable model lean to confirm.` };
    }
    if (!this._modelSideSwitchGates) this._modelSideSwitchGates = Object.create(null);
    const key = String(ticker || symbol || '');
    if (!key) return { ok: true };
    const closeMs = Number(closeTime);
    let g = this._modelSideSwitchGates[key];
    if (!g || (Number.isFinite(closeMs) && Number(g.closeTime) !== closeMs)) {
      g = {
        direction: null,
        switching: false,
        since: null,
        ticks: 0,
        closeTime: closeMs,
      };
      this._modelSideSwitchGates[key] = g;
    }

    const needMs = modelSideSwitchConfirmMs(minutesRemaining, this.config);
    const needTicks = modelSideSwitchConfirmTicks(minutesRemaining, this.config);
    const now = Date.now();

    if (g.direction == null) {
      g.direction = dir;
      g.switching = false;
      g.since = now;
      g.ticks = 1;
      return { ok: true, first: true };
    }

    if (g.direction !== dir) {
      g.direction = dir;
      g.switching = true;
      g.since = now;
      g.ticks = 1;
      const sec = Math.max(1, Math.ceil(needMs / 1000));
      return {
        ok: false,
        reason:
          `Waiting: ${symbol} switched to ${dir} — confirming direction ` +
          `(~${sec}s / ${needTicks} ticks; ${Number(minutesRemaining).toFixed(1)}m left) before bid.`,
      };
    }

    g.ticks = (Number(g.ticks) || 0) + 1;
    if (g.switching) {
      const elapsed = now - (Number(g.since) || now);
      if (elapsed < needMs || g.ticks < needTicks) {
        const remainSec = Math.max(1, Math.ceil((needMs - elapsed) / 1000));
        return {
          ok: false,
          reason:
            `Waiting: ${symbol} ${dir} confirm ${g.ticks}/${needTicks} ticks, ` +
            `~${remainSec}s left — then bid.`,
        };
      }
      g.switching = false;
    }
    return { ok: true };
  }

  /**
   * Model confirmation gate (optional):
   * Off for a coin until that coin finishes a MODEL buy+sell opened this run.
   * Then, for YES and NO alike:
   * 1) Must observe ask below confirmCross (default 50¢) this market
   * 2) Then see it cross ≥ confirmCross → arm
   * 3) Enter only after min continuation above the cross
   * 4) If ask runs too far past the cross → too late / buying the top
   * 5) If ask falls back under confirmCross → disarm (no chase)
   * Closing a MODEL trade resets the gate so it can't rebuy the same level.
   * Set modelConfirmCrossCents = 0 to disable.
   */
  _checkModelConfirmGate({ ticker, symbol, side, priceCents, closeTime }) {
    const confirm = modelConfirmCrossCents(this.config);
    if (!(confirm > 0)) return { ok: true, skipped: true };

    // Don't enforce until THIS coin has done a MODEL buy → sell this run.
    if (!this._hasCompletedModelRoundTrip(symbol)) {
      return { ok: true, skipped: true, warmup: true };
    }

    if (!this._modelConfirmGates) this._modelConfirmGates = Object.create(null);
    const key = `${String(ticker || symbol)}:${String(side || '').toLowerCase()}`;
    const ask = Math.round(Number(priceCents));
    if (!Number.isFinite(ask) || ask < 1 || ask > 99) {
      return { ok: false, reason: `Waiting: ${symbol} confirm gate — no usable ask.` };
    }

    let g = this._modelConfirmGates[key];
    const closeMs = Number(closeTime);
    if (!g || (Number.isFinite(closeMs) && Number(g.closeTime) !== closeMs) || g.side !== side) {
      g = {
        seenBelow: false,
        armed: false,
        crossedAt: null,
        crossAsk: null,
        peakAsk: null,
        lastAsk: null,
        closeTime: closeMs,
        side,
      };
      this._modelConfirmGates[key] = g;
    }

    const maxExt = modelConfirmMaxExtensionCents(this.config);
    const minCont = modelConfirmMinContinueCents(this.config);

    if (ask < confirm) {
      g.seenBelow = true;
      g.armed = false;
      g.crossedAt = null;
      g.crossAsk = null;
      g.peakAsk = null;
      g.lastAsk = ask;
      return {
        ok: false,
        reason:
          `Waiting: ${symbol} ${String(side).toUpperCase()} at ${ask}¢ — need cross of ${confirm}¢ ` +
          `before MODEL re-entry (confirm gate; both YES/NO).`,
      };
    }

    // At/above confirm line.
    if (!g.seenBelow) {
      g.lastAsk = ask;
      return {
        ok: false,
        reason:
          `Waiting: ${symbol} ${String(side).toUpperCase()} already ${ask}¢ — need a fresh print under ` +
          `${confirm}¢ after the last exit (won't rebuy where we just were).`,
      };
    }

    if (!g.armed) {
      g.armed = true;
      g.crossedAt = Date.now();
      g.crossAsk = ask;
      g.peakAsk = ask;
      g.lastAsk = ask;
      return {
        ok: false,
        reason:
          `Watching: ${symbol} ${String(side).toUpperCase()} just crossed ${confirm}¢ @ ${ask}¢ — ` +
          `waiting for continuation (not buying the cross tick).`,
      };
    }

    g.peakAsk = Math.max(Number(g.peakAsk) || ask, ask);
    const crossAsk = Number(g.crossAsk);
    const extension = Number.isFinite(crossAsk) ? ask - crossAsk : 0;
    const prevAsk = Number(g.lastAsk);
    const falling = Number.isFinite(prevAsk) && ask < prevAsk;
    g.lastAsk = ask;

    if (falling && ask < confirm + Math.max(1, minCont)) {
      return {
        ok: false,
        reason:
          `Waiting: ${symbol} ${String(side).toUpperCase()} faded to ${ask}¢ after the ${confirm}¢ cross — not chasing.`,
      };
    }

    if (maxExt > 0 && extension > maxExt) {
      return {
        ok: false,
        reason:
          `Waiting: ${symbol} ${String(side).toUpperCase()} at ${ask}¢ is +${extension}¢ past the ` +
          `${confirm}¢ cross (max +${maxExt}¢) — move already happened, not buying the top.`,
      };
    }

    if (minCont > 0 && extension < minCont) {
      return {
        ok: false,
        reason:
          `Watching: ${symbol} ${String(side).toUpperCase()} crossed ${confirm}¢ — need +${minCont}¢ ` +
          `continuation (now +${Math.max(0, extension)}¢ @ ${ask}¢).`,
      };
    }

    const strengthening =
      !Number.isFinite(prevAsk) || ask >= prevAsk || (Number.isFinite(crossAsk) && ask > crossAsk);
    if (!strengthening) {
      return {
        ok: false,
        reason:
          `Waiting: ${symbol} ${String(side).toUpperCase()} soft at ${ask}¢ after cross — want firm continuation.`,
      };
    }

    return {
      ok: true,
      crossAsk,
      extension,
      confirm,
    };
  }

  /**
   * Re-check MODEL direction after fill (same cycle predictions).
   * Pre-entry gate runs in evaluate; this catches lean rot during IOC chase.
   */
  _modelRecheckEntryDirection({
    symbol,
    side,
    direction,
    windowKey,
    entryHeldProb,
    windowCloseTime,
  } = {}) {
    const pred =
      this._cyclePredictions && symbol ? this._cyclePredictions[String(symbol).toUpperCase()] : null;
    if (!pred || !pred.ready) return { ok: true, firm: true, turning: false };
    const closeAt = Number(windowCloseTime);
    const minutesRemaining = Number.isFinite(closeAt)
      ? Math.max(0.1, (closeAt - Date.now()) / 60000)
      : 10;
    const picked = pickModelWindow(pred, minutesRemaining);
    if (!picked || !picked.window) return { ok: false, firm: false, turning: true };
    const minConf = Number.isFinite(Number(this.config.modelMinConfidence))
      ? Number(this.config.modelMinConfidence)
      : MODEL_MIN_CONFIDENCE_DEFAULT;
    const useDir = direction || picked.direction;
    const useKey = windowKey || picked.key;
    if (useKey && picked.key && useKey !== picked.key) {
      return { ok: false, firm: false, turning: true };
    }
    return modelDirectionSupportsHold({
      window: picked.window,
      direction: useDir,
      side,
      entryHeldProb,
      minConf,
      config: this.config,
    });
  }

  /**
   * Model mode: side from active window locked direction (UP→YES, DOWN→NO).
   * No Edge/Settle protection gates — windows + confidence floor only.
   */
  async _evaluateSymbolForModel(symbol, predictions, { quiet = false, onSkip = null } = {}) {
    const say = (msg) => {
      if (typeof onSkip === 'function') onSkip(symbol, msg);
      if (!quiet) this.lastDecision = msg;
    };
    if (!isKalshiTradeEnabled(symbol, this.config)) {
      say(`Waiting: ${symbol} is opted out of trading.`);
      return null;
    }

    if (this._hasOpenOnSymbol(symbol)) {
      say(`Waiting: already holding an open ${symbol} position (one open per coin).`);
      return null;
    }

    const globalCd = checkModelGlobalPostExitCooldown({
      trades: this.ledger.trades,
      cooldownMs: modelGlobalPostExitCooldownMs(this.config),
      now: Date.now(),
    });
    if (!globalCd.ok) {
      say(globalCd.reason);
      return null;
    }

    const cooldown = checkModelPostExitCooldown({
      trades: this.ledger.trades,
      symbol,
      cooldownMs: modelPostExitCooldownMs(this.config),
      leanStopCooldownMs: modelPostLeanStopCooldownMs(this.config),
      now: Date.now(),
    });
    if (!cooldown.ok) {
      say(cooldown.reason);
      return null;
    }

    const assetPrediction = predictions[symbol];
    if (!assetPrediction || !assetPrediction.ready) {
      say(`Waiting: ${symbol} prediction data is still seeding.`);
      return null;
    }

    const seriesTicker = SERIES_BY_SYMBOL[symbol];
    if (!seriesTicker) {
      say(`Waiting: ${symbol} has no supported Kalshi market.`);
      return null;
    }

    let market;
    try {
      market = await this._fetchLiveMarket(seriesTicker, 5000);
    } catch (err) {
      this.lastError = `Failed to fetch Kalshi market for ${seriesTicker}: ${err.message}`;
      console.error('[bot]', this.lastError);
      say(this.lastError);
      return null;
    }
    if (!market) {
      say(this._liveMarketWaitReason(symbol, seriesTicker));
      return null;
    }
    market = (await this._hydrateMarketQuote(market, 3500)) || normalizeMarketPrices(market);
    this._noteEngineStrike(symbol, market);
    if (this._hasOpenOnTicker(market.ticker)) {
      say(`Waiting: already holding an open position on ${market.ticker}.`);
      return null;
    }

    const now = Date.now();
    const closeTime = new Date(market.close_time).getTime();
    if (!Number.isFinite(closeTime) || closeTime <= now) {
      say(`Waiting: the available ${symbol} market is already closed.`);
      return null;
    }

    const minutesRemaining = Math.max(0.1, (closeTime - now) / 60000);
    const minMinutesToOpen = modelEntryCutoffMinutes(this.config);
    if (minMinutesToOpen > 0 && minutesRemaining < minMinutesToOpen) {
      say(
        `Waiting: ${symbol} model — only ${minutesRemaining.toFixed(1)} min left (no new entries in last ${minMinutesToOpen}m).`
      );
      return null;
    }
    const picked = pickModelWindow(assetPrediction, minutesRemaining);
    if (!picked || !picked.window || !picked.direction) {
      say(`Waiting: ${symbol} has no usable model window lean.`);
      return null;
    }
    const { window, direction, key: windowKey } = picked;
    const switchGate = this._checkModelSideSwitchConfirm({
      ticker: market.ticker,
      symbol,
      direction,
      minutesRemaining,
      closeTime,
    });
    if (!switchGate.ok) {
      say(switchGate.reason);
      return null;
    }
    const minConf = Number.isFinite(Number(this.config.modelMinConfidence))
      ? Number(this.config.modelMinConfidence)
      : MODEL_MIN_CONFIDENCE_DEFAULT;
    if (!Number.isFinite(window.confidence) || window.confidence < minConf) {
      const confidence = Number.isFinite(window.confidence) ? window.confidence : 'unavailable';
      say(`Waiting: ${symbol} ${windowKey} confidence is ${confidence}% (minimum ${minConf}%).`);
      return null;
    }

    const signalSide = modelSignalSideFromDirection(direction);
    if (!signalSide) {
      say(`Waiting: ${symbol} has no usable model window lean.`);
      return null;
    }
    const invert = isModelInvertSide(this.config);
    const side = invert ? flipKalshiSide(signalSide) : signalSide;
    if (this._hasRecentEntryMiss(symbol, closeTime, side)) {
      say(
        `Waiting: ${symbol} ${side.toUpperCase()} fill-miss cool-down (~${Math.round(ENTRY_MISS_COOLDOWN_MS / 1000)}s) — trying other cryptos.`
      );
      return null;
    }
    let yesBid = Number(market.yes_bid);
    let yesAsk = Number(market.yes_ask);
    if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid < 1 || yesAsk > 99 || yesBid > yesAsk) {
      const limited =
        this.client &&
        typeof this.client.isPublicRateLimited === 'function' &&
        this.client.isPublicRateLimited();
      this.lastError = limited
        ? this._seriesHasUsableCachedQuote(seriesTicker)
          ? `Waiting: ${symbol} — Kalshi rate limit; cached quote not merging (retrying).`
          : `Waiting: ${symbol} — Kalshi rate limit (~${Math.max(1, Math.ceil((this.client.publicRateLimitRemainingMs?.() || 5000) / 1000))}s), no bid/ask cache yet.`
        : `Skipped ${symbol}: Kalshi has no usable two-sided quote yet.`;
      say(this.lastError);
      return null;
    }

    let noAsk = Number(market.no_ask);
    if (!Number.isFinite(noAsk) || noAsk < 1 || noAsk > 99) {
      noAsk = 100 - yesBid;
    } else {
      noAsk = Math.round(noAsk);
    }
    const priceCents = side === 'yes' ? yesAsk : noAsk;
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) {
      this.lastError = `Skipped ${symbol}: selected ${side.toUpperCase()} price is unavailable.`;
      say(this.lastError);
      return null;
    }

    const kalshiFavGate = modelKalshiFavoriteGate({
      market,
      side,
      priceCents,
      config: this.config,
    });
    if (!kalshiFavGate.ok) {
      say(`Waiting: ${symbol} — ${kalshiFavGate.reason}.`);
      return null;
    }

    const noBid = modelActualSideBidCents(market, 'no');
    const heldBid = side === 'yes' ? modelActualSideBidCents(market, 'yes') : noBid;
    const maxSpreadBase = modelMaxEntrySpreadCentsForSymbol(symbol, this.config);
    const richAsk = modelRichAskCents(this.config);
    const isRichAsk = Number.isFinite(priceCents) && priceCents >= richAsk;
    const maxSpread = isRichAsk
      ? Math.min(maxSpreadBase > 0 ? maxSpreadBase : 99, modelRichMaxSpreadCents(this.config) || maxSpreadBase)
      : maxSpreadBase;
    if (maxSpread > 0) {
      if (!Number.isFinite(heldBid) || heldBid < 1) {
        say(
          `Waiting: ${symbol} ${String(side).toUpperCase()} has no live bid — won't buy blind into the ask.`
        );
        return null;
      }
      const spread = Math.round(priceCents - heldBid);
      if (spread > maxSpread) {
        say(
          `Waiting: ${symbol} ${String(side).toUpperCase()} ask ${priceCents}¢ vs bid ${Math.round(heldBid)}¢ ` +
            `(gap ${spread}¢) — won't buy into a wide spread` +
            (isRichAsk ? ' on a rich ask' : '') +
            '.'
        );
        return null;
      }
    }
    if (isRichAsk) {
      const richConf = Math.max(minConf, modelRichMinConfidence(this.config));
      if (!Number.isFinite(window.confidence) || window.confidence < richConf) {
        say(
          `Waiting: ${symbol} rich ask ${priceCents}¢ needs conf ≥${richConf}% ` +
            `(have ${Number.isFinite(window.confidence) ? Math.round(window.confidence) : '?'}%).`
        );
        return null;
      }
    }

    const entryHeldProb = side === 'yes' ? Number(window.probabilityUp) : Number(window.probabilityDown);
    const leanGate = modelMinEntryLeanGate({ window, side, config: this.config });
    if (!leanGate.ok) {
      say(`Waiting: ${symbol} ${String(side).toUpperCase()} — ${leanGate.reason}.`);
      return null;
    }
    // Don't place if the model already thinks this ticket dumps (weakening / fair < ask / lean soft).
    const dumpRisk = modelEntryDumpRisk({
      window,
      direction,
      side,
      priceCents,
      minConf,
      config: this.config,
      fade: invert,
    });
    if (dumpRisk.dump) {
      say(`Waiting: ${symbol} — skip entry, ${dumpRisk.reason}.`);
      return null;
    }
    if (
      modelEngineTurningAgainst({
        window,
        direction,
        side,
        minConf,
        entryHeldProb,
        config: this.config,
      })
    ) {
      say(
        `Waiting: ${symbol} model lean already turning on ${String(side).toUpperCase()} — no chase entry.`
      );
      return null;
    }

    // Confirm gate observes every quote (records under-50 prints even if lean is soft).
    const confirmGate = this._checkModelConfirmGate({
      ticker: market.ticker,
      symbol,
      side,
      priceCents,
      closeTime,
    });
    if (!confirmGate.ok) {
      say(confirmGate.reason);
      return null;
    }

    // Lock alone is not enough — live probs must still favor the SIGNAL
    // (then fade buys the other side). Don't require lean to already agree
    // with the faded ticket or we'd never enter.
    const liveMargin = modelEntryLiveLeanMarginPct(this.config);
    if (!modelLiveLeanStillFavors(window, signalSide, liveMargin)) {
      const up = Number(window.probabilityUp);
      const down = Number(window.probabilityDown);
      say(
        `Waiting: ${symbol} lock is ${direction} but live lean is ` +
          `${Number.isFinite(up) ? up.toFixed(0) : '?'}% UP / ${Number.isFinite(down) ? down.toFixed(0) : '?'}% DOWN` +
          ` (need live favor by ≥${liveMargin}pts).`
      );
      return null;
    }

    const priceGate = modelPriceAllowed(priceCents, window, this.config);
    if (!priceGate.ok) {
      say(`Waiting: ${symbol} ${side.toUpperCase()} is ${priceCents}¢ — ${priceGate.reason}.`);
      return null;
    }

    const lowAskGate = modelLowAskConvictionGate({
      priceCents,
      window,
      signalSide,
      config: this.config,
    });
    if (!lowAskGate.ok) {
      say(`Waiting: ${symbol} ${side.toUpperCase()} @ ${priceCents}¢ — ${lowAskGate.reason}.`);
      return null;
    }

    const preDir = modelDirectionSupportsHold({
      window,
      direction,
      side,
      entryHeldProb,
      minConf,
      config: this.config,
    });
    if (!preDir.ok) {
      say(
        `Waiting: ${symbol} — model direction not firm for ${String(side).toUpperCase()} ` +
          `(pre-entry check).`
      );
      return null;
    }

    // Multi-horizon agreement: skip when w5/w10/w15 mostly disagree with this side.
    if (!windowConsensusSupportsSide(assetPrediction.windows, side)) {
      const maj =
        assetPrediction.consensus && assetPrediction.consensus.majorityDirection
          ? assetPrediction.consensus.majorityDirection
          : assetPrediction.windows &&
              assetPrediction.windows.w5 &&
              assetPrediction.windows.w5.consensus
            ? assetPrediction.windows.w5.consensus.majorityDirection
            : '?';
      say(
        `Waiting: ${symbol} — horizons disagree with ${String(side).toUpperCase()} ` +
          `(majority ${maj}; need 2/3 agreement).`
      );
      return null;
    }

    // When this confidence bucket historically loses, skip (mature samples only).
    const engCal = predictions && predictions.engineCalibration;
    const calGate = modelCalibrationEntryGate({
      symbol,
      windowKey,
      probabilityUp: window.probabilityUpRaw != null ? window.probabilityUpRaw : window.probabilityUp,
      side,
      calibration: engCal,
      minWinRatePct: 52,
    });
    if (!calGate.ok) {
      say(`Waiting: ${symbol} ${String(side).toUpperCase()} — ${calGate.reason}.`);
      return null;
    }

    const leanStrength = Math.abs(Number(window.probabilityUp) - 50) || 1;
    const uncertain = modelIsHalfStakeAsk(priceCents);
    return {
      symbol,
      market,
      window,
      windowKey,
      direction,
      side,
      priceCents,
      entryBidCents: Number.isFinite(heldBid) ? Math.round(heldBid) : null,
      closeTime,
      rankScore:
        leanStrength *
        (window.confidence / 100) *
        (assetPrediction.consensus && assetPrediction.consensus.unanimous ? 1.15 : 1) *
        (calGate.winRatePct != null ? Math.min(1.2, calGate.winRatePct / 55) : 1),
      uncertain,
      invert,
      signalSide,
      signalPriceCents: signalSide === 'yes' ? yesAsk : noAsk,
      confirmCrossAsk: confirmGate.crossAsk != null ? confirmGate.crossAsk : null,
    };
  }

  async _findModelOpportunities(predictions) {
    const candidates = tradeableKalshiSymbols(this.config).filter(
      (sym) => predictions[sym] && !this._hasOpenOnSymbol(sym)
    );
    if (candidates.length === 0) return [];
    await this._prefetchKalshiForSymbols(candidates, 5000);
    const skips = [];
    // Serial — parallel AUTO scans were bursting list GETs and tripping 429.
    const valid = [];
    for (const sym of candidates) {
      const opp = await this._evaluateSymbolForModel(sym, predictions, {
        quiet: true,
        onSkip: (_s, msg) => {
          if (msg) skips.push(msg.replace(/^Waiting:\s*/i, ''));
        },
      });
      if (opp) valid.push(opp);
      if (
        this.client &&
        typeof this.client.isPublicRateLimited === 'function' &&
        this.client.isPublicRateLimited()
      ) {
        break;
      }
    }
    valid.sort((a, b) => {
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return liquidityPriority(b.symbol) - liquidityPriority(a.symbol);
    });
    if (valid.length === 0 && skips.length) {
      const short = skips
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 4);
      this.lastDecision = `Waiting: ${short.join(' · ')}`;
    } else if (valid.length > 0) {
      const names = valid.map((o) => o.symbol).join(', ');
      this.lastDecision =
        valid.length === 1
          ? `MODEL: ${names} ready — opening.`
          : `MODEL: ${names} ready (${valid.length}) — filling free slots.`;
    }
    return valid;
  }

  async _findBestModelOpportunity(predictions) {
    const ranked = await this._findModelOpportunities(predictions);
    return ranked[0] || null;
  }

  _modelOppToOpenArgs(opportunity) {
    const entryBid = Number(opportunity.entryBidCents);
    const price = Number(opportunity.priceCents);
    const spread =
      Number.isFinite(entryBid) && Number.isFinite(price)
        ? Math.max(0, Math.round(price - entryBid))
        : null;
    return {
      symbol: opportunity.symbol,
      ticker: opportunity.market.ticker,
      side: opportunity.side,
      priceCents: opportunity.priceCents,
      floorStrike: marketStrikePrice(opportunity.market) ?? opportunity.market.floor_strike,
      closeTime: opportunity.closeTime,
      engineProbability:
        (opportunity.signalSide || opportunity.side) === 'yes'
          ? opportunity.window.probabilityUp
          : opportunity.window.probabilityDown,
      engineConfidence: opportunity.window.confidence,
      strategy: 'model',
      modelWindowKey: opportunity.windowKey,
      modelDirection: opportunity.direction,
      modelEntryHeldProb:
        opportunity.side === 'yes'
          ? opportunity.window.probabilityUp
          : opportunity.window.probabilityDown,
      modelEntryNetDominance:
        opportunity.window.signalScore && Number.isFinite(Number(opportunity.window.signalScore.netDominance))
          ? opportunity.window.signalScore.netDominance
          : null,
      modelEntryBidCents: Number.isFinite(entryBid) ? entryBid : null,
      modelEntrySpreadCents: spread,
      uncertain: opportunity.uncertain,
      modelInverted: opportunity.invert === true,
      modelSignalSide: opportunity.signalSide || null,
      modelSignalEntryCents:
        opportunity.signalPriceCents != null ? opportunity.signalPriceCents : null,
    };
  }

  /**
   * MODEL AUTO: open several correlated tickets in one cycle (up to free slots).
   * Parallel top-N when multiple slots free so entries land nearly together.
   */
  async _openModelRanked(ranked) {
    if (!ranked || ranked.length === 0) return;
    const globalCd = checkModelGlobalPostExitCooldown({
      trades: this.ledger.trades,
      cooldownMs: modelGlobalPostExitCooldownMs(this.config),
      now: Date.now(),
    });
    if (!globalCd.ok) {
      this.lastDecision = globalCd.reason;
      return;
    }
    const slotsFree = () =>
      Math.max(0, this._effectiveMaxOpenPositions() - this.openTrades.length);
    if (slotsFree() <= 0) return;

    const tryOne = async (opp) => this._openPosition(this._modelOppToOpenArgs(opp));

    let i = 0;
    const parallelN = Math.min(slotsFree(), ranked.length, 3);
    if (parallelN >= 2) {
      const batch = ranked.slice(0, parallelN);
      const names = batch.map((o) => o.symbol).join(' + ');
      this.lastDecision = `MODEL multi-entry: trying ${names} together.`;
      this._logActivity(this.lastDecision, {
        kind: 'open',
        symbol: names,
        strategy: 'model',
      });
      await Promise.all(batch.map((opp) => tryOne(opp)));
      i = parallelN;
    }

    while (i < ranked.length && slotsFree() > 0) {
      await tryOne(ranked[i]);
      i += 1;
    }
  }

  /**
   * Settle mode: YES in primary band (default 85–94¢); NO from settleNoEntryMin
   * (default 80¢) through the same max so downs in the 80s qualify. Late fallback
   * still expands both sides toward settleLateEntryMinCents. Coinbase lean only
   * ranks YES vs NO when both are in band — it does not veto the priced side.
   */
  async _evaluateSymbolForSettle(symbol, predictions, { quiet = false, onSkip = null, onQuote = null } = {}) {
    const say = (msg) => {
      if (typeof onSkip === 'function') onSkip(symbol, msg);
      if (!quiet) this.lastDecision = msg;
    };
    if (!isKalshiTradeEnabled(symbol, this.config)) {
      say(`Waiting: ${symbol} is opted out of trading.`);
      return null;
    }
    if (this._hasOpenOnSymbol(symbol)) {
      say(`Waiting: already holding an open ${symbol} position (one open per coin).`);
      return null;
    }

    const assetPrediction = predictions && predictions[symbol];
    const engineReady = Boolean(
      assetPrediction &&
        assetPrediction.ready &&
        assetPrediction.windows &&
        typeof assetPrediction.windows === 'object'
    );

    const seriesTicker = SERIES_BY_SYMBOL[symbol];
    if (!seriesTicker) {
      say(`Waiting: ${symbol} has no supported Kalshi market.`);
      return null;
    }

    let market;
    try {
      market = await this._fetchLiveMarket(seriesTicker, 5000);
    } catch (err) {
      this.lastError = `Failed to fetch Kalshi market for ${seriesTicker}: ${err.message}`;
      console.error('[bot]', this.lastError);
      return null;
    }
    if (!market) {
      say(this._liveMarketWaitReason(symbol, seriesTicker));
      return null;
    }
    market = (await this._hydrateMarketQuote(market, 3500)) || normalizeMarketPrices(market);
    this._noteEngineStrike(symbol, market);
    if (this._hasOpenOnTicker(market.ticker)) {
      say(`Waiting: already holding an open position on ${market.ticker}.`);
      return null;
    }

    const now = Date.now();
    const closeTime = new Date(market.close_time).getTime();
    if (!Number.isFinite(closeTime) || closeTime <= now) {
      say(`Waiting: the available ${symbol} market is already closed.`);
      return null;
    }

    const minutesRemaining = Math.max(0.1, (closeTime - now) / 60000);
    const minMinutes = Number.isFinite(Number(this.config.settleMinMinutesToOpen))
      ? Number(this.config.settleMinMinutesToOpen)
      : 0.5;
    const maxMinutes = Number.isFinite(Number(this.config.settleMaxMinutesToOpen))
      ? Number(this.config.settleMaxMinutesToOpen)
      : 12;
    if (minMinutes > 0 && minutesRemaining < minMinutes) {
      say(`Waiting: ${symbol} settle — only ${minutesRemaining.toFixed(1)} min left (need ≥ ${minMinutes}).`);
      return null;
    }
    if (maxMinutes > 0 && minutesRemaining > maxMinutes) {
      say(
        `Waiting: ${symbol} settle — price may qualify, but ${minutesRemaining.toFixed(1)} min left ` +
          `(only opens with ≤ ${maxMinutes} min left).`
      );
      return null;
    }

    // Neutral placeholder when Coinbase isn't seeded — band/quote gates still apply.
    const window = engineReady
      ? this._pickWindow(assetPrediction.windows, minutesRemaining)
      : { probabilityUp: 50, probabilityDown: 50, confidence: 0 };
    if (!window) {
      say(`Waiting: ${symbol} has no usable prediction window for settle.`);
      return null;
    }

    const yesBid = Number(market.yes_bid);
    const yesAsk = Number(market.yes_ask);
    const yesAskOk = Number.isFinite(yesAsk) && yesAsk >= 1 && yesAsk <= 99;
    const yesBidOk =
      Number.isFinite(yesBid) && yesBid >= 1 && yesBid <= 99 && (!yesAskOk || yesBid <= yesAsk);
    // Prefer Kalshi's real NO ask; implied 100−yes_bid only when YES bid exists.
    let noAsk = Number(market.no_ask);
    if (!Number.isFinite(noAsk) || noAsk < 1 || noAsk > 99) {
      noAsk = yesBidOk ? 100 - yesBid : NaN;
    } else {
      noAsk = Math.round(noAsk);
    }
    const noAskOk = Number.isFinite(noAsk) && noAsk >= 1 && noAsk <= 99;
    if (!yesAskOk && !noAskOk) {
      this.lastError = `Skipped ${symbol}: Kalshi has no usable YES or NO ask yet.`;
      return null;
    }

    const primary = settleEntryBand(this.config);
    const noMin = settleNoEntryMinCents(this.config);
    if (typeof onQuote === 'function') {
      onQuote({
        symbol,
        yesAsk: yesAskOk ? yesAsk : null,
        noAsk: noAskOk ? noAsk : null,
        noInBand:
          noAskOk && noAsk >= noMin && noAsk <= primary.max && 100 - noAsk >= settleMinUpsideCents(this.config),
      });
    }
    // YES uses primary min; NO may start lower (default 80¢) so downs in the 80s qualify.
    // Fill-miss cool-down is per side — YES miss must not block NO (and vice versa).
    const collect = (yesMinCents, noMinCents, maxCents) => {
      const out = [];
      if (
        yesAskOk &&
        yesAsk >= yesMinCents &&
        yesAsk <= maxCents &&
        !this._hasRecentEntryMiss(symbol, closeTime, 'yes')
      ) {
        out.push({ side: 'yes', priceCents: yesAsk });
      }
      if (
        noAskOk &&
        noAsk >= noMinCents &&
        noAsk <= maxCents &&
        !this._hasRecentEntryMiss(symbol, closeTime, 'no')
      ) {
        out.push({ side: 'no', priceCents: noAsk });
      }
      return out;
    };

    const minUpside = settleMinUpsideCents(this.config);
    const richFloor = settleRichAskFloorCents(this.config);
    const profitableEnough = (c) => {
      const upside = 100 - c.priceCents;
      if (minUpside > 0 && upside < minUpside) return false;
      // Hard skip nearly-certain tickets — leave them; hunt other coins.
      if (c.priceCents >= richFloor) return false;
      return true;
    };

    let candidates = collect(primary.min, noMin, primary.max).filter(profitableEnough);
    let usedLateBand = false;
    if (candidates.length === 0) {
      const late = settleEffectiveEntryBand(this.config, minutesRemaining);
      if (late.late) {
        candidates = collect(late.min, late.min, late.max).filter(profitableEnough);
        usedLateBand = candidates.length > 0;
      }
    }
    if (candidates.length === 0) {
      const lateMins = settleLateEntryMinutes(this.config);
      const lateFloor = settleLateEntryMinCents(this.config);
      const inBandRaw = collect(primary.min, noMin, primary.max);
      const richOnly =
        inBandRaw.length > 0 && inBandRaw.every((c) => c.priceCents >= richFloor || (100 - c.priceCents) < minUpside);
      if (richOnly) {
        say(
          `Waiting: ${symbol} settle — ask too rich (need ≤${richFloor - 1}¢ and ≥${minUpside}¢ upside to 100; trying other cryptos).`
        );
        return null;
      }
      const lateHint =
        lateMins > 0 && minutesRemaining > lateMins
          ? ` (late fallback ${lateFloor}–${primary.max}¢ only with ≤ ${lateMins} min left)`
          : '';
      const yesLabel = yesAskOk ? `${yesAsk}¢` : 'n/a';
      const noLabel = noAskOk ? `${noAsk}¢` : 'n/a';
      say(
        `Waiting: ${symbol} settle — YES ask ${yesLabel} (need ${primary.min}–${primary.max}) / NO ask ${noLabel} (need ${noMin}–${primary.max})` +
          lateHint +
          '.'
      );
      return null;
    }

    // Prefer engine-agreed side when spot is ready; else highest ask under rich floor.
    // Lean is ranking only — do not hard-block. Kalshi can price NO in the 90s while
    // Coinbase still mildly leans YES (and vice versa); vetoing that skips real tickets.
    if (engineReady) {
      const favorsYes = window.probabilityUp >= window.probabilityDown;
      candidates.sort((a, b) => {
        const aAgree = (a.side === 'yes') === favorsYes ? 0 : 1;
        const bAgree = (b.side === 'yes') === favorsYes ? 0 : 1;
        if (aAgree !== bAgree) return aAgree - bAgree;
        return b.priceCents - a.priceCents;
      });
    } else {
      candidates.sort((a, b) => b.priceCents - a.priceCents);
    }
    const pick = candidates[0];

    // Don't open if we're already inside this entry's stale window — would
    // churn: enter → immediately green → settle_stale → reopen (see BTC 7:25–7:27).
    if (isSettleTieredExitsEnabled(this.config)) {
      const entryPlan = settleExitPlan(pick.priceCents);
      if (
        entryPlan.staleMinutesLeft != null &&
        minutesRemaining <= entryPlan.staleMinutesLeft
      ) {
        say(
          `Waiting: ${symbol} settle — ≤${entryPlan.staleMinutesLeft}m left (already in stale zone); not opening a churn entry.`
        );
        return null;
      }
    }

    const lastClosed = this._mostRecentClosedTrade();
    const staleSitOut = checkSameSideExitCooldown({
      lastTrade: lastClosed,
      exitReasons: ['settle_stale', 'take_profit', 'settle_stuck', 'settle_weak_switch'],
      forCandidateSymbol: symbol,
      forCandidateSide: pick.side,
      cooldownMs: Math.max(
        settlePostStaleSameSideCooldownMs(this.config),
        // Weak-switch uses the longer settle post-stop sit-out (default 2.5m).
        lastClosed && lastClosed.exitReason === 'settle_weak_switch'
          ? postStopSameSideCooldownMs(this.config)
          : 0
      ),
      now: Date.now(),
      reasonVerb: lastClosed && lastClosed.exitReason === 'settle_weak_switch' ? 'weak-switched' : 'banked',
    });
    if (!staleSitOut.ok) {
      say(staleSitOut.reason);
      return null;
    }

    const recoveryCheck = await this._stoppedCoinRecoveryGate(
      symbol,
      pick.side,
      pick.priceCents,
      window,
      predictions
    );
    if (!recoveryCheck.ok) {
      if (!quiet) this.lastDecision = recoveryCheck.reason;
      this._noteProtectionGate(recoveryCheck.reason, { fromSymbol: symbol });
      return null;
    }
    this._noteProtectionGate(null, { fromSymbol: symbol });

    return {
      symbol,
      market,
      window,
      side: pick.side,
      priceCents: pick.priceCents,
      closeTime,
      edge: 100 - pick.priceCents,
      // Mid-band asks first (under rich floor, default 94¢); among those prefer
      // higher ask + liquidity + tighter spread. 94¢+ only after nothing sweeter.
      rankScore:
        settleRankAskScore(pick.priceCents, {
          richFloorCents: settleRichAskFloorCents(this.config),
          usedLateBand,
        }) +
        liquidityPriority(symbol) +
        (yesAskOk && yesBidOk ? Math.max(0, 15 - Math.max(0, yesAsk - yesBid)) : 0),
      strategy: 'settle',
      settleLateEntry: usedLateBand,
      engineReady,
      // Quote snapshot so AUTO Decision/activity can prove NO was considered.
      settleYesAskCents: yesAskOk ? yesAsk : null,
      settleNoAskCents: noAskOk ? noAsk : null,
      settleNoInBand: candidates.some((c) => c.side === 'no'),
    };
  }

  async _rankSettleOpportunities(predictions, { preferOtherThan = null } = {}) {
    const cooling = this._entryMissCooldownSymbols();
    const allTradeable = tradeableKalshiSymbols(this.config);
    const noSpotLean = allTradeable.filter((sym) => !predictions[sym] || !predictions[sym].ready);
    // Settle scans every tradeable Kalshi series — Coinbase ready is optional (Kalshi-only).
    const candidates = allTradeable.filter((sym) => !this._hasOpenOnSymbol(sym));
    if (candidates.length === 0) {
      if (cooling.length) {
        this.lastDecision =
          `Waiting: fill-miss cool-down on ${cooling.join(', ')} — not pinging those sides (~${Math.round(ENTRY_MISS_COOLDOWN_MS / 1000)}s).`;
      } else {
        this.lastDecision = `Waiting: no tradeable coins available for settle scan.`;
      }
      return [];
    }
    const skips = [];
    const quoteSnaps = [];
    const shortSkip = (msg) => {
      const m = String(msg || '');
      if (/not ready|seeding/i.test(m)) return 'feed not ready';
      if (/too rich|not enough upside|≥\d+¢/i.test(m)) return 'ask too rich / thin upside';
      if (/stale zone|churn entry/i.test(m)) return 'already in stale window';
      if (/leans NO/i.test(m)) return 'engine leans NO';
      if (/leans YES/i.test(m)) return 'engine leans YES';
      // Keep YES/NO ask snapshot so activity/Decision prove NO was scanned.
      const yesNo = m.match(/YES ask\s+([^\s(]+).*NO ask\s+([^\s(]+)/i);
      if (yesNo) return `YES ${yesNo[1]} / NO ${yesNo[2]}`;
      if (/outside .+¢/i.test(m)) return 'ask outside band';
      if (/sit-out|same-side|weak-switched/i.test(m)) return 'same-side sit-out';
      if (/min left/i.test(m)) return 'time window gate';
      if (/no open Kalshi/i.test(m)) return 'no Kalshi market';
      return m.replace(/^Waiting:\s*/i, '').slice(0, 64);
    };
    const evaluations = [];
    for (const sym of candidates) {
      evaluations.push(
        await this._evaluateSymbolForSettle(sym, predictions, {
          quiet: true,
          onSkip: (s, msg) => {
            if (skips.length < 12) skips.push({ symbol: s, why: shortSkip(msg) });
          },
          onQuote: (q) => {
            if (quoteSnaps.length < 16) quoteSnaps.push(q);
          },
        })
      );
      if (
        this.client &&
        typeof this.client.isPublicRateLimited === 'function' &&
        this.client.isPublicRateLimited()
      ) {
        break;
      }
    }
    const valid = evaluations.filter(Boolean);
    const skipLine = skips.length
      ? skips.map((s) => `${s.symbol} (${s.why})`).join('; ')
      : '';
    const kalshiOnlyLine =
      noSpotLean.length > 0
        ? `Kalshi-only (no spot lean): ${noSpotLean.join(', ')}.`
        : '';
    const noInBandOpps = valid.filter((o) => o.side === 'no');
    const noQuotedInBand = quoteSnaps.filter((q) => q && q.noInBand);
    const noScanParts = [];
    if (noInBandOpps.length) {
      noScanParts.push(
        ...noInBandOpps.map((o) => `${o.symbol}@${o.priceCents}¢`)
      );
    } else if (noQuotedInBand.length) {
      noScanParts.push(
        ...noQuotedInBand.map((q) => `${q.symbol}@${q.noAsk}¢(gated)`)
      );
    }
    const noScanLine =
      noScanParts.length > 0
        ? `NO in-band: ${[...new Set(noScanParts)].join(', ')}.`
        : 'NO in-band: none.';
    // Persist a short activity breadcrumb so trade log isn't the only NO proof.
    this._noteSettleNoScan(noScanLine, noInBandOpps, noQuotedInBand);
    if (valid.length === 0) {
      this.lastDecision =
        `Settle scan: no entry. ${noScanLine}` +
        (kalshiOnlyLine ? ` ${kalshiOnlyLine}` : '') +
        (skipLine ? ` Skipped: ${skipLine}.` : '') +
        (cooling.length ? ` Cooling: ${cooling.join(', ')}.` : '');
      return [];
    }
    valid.sort((a, b) => {
      if (preferOtherThan) {
        const aPen = a.symbol === preferOtherThan ? 1 : 0;
        const bPen = b.symbol === preferOtherThan ? 1 : 0;
        if (aPen !== bPen) return aPen - bPen;
      }
      // Prefer coins with fewer recent fill-miss streaks, then ask score / liquidity.
      const aMiss = this._entryMissStreakFor(a.symbol, a.side);
      const bMiss = this._entryMissStreakFor(b.symbol, b.side);
      if (aMiss !== bMiss) return aMiss - bMiss;
      // When scores tie, prefer a Coinbase lean over pure Kalshi-only.
      const aLean = a.engineReady ? 1 : 0;
      const bLean = b.engineReady ? 1 : 0;
      if (aLean !== bLean) return bLean - aLean;
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return liquidityPriority(b.symbol) - liquidityPriority(a.symbol);
    });
    // Keep Decision honest when alts were in mind but lost to filters / ranking.
    const best = valid[0];
    const altNote = skipLine ? ` Also skipped: ${skipLine}.` : '';
    const feedNote = kalshiOnlyLine ? ` ${kalshiOnlyLine}` : '';
    const leanTag = best.engineReady ? '' : ' · no spot lean';
    this.lastDecision =
      `Settle scan: best ${best.symbol} ${String(best.side).toUpperCase()} @ ${best.priceCents}¢` +
      ` (${valid.length} mid-band${leanTag}). ${noScanLine}${feedNote}${altNote}`;
    return valid;
  }

  /**
   * Activity breadcrumb for settle NO scanning (deduped so polls don't spam).
   * When NO is in-band, log immediately; when none, log at most every ~2 min.
   */
  _noteSettleNoScan(noScanLine, noInBandOpps = [], noQuotedInBand = []) {
    const line = String(noScanLine || '').trim();
    if (!line) return;
    const now = Date.now();
    const hasNoOpp = Array.isArray(noInBandOpps) && noInBandOpps.length > 0;
    const hasNoQuoted = Array.isArray(noQuotedInBand) && noQuotedInBand.length > 0;
    const hasNo = hasNoOpp || hasNoQuoted;
    const key = hasNoOpp
      ? `no:${noInBandOpps.map((o) => `${o.symbol}@${o.priceCents}`).join(',')}`
      : hasNoQuoted
        ? `gated:${noQuotedInBand.map((q) => `${q.symbol}@${q.noAsk}`).join(',')}`
        : 'no:none';
    if (this._lastSettleNoScanKey === key && now - (this._lastSettleNoScanAt || 0) < (hasNo ? 45_000 : 120_000)) {
      return;
    }
    this._lastSettleNoScanKey = key;
    this._lastSettleNoScanAt = now;
    let msg;
    if (hasNoOpp) {
      msg = `Settle NO scan: ${noInBandOpps.map((o) => `${o.symbol} NO @ ${o.priceCents}¢`).join(', ')}`;
    } else if (hasNoQuoted) {
      msg =
        `Settle NO scan (priced in band, gated): ` +
        noQuotedInBand.map((q) => `${q.symbol} NO @ ${q.noAsk}¢`).join(', ');
    } else {
      msg = 'Settle NO scan: no NO asks in band (markets YES-priced / outside 80–94).';
    }
    this._logActivity(msg, {
      kind: 'settle-no-scan',
      side: hasNo ? 'no' : null,
      symbol: hasNoOpp ? noInBandOpps[0].symbol : hasNoQuoted ? noQuotedInBand[0].symbol : null,
    });
    this._persist();
  }

  async _findBestSettleOpportunity(predictions, { preferOtherThan = null } = {}) {
    const ranked = await this._rankSettleOpportunities(predictions, { preferOtherThan });
    return ranked[0] || null;
  }

  /**
   * AUTO mode: scores every Kalshi-tradeable symbol the engine is currently
   * predicting, and returns only the single best-ranked opportunity that
   * clears both thresholds — so instead of being locked into trading one
   * asset every 15 minutes whether or not it's a good setup, the bot only
   * acts on whichever market currently has the strongest, most trustworthy
   * edge across everything it's watching. Symbols that already have an open
   * position are skipped so a second slot diversifies instead of doubling up.
   *
   * After a stop-loss, `preferOtherThan` demotes that coin so other cryptos
   * are tried first; the stopped coin is only chosen if nothing else clears.
   */
  async _findBestOpportunity(predictions, { preferOtherThan = null } = {}) {
    const cooling = this._entryMissCooldownSymbols();
    const candidates = tradeableKalshiSymbols(this.config).filter(
      (sym) => predictions[sym] && !this._hasOpenOnSymbol(sym)
    );
    if (candidates.length === 0) {
      if (cooling.length) {
        this.lastDecision =
          `Waiting: recent fill misses on ${cooling.join(', ')} — cooling ~${Math.round(ENTRY_MISS_COOLDOWN_MS / 1000)}s before retry.`;
      }
      return null;
    }
    const evaluations = [];
    for (const sym of candidates) {
      evaluations.push(await this._evaluateSymbolForEdge(sym, predictions));
      if (
        this.client &&
        typeof this.client.isPublicRateLimited === 'function' &&
        this.client.isPublicRateLimited()
      ) {
        break;
      }
    }
    const valid = evaluations.filter(Boolean);
    if (valid.length === 0) return null;
    valid.sort((a, b) => {
      if (preferOtherThan) {
        const aPen = a.symbol === preferOtherThan ? 1 : 0;
        const bPen = b.symbol === preferOtherThan ? 1 : 0;
        if (aPen !== bPen) return aPen - bPen;
      }
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return liquidityPriority(b.symbol) - liquidityPriority(a.symbol);
    });
    return valid[0];
  }

  /**
   * Records a settled trade into its probability-at-entry bucket (50-59%,
   * 60-69%, etc, using the engine's own confidence-in-direction at the
   * moment the trade opened). This is deliberately NEVER rotated/cleared —
   * unlike the 12h ledger, calibration needs a large accumulated sample
   * (100-200+ trades per bucket) to actually mean anything, so it keeps
   * growing indefinitely across every 12h period.
   */
  _recordCalibration(trade) {
    if (this._inShadow || (trade && trade.shadow)) return;
    if (trade.engineProbability == null) return;
    const bucketKey = String(Math.min(90, Math.floor(trade.engineProbability / 10) * 10));
    if (!this.calibration.buckets[bucketKey]) {
      this.calibration.buckets[bucketKey] = { trades: 0, wins: 0 };
    }
    this.calibration.buckets[bucketKey].trades += 1;
    if (trade.pnlCents > 0) this.calibration.buckets[bucketKey].wins += 1;
    saveCalibration(this.calibration);
  }

  /**
   * Returns the probability-bucketed calibration table — trades, wins, and
   * win rate for each "probability at entry" range the engine has actually
   * traded, plus sample-size guidance so you're not guessing whether a
   * given probability threshold is meaningful in your own system.
   */
  calibrationReport() {
    const rows = Object.keys(this.calibration.buckets)
      .map(Number)
      .sort((a, b) => a - b)
      .map((bucketStart) => {
        const b = this.calibration.buckets[String(bucketStart)];
        return {
          range: `${bucketStart}-${bucketStart + 9}%`,
          trades: b.trades,
          wins: b.wins,
          winRatePct: b.trades ? +((b.wins / b.trades) * 100).toFixed(1) : null,
          sampleQuality:
            b.trades >= CALIBRATION_GUIDANCE.best
              ? 'best'
              : b.trades >= CALIBRATION_GUIDANCE.better
              ? 'good'
              : b.trades >= CALIBRATION_GUIDANCE.minToStartTrusting
              ? 'minimal'
              : 'too_few',
        };
      });
    return { guidance: CALIBRATION_GUIDANCE, buckets: rows };
  }

  getTradeLog({ limit = 100, offset = 0 } = {}) {
    const all = loadTradeLog();
    const start = Math.max(0, Number(offset) || 0);
    const take = Math.min(500, Math.max(1, Number(limit) || 100));
    return {
      total: all.length,
      trades: all.slice(start, start + take),
      path: TRADE_LOG_PATH,
    };
  }

  status() {
    const closed = this.ledger.trades.filter((t) => t.status === 'closed');
    const wins = closed.filter((t) => t.pnlCents > 0).length;

    // ledger.trades is newest-first. Current streak: consecutive wins
    // starting from the most recent closed trade. Longest streak: scan the
    // whole history in chronological order (oldest -> newest).
    let currentWinStreak = 0;
    for (const t of closed) {
      if (t.pnlCents > 0) currentWinStreak += 1;
      else break;
    }
    let longestWinStreak = 0;
    let running = 0;
    for (const t of [...closed].reverse()) {
      if (t.pnlCents > 0) {
        running += 1;
        longestWinStreak = Math.max(longestWinStreak, running);
      } else {
        running = 0;
      }
    }

    const capital = this._capitalStatus();
    const permanentLog = loadTradeLog();
    const now = Date.now();
    const overdueOpen = this.openTrades.filter((t) => {
      const d = this._tradeCloseDeadline(t);
      return Number.isFinite(d) && now >= d;
    });
    const hourlyPnl = buildHourlyPnlBuckets(permanentLog, { hours: 6, now });
    const settleWindowRec = this.getSettleWindowRecommendation({ now });
    return {
      mode: this.config.mode,
      isRunning: this.isRunning,
      runningSince: this.runningSince,
      config: this.config,
      lastError: this.lastError,
      lastDecision: this.lastDecision,
      openTrades: this.openTrades,
      overdueOpenCount: overdueOpen.length,
      recentTrades: this.ledger.trades.slice(0, 20),
      activityLog: (this.ledger.activityLog || []).slice(0, 40),
      // Permanent history (survives 12h ledger rotation). Newest first.
      tradeLog: permanentLog.slice(0, 50),
      tradeLogTotal: permanentLog.length,
      hourlyPnl,
      modelSetups: this._modelSetupScoreboard(),
      modelShadowBooks: {
        enabled: this._modelShadowBooksEnabled(),
      },
      modelAutoSwitch: {
        enabled: this._modelAutoSwitchEnabled(),
        lowAvailDollars:
          Number(this.config.modelAutoSwitchLowAvailDollars) || MODEL_AUTO_SWITCH_LOW_AVAIL_DEFAULT,
        minLeadDollars:
          Number(this.config.modelAutoSwitchMinLeadDollars) || MODEL_AUTO_SWITCH_MIN_LEAD_DEFAULT,
        cooldownMinutes:
          Number(this.config.modelAutoSwitchCooldownMinutes) || MODEL_AUTO_SWITCH_COOLDOWN_MINUTES_DEFAULT,
        lastSwitchAt: this._lastAutoSetupSwitchAt || null,
        note: this._lastAutoSwitchNote || null,
      },
      settleWindowRec,
      stats: {
        totalAttempts: this.ledger.trades.length, // current period open + closed
        totalTrades: closed.length, // settled/closed trades only (current period)
        wins,
        profitableExits: wins,
        losses: closed.length - wins,
        winRatePct: closed.length ? +((wins / closed.length) * 100).toFixed(1) : null,
        currentWinStreak,
        longestWinStreak,
        netPnlCents: closed.reduce((sum, t) => sum + (t.pnlCents || 0), 0),
        reserveCents: this.ledger.reserveCents || 0,
        insuranceCents: this.ledger.insuranceCents || 0,
        insuranceDepositedCents: this.ledger.insuranceDepositedCents || 0,
        lifetimeTrades: permanentLog.length,
        hourlyPnl,
      },
      capital: {
        ...capital,
        liveAvailableCents: Number.isFinite(this.liveBalanceCents) ? this.liveBalanceCents : null,
        livePortfolioValueCents: Number.isFinite(this.livePortfolioValueCents) ? this.livePortfolioValueCents : null,
        liveBalanceUpdatedAt: this.liveBalanceUpdatedAt,
      },
    };
  }
}

module.exports = {
  TradingBot,
  SERIES_BY_SYMBOL,
  pickLiveOpenMarket,
  DISABLED_TRADE_SYMBOLS,
  OPTIONAL_TRADE_SYMBOLS,
  DEFAULT_AUTO_TRADE_SYMBOLS,
  MODEL_SETUPS,
  resolveAutoTradeSymbols,
  scoreModelSetupsAgainstLog,
  modelSetupById,
  modelSetupConfigPatch,
  isKalshiTradeEnabled,
  tradeableKalshiSymbols,
  symbolsNeedingKalshiTargets,
  symbolsNeedingEngineCompute,
  liquidityPriority,
  LIQUIDITY_PRIORITY_BY_SYMBOL,
  settleEntryBand,
  settleNoEntryMinCents,
  settleSideEntryBand,
  settleLateEntryMinutes,
  settleLateEntryMinCents,
  settleEffectiveEntryBand,
  isSettleEntryPriceCents,
  isSettleStrategyMode,
  isSettleTrade,
  isModelStrategyMode,
  isModelTrade,
  isModelInvertSide,
  modelSignalSideFromDirection,
  flipKalshiSide,
  modelSignalDropCents,
  pickModelWindowKey,
  pickModelWindow,
  modelWindowDirection,
  modelDirectionAgainstHeld,
  modelLiveLeanAgainstHeld,
  modelLiveLeanStillFavors,
  modelLiveProbNotWithUs,
  modelSignalTurningAgainst,
  modelSignalDominanceMin,
  modelSignalScoreEnabled,
  MODEL_SIGNAL_DOMINANCE_MIN_DEFAULT,
  modelProbDriftAgainst,
  modelProbDriftPts,
  modelEngineTurningAgainst,
  modelEngineHardAgainst,
  modelEntryDumpRisk,
  modelMinEntryLeanPct,
  modelMinEntryLeanGate,
  MODEL_MIN_ENTRY_LEAN_PCT_DEFAULT,
  modelEngineClearlyWithUs,
  modelNearFlatCents,
  modelBreakevenExitAllowed,
  modelLeanStaleForScratch,
  modelStagnationExitReady,
  modelRapidAdverseExitReady,
  modelBeChaseExitReady,
  modelBeChaseUpwardEvidence,
  modelUpwardMomentumEvidence,
  modelStallBankReady,
  modelBeChaseSeconds,
  modelPeakProgressCents,
  MODEL_STAGNATION_SECONDS_DEFAULT,
  MODEL_RAPID_ADVERSE_CENTS_DEFAULT,
  modelDirectionSupportsHold,
  windowConsensusSupportsSide,
  modelCalibrationEntryGate,
  modelPriceAllowed,
  modelLowAskConvictionGate,
  modelKalshiFavoriteCents,
  modelKalshiFavoriteSide,
  modelKalshiFavoriteGate,
  MODEL_KALSHI_FAVORITE_CENTS_DEFAULT,
  modelLowAskMinConfidence,
  MODEL_MIN_ENTRY_DEFAULT_CENTS,
  MODEL_LOW_ASK_MIN_CONFIDENCE_DEFAULT,
  MODEL_LOW_ASK_CEILING_CENTS_DEFAULT,
  MODEL_LOW_ASK_LIVE_FAVOR_DEFAULT,
  MODEL_LOW_ASK_HELD_PROB_DEFAULT,
  checkModelPostExitCooldown,
  checkModelGlobalPostExitCooldown,
  modelMinHoldMs,
  modelPostExitCooldownMs,
  modelGlobalPostExitCooldownMs,
  modelPostLeanStopCooldownMs,
  modelLeanAgainstBeMs,
  modelOpenGraceMs,
  modelOnPaceBelowBarrier,
  modelShouldLeanStopRed,
  modelLeanStopBarrierCents,
  modelLeanStopPaceDrawdownPct,
  modelLeanStopPaceMinSampleMs,
  modelLeanStopMinAdverseCents,
  modelLeanStopPaceArmCents,
  MODEL_LEAN_STOP_PACE_DRAWDOWN_PCT_DEFAULT,
  MODEL_LEAN_STOP_PACE_MIN_SAMPLE_MS_DEFAULT,
  modelMinTpCents,
  modelTakeProfitMeetsFloor,
  modelBankGreenCents,
  modelNearTargetBankCents,
  modelTrailArmCents,
  modelSettleCloseMinutes,
  modelLateBarrierMinutes,
  modelPreCloseForceMinutes,
  modelLateExtendMinConfidence,
  modelLateExtendOk,
  modelMomentumStallMs,
  modelMomentumPullbackCents,
  modelDumpPullbackCents,
  modelFastRedCents,
  modelMaxEntrySpreadCents,
  modelMaxEntrySpreadCentsForSymbol,
  MODEL_DUMP_PULLBACK_CENTS_DEFAULT,
  MODEL_FAST_RED_CENTS_DEFAULT,
  MODEL_FAST_RED_MIN_HOLD_MS_DEFAULT,
  MODEL_MAX_ENTRY_SPREAD_CENTS_DEFAULT,
  MODEL_POST_LEAN_STOP_COOLDOWN_MS_DEFAULT,
  MODEL_OPEN_GRACE_MS_DEFAULT,
  MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT,
  MODEL_PROB_DRIFT_PTS_DEFAULT,
  modelLowPriceMaxCents,
  modelLowPriceStakeQuarters,
  modelLowPriceStakeFraction,
  modelLowPriceStakeLabel,
  modelIsHalfStakeAsk,
  MODEL_HALF_STAKE_UNDER_CENTS,
  summarizeLedgerCapital,
  rebuildLedgerSkimFromTrades,
  MODEL_AUTO_SWITCH_LOW_AVAIL_DEFAULT,
  MODEL_AUTO_SWITCH_MIN_LEAD_DEFAULT,
  MODEL_AUTO_SWITCH_COOLDOWN_MINUTES_DEFAULT,
  isForceRetryExitReason,
  PAPER_RESET_KEEP_SAMPLES,
  pickRecentClosedTradeSamples,
  rebuildCalibrationFromTrades,
  modelConfirmCrossCents,
  modelConfirmMaxExtensionCents,
  modelConfirmMinContinueCents,
  MODEL_CONFIRM_CROSS_CENTS_DEFAULT,
  MODEL_CONFIRM_MAX_EXTENSION_CENTS_DEFAULT,
  MODEL_CONFIRM_MIN_CONTINUE_CENTS_DEFAULT,
  modelLiveLeanMarginPct,
  modelExtremeLiveLeanExitPct,
  modelExtremeLiveLeanHit,
  modelExtremeLeanAgainstHeld,
  modelExtremeLeanWithUs,
  MODEL_EXTREME_LIVE_LEAN_EXIT_PCT_DEFAULT,
  modelHeldSideProb,
  modelLeanDecayCutState,
  modelLeanDecayPeakMin,
  modelLeanDecayFloor,
  modelLeanDecayDropPts,
  MODEL_LEAN_DECAY_PEAK_MIN_DEFAULT,
  MODEL_LEAN_DECAY_FLOOR_DEFAULT,
  MODEL_LEAN_DECAY_DROP_PTS_DEFAULT,
  modelEntryLiveLeanMarginPct,
  modelSoftLeanMarginPct,
  modelTrailCents,
  modelMaxAdverseCents,
  modelHardAdverseCents,
  modelMaxLossCents,
  modelEffectiveMaxLossCents,
  modelHardStopFloorCents,
  modelMinRoomToFloorCents,
  modelEntryRoomToFloorGate,
  modelRichStopFloorCents,
  modelAdverseExitFillCents,
  modelRichAskCents,
  MODEL_MAX_LOSS_CENTS_DEFAULT,
  MODEL_RICH_STOP_FLOOR_CENTS_DEFAULT,
  MODEL_HARD_STOP_FLOOR_CENTS_DEFAULT,
  MODEL_MIN_ROOM_TO_FLOOR_CENTS_DEFAULT,
  MODEL_MID_RICH_STOP_FLOOR_CENTS_DEFAULT,
  MODEL_RICH_STOP_ENTRY_MIN_CENTS_DEFAULT,
  MODEL_RICH_STOP_MIN_CONFIDENCE_DEFAULT,
  modelSideSwitchConfirmMs,
  modelSideSwitchConfirmTicks,
  MODEL_LIVE_LEAN_MARGIN_DEFAULT,
  MODEL_ENTRY_LIVE_LEAN_MARGIN_DEFAULT,
  MODEL_RED_GIVEUP_MS_DEFAULT,
  MODEL_SOFT_BANK_MS_DEFAULT,
  MODEL_MIN_HOLD_MS_DEFAULT,
  MODEL_POST_EXIT_COOLDOWN_MS_DEFAULT,
  MODEL_GLOBAL_POST_EXIT_COOLDOWN_MS_DEFAULT,
  MODEL_LEAN_AGAINST_BE_MS_DEFAULT,
  MODEL_MIN_TP_CENTS_DEFAULT,
  MODEL_BANK_GREEN_CENTS_DEFAULT,
  MODEL_NEAR_TARGET_BANK_CENTS_DEFAULT,
  MODEL_TRAIL_ARM_CENTS_DEFAULT,
  MODEL_SETTLE_CLOSE_MINUTES_DEFAULT,
  MODEL_LATE_BARRIER_MINUTES_DEFAULT,
  MODEL_PRE_CLOSE_FORCE_MINUTES_DEFAULT,
  MODEL_LATE_EXTEND_MIN_CONFIDENCE_DEFAULT,
  MODEL_MOMENTUM_STALL_MS_DEFAULT,
  MODEL_MOMENTUM_PULLBACK_CENTS_DEFAULT,
  MODEL_LOW_PRICE_STAKE_QUARTERS_DEFAULT,
  MODEL_TRAIL_CENTS_DEFAULT,
  MODEL_MAX_ADVERSE_CENTS_DEFAULT,
  MODEL_HARD_ADVERSE_CENTS_DEFAULT,
  MODEL_MIN_CONFIDENCE_DEFAULT,
  MODEL_SOFT_LEAN_MARGIN_DEFAULT,
  MODEL_PERFECT_MIN_ENTRY_DEFAULT_CENTS,
  MODEL_PERFECT_CONFIDENCE_DEFAULT,
  MODEL_PERFECT_LEAN_DEFAULT,
  MODEL_MIN_MINUTES_TO_OPEN_DEFAULT,
  isSettleTieredExitsEnabled,
  settleExitPlan,
  settleExitTiersForDashboard,
  SETTLE_EXIT_TIERS,
  settleStuckHoldMs,
  settleRichAskFloorCents,
  settleRankAskScore,
  settleMinUpsideCents,
  stopRecoveryCentsRequired,
  stopRecoveryMaxAgeMs,
  peerCascadeMaxAgeMs,
  postStopMaxOneAgeMs,
  isPostStopMaxOneActive,
  postStopSameSideCooldownMs,
  checkPostStopSameSideCooldown,
  checkSameSideExitCooldown,
  settlePostStaleSameSideCooldownMs,
  SETTLE_STALE_MIN_HOLD_MS,
  SETTLE_TOUCHED90_HOLD_MINUTES,
  SETTLE_WEAK_CONFIRM_CENTS,
  SETTLE_STUCK_HOLD_DEFAULT_MINUTES,
  stopTradeReferenceMs,
  tradeWindowCloseMs,
  isPostStopRecoverySessionExpired,
  checkPostStopRecovery,
  checkPostStopPeerCascade,
  applyProfitBuckets,
  insuranceArmFloorCents,
  insuranceOverflowCents,
  syncInsuranceReady,
  normalizeInsuranceThresholds,
  INSURANCE_ARM_DEFAULT,
  INSURANCE_FLOOR_DEFAULT,
  INSURANCE_OVERFLOW_DEFAULT,
  stopVerdictLabel,
  classifyStopVerdictFromResult,
  classifyStopVerdictFromBids,
  buildHourlyPnlBuckets,
  recommendSettleOpenWindow,
  strategyModeForLight,
  scoreSymbolFifteenMinuteWindow,
  scoreMarketRegime,
  EDGE_MAX_ENTRY_DEFAULT_CENTS,
  MODEL_MAX_ENTRY_DEFAULT_CENTS,
  MODEL_MIN_ENTRY_DEFAULT_CENTS,
  EDGE_PRE_CLOSE_SMALL_LOSS_DEFAULT_CENTS,
  EDGE_PRE_CLOSE_MINUTES_DEFAULT,
  EDGE_BREAKEVEN_AFTER_MINUTES_DEFAULT,
  MARKET_REGIME_WINDOW_MINUTES,
};
