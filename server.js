'use strict';
const SERVER_START_TIME = Date.now();
const path = require("path");
const fs = require("fs");
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { CandleSeries, fetchHistoricalRange } = require('./candles');
const { OrderBook } = require('./orderBook');
const { CoinbaseFeed } = require('./coinbaseFeed');
const { buildPredictions } = require('./prediction');
const { PredictionTracker } = require('./tracker');
const { SignalAccumulatorManager } = require('./signalAccumulator');
const { KalshiClient } = require('./kalshiClient');
const { TradingBot, SERIES_BY_SYMBOL, tradeableKalshiSymbols, symbolsNeedingEngineCompute, settleExitTiersForDashboard } = require('./bot');
const { backtestSymbol, backtestWithSettings, huntBestSettings } = require('./backtest');
const { DATA_DIR, DATA_DIR_EPHEMERAL, DATA_DIR_FROM_ENV, dataPath, ensureDataDir, ARCHIVE_RETENTION_DAYS, writeJsonAtomic } = require('./paths');
const APP_VERSION = require('./package.json').version;

ensureDataDir();

const tracker = new PredictionTracker();

// Half-lives roughly scaled to each window's own horizon: the 0-5 min
// window forgets old signal pressure fastest (little time left for a stale
// reading to matter), the 10-15 min window holds onto it longest.
const signalAccumulatorManager = new SignalAccumulatorManager({
  w5: 2 * 60 * 1000,
  w10: 4 * 60 * 1000,
  w15: 7 * 60 * 1000,
});

// ---------- Kalshi bot setup ----------
// SAFETY: two separate switches must both be set for real orders to ever be
// placed. Missing either one (or misconfigured credentials) means the bot
// runs in paper mode against live Kalshi prices — no real money moves.
const KALSHI_ENABLED = (process.env.KALSHI_ENABLED || 'false').toLowerCase() === 'true';
const LIVE_TRADING_REQUESTED = (process.env.KALSHI_LIVE_TRADING || 'false').toLowerCase() === 'true';
const LIVE_TRADING_CONFIRMED = process.env.KALSHI_LIVE_TRADING_CONFIRM === 'I_UNDERSTAND_THE_RISK';

const kalshiClient = new KalshiClient({
  baseUrl: process.env.KALSHI_BASE_URL,
  keyId: process.env.KALSHI_API_KEY_ID,
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
});

// Lets Kalshi API credentials be entered from the dashboard instead of only
// via env vars/a key file on disk. Stored in plaintext in DATA_DIR
// alongside the trading ledger — reasonable for a personal, single-user
// deployment, but worth knowing: anyone with server disk access could read
// it. Never sent back to the client once saved — only whether it's set.
const CREDENTIALS_PATH = dataPath('kalshi-credentials.json');

function loadSavedCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      kalshiClient.setCredentials(saved);
      console.log('[kalshi] loaded previously-saved API credentials from disk');
    }
  } catch (err) {
    console.error('[kalshi] failed to load saved credentials:', err.message);
  }
}
loadSavedCredentials();

if (kalshiClient.hasCredentials) {
  setTimeout(() => {
    kalshiClient.syncAccountLimits({ force: true }).catch((err) => {
      console.warn('[kalshi] account limits sync deferred:', err && err.message ? err.message : err);
    });
  }, 12_000);
}

function saveCredentials({ keyId, privateKeyPem }) {
  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ keyId, privateKeyPem }, null, 2));
}

const wantsLive = LIVE_TRADING_REQUESTED && LIVE_TRADING_CONFIRMED && kalshiClient.hasCredentials;
if (LIVE_TRADING_REQUESTED && !wantsLive) {
  console.warn(
    '[bot] KALSHI_LIVE_TRADING=true but live trading is NOT active — ' +
      'requires KALSHI_LIVE_TRADING_CONFIRM=I_UNDERSTAND_THE_RISK and valid API credentials. Running in paper mode.'
  );
}

const bot = KALSHI_ENABLED
  ? new TradingBot({
      kalshiClient,
      config: {
        symbol: (process.env.KALSHI_SYMBOL || 'AUTO').toUpperCase(),
        strategyMode: (() => {
          const m = (process.env.KALSHI_STRATEGY_MODE || 'model').toLowerCase();
          return m === 'edge' || m === 'settle' ? m : 'model';
        })(),
        edgeThresholdPct: parseFloat(process.env.KALSHI_EDGE_THRESHOLD_PCT || '1'),
        minConfidence: parseFloat(process.env.KALSHI_MIN_CONFIDENCE || '55'),
        stopLossCents: parseInt(process.env.KALSHI_STOP_LOSS_CENTS || '23', 10),
        takeProfitCents: parseInt(process.env.KALSHI_TAKE_PROFIT_CENTS || '15', 10),
        minEntryCents: parseInt(process.env.KALSHI_MIN_ENTRY_CENTS || '40', 10),
        minMinutesToOpen: parseFloat(process.env.KALSHI_MIN_MINUTES_TO_OPEN || '3'),
        modelMinConfidence: parseFloat(process.env.KALSHI_MODEL_MIN_CONFIDENCE || '41'),
        stopRecoveryCents: parseInt(process.env.KALSHI_STOP_RECOVERY_CENTS || '6', 10),
        stopRecoveryMaxMinutes: parseFloat(process.env.KALSHI_STOP_RECOVERY_MAX_MINUTES || '15'),
        peerCascadeMaxMinutes: parseFloat(process.env.KALSHI_PEER_CASCADE_MAX_MINUTES || '3'),
        postStopMaxOneMinutes: parseFloat(process.env.KALSHI_POST_STOP_MAX_ONE_MINUTES || '1.5'),
        postStopSameSideCooldownMinutes: parseFloat(
          process.env.KALSHI_POST_STOP_SAME_SIDE_COOLDOWN_MINUTES || '2'
        ),
        settleEntryMinCents: parseFloat(process.env.KALSHI_SETTLE_ENTRY_MIN_CENTS || '80'),
        settleEntryMaxCents: parseFloat(process.env.KALSHI_SETTLE_ENTRY_MAX_CENTS || '94'),
        settleNoEntryMinCents: parseFloat(process.env.KALSHI_SETTLE_NO_ENTRY_MIN_CENTS || '80'),
        settleStopLossCents: parseInt(process.env.KALSHI_SETTLE_STOP_LOSS_CENTS || '50', 10),
        settleMaxMinutesToOpen: parseFloat(process.env.KALSHI_SETTLE_MAX_MINUTES_TO_OPEN || '8.5'),
        settlePostStopSameSideCooldownMinutes: parseFloat(
          process.env.KALSHI_SETTLE_POST_STOP_SAME_SIDE_COOLDOWN_MINUTES || '2.5'
        ),
        settleStuckHoldMinutes: parseFloat(process.env.KALSHI_SETTLE_STUCK_HOLD_MINUTES || '3'),
        settleLateEntryMinutes: parseFloat(process.env.KALSHI_SETTLE_LATE_ENTRY_MINUTES || '2.5'),
        settleLateEntryMinCents: parseFloat(process.env.KALSHI_SETTLE_LATE_ENTRY_MIN_CENTS || '70'),
        settleTieredExits: process.env.KALSHI_SETTLE_TIERED_EXITS || 'on',
        maxEntryCents: parseInt(process.env.KALSHI_MAX_ENTRY_CENTS || '95', 10),
        edgePreCloseSmallLossCents: parseInt(
          process.env.KALSHI_EDGE_PRE_CLOSE_SMALL_LOSS_CENTS || '75',
          10
        ),
        edgePreCloseMinutes: parseFloat(process.env.KALSHI_EDGE_PRE_CLOSE_MINUTES || '5'),
        edgeBreakevenAfterMinutes: parseFloat(
          process.env.KALSHI_EDGE_BREAKEVEN_AFTER_MINUTES || '3'
        ),
        stakeDollars: parseFloat(process.env.KALSHI_STAKE_DOLLARS || '3'),
        maxOpenPositions: parseInt(process.env.KALSHI_MAX_OPEN_POSITIONS || '3', 10),
        skimMode: process.env.KALSHI_SKIM_MODE || 'insurance',
        skimFixedDollars: parseFloat(process.env.KALSHI_SKIM_FIXED_DOLLARS || '5'),
        skimPercent: parseFloat(process.env.KALSHI_SKIM_PERCENT || '50'),
        insuranceCapDollars: parseFloat(process.env.KALSHI_INSURANCE_CAP_DOLLARS || '10'),
        insuranceFloorDollars: parseFloat(process.env.KALSHI_INSURANCE_FLOOR_DOLLARS || '6'),
        insuranceOverflowDollars: parseFloat(process.env.KALSHI_INSURANCE_OVERFLOW_DOLLARS || '15'),
        paperStartingBalanceDollars: parseFloat(process.env.KALSHI_PAPER_STARTING_BALANCE || '100'),
        mode: wantsLive ? 'live' : 'paper',
        // Fixed ceiling for this process's lifetime, set only from the
        // server-side env vars — never editable from the dashboard. The
        // dashboard can pause/resume between paper and live at runtime,
        // but can never raise this ceiling; if it's false, live mode is
        // completely unreachable no matter what the UI requests.
        liveAuthorized: wantsLive,
      },
    })
  : null;

if (KALSHI_ENABLED) {
  console.log(`[bot] Kalshi bot enabled in ${wantsLive ? 'LIVE' : 'paper'} mode, trading ${(process.env.KALSHI_SYMBOL || 'AUTO').toUpperCase()}, strategy ${(process.env.KALSHI_STRATEGY_MODE || 'model').toLowerCase()}`);
}

const PORT = parseInt(process.env.PORT || '4000', 10);
const PRODUCTS = (process.env.PRODUCTS || 'BTC-USD,XRP-USD,ETH-USD,SOL-USD,DOGE-USD,BNB-USD,NEAR-USD,HYPE-USD,ZEC-USD').split(',').map((s) => s.trim());
const COMPUTE_INTERVAL_MS = parseInt(process.env.COMPUTE_INTERVAL_MS || '5000', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const SYMBOL_OF = {
  'BTC-USD': 'BTC',
  'XRP-USD': 'XRP',
  'ETH-USD': 'ETH',
  'SOL-USD': 'SOL',
  'DOGE-USD': 'DOGE',
  'BNB-USD': 'BNB',
  'NEAR-USD': 'NEAR',
  'HYPE-USD': 'HYPE',
  'ZEC-USD': 'ZEC',
};

const state = {}; // e.g. state.BTC = { productId, series, book, lastTradeAt }
for (const productId of PRODUCTS) {
  const symbol = SYMBOL_OF[productId] || productId;
  state[symbol] = {
    productId,
    series: new CandleSeries(productId),
    book: new OrderBook(productId),
    lastTradeAt: null,
    feedStatus: 'connecting',
  };
}

// Strategy light uses live ~15m Coinbase candles (volatile/chop → edge, calm one-sided → settle).
if (bot) {
  bot.getMarketCandles = () => {
    const out = {};
    for (const [sym, s] of Object.entries(state)) {
      if (s && s.series && Array.isArray(s.series.candles)) {
        out[sym] = s.series.candles;
      }
    }
    return out;
  };
}

let latestPrediction = { ready: false, message: 'Seeding historical data, please wait…' };
let lastComputeError = null;

async function seedAll() {
  await Promise.all(Object.values(state).map((s) => s.series.seed()));
}

function wireFeed() {
  const feed = new CoinbaseFeed(PRODUCTS);

  feed.on('connected', () => {
    console.log('[feed] connected to Coinbase WebSocket');
    for (const s of Object.values(state)) s.feedStatus = 'live';
  });

  feed.on('disconnected', () => {
    console.warn('[feed] disconnected — will retry with backoff');
    for (const s of Object.values(state)) s.feedStatus = 'reconnecting';
  });

  feed.on('error', (err) => {
    console.error('[feed] error:', err.message);
  });

  feed.on('trade', (trade) => {
    const symbol = SYMBOL_OF[trade.productId] || trade.productId;
    const s = state[symbol];
    if (!s) return;
    s.series.addTrade(trade.price, trade.size, trade.time);
    s.lastTradeAt = trade.time;
  });

  feed.on('l2snapshot', (snap) => {
    const symbol = SYMBOL_OF[snap.productId] || snap.productId;
    const s = state[symbol];
    if (!s) return;
    s.book.loadSnapshot(snap.bids, snap.asks);
  });

  feed.on('l2update', (upd) => {
    const symbol = SYMBOL_OF[upd.productId] || upd.productId;
    const s = state[symbol];
    if (!s) return;
    for (const [side, price, size] of upd.changes) {
      s.book.applyChange(side, price, size);
    }
  });

  feed.connect();
  return feed;
}

const lastManualStrikeMeta = Object.create(null);
const MANUAL_STRIKES_PATH = dataPath('manual-strikes.json');
const MANUAL_STRIKE_TTL_MS = 15 * 60 * 1000;

function loadManualStrikes() {
  try {
    if (fs.existsSync(MANUAL_STRIKES_PATH)) {
      const raw = JSON.parse(fs.readFileSync(MANUAL_STRIKES_PATH, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    }
  } catch (err) {
    console.warn('[manual-strike] failed to load manual strikes:', err.message);
  }
  return Object.create(null);
}

let manualStrikes = loadManualStrikes();

function saveManualStrikes() {
  try {
    writeJsonAtomic(MANUAL_STRIKES_PATH, manualStrikes);
  } catch (err) {
    console.warn('[manual-strike] failed to save manual strikes:', err.message);
  }
}

function pruneManualStrikes(now = Date.now()) {
  let changed = false;
  for (const [symbol, row] of Object.entries(manualStrikes)) {
    const price = Number(row && row.price);
    const expires = Number(row && row.expiresAt);
    if (!Number.isFinite(price) || price <= 0 || (Number.isFinite(expires) && expires <= now)) {
      delete manualStrikes[symbol];
      changed = true;
    }
  }
  if (changed) saveManualStrikes();
}

function applyManualStrikes(targets, now = Date.now()) {
  pruneManualStrikes(now);
  const out = { ...targets };
  const fifteen = 15 * 60 * 1000;
  for (const [symbol, row] of Object.entries(manualStrikes)) {
    const price = Number(row && row.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const existing = out[symbol];
    const bucketStart = Math.floor(now / fifteen) * fifteen;
    out[symbol] = {
      price,
      closeTime:
        (existing && Number(existing.closeTime)) ||
        Number(row.closeTime) ||
        bucketStart + fifteen,
      ticker:
        (existing && existing.ticker) ||
        row.ticker ||
        `FALLBACK-${symbol}-${bucketStart}`,
      source: 'manual',
    };
  }
  return out;
}

// Intentionally avoid an extra Kalshi list HTTP here: the bot caches strikes
// from markets it already fetches for trading, and manual strikes override.
function dashboardStrikeTargets() {
  const fromBot =
    bot && typeof bot.getEngineStrikeTargets === 'function' ? bot.getEngineStrikeTargets() : {};
  return applyManualStrikes(fromBot);
}

function activeEngineSymbols() {
  // Prediction-only (no bot): keep full dashboard compute.
  if (!bot) return Object.keys(state);
  const want = new Set(
    symbolsNeedingEngineCompute({
      config: bot.config,
      openTrades: bot.openTrades,
    })
  );
  return Object.keys(state).filter((s) => want.has(s));
}

function pausedEngineStub(symbol, prevAsset) {
  const s = state[symbol];
  const price =
    (s && s.series && typeof s.series.latestClose === 'function' && s.series.latestClose()) ||
    (prevAsset && Number(prevAsset.price)) ||
    null;
  return {
    ready: false,
    enginePaused: true,
    price: Number.isFinite(Number(price)) ? Number(price) : null,
    message: 'Engine paused — not in AUTO / no open position',
  };
}

let recomputeInFlight = false;

async function recompute() {
  if (recomputeInFlight) return; // guard against overlapping runs if a cycle takes longer than the interval
  recomputeInFlight = true;
  try {
    const active = activeEngineSymbols();
    const input = {};
    for (const symbol of active) {
      const s = state[symbol];
      if (!s) continue;
      input[symbol] = { series: s.series, book: s.book };
    }

    const kalshiTargets = dashboardStrikeTargets();
    const result = buildPredictions(input, kalshiTargets, signalAccumulatorManager, {
      calibration: tracker.calibration,
    });
    result.engineCalibration = tracker.calibration;
    result.feedStatus = Object.fromEntries(
      Object.entries(state).map(([sym, s]) => [sym, s.feedStatus])
    );

    // Idle coins: stub so the dashboard still lists them, without running
    // indicators / Kalshi clocks / tracker updates.
    const prev = latestPrediction && typeof latestPrediction === 'object' ? latestPrediction : {};
    for (const symbol of Object.keys(state)) {
      if (result[symbol]) continue;
      result[symbol] = pausedEngineStub(symbol, prev[symbol]);
    }

    // Feed each ready symbol through the tracker once — all three windows
    // (0-5/5-10/10-15 min) share the same target price and the same real
    // Kalshi clock, rather than each running its own independent timer.
    const now = Date.now();
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    for (const [symbol, assetResult] of Object.entries(result)) {
      if (!assetResult || !assetResult.ready || !assetResult.windows) continue;
      if (assetResult.enginePaused) continue;

      // Graceful fallback when no live Kalshi market was found: synthesize a
      // ticker/close time that still rotates every real 15 minutes (aligned
      // to the wall clock), so tracking still works, just without being
      // phase-matched to Kalshi's actual window boundaries.
      let ticker = assetResult.kalshiTicker;
      let closeTime = assetResult.targetCloseTime;
      if (!ticker || !closeTime) {
        const bucketStart = Math.floor(now / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
        ticker = `FALLBACK-${symbol}-${bucketStart}`;
        closeTime = bucketStart + FIFTEEN_MIN_MS;
        // Keep the asset-level close time in sync with whichever clock is
        // actually driving the windows, so the big top-level countdown never
        // shows blank while the per-window countdowns underneath are ticking.
        assetResult.targetCloseTime = closeTime;
      }

      const trackerOutput = tracker.update(symbol, {
        ticker,
        targetPrice: assetResult.targetPrice,
        closeTime,
        currentPrice: assetResult.price,
        windows: assetResult.windows,
        now,
      });

      for (const windowKey of Object.keys(assetResult.windows)) {
        const w = assetResult.windows[windowKey];
        const t = trackerOutput[windowKey];
        w.tracking = t.tracking;
        w.lastResult = t.lastResult;
        w.accuracy = t.accuracy;
        w.history = t.history;
      }
    }

    latestPrediction = result;
    if (latestPrediction && typeof latestPrediction === 'object') {
      latestPrediction.manualStrikes = manualStrikes;
      latestPrediction.engineSymbols = active;
    }
    lastComputeError = null;

    if (bot) {
      await bot.runCycle(result).catch((err) => {
        console.error('[bot] cycle error:', err.message);
      });
    }
  } catch (err) {
    lastComputeError = err.message;
    console.error('[predict] compute failed:', err);
    // Settlement must not depend on a healthy prediction cycle — still
    // force-manage any open paper/live trades when Coinbase/Kalshi target
    // fetches blow up mid-window.
    if (bot) {
      await bot.manageOpenPositions(latestPrediction).catch((botErr) => {
        console.error('[bot] manage-open after compute failure:', botErr.message);
      });
    }
  } finally {
    recomputeInFlight = false;
  }
}

async function main() {
  console.log('[startup] seeding historical candles from Coinbase REST API…');
  await seedAll();
  for (const [symbol, s] of Object.entries(state)) {
    console.log(`[startup] ${symbol}: seeded ${s.series.candles.length} candles`);
  }

  wireFeed();

  // First compute as soon as we have enough seeded history; then on an interval.
  await recompute();
  setInterval(recompute, COMPUTE_INTERVAL_MS);

  // Settlement watchdog: every 4s, force-close any trade past its own
  // windowCloseTime. Must NOT depend on recomputeInFlight — a hung Coinbase
  // / Kalshi cycle was letting opens "freeze" into the next 15m session.
  if (bot) {
    setInterval(() => {
      bot.forceSettleOverdue(latestPrediction).catch((err) => {
        console.error('[bot] settle-watchdog error:', err.message);
      });
      // Manage opens only when inventory exists — never poll Kalshi when flat.
      const opens = Array.isArray(bot.openTrades) ? bot.openTrades : [];
      if (opens.length > 0) {
        bot.manageOpenPositions(latestPrediction).catch((err) => {
          console.error('[bot] manage-watchdog error:', err.message);
        });
      }
    }, 2500);
    console.log('[startup] settle + manage watchdog every 2.5s (independent of prediction loop)');
  }

  const app = express();
  app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
  app.use(express.json());
  app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
  app.get('/api/latest', (req, res) => {
    res.json(latestPrediction);
  });

  app.get('/api/strikes/manual', (req, res) => {
    pruneManualStrikes();
    res.json({ ok: true, strikes: manualStrikes });
  });

  app.post('/api/strikes/manual', (req, res) => {
    const symbol = String((req.body && req.body.symbol) || '').toUpperCase();
    if (!state[symbol]) {
      return res.status(400).json({ ok: false, message: 'Unknown symbol.' });
    }
    const raw = req.body && req.body.price;
    if (raw == null || raw === '') {
      delete manualStrikes[symbol];
      saveManualStrikes();
      recompute().catch((err) => console.error('[manual-strike] recompute after clear failed:', err.message));
      return res.json({ ok: true, strikes: manualStrikes });
    }
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ ok: false, message: 'Enter a price greater than 0.' });
    }
    const prev = lastManualStrikeMeta[symbol] || (latestPrediction && latestPrediction[symbol]) || {};
    manualStrikes[symbol] = {
      price,
      setAt: Date.now(),
      expiresAt: Date.now() + MANUAL_STRIKE_TTL_MS,
      ticker: prev.kalshiTicker || prev.ticker || null,
      closeTime: prev.targetCloseTime || prev.closeTime || null,
    };
    lastManualStrikeMeta[symbol] = {
      ticker: manualStrikes[symbol].ticker,
      closeTime: manualStrikes[symbol].closeTime,
      price,
    };
    saveManualStrikes();
    recompute().catch((err) => console.error('[manual-strike] recompute after save failed:', err.message));
    res.json({ ok: true, strikes: manualStrikes });
  });

  app.get('/api/health', (req, res) => {
    const configPath = dataPath('bot-config.json');
    res.json({
      ok: true,
      version: APP_VERSION,
      lastComputeError,
      feedStatus: Object.fromEntries(Object.entries(state).map(([sym, s]) => [sym, s.feedStatus])),
      candleCounts: Object.fromEntries(Object.entries(state).map(([sym, s]) => [sym, s.series.candles.length])),
      computeIntervalMs: COMPUTE_INTERVAL_MS,
      botEnabled: !!bot,
      botRunning: bot ? bot.isRunning : false,
      // Predictions + bot cycles run inside this Node process on a timer.
      // Closing the browser/dashboard does not pause them.
      dashboardIndependent: true,
      dataDir: DATA_DIR,
      // Without a persistent disk on Render, restarts wipe settings/ledger.
      dataDirFromEnv: DATA_DIR_FROM_ENV,
      dataDirEphemeral: DATA_DIR_EPHEMERAL,
      archiveRetentionDays: ARCHIVE_RETENTION_DAYS,
      configFileExists: fs.existsSync(configPath),
      uptimeMs: Date.now() - SERVER_START_TIME,
      time: new Date().toISOString(),
    });
  });

  app.get('/api/bot/status', (req, res) => {
    if (!bot) {
      res.json({
        enabled: false,
        version: APP_VERSION,
        message: 'Set KALSHI_ENABLED=true to turn on the trading bot (paper mode by default). The engine keeps running on the server either way — the dashboard is only a viewer/control panel.',
      });
      return;
    }
    res.json({
      enabled: true,
      version: APP_VERSION,
      dashboardIndependent: true,
      ...bot.status(),
    });
  });

  app.get('/api/bot/calibration', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    res.json(bot.calibrationReport());
  });

  app.get('/api/bot/trades', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const limit = parseInt(req.query.limit || '100', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    res.json({ enabled: true, ...bot.getTradeLog({ limit, offset }) });
  });

  // Engine-level calibration: every prediction the engine has ever made for
  // this symbol, whether or not the bot actually traded it — a broader,
  // complementary view to /api/bot/calibration (which only covers actual
  // trades). Answers "how trustworthy is a given confidence level in this
  // system overall" rather than "how have my actual bets performed."
  app.get('/api/calibration', (req, res) => {
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    res.json({ symbol, windows: tracker.getCalibration(symbol) });
  });

  app.get('/api/kalshi/credentials-status', (req, res) => {
    res.json({
      configured: kalshiClient.hasCredentials,
      keyIdPreview: kalshiClient.keyId ? `${kalshiClient.keyId.slice(0, 6)}…` : null,
    });
  });

  app.post('/api/kalshi/credentials', (req, res) => {
    const { keyId, privateKeyPem } = req.body || {};
    if (!keyId && !privateKeyPem) {
      res.status(400).json({ error: 'Provide at least a keyId or privateKeyPem.' });
      return;
    }
    try {
      kalshiClient.setCredentials({ keyId, privateKeyPem });
      saveCredentials({ keyId: keyId || kalshiClient.keyId, privateKeyPem: privateKeyPem || kalshiClient.privateKey });
      if (kalshiClient.hasCredentials) {
        kalshiClient.syncAccountLimits({ force: true }).catch(() => undefined);
      }
      res.json({ ok: true, configured: kalshiClient.hasCredentials });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/bot/config', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    res.json({
      config: bot.config,
      settleExitTiers: settleExitTiersForDashboard(),
    });
  });

  app.post('/api/bot/config', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.updateConfig(req.body || {});
    res.json({ ...result, settleExitTiers: settleExitTiersForDashboard() });
  });

  app.post('/api/bot/setup', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const id = req.body && req.body.setupId;
    const result = bot.applyModelSetup(id);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json({ ...result, settleExitTiers: settleExitTiersForDashboard() });
  });

  app.get('/api/bot/settle-window-rec', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    res.json({ recommendation: bot.getSettleWindowRecommendation() });
  });

  app.post('/api/bot/settle-window-rec/apply', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const body = req.body || {};
    let force = body.light != null ? body.light : body.package;
    const pkg = String(force || '').toLowerCase();
    if (pkg === 'volatile' || pkg === 'edge') force = 'red';
    if (pkg === 'stable' || pkg === 'settle') force = 'green';
    const result = bot.applySettleWindowRecommendation(
      force ? { light: force } : {}
    );
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/bot/reset-daily-loss', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    bot._dailyLossHaltedAt = null;
    bot._dailyLossCents = null;
    bot._dailyLossResetAt = Date.now();
    bot._logActivity('Daily loss limit reset by user — trading resumed.', { kind: 'info' });
    res.json({ ok: true });
  });

  app.post('/api/bot/reset-paper', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.resetPaperState();
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/bot/insurance/deposit', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const body = req.body || {};
    const raw = body.dollars != null ? body.dollars : body.amount;
    const dollars = typeof raw === 'string' ? Number(String(raw).trim()) : Number(raw);
    const result = bot.depositInsurance(dollars);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/bot/running', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.setRunning((req.body || {}).running);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/bot/mode', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.setMode((req.body || {}).mode);
    res.status(result.ok ? 200 : 400).json(result);
  });

  const SYMBOL_TO_PRODUCT = {
    BTC: 'BTC-USD',
    XRP: 'XRP-USD',
    ETH: 'ETH-USD',
    SOL: 'SOL-USD',
    DOGE: 'DOGE-USD',
    BNB: 'BNB-USD',
    NEAR: 'NEAR-USD',
    HYPE: 'HYPE-USD',
    ZEC: 'ZEC-USD',
  };
  // Same set the live AUTO bot can trade on Kalshi (ZEC: no 15m; NEAR/DOGE opt-in).
  const AUTO_BACKTEST_SYMBOLS = tradeableKalshiSymbols(bot ? bot.config : null);
  const MAX_BACKTEST_HOURS = 168; // 7 full days of continuous minute data

  function parseBacktestSettings(source = {}) {
    // Prefer explicit request settings; fall back to the live bot config so a
    // backtest always reflects whatever the dashboard is actually using.
    const live = bot ? bot.config : {};
    return {
      edgeThresholdPct: source.edgeThresholdPct ?? live.edgeThresholdPct,
      minConfidence: source.minConfidence ?? live.minConfidence,
      stopLossCents: source.stopLossCents ?? live.stopLossCents,
      takeProfitCents: source.takeProfitCents ?? live.takeProfitCents,
      minEntryCents: source.minEntryCents ?? live.minEntryCents,
      stopRecoveryCents: source.stopRecoveryCents ?? live.stopRecoveryCents,
      stopRecoveryMaxMinutes: source.stopRecoveryMaxMinutes ?? live.stopRecoveryMaxMinutes,
      peerCascadeMaxMinutes: source.peerCascadeMaxMinutes ?? live.peerCascadeMaxMinutes,
      postStopMaxOneMinutes: source.postStopMaxOneMinutes ?? live.postStopMaxOneMinutes,
      postStopSameSideCooldownMinutes:
        source.postStopSameSideCooldownMinutes ?? live.postStopSameSideCooldownMinutes,
      stakeDollars: source.stakeDollars ?? live.stakeDollars,
      stakingStrategy: source.stakingStrategy ?? live.stakingStrategy,
      maxOpenPositions: source.maxOpenPositions ?? live.maxOpenPositions,
      skimMode: source.skimMode ?? live.skimMode,
      skimPercent: source.skimPercent ?? live.skimPercent,
      skimFixedDollars: source.skimFixedDollars ?? live.skimFixedDollars,
      insuranceCapDollars: source.insuranceCapDollars ?? live.insuranceCapDollars,
      insuranceFloorDollars: source.insuranceFloorDollars ?? live.insuranceFloorDollars,
      insuranceOverflowDollars: source.insuranceOverflowDollars ?? live.insuranceOverflowDollars,
      paperStartingBalanceDollars: source.paperStartingBalanceDollars ?? live.paperStartingBalanceDollars,
      assumedEntryCents: source.assumedEntryCents ?? 50,
    };
  }

  async function runBacktestHandler(req, res) {
    const source = { ...(req.query || {}), ...((req.body && typeof req.body === 'object') ? req.body : {}) };
    const symbol = String(source.symbol || 'BTC').toUpperCase();
    let hours = parseFloat(source.hours || '24');
    const isAuto = symbol === 'AUTO';

    if (!isAuto && !SYMBOL_TO_PRODUCT[symbol]) {
      res.status(400).json({ error: `Unknown symbol '${symbol}'. Use AUTO or a supported asset.` });
      return;
    }
    if (!hours || hours <= 0) hours = 24;
    if (hours > MAX_BACKTEST_HOURS) hours = MAX_BACKTEST_HOURS;

    const settings = parseBacktestSettings(source);
    const fetchSymbols = isAuto
      ? AUTO_BACKTEST_SYMBOLS
      : symbol === 'BTC'
        ? ['BTC']
        : ['BTC', symbol]; // BTC included for correlation / confidence agreement

    try {
      console.log(`[backtest] fetching ${hours}h of ${fetchSymbols.join(',')} history…`);
      const candlesBySymbol = {};
      for (const sym of fetchSymbols) {
        const productId = SYMBOL_TO_PRODUCT[sym];
        if (!productId) continue;
        // Sequential to stay polite with Coinbase's public rate limits.
        // eslint-disable-next-line no-await-in-loop
        candlesBySymbol[sym] = await fetchHistoricalRange(productId, hours);
        console.log(`[backtest] ${sym}: ${candlesBySymbol[sym].length} candles`);
      }

      const tradeInput = isAuto
        ? Object.fromEntries(AUTO_BACKTEST_SYMBOLS.map((s) => [s, candlesBySymbol[s]]).filter(([, c]) => c))
        : candlesBySymbol; // may include BTC peer + focus symbol

      console.log(`[backtest] running ${isAuto ? 'AUTO' : symbol} walk-forward with settings…`);
      const wantHunt = source.hunt === true || source.hunt === 'true' || source.hunt === '1';

      let hunt = null;
      let trading;
      if (wantHunt) {
        console.log('[backtest] hunting best edge/confidence/stop for win rate + profit…');
        hunt = huntBestSettings(tradeInput, settings, {
          stepMinutes: 2,
          mode: isAuto ? 'AUTO' : 'single',
          focusSymbol: isAuto ? null : symbol,
        });
        trading = hunt.bestTrading;
        if (!trading) {
          trading = backtestWithSettings(tradeInput, settings, {
            stepMinutes: 1,
            mode: isAuto ? 'AUTO' : 'single',
            focusSymbol: isAuto ? null : symbol,
            continuousSearch: true,
          });
        }
      } else {
        trading = backtestWithSettings(tradeInput, settings, {
          stepMinutes: 1,
          mode: isAuto ? 'AUTO' : 'single',
          focusSymbol: isAuto ? null : symbol,
          continuousSearch: true,
        });
      }

      let windows;
      if (isAuto) {
        windows = {};
        for (const sym of AUTO_BACKTEST_SYMBOLS) {
          if (!candlesBySymbol[sym]) continue;
          windows[sym] = backtestSymbol(candlesBySymbol[sym], {
            stepMinutes: 1,
            symbol: sym,
            btcCandles: candlesBySymbol.BTC,
          });
        }
      } else {
        windows = backtestSymbol(candlesBySymbol[symbol], {
          stepMinutes: 1,
          symbol,
          btcCandles: symbol === 'BTC' ? null : candlesBySymbol.BTC,
        });
      }

      const candleCount = Object.values(candlesBySymbol).reduce((sum, c) => sum + c.length, 0);
      res.json({
        symbol,
        mode: isAuto ? 'AUTO' : 'single',
        symbolsScanned: isAuto ? AUTO_BACKTEST_SYMBOLS : [symbol],
        hoursRequested: hours,
        candleCount,
        hunted: !!wantHunt,
        hunt: hunt
          ? {
              searched: hunt.searched,
              best: hunt.best,
              top: hunt.top,
              note: hunt.note,
            }
          : null,
        settingsUsed: trading.settings,
        trading,
        windows,
        note: wantHunt && hunt ? `${hunt.note} ${trading.note || ''}` : trading.note,
      });
    } catch (err) {
      console.error('[backtest] failed:', err);
      res.status(500).json({ error: err.message });
    }
  }

  app.get('/api/backtest', runBacktestHandler);
  app.post('/api/backtest', runBacktestHandler);

  app.listen(PORT, () => {
    console.log(`[startup] prediction engine API listening on http://0.0.0.0:${PORT}`);
    console.log(`[startup] compute loop every ${COMPUTE_INTERVAL_MS / 1000}s — continues whether or not any dashboard is open`);
    console.log(`[startup] data dir: ${DATA_DIR}${DATA_DIR_EPHEMERAL ? ' (ephemeral on Render — attach a Persistent Disk at /var/data or set DATA_DIR)' : ''}`);
    if (bot) {
      console.log(`[startup] trading bot is ${bot.isRunning ? 'RUNNING' : 'STOPPED'} on the server (dashboard is optional)`);
    }
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
