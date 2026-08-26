'use strict';

/**
 * Full offline suite — every module, every critical path we can hit without
 * risking real money. Optional live public-API checks with ONLINE=1.
 *
 *   npm test
 *   ONLINE=1 npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-fulltest-'));
process.env.DATA_DIR = tmpDir;
// Keep bot from thinking it's on Render during tests.
delete process.env.RENDER;
delete process.env.RENDER_SERVICE_ID;

const { DATA_DIR, ensureDataDir, dataPath, writeJsonAtomic, pruneArchiveFiles } = require('./paths');
const indicators = require('./indicators');
const { CandleSeries } = require('./candles');
const { OrderBook } = require('./orderBook');
const { SignalAccumulator, SignalAccumulatorManager } = require('./signalAccumulator');
const { PredictionTracker } = require('./tracker');
const {
  buildPredictions,
  gatherIndicators,
  directionalScore,
  buildWindowPrediction,
  logistic,
  WINDOWS,
} = require('./prediction');
const {
  calibrateProbabilityUp,
  applyWindowConsensus,
  windowConsensusSupportsSide,
  modelCalibrationEntryGate,
  applyCalibrationToWindow,
} = require('./engineCalibration');
const {
  backtestSymbol,
  backtestWithSettings,
  huntBestSettings,
  normalizeSettings,
  LOOKBACK_MIN,
} = require('./backtest');
const { TradingBot, SERIES_BY_SYMBOL, isKalshiTradeEnabled, tradeableKalshiSymbols, symbolsNeedingKalshiTargets, symbolsNeedingEngineCompute, DEFAULT_AUTO_TRADE_SYMBOLS, resolveAutoTradeSymbols, scoreModelSetupsAgainstLog, modelSetupById, MODEL_SETUPS, settleEntryBand, settleEffectiveEntryBand, isSettleEntryPriceCents, isSettleStrategyMode, isSettleTrade, isModelStrategyMode, isModelTrade, pickModelWindowKey, pickModelWindow, modelWindowDirection, modelDirectionAgainstHeld, modelLiveLeanAgainstHeld, modelLiveLeanStillFavors, modelLiveProbNotWithUs, modelSignalTurningAgainst, modelProbDriftAgainst, modelEngineTurningAgainst, modelEntryDumpRisk, modelMinEntryLeanGate, modelEngineClearlyWithUs, modelNearFlatCents, modelBreakevenExitAllowed, modelLeanStaleForScratch, modelStagnationExitReady, modelRapidAdverseExitReady, modelBeChaseExitReady, modelBeChaseUpwardEvidence, modelUpwardMomentumEvidence, modelStallBankReady, modelPeakProgressCents, modelPriceAllowed, modelEntryRoomToFloorGate, modelLowAskConvictionGate, modelKalshiFavoriteSide, modelKalshiFavoriteGate, MODEL_KALSHI_FAVORITE_CENTS_DEFAULT, checkModelPostExitCooldown, modelPostExitCooldownMs, checkModelGlobalPostExitCooldown, modelGlobalPostExitCooldownMs, modelLeanDecayCutState, modelHeldSideProb, modelSignalDropCents, modelAdverseExitFillCents, modelEffectiveMaxLossCents, modelOnPaceBelowBarrier, modelShouldLeanStopRed, modelLeanStopMinAdverseCents, MODEL_MAX_LOSS_CENTS_DEFAULT, MODEL_RICH_STOP_FLOOR_CENTS_DEFAULT, MODEL_HARD_STOP_FLOOR_CENTS_DEFAULT, MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT, modelSideSwitchConfirmMs, modelSideSwitchConfirmTicks, MODEL_LIVE_LEAN_MARGIN_DEFAULT, MODEL_ENTRY_LIVE_LEAN_MARGIN_DEFAULT, MODEL_RED_GIVEUP_MS_DEFAULT, MODEL_SOFT_BANK_MS_DEFAULT, MODEL_DUMP_PULLBACK_CENTS_DEFAULT, MODEL_FAST_RED_CENTS_DEFAULT, MODEL_PROB_DRIFT_PTS_DEFAULT, MODEL_MIN_TP_CENTS_DEFAULT, MODEL_TRAIL_ARM_CENTS_DEFAULT, MODEL_MOMENTUM_STALL_MS_DEFAULT, MODEL_MOMENTUM_PULLBACK_CENTS_DEFAULT, MODEL_TRAIL_CENTS_DEFAULT, MODEL_MAX_ADVERSE_CENTS_DEFAULT, MODEL_HARD_ADVERSE_CENTS_DEFAULT, MODEL_BANK_GREEN_CENTS_DEFAULT, MODEL_STAGNATION_SECONDS_DEFAULT, MODEL_RAPID_ADVERSE_CENTS_DEFAULT, modelTakeProfitMeetsFloor, MODEL_MIN_MINUTES_TO_OPEN_DEFAULT, MODEL_PERFECT_MIN_ENTRY_DEFAULT_CENTS, MODEL_CONFIRM_CROSS_CENTS_DEFAULT, MODEL_CONFIRM_MAX_EXTENSION_CENTS_DEFAULT, isSettleTieredExitsEnabled, settleExitPlan, settleExitTiersForDashboard, SETTLE_EXIT_TIERS, settleRankAskScore, settleMinUpsideCents, liquidityPriority, stopRecoveryCentsRequired, stopRecoveryMaxAgeMs, peerCascadeMaxAgeMs, postStopMaxOneAgeMs, isPostStopMaxOneActive, postStopSameSideCooldownMs, checkPostStopSameSideCooldown, checkSameSideExitCooldown, tradeWindowCloseMs, isPostStopRecoverySessionExpired, checkPostStopRecovery, checkPostStopPeerCascade, applyProfitBuckets, normalizeInsuranceThresholds, classifyStopVerdictFromResult, classifyStopVerdictFromBids, buildHourlyPnlBuckets, recommendSettleOpenWindow, strategyModeForLight, scoreSymbolFifteenMinuteWindow, scoreMarketRegime, EDGE_MAX_ENTRY_DEFAULT_CENTS, MODEL_MAX_ENTRY_DEFAULT_CENTS, MODEL_MIN_ENTRY_DEFAULT_CENTS, EDGE_PRE_CLOSE_SMALL_LOSS_DEFAULT_CENTS, EDGE_PRE_CLOSE_MINUTES_DEFAULT, stopVerdictLabel, summarizeLedgerCapital, rebuildLedgerSkimFromTrades, MODEL_AUTO_SWITCH_LOW_AVAIL_DEFAULT, isForceRetryExitReason } = require('./bot');
const {
  publishPrimaryCoordination,
  loadCoordination,
  checkBackupEntryAllowed,
  backupRescueCandidates,
  isCoordinationFresh,
} = require('./botCoordination');
const {
  KalshiClient,
  normalizeMarketPrices,
  priceInCents,
  marketStrikePrice,
  parseMarketCloseMs,
  bookSideFromLegacy,
  buildCreateOrderV2Body,
  normalizeCreateOrderResponse,
} = require('./kalshiClient');

const ONLINE = process.env.ONLINE === '1' || process.env.ONLINE === 'true';

let passed = 0;
let failed = 0;
const failures = [];

function check(cond, label) {
  try {
    assert.ok(cond, label);
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    failures.push(label);
    console.error(`  ✗ ${label}${err.message && err.message !== label ? ` — ${err.message}` : ''}`);
  }
}

function checkEq(actual, expected, label) {
  try {
    assert.strictEqual(actual, expected, `${label} (got ${actual}, expected ${expected})`);
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    failures.push(label);
    console.error(`  ✗ ${err.message}`);
  }
}

function section(title) {
  console.log(`\n══ ${title} ══`);
}

function makeCandles(n, { start = 100, drift = 0.08, wobble = 0.4, startTime = Date.now() - n * 60_000 } = {}) {
  const candles = [];
  let price = start;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const change = drift + Math.sin(i / 9) * wobble;
    const close = Math.max(1, open + change);
    candles.push({
      time: startTime + i * 60_000,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 8 + (i % 6) * 3,
    });
    price = close;
  }
  return candles;
}

function seriesFromCandles(candles) {
  const s = new CandleSeries('TEST-USD');
  s.candles = candles.slice();
  return s;
}

function mockClient(market, { failGet = false, openMarkets } = {}) {
  return {
    hasCredentials: false,
    async getMarket() {
      if (failGet) throw new Error('mock network failure');
      return market;
    },
    async getOpenMarkets() {
      if (openMarkets) return openMarkets;
      return market ? [market] : [];
    },
    async createOrder() {
      throw new Error('createOrder must not be called in paper self-test');
    },
    async getBalance() {
      return { balance: 0, portfolio_value: 0 };
    },
  };
}

function makeBot(client, config = {}) {
  // Wipe persisted overrides so earlier updateConfig calls cannot leak into
  // later cases (same DATA_DIR for the whole suite).
  for (const name of ['bot-config.json', 'bot-mode-state.json', 'bot-run-state.json', 'shadow-books.json']) {
    try {
      fs.unlinkSync(dataPath(name));
    } catch {
      // ignore
    }
  }
  const bot = new TradingBot({
    kalshiClient: client,
    config: {
      mode: 'paper',
      liveAuthorized: false,
      edgeThresholdPct: 8,
      minConfidence: 55,
      stopLossCents: 23,
      takeProfitCents: 15,
      minEntryCents: 40,
      stakeDollars: 10,
      maxOpenPositions: 1,
      skimMode: 'off',
      skimPercent: 20,
      skimFixedDollars: 5,
      paperStartingBalanceDollars: 100,
      stakingStrategy: 'fixed',
      symbol: 'ETH',
      autoTradeSymbols: 'BTC,ETH,SOL,XRP,DOGE,BNB,NEAR,HYPE',
      ...config,
    },
  });
  // Re-apply explicit test config after constructor merge so defaults win.
  Object.assign(bot.config, {
    mode: config.mode || 'paper',
    liveAuthorized: config.liveAuthorized === true,
    // Suite defaults to Edge unless a case opts into settle/model.
    strategyMode: config.strategyMode ?? 'edge',
    edgeThresholdPct: config.edgeThresholdPct ?? 8,
    minConfidence: config.minConfidence ?? 55,
    stopLossCents: config.stopLossCents ?? 23,
    takeProfitCents: config.takeProfitCents ?? 15,
    minEntryCents: config.minEntryCents ?? 40,
    minMinutesToOpen: config.minMinutesToOpen ?? 3,
    modelMinConfidence: config.modelMinConfidence ?? 55,
    modelConfirmCrossCents:
      config.modelConfirmCrossCents != null ? config.modelConfirmCrossCents : 0,
    stopRecoveryCents: config.stopRecoveryCents ?? 6,
    stakeDollars: config.stakeDollars ?? 10,
    maxOpenPositions: config.maxOpenPositions ?? 1,
    skimMode: config.skimMode ?? 'off',
    skimPercent: config.skimPercent ?? 20,
    skimFixedDollars: config.skimFixedDollars ?? 5,
    insuranceCapDollars: config.insuranceCapDollars ?? 10,
    insuranceFloorDollars: config.insuranceFloorDollars ?? 6,
    insuranceOverflowDollars: config.insuranceOverflowDollars ?? 15,
    paperStartingBalanceDollars: config.paperStartingBalanceDollars ?? 100,
    stakingStrategy: config.stakingStrategy ?? 'fixed',
    symbol: config.symbol ?? 'ETH',
    autoTradeSymbols: config.autoTradeSymbols ?? 'BTC,ETH,SOL,XRP,DOGE,BNB,NEAR,HYPE',
    // Off unless a case opts in — 10-minute-old openTrade fixtures would otherwise BE-stop.
    edgeBreakevenAfterMinutes:
      config.edgeBreakevenAfterMinutes != null ? config.edgeBreakevenAfterMinutes : 0,
    // Suite opens multi-slot positions without greening the first hold unless a case opts in.
    secondOpenRequiresGreen: config.secondOpenRequiresGreen ?? 'off',
  });
  normalizeInsuranceThresholds(bot.config);
  bot.ledger = { trades: [], reserveCents: 0, insuranceCents: 0, insuranceReady: false, insuranceDepositedCents: 0, periodStartTime: Date.now() };
  bot.calibration = { buckets: {} };
  bot.isRunning = true;
  bot.lastError = null;
  // Instant sleeps so stop-loss retry loops don't slow the suite.
  bot._sleep = async () => {};
  return bot;
}

function openTrade(bot, overrides = {}) {
  const now = Date.now();
  const trade = {
    id: `test-${Math.random().toString(16).slice(2)}`,
    mode: 'paper',
    symbol: 'ETH',
    ticker: 'KXETH15M-TEST',
    side: 'no',
    contracts: 10,
    stakeDollars: 5,
    entryPriceCents: 50,
    floorStrike: 3000,
    openedAt: now - 10 * 60 * 1000,
    windowCloseTime: now + 5 * 60 * 1000,
    engineProbability: 60,
    engineConfidence: 70,
    status: 'open',
    ...overrides,
  };
  bot.ledger.trades.unshift(trade);
  return trade;
}

function win(up, conf, extra = {}) {
  const down = 100 - up;
  const signalScore =
    extra.signalScore !== undefined
      ? extra.signalScore
      : up > down
        ? { upScore: 2, downScore: 0.5, netDominance: 1.5, trend: 'strengthening' }
        : up < down
          ? { upScore: 0.5, downScore: 2, netDominance: -1.5, trend: 'strengthening' }
          : { upScore: 1, downScore: 1, netDominance: 0, trend: 'steady' };
  const { signalScore: _drop, ...rest } = extra;
  return {
    probabilityUp: up,
    probabilityDown: down,
    confidence: conf,
    window: '0-5 min',
    signalScore,
    ...rest,
  };
}

function predictions(price, windows = {}) {
  return {
    ETH: {
      ready: true,
      price,
      windows: {
        w5: windows.w5 || win(55, 60),
        w10: windows.w10 || win(55, 60),
        w15: windows.w15 || win(55, 60),
      },
    },
    BTC: {
      ready: true,
      price: price * 20,
      windows: {
        w5: win(55, 60),
        w10: win(55, 60),
        w15: win(55, 60),
      },
    },
  };
}

// ───────────────────────────── paths ─────────────────────────────

function testPaths() {
  section('paths.js');
  ensureDataDir();
  check(DATA_DIR === tmpDir || path.resolve(DATA_DIR) === path.resolve(tmpDir), 'DATA_DIR uses test temp dir');
  const file = dataPath('atomic-check.json');
  writeJsonAtomic(file, { ok: true, n: 42 });
  const read = JSON.parse(fs.readFileSync(file, 'utf8'));
  checkEq(read.ok, true, 'atomic write readable');
  checkEq(read.n, 42, 'atomic write payload intact');
  check(fs.existsSync(dataPath('archive')), 'archive dir created');

  const archiveDir = dataPath('archive');
  const oldFile = path.join(archiveDir, 'bot-ledger-old.json');
  const newFile = path.join(archiveDir, 'bot-ledger-new.json');
  fs.writeFileSync(oldFile, '{"trades":[]}');
  fs.writeFileSync(newFile, '{"trades":[]}');
  const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, new Date(twentyDaysAgo / 1000), new Date(twentyDaysAgo / 1000));
  const pruned = pruneArchiveFiles({ now: Date.now() });
  check(!fs.existsSync(oldFile), 'prune deletes archive older than retention');
  check(fs.existsSync(newFile), 'prune keeps recent archive');
  check(pruned.deleted >= 1, 'prune reports deleted count');
  try {
    fs.unlinkSync(newFile);
  } catch {
    // ignore
  }
}

// ───────────────────────────── indicators ─────────────────────────────

function testIndicators() {
  section('indicators.js');
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.4 + Math.sin(i / 5));
  const vols = closes.map((_, i) => 10 + (i % 4));
  const candles = closes.map((c, i) => ({
    open: c - 0.1,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: vols[i],
  }));

  check(Number.isFinite(indicators.sma(closes, 10)), 'sma');
  check(Number.isFinite(indicators.ema(closes, 12)), 'ema');
  check(indicators.emaSeries(closes, 12).length === closes.length, 'emaSeries length');
  const rsi = indicators.rsi(closes, 14);
  check(rsi != null && rsi >= 0 && rsi <= 100, 'rsi in 0..100');
  const macd = indicators.macd(closes);
  check(macd && Number.isFinite(macd.histogram), 'macd histogram');
  check(Number.isFinite(indicators.atr(candles, 14)), 'atr');
  check(Number.isFinite(indicators.momentum(closes, 10)), 'momentum');
  check(Number.isFinite(indicators.volatility(closes, 20)), 'volatility');
  const corr = indicators.correlation(closes, closes.map((c) => c * 1.01), 30);
  check(corr != null && corr > 0.9, 'correlation near 1 on nearly-identical series');
  const trend = indicators.trendStrength(closes);
  check(trend && Number.isFinite(trend.alignment), 'trendStrength');
  check(indicators.volumeSpike(vols, 20) != null, 'volumeSpike');
  check(indicators.candlePattern(candles) && typeof indicators.candlePattern(candles).lean === 'number', 'candlePattern');
  check(indicators.sma([1, 2], 5) == null || !Number.isFinite(indicators.sma([1, 2], 5)), 'sma short series safe');
}

// ───────────────────────────── candles / order book ─────────────────────────────

function testCandlesAndBook() {
  section('candles.js + orderBook.js');
  const series = new CandleSeries('BTC-USD');
  const t0 = Math.floor(Date.now() / 60_000) * 60_000;
  series.addTrade(100, 1, t0 + 1000);
  series.addTrade(101, 2, t0 + 2000);
  checkEq(series.candles.length, 1, 'same-minute trades fold into one candle');
  checkEq(series.latestClose(), 101, 'latestClose updates');
  checkEq(series.candles[0].volume, 3, 'volume accumulates');
  series.addTrade(102, 1, t0 + 60_000 + 500);
  checkEq(series.candles.length, 2, 'new minute opens new candle');
  check(!series.ready(210), 'not ready with few candles');
  series.candles = makeCandles(220);
  check(series.ready(210), 'ready with 220 candles');
  check(series.closes().length === 220, 'closes length');

  const book = new OrderBook('BTC-USD');
  book.loadSnapshot(
    [
      ['100', '2'],
      ['99', '3'],
    ],
    [
      ['101', '1.5'],
      ['102', '4'],
    ]
  );
  check(book.ready, 'order book ready after snapshot');
  checkEq(book.bestBid(), 100, 'bestBid');
  checkEq(book.bestAsk(), 101, 'bestAsk');
  checkEq(book.midPrice(), 100.5, 'midPrice');
  check(book.spread().absolute > 0, 'spread absolute');
  const imb = book.imbalance(5);
  check(imb && Number.isFinite(imb.ratio), 'imbalance ratio');
  check(book.liquidity(5) > 0, 'liquidity > 0');
  book.applyChange('buy', '100', '0');
  check(!book.bids.has(100), 'size 0 removes level');
}

// ───────────────────────────── signal accumulator ─────────────────────────────

function testSignalAccumulator() {
  section('signalAccumulator.js');
  const acc = new SignalAccumulator(60_000);
  const a = acc.update([1, 0.5, -0.2], 1_000_000);
  check(a.upScore > 0 && a.downScore > 0, 'scores accumulate');
  const b = acc.update([0, 0, 0], 1_000_000 + 60_000);
  check(b.upScore < a.upScore, 'half-life decays prior influence');
  const mgr = new SignalAccumulatorManager({ w5: 1000, w10: 2000 });
  check(mgr.get('BTC', 'w5') === mgr.get('BTC', 'w5'), 'manager reuses accumulator');
  check(mgr.get('BTC', 'w5') !== mgr.get('ETH', 'w5'), 'manager isolates symbols');
  const sessionA = mgr.get('BTC', 'w5', 'TICK-1');
  sessionA.update([2], 1_000_000);
  const sessionB = mgr.get('BTC', 'w5', 'TICK-2');
  check(sessionA !== sessionB, 'new Kalshi session gets a fresh accumulator');
  checkEq(sessionB.upScore, 0, 'new session bars start at 0 (aligned to new strike)');
}

// ───────────────────────────── tracker ─────────────────────────────

function testTracker() {
  section('tracker.js');
  const tracker = new PredictionTracker();
  tracker.cycles = new Map();
  tracker.history = new Map();
  const now = Date.now();
  const closeTime = now + 15 * 60 * 1000;
  const windows = {
    w5: { probabilityUp: 70, probabilityDown: 30 },
    w10: { probabilityUp: 60, probabilityDown: 40 },
    w15: { probabilityUp: 55, probabilityDown: 45 },
  };
  const first = tracker.update('BTC', {
    ticker: 'T1',
    targetPrice: 100,
    closeTime,
    currentPrice: 100,
    windows,
    now,
  });
  check(first.w5.tracking.secondsRemaining > 0, 'tracker countdown positive mid-window');
  checkEq(first.w5.tracking.predictedDirection, 'UP', 'w5 predicted UP');

  // Jump past 5-minute checkpoint with price above strike
  const after5 = tracker.update('BTC', {
    ticker: 'T1',
    targetPrice: 100,
    closeTime,
    currentPrice: 101,
    windows,
    now: now + 5 * 60 * 1000 + 1000,
  });
  check(after5.w5.lastResult != null, 'w5 checkpoint resolved');
  checkEq(after5.w5.lastResult.correct, true, 'w5 correct when price up');

  // New ticker = new cycle
  const next = tracker.update('BTC', {
    ticker: 'T2',
    targetPrice: 105,
    closeTime: closeTime + 15 * 60 * 1000,
    currentPrice: 105,
    windows,
    now: closeTime + 1000,
  });
  checkEq(next.w5.tracking.baselinePrice, 105, 'new cycle baseline');

  // 24h roll keeps yesterday's probability beside today — does not wipe history.
  {
    const { ROTATION_PERIOD_MS } = require('./tracker');
    const roll = new PredictionTracker();
    roll.cycles = new Map();
    roll.history = new Map();
    const t0 = Date.now();
    roll.periodStartTime = t0;
    const yWin = {
      w5: { probabilityUp: 70, probabilityDown: 30 },
      w10: { probabilityUp: 60, probabilityDown: 40 },
      w15: { probabilityUp: 55, probabilityDown: 45 },
    };
    const yClose = t0 + 15 * 60 * 1000;
    roll.update('BTC', {
      ticker: 'YDAY',
      targetPrice: 100,
      closeTime: yClose,
      currentPrice: 100,
      windows: yWin,
      now: t0,
    });
    roll.update('BTC', {
      ticker: 'YDAY',
      targetPrice: 100,
      closeTime: yClose,
      currentPrice: 101,
      windows: yWin,
      now: t0 + 5 * 60 * 1000 + 1000,
    });
    check(roll.history.get('BTC').w5.length >= 1, 'yesterday sample stored');
    const afterRoll = roll.update('BTC', {
      ticker: 'TODAY',
      targetPrice: 110,
      closeTime: t0 + ROTATION_PERIOD_MS + 15 * 60 * 1000,
      currentPrice: 110,
      windows: yWin,
      now: t0 + ROTATION_PERIOD_MS + 1000,
    });
    checkEq(afterRoll.w5.accuracy.sampleSize, 0, 'today track record starts empty after 24h');
    check(afterRoll.w5.accuracy.previous && afterRoll.w5.accuracy.previous.sampleSize >= 1, 'yesterday probability kept beside today');
    check(roll.history.get('BTC').w5.length >= 1, 'history not wiped on 24h roll');
  }
}

// ───────────────────────────── prediction ─────────────────────────────

function testPrediction() {
  section('prediction.js');
  check(logistic(0) > 0.49 && logistic(0) < 0.51, 'logistic(0) ≈ 0.5');
  check(logistic(5) > 0.9, 'logistic(+large) high');
  check(logistic(-5) < 0.1, 'logistic(-large) low');
  {
    const modestDown = (1 - logistic(-1.7)) * 100;
    check(modestDown >= 75 && modestDown <= 90, `modest bearish score ~${modestDown.toFixed(0)}% not 99`);
    const modestUp = logistic(1.7) * 100;
    check(modestUp >= 75 && modestUp <= 90, `modest bullish score ~${modestUp.toFixed(0)}% not 99`);
  }
  checkEq(WINDOWS.length, 3, 'three prediction windows');

  const candles = makeCandles(240, { start: 50000, drift: 15, wobble: 40 });
  const series = seriesFromCandles(candles);
  const book = new OrderBook('BTC-USD');
  book.loadSnapshot(
    [
      [String(series.latestClose() - 10), '1'],
      [String(series.latestClose() - 20), '2'],
    ],
    [
      [String(series.latestClose() + 10), '1'],
      [String(series.latestClose() + 20), '2'],
    ]
  );
  const ind = gatherIndicators(series, book);
  check(ind != null, 'gatherIndicators with 240 candles');
  check(Number.isFinite(ind.price), 'indicator price');
  const scored = directionalScore(ind, 'w5');
  check(Number.isFinite(scored.score), 'directionalScore');
  const wPred = buildWindowPrediction(WINDOWS[0], ind, null, null, ind.price, 'BTC', null, Date.now());
  check(wPred.probabilityUp >= 0 && wPred.probabilityUp <= 100, 'window probabilityUp 0..100');
  check(wPred.confidence >= 0 && wPred.confidence <= 100, 'window confidence 0..100');

  const ethCandles = makeCandles(240, { start: 3000, drift: 1, wobble: 3 });
  const result = buildPredictions(
    {
      BTC: { series, book },
      ETH: { series: seriesFromCandles(ethCandles), book: null },
    },
    {
      BTC: { price: series.latestClose(), closeTime: Date.now() + 600_000, ticker: 'KXBTC15M-X' },
      ETH: { price: ethCandles[ethCandles.length - 1].close, closeTime: Date.now() + 600_000, ticker: 'KXETH15M-X' },
    },
    new SignalAccumulatorManager({ w5: 120000, w10: 240000, w15: 420000 })
  );
  check(result.BTC && result.BTC.ready, 'BTC prediction ready');
  checkEq(result.BTC.targetSource, 'kalshi', 'kalshi target source when strike provided');
  const manualPred = buildPredictions(
    { BTC: { series, book } },
    { BTC: { price: 61234.5, ticker: 'MANUAL-BTC', closeTime: Date.now() + 600_000, source: 'manual' } }
  );
  checkEq(manualPred.BTC.targetSource, 'manual', 'manual price-to-beat source');
  checkEq(manualPred.BTC.targetPrice, 61234.5, 'manual strike used as target');
  check(result.ETH && result.ETH.ready, 'ETH prediction ready');
  check(result.BTC.windows.w5 && result.BTC.windows.w15, 'all windows present');
  check(result.BTC.targetCloseTime > Date.now(), 'targetCloseTime in future');
  check(result.BTC.consensus && result.BTC.consensus.agreeCount >= 2, 'consensus attached');
  check(
    result.BTC.windows.w5.probabilityUpRaw != null,
    'raw probability preserved for tracker calibration'
  );

  // Empirical calibration soft-shrinks overconfident buckets toward history.
  const calMap = {
    BTC: {
      w5: { '70-79%': { trades: 120, wins: 66 } },
    },
  };
  const cal = calibrateProbabilityUp(0.74, {
    symbol: 'BTC',
    windowKey: 'w5',
    calibration: calMap,
  });
  check(cal.calibrated, 'calibration blends with mature bucket');
  check(cal.probabilityUp < 0.74 && cal.probabilityUp > 0.5, 'overconfident 74% pulled toward ~55%');

  const flipTrap = calibrateProbabilityUp(0.74, {
    symbol: 'BTC',
    windowKey: 'w5',
    calibration: { BTC: { w5: { '70-79%': { trades: 200, wins: 50 } } } },
  });
  check(flipTrap.calibrated, 'poor bucket still calibrates');
  check(flipTrap.probabilityUp >= 0.5, 'bad calibration never flips UP→DOWN (was Strong Sell bug)');
  checkEq(flipTrap.probabilityUp, 0.5, 'sub-50% history shrinks to coin-flip, not reverse');

  const thin = calibrateProbabilityUp(0.74, {
    symbol: 'BTC',
    windowKey: 'w5',
    calibration: { BTC: { w5: { '70-79%': { trades: 10, wins: 3 } } } },
  });
  check(!thin.calibrated, 'thin buckets leave probs untouched');

  const gateBad = modelCalibrationEntryGate({
    symbol: 'BTC',
    windowKey: 'w5',
    probabilityUp: 74,
    side: 'yes',
    calibration: { BTC: { w5: { '70-79%': { trades: 80, wins: 30 } } } },
    minWinRatePct: 52,
  });
  check(!gateBad.ok, 'entry blocked when calibrated bucket historically loses');

  const disagree = {
    w5: { probabilityUp: 70, probabilityDown: 30, confidence: 70 },
    w10: { probabilityUp: 35, probabilityDown: 65, confidence: 70 },
    w15: { probabilityUp: 38, probabilityDown: 62, confidence: 70 },
  };
  applyWindowConsensus(disagree);
  check(disagree.w5.probabilityUp < 70, 'outlier horizon shrunk toward 50');
  check(!windowConsensusSupportsSide(disagree, 'yes'), 'YES blocked when majority DOWN');
  check(windowConsensusSupportsSide(disagree, 'no'), 'NO allowed when majority DOWN');

  const withCal = buildPredictions(
    { BTC: { series, book } },
    { BTC: { price: series.latestClose(), closeTime: Date.now() + 600_000, ticker: 'KXBTC15M-Y' } },
    null,
    { calibration: calMap }
  );
  check(withCal.BTC.ready, 'buildPredictions accepts calibration option');
}

// ───────────────────────────── kalshi client helpers ─────────────────────────────

async function testKalshiClient() {
  section('kalshiClient.js');
  checkEq(priceInCents(56, null), 56, 'legacy cents');
  checkEq(priceInCents(null, '0.5600'), 56, 'dollar string → cents');
  checkEq(priceInCents(undefined, '0.5600'), 56, 'undefined legacy falls through to dollars');
  checkEq(priceInCents('', '0.5600'), 56, 'empty legacy falls through to dollars');
  checkEq(priceInCents(undefined, 'bad'), null, 'invalid dollars → null');
  // Regression: null must NOT become 0¢ and mask a real dollar quote.
  checkEq(priceInCents(null, '0.41'), 41, 'null legacy does not become 0¢');
  const norm = normalizeMarketPrices({
    yes_bid_dollars: '0.41',
    yes_ask_dollars: '0.43',
    no_bid_dollars: '0.57',
    no_ask_dollars: '0.59',
    last_price_dollars: '0.42',
  });
  checkEq(norm.yes_bid, 41, 'normalize yes_bid');
  checkEq(norm.yes_ask, 43, 'normalize yes_ask');
  checkEq(norm.no_bid, 57, 'normalize no_bid');
  const client = new KalshiClient({});
  checkEq(client.hasCredentials, false, 'no credentials by default');
  client.setCredentials({ keyId: 'abc', privateKeyPem: 'not-a-real-key' });
  checkEq(client.hasCredentials, true, 'credentials flag after set');

  {
    const { createTokenBucket } = require('./kalshiClient');
    const bucket = createTokenBucket(100, 100);
    let took = 0;
    const t0 = Date.now();
    await bucket.take(50);
    await bucket.take(50);
    took = Date.now() - t0;
    check(took < 80, `full capacity take is immediate (got ${took}ms)`);
    const t1 = Date.now();
    await bucket.take(10);
    const waited = Date.now() - t1;
    check(waited >= 80, `refill wait for 10 tokens at 100/s (~100ms, got ${waited}ms)`);
  }

  {
    const c = new KalshiClient({});
    c.applyAccountLimits({
      usage_tier: 'basic',
      read: { refill_rate: 200, bucket_capacity: 400 },
      write: { refill_rate: 100, bucket_capacity: 100 },
    });
    checkEq(c._usageTier, 'basic', 'applyAccountLimits stores tier');
    check(c._readBudget.refillPerSec === 170, 'read paced at 85% of Basic 200');
    check(c._writeBudget.refillPerSec === 85, 'write paced at 85% of Basic 100');
  }

  {
    const { marketHasUsableTwoSidedQuote, normalizeMarketPrices } = require('./kalshiClient');
    checkEq(marketHasUsableTwoSidedQuote({ yes_bid: 40, yes_ask: 42 }), true, 'usable quote ok');
    checkEq(marketHasUsableTwoSidedQuote({ yes_bid: null, yes_ask: 42 }), false, 'missing bid not usable');
    checkEq(
      marketHasUsableTwoSidedQuote(normalizeMarketPrices({ yes_bid_dollars: '0.41', yes_ask_dollars: '0.43' })),
      true,
      'dollar quotes normalize to usable'
    );
  }

  // Create Order V2 mapping (legacy action/side → book bid/ask + dollar price)
  checkEq(bookSideFromLegacy('yes', 'buy'), 'bid', 'buy YES → bid');
  checkEq(bookSideFromLegacy('yes', 'sell'), 'ask', 'sell YES → ask');
  checkEq(bookSideFromLegacy('no', 'buy'), 'ask', 'buy NO → ask');
  checkEq(bookSideFromLegacy('no', 'sell'), 'bid', 'sell NO → bid');
  const v2Body = buildCreateOrderV2Body({
    ticker: 'KXBTC15M-TEST',
    side: 'yes',
    action: 'buy',
    count: 10,
    priceCents: 56,
    clientOrderId: 'cid-test',
  });
  checkEq(v2Body.side, 'bid', 'V2 body book side');
  checkEq(v2Body.count, '10.00', 'V2 body count_fp string');
  checkEq(v2Body.price, '0.5600', 'V2 body dollar price');
  checkEq(v2Body.time_in_force, 'good_till_canceled', 'V2 body TIF');
  checkEq(v2Body.self_trade_prevention_type, 'taker_at_cross', 'V2 body STP');
  checkEq(v2Body.client_order_id, 'cid-test', 'V2 body client_order_id');
  const iocBody = buildCreateOrderV2Body({
    ticker: 'KXBTC15M-TEST',
    side: 'yes',
    action: 'buy',
    count: 5,
    priceCents: 87,
    timeInForce: 'immediate_or_cancel',
  });
  checkEq(iocBody.time_in_force, 'immediate_or_cancel', 'V2 body supports IOC for live entry');
  const buyNoBody = buildCreateOrderV2Body({
    ticker: 'KXBTC15M-TEST',
    side: 'no',
    action: 'buy',
    count: 11,
    priceCents: 84, // NO ¢ — V2 wire must be YES-leg 16¢
    clientOrderId: 'cid-no',
  });
  checkEq(buyNoBody.side, 'ask', 'buy NO → ask book');
  checkEq(buyNoBody.price, '0.1600', 'buy NO 84¢ → YES-leg price 16¢');
  const sellNoBody = buildCreateOrderV2Body({
    ticker: 'KXBTC15M-TEST',
    side: 'no',
    action: 'sell',
    count: 3,
    priceCents: 70,
  });
  checkEq(sellNoBody.side, 'bid', 'sell NO → bid book');
  checkEq(sellNoBody.price, '0.3000', 'sell NO 70¢ → YES-leg price 30¢');
  let badPrice = false;
  try {
    buildCreateOrderV2Body({
      ticker: 'T',
      side: 'yes',
      action: 'buy',
      count: 1,
      priceCents: 0,
    });
  } catch {
    badPrice = true;
  }
  check(badPrice, 'V2 body refuses 0¢ (no silent clamp to 1)');
  const flatNorm = normalizeCreateOrderResponse({ order_id: 'oid-flat', fill_count: '0.00' });
  checkEq(flatNorm.order.order_id, 'oid-flat', 'normalize flat V2 create response');
  const nestedNorm = normalizeCreateOrderResponse({ order: { order_id: 'oid-nested' } });
  checkEq(nestedNorm.order.order_id, 'oid-nested', 'normalize nested legacy create response');

  checkEq(marketStrikePrice({ floor_strike: 63048.28 }), 63048.28, 'strike from floor_strike');
  checkEq(
    marketStrikePrice({ yes_sub_title: 'Target Price: $63,048.28' }),
    63048.28,
    'strike from yes_sub_title when floor_strike omitted'
  );
  checkEq(marketStrikePrice({ strike_type: 'less', cap_strike: 1884.4 }), 1884.4, 'less markets use cap_strike');
  checkEq(marketStrikePrice({ yes_sub_title: 'Target price: TBD' }), null, 'TBD subtitle is not a strike');
  check(
    Number.isFinite(parseMarketCloseMs({ close_time: new Date(Date.now() + 60_000).toISOString() })),
    'parseMarketCloseMs reads ISO close_time'
  );

  {
    const liveClient = new KalshiClient({});
    const close = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    liveClient._request = async (_method, _path, opts = {}) => {
      check(opts.query && opts.query.status !== 'active', 'never query Kalshi with status=active (400)');
      return {
        markets: [
          {
            ticker: 'KXBTC15M-ACTIVE',
            status: 'active',
            close_time: close,
            yes_sub_title: 'Target Price: $63,048.28',
            yes_bid_dollars: '0.5700',
            yes_ask_dollars: '0.5800',
          },
        ],
      };
    };
    const picked = await liveClient.getLiveOpenMarket('KXBTC15M', { minMsLeft: 1500 });
    check(picked && picked.ticker === 'KXBTC15M-ACTIVE', 'status=active 15m market is treated as live');
    checkEq(marketStrikePrice(picked), 63048.28, 'live active market strike parsed from subtitle');
  }

  {
    const c = new KalshiClient({});
    let n = 0;
    c._request = async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        markets: [
          {
            ticker: 'KXBTC15M-ONE',
            status: 'open',
            close_time: new Date(Date.now() + 60_000).toISOString(),
            floor_strike: 1,
          },
        ],
      };
    };
    const [a, b] = await Promise.all([c.getOpenMarkets('KXBTC15M'), c.getOpenMarkets('KXBTC15M')]);
    checkEq(n, 1, 'parallel getOpenMarkets coalesces to one HTTP call');
    check(a[0] && b[0] && a[0].ticker === b[0].ticker, 'coalesced callers share the same list');
  }

  {
    const c = new KalshiClient({});
    c._openMarketsCache.set('KXBTC15M', {
      at: Date.now() - 20_000,
      markets: [{ ticker: 'STALE-OK' }],
    });
    c._request = async () => {
      const err = new Error('Kalshi API GET /markets -> HTTP 429');
      err.status = 429;
      throw err;
    };
    const list = await c.getOpenMarkets('KXBTC15M');
    checkEq(list[0] && list[0].ticker, 'STALE-OK', '429 serves stale markets instead of empty');
  }

  {
    const c = new KalshiClient({});
    // Empty list must not stick for the full 12s TTL.
    c._openMarketsCache.set('KXBTC15M', { at: Date.now() - 2_000, markets: [] });
    let n = 0;
    c._request = async () => {
      n += 1;
      return {
        markets: [
          {
            ticker: 'KXBTC15M-NEXT',
            status: 'open',
            close_time: new Date(Date.now() + 10 * 60_000).toISOString(),
            floor_strike: 1,
            yes_bid: 50,
            yes_ask: 52,
          },
        ],
      };
    };
    const picked = await c.getLiveOpenMarket('KXBTC15M', { minMsLeft: 1500 });
    check(n >= 1, 'empty open-markets cache is refreshed quickly');
    checkEq(picked && picked.ticker, 'KXBTC15M-NEXT', 'getLiveOpenMarket finds next window after empty cache');
  }

  {
    const c = new KalshiClient({});
    c._cooldownUntil = Date.now() + 20_000;
    c._marketByTickerCache.set('KXETH15M-CACHED', {
      at: Date.now(),
      market: { ticker: 'KXETH15M-CACHED', yes_bid: 40, yes_ask: 42 },
    });
    let n = 0;
    c._request = async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 50));
      return { market: { ticker: 'SHOULD-NOT-FETCH', yes_bid: 1, yes_ask: 2 } };
    };
    const started = Date.now();
    const m = await c.getMarket('KXETH15M-CACHED');
    checkEq(m && m.ticker, 'KXETH15M-CACHED', 'getMarket during cooldown reuses usable cached quote');
    checkEq(n, 0, 'getMarket cooldown with cache does not hit HTTP');
    check(Date.now() - started < 200, 'cached cooldown path is fast');
  }

  {
    const c = new KalshiClient({});
    c._cooldownUntil = Date.now() + 20_000;
    let n = 0;
    c._request = async () => {
      n += 1;
      return { market: { ticker: 'SHOULD-NOT-FETCH', yes_bid: 1, yes_ask: 2 } };
    };
    const m = await c.getMarket('KXBTC15M-NOCACHE');
    checkEq(m, null, 'getMarket cooldown without cache returns null');
    checkEq(n, 0, 'getMarket cooldown without cache does not hit HTTP');
  }

  {
    const c = new KalshiClient({});
    c._429Streak = 3;
    c._last429At = Date.now() - 5_000;
    c._cooldownUntil = 0;
    check(c.isPublicRateLimited(), 'quiet period keeps public GETs deferred after streak');
  }

  {
    const c = new KalshiClient({});
    for (let i = 0; i < 12; i += 1) c._noteRateLimit();
    const rem = c.publicRateLimitRemainingMs();
    check(rem > 0, 'repeated 429s still pause public GETs');
    check(rem <= 20_500, '429 backoff caps at 20s — does not lock Kalshi out for minutes');
  }

  {
    const { normalizeMarketPrices, marketHasUsableTwoSidedQuote } = require('./kalshiClient');
    const oneSided = normalizeMarketPrices({
      yes_bid_dollars: '0.0000',
      no_bid_dollars: '0.58',
      no_ask_dollars: '0.60',
    });
    checkEq(oneSided.yes_ask, 42, 'YES ask complemented from NO bid');
    checkEq(oneSided.yes_bid, 40, 'YES bid complemented from NO ask');
    checkEq(marketHasUsableTwoSidedQuote(oneSided), true, 'complemented book is usable');
  }

  // fill_count_fp parsing (v1.2.17+) — never invent fills from status alone
  const fillBot = makeBot(mockClient({}));
  checkEq(fillBot._orderFillCount({ fill_count_fp: '3.00' }), 3, 'fill_count_fp string');
  checkEq(fillBot._orderFillCount({ fill_count: 7 }), 7, 'fill_count integer');
  checkEq(fillBot._orderFillCount({ status: 'executed' }), 0, 'status alone is not a fill');
  checkEq(fillBot._orderFillCount({ fill_count_fp: '0.00', status: 'executed' }), 0, 'zero fill_count_fp stays zero');
  // Create Order V2 flat fill_count + average_fill_price
  checkEq(fillBot._orderFillCount({ fill_count: '5.00' }), 5, 'V2 create fill_count string');
  checkEq(
    fillBot._orderFillCount({ initial_count_fp: '10.00', remaining_count_fp: '4.00' }),
    6,
    'fill derived from initial − remaining'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.4200', fill_count: '2.00', side: 'bid' },
      'yes',
      'buy'
    ),
    42,
    'V2 buy YES average_fill_price → cents (raw YES quote)'
  );
  // Without sellLimit, do not blind-complement ask-book averages (TP 57 was
  // wrongly logged as 43 when 0.57 was already YES dollars).
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.5700', fill_count: '5.00', side: 'ask' },
      'yes',
      'sell'
    ),
    57,
    'V2 sell YES average_fill_price without limit stays raw (not blind complement)'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.8200', fill_count: '14.00', side: 'ask' },
      'yes',
      'sell',
      18
    ),
    18,
    'sell YES avg 0.82 with stop limit 18 → complement (closer to limit)'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.5700', fill_count: '5.00', side: 'ask' },
      'yes',
      'sell',
      57
    ),
    57,
    'sell YES avg 0.57 with TP limit 57 → raw (not complement to 43)'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.8200',
        taker_fill_cost_dollars: '2.52',
        fill_count: '14.00',
        side: 'ask',
      },
      'yes',
      'sell',
      18
    ),
    18,
    'average_fill_price preferred; disambiguated to stop limit (not raw 82)'
  );
  // XRP false +$10.32: maker buy ships taker_fill_cost_dollars="0.00" — must
  // not book clamp(0)=1¢ entry (which invents (76−1)×14 ≈ $10.50).
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.6900',
        taker_fill_cost_dollars: '0.00',
        maker_fill_cost_dollars: '9.66',
        fill_count: '14.00',
        side: 'bid',
      },
      'yes',
      'buy',
      69
    ),
    69,
    'maker-only buy: average_fill_price wins over zero/maker cost'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.6900',
        taker_fill_cost_dollars: '0.00',
        maker_fill_cost_dollars: '0.00',
        fill_count: '14.00',
        side: 'bid',
      },
      'yes',
      'buy',
      69
    ),
    69,
    'zero fill costs ignored; average_fill_price used'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.7600',
        taker_fill_cost_dollars: '20.00',
        fill_count: '14.00',
        side: 'ask',
      },
      'yes',
      'sell',
      76
    ),
    76,
    'misleading taker_fill_cost ignored when average_fill_price present'
  );
  // Cost fallback only when average_fill_price is absent.
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        taker_fill_cost_dollars: '1.26',
        maker_fill_cost_dollars: '1.26',
        fill_count: '14.00',
        side: 'ask',
      },
      'yes',
      'sell',
      18
    ),
    18,
    'without avg: taker+maker fill costs summed for cents'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        taker_fill_cost_dollars: '20.00',
        fill_count: '14.00',
        side: 'ask',
      },
      'yes',
      'sell',
      76
    ),
    null,
    'without avg: cost far from sell limit refused (no invented price)'
  );
  // ETH under-count: fill_cost near buy limit must not hide avg price improvement.
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.5200',
        taker_fill_cost_dollars: '9.52', // 17×$0.56 limit — agrees with intended, wrong vs avg
        fill_count: '17.00',
        side: 'bid',
      },
      'yes',
      'buy',
      56
    ),
    52,
    'ETH-style: average_fill_price improvement beats limit-shaped fill_cost'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.5800', fill_count: '5.00', side: 'ask' },
      'no',
      'buy'
    ),
    58,
    'V2 buy NO average_fill_price → raw cents without blind book_side flip'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.8200', fill_count: '10.00', side: 'bid' },
      'no',
      'sell',
      18
    ),
    18,
    'sell NO avg 0.82 with sell limit 18 → complement (closer to limit)'
  );
  checkEq(
    fillBot._sanityCheckExitFillCents(30, 70, 50, 'take_profit'),
    70,
    'sanity: TP exit << entry with sellLimit >= entry → use closer-to-limit'
  );
  checkEq(
    fillBot._sanityCheckExitFillCents(82, 18, 42, 'stop_loss'),
    18,
    'sanity: stop exit >> entry with sellLimit <= entry → use closer-to-limit'
  );
  checkEq(
    fillBot._sanityCheckExitFillCents(57, 57, 42, 'take_profit'),
    57,
    'sanity: good TP fill passes through'
  );
  const v2FillNorm = normalizeCreateOrderResponse({
    order_id: 'oid-v2-fill',
    fill_count: '4.00',
    remaining_count: '0.00',
    average_fill_price: '0.5100',
  });
  checkEq(v2FillNorm.order.order_id, 'oid-v2-fill', 'normalize V2 create keeps order_id');
  checkEq(v2FillNorm.order.fill_count, '4.00', 'normalize V2 create keeps fill_count on order');
  checkEq(fillBot._orderFillCount(v2FillNorm.order), 4, 'normalized V2 create fill parses');
}

// ───────────────────────────── backtest ─────────────────────────────

function testBacktest() {
  section('backtest.js');
  const settings = normalizeSettings({
    edgeThresholdPct: 5,
    minConfidence: 40,
    stopLossCents: 30,
    takeProfitCents: 80,
    stakeDollars: 10,
    skimMode: 'off',
    paperStartingBalanceDollars: 200,
    assumedEntryCents: 50,
  });
  checkEq(settings.minConfidence, 40, 'normalizeSettings minConfidence');
  check(LOOKBACK_MIN >= 200, 'LOOKBACK_MIN sufficient for indicators');

  const btc = makeCandles(280, { start: 60000, drift: 8, wobble: 25 });
  const eth = makeCandles(280, { start: 3000, drift: 0.8, wobble: 4 });
  const summary = backtestSymbol(btc, { symbol: 'BTC' });
  check(summary && typeof summary === 'object', 'backtestSymbol returns summary');

  const trading = backtestWithSettings(
    { BTC: btc, ETH: eth },
    settings,
    { stepMinutes: 2, mode: 'AUTO', continuousSearch: true }
  );
  check(trading && Number.isFinite(trading.netPnlCents), 'backtestWithSettings netPnlCents');
  check(typeof trading.trades === 'number', 'backtest trades count');
  check(trading.skipCounts && typeof trading.skipCounts === 'object', 'skipCounts present');
  check(trading.longevity && Number.isFinite(trading.longevity.simulatedHours), 'longevity simulatedHours');
  check(typeof trading.longevity.survivedFullPeriod === 'boolean', 'longevity survivedFullPeriod');
  check(Array.isArray(trading.longevity.dailyEquity), 'longevity dailyEquity array');

  const hunt = huntBestSettings({ BTC: btc, ETH: eth }, settings, { stepMinutes: 3 });
  check(hunt && hunt.best, 'huntBestSettings returns best');
  check(hunt.best.settings && Number.isFinite(hunt.best.settings.edgeThresholdPct), 'best settings numeric');
}

// ───────────────────────────── bot: config / mode / capital ─────────────────────────────

function testBotControls() {
  section('bot.js controls');
  const bot = makeBot(mockClient({}));
  const liveReject = bot.setMode('live');
  checkEq(liveReject.ok, false, 'cannot go live without liveAuthorized');
  const paperOk = bot.setMode('paper');
  checkEq(paperOk.ok, true, 'paper mode always allowed');

  const liveBot = makeBot(mockClient({}), { liveAuthorized: true, mode: 'live' });
  liveBot.config.liveAuthorized = true;
  const pause = liveBot.setMode('paper');
  checkEq(pause.ok, true, 'authorized bot can pause to paper');
  const resume = liveBot.setMode('live');
  checkEq(resume.ok, true, 'authorized bot can resume live');

  const stopped = bot.setRunning(false);
  checkEq(stopped.isRunning, false, 'setRunning false');
  const started = bot.setRunning(true);
  checkEq(started.isRunning, true, 'setRunning true');

  const updated = bot.updateConfig({
    edgeThresholdPct: 12,
    minConfidence: 61,
    stopLossCents: 28,
    takeProfitCents: 75,
    stakeDollars: 7,
    maxOpenPositions: 2,
    symbol: 'AUTO',
    skimMode: 'fixed',
    skimFixedDollars: 3,
    paperStartingBalanceDollars: 150,
  });
  checkEq(updated.applied.edgeThresholdPct, 12, 'updateConfig edge');
  checkEq(bot.config.symbol, 'AUTO', 'updateConfig symbol AUTO');
  check(fs.existsSync(dataPath('bot-config.json')), 'config persisted to disk');
  const saved = JSON.parse(fs.readFileSync(dataPath('bot-config.json'), 'utf8'));
  checkEq(saved.minConfidence, 61, 'persisted minConfidence');

  // Ignore mode via updateConfig
  bot.updateConfig({ mode: 'live' });
  check(bot.config.mode !== 'live' || !bot.config.liveAuthorized, 'updateConfig cannot force unauthorized live');

  const reset = bot.resetPaperState();
  checkEq(reset.ok, true, 'reset paper in paper mode');
  checkEq(bot.ledger.trades.length, 0, 'ledger cleared for fresh P&L');

  // Paper reset keeps the newest 40 closed samples for calibration.
  {
    const keepBot = makeBot(mockClient({ status: 'open' }), { mode: 'paper', strategyMode: 'model' });
    const now = Date.now();
    keepBot.ledger.trades = [];
    for (let i = 0; i < 45; i++) {
      keepBot.ledger.trades.push({
        id: `keep-${i}`,
        mode: 'paper',
        symbol: 'ETH',
        side: 'yes',
        status: 'closed',
        closedAt: now - (45 - i) * 1000,
        openedAt: now - (45 - i) * 1000 - 60_000,
        engineProbability: 60 + (i % 5),
        pnlCents: i % 2 === 0 ? 50 : -40,
        exitReason: 'breakeven',
        contracts: 1,
        entryPriceCents: 55,
      });
    }
    const r = keepBot.resetPaperState();
    checkEq(r.ok, true, 'reset with history ok');
    checkEq(r.keptSamples, 40, 'keeps last 40 closed samples');
    checkEq(keepBot.ledger.trades.length, 0, 'live ledger still cleared');
    const calTrades = Object.values(keepBot.calibration.buckets).reduce((s, b) => s + b.trades, 0);
    check(calTrades > 0, 'calibration rebuilt from kept samples');
    checkEq(calTrades, 40, 'calibration counts match kept samples');
    const logPath = dataPath('trade-log.json');
    const logRaw = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    const logTrades = Array.isArray(logRaw) ? logRaw : logRaw.trades || [];
    checkEq(logTrades.length, 40, 'trade log retains 40 samples');
  }
}

// ───────────────────────────── bot: exits / settlement ─────────────────────────────

async function testBotExits() {
  section('bot.js exits + settlement');

  // Official result
  {
    const now = Date.now();
    const client = mockClient({
      ticker: 'KXETH15M-TEST',
      status: 'closed',
      result: 'no',
      floor_strike: 3000,
      close_time: new Date(now - 1000).toISOString(),
      yes_bid: 5,
      no_bid: 95,
    });
    const bot = makeBot(client);
    const trade = openTrade(bot, { windowCloseTime: now - 1000, side: 'no' });
    await bot._manageOpenTrade(trade, predictions(2990));
    checkEq(trade.status, 'closed', 'result settle closes');
    checkEq(trade.exitReason, 'settled', 'result settle reason');
    checkEq(trade.exitPriceCents, 100, 'NO win = 100¢');
  }

  // YES result loss
  {
    const now = Date.now();
    const client = mockClient({
      ticker: 'KXETH15M-TEST',
      status: 'settled',
      result: 'YES',
      floor_strike: 3000,
      close_time: new Date(now - 1000).toISOString(),
    });
    const bot = makeBot(client);
    const trade = openTrade(bot, { windowCloseTime: now - 1000, side: 'no' });
    await bot._manageOpenTrade(trade, predictions(3100));
    checkEq(trade.exitPriceCents, 0, 'NO loss when result YES');
  }

  // Price vs strike
  {
    const now = Date.now();
    const client = mockClient({
      ticker: 'KXETH15M-TEST',
      status: 'closed',
      result: '',
      floor_strike: 3000,
      close_time: new Date(now - 1000).toISOString(),
    });
    const bot = makeBot(client);
    const trade = openTrade(bot, { windowCloseTime: now - 1000, side: 'no', floorStrike: 3000 });
    await bot._manageOpenTrade(trade, predictions(2950));
    checkEq(trade.exitReason, 'settled', 'strike settle');
    checkEq(trade.exitPriceCents, 100, 'below strike NO wins');
  }

  // Fetch fail after close
  {
    const now = Date.now();
    const bot = makeBot(mockClient(null, { failGet: true }));
    const trade = openTrade(bot, { windowCloseTime: now - 60_000, side: 'yes', floorStrike: 3000 });
    await bot._manageOpenTrade(trade, predictions(3100));
    checkEq(trade.status, 'closed', 'fetch-fail force settle');
  }

  // Max age without windowCloseTime
  {
    const now = Date.now();
    const bot = makeBot(mockClient(null, { failGet: true }));
    const trade = openTrade(bot, { openedAt: now - 17 * 60 * 1000, floorStrike: 3000, side: 'no' });
    delete trade.windowCloseTime;
    await bot._manageOpenTrade(trade, predictions(2900));
    checkEq(trade.status, 'closed', 'max-age force settle');
  }

  // Saved close in the past must settle even if Kalshi still says active + future close
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'active',
        close_time: new Date(now + 14 * 60 * 1000).toISOString(),
        result: '',
        floor_strike: 3000,
        yes_bid: 40,
        no_bid: 55,
      })
    );
    const trade = openTrade(bot, {
      side: 'no',
      floorStrike: 3000,
      windowCloseTime: now - 5000,
    });
    await bot._manageOpenTrade(trade, predictions(2950));
    checkEq(trade.status, 'closed', 'past saved close settles despite active+future API close');
  }

  // ISO string windowCloseTime still parses
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'active',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        result: 'no',
      })
    );
    const trade = openTrade(bot, {
      side: 'no',
      windowCloseTime: new Date(now - 2000).toISOString(),
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'closed', 'ISO windowCloseTime settles');
  }

  // Stop loss — relative to entry (entry 50, stop −10 → level 40)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 80,
        no_bid: 20,
      }),
      { stopLossCents: 10, takeProfitCents: 40 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'stop_loss', 'stop_loss');
    checkEq(trade.exitPriceCents, 40, 'paper stop fills at entry−drop (50−10)');
  }

  // Take profit — relative to entry (entry 50, TP +15 → level 65)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 20,
        no_bid: 75,
      }),
      { stopLossCents: 40, takeProfitCents: 15 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'take_profit', 'take_profit');
    checkEq(trade.exitPriceCents, 65, 'paper TP fills at entry+rise (50+15)');
  }

  // Settle: under tier target with plenty of time — hold (ignore edge TP knobs)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 92,
        no_bid: 8,
      }),
      { stopLossCents: 40, takeProfitCents: 5, settleStopLossCents: 8, nearCertainExitCents: 90 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now, // fresh open — must not stuck-exit while still climbing
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle holds under tier target early in window');
    checkEq(trade.exitReason, undefined, 'settle early hold has no exit reason');
  }

  // Settle: entry 87¢ → target 96¢ hit → take profit
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'take_profit', 'settle take_profit when tier target hit');
    checkEq(trade.status, 'closed', 'settle TP closes trade');
    check(trade.exitPriceCents >= 96, 'settle TP fill at/above target');
  }

  // Settle: entry 87¢, green but under 96 with ≤2m left → settle_stale bank
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 90 * 1000).toISOString(),
        yes_bid: 89, // under 90 so touched-90 latch does not skip stale
        no_bid: 11,
      }),
      { settleStopLossCents: 8, settleStuckHoldMinutes: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 90 * 1000,
      openedAt: now - 3 * 60 * 1000, // held long enough for stale
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'settle_stale', 'settle stale banks green before close');
    checkEq(trade.exitPriceCents, 89, 'settle stale sells at live bid');
  }

  // Settle: inside stale clock but held <90s — do not instant-stale (churn guard)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 90 * 1000).toISOString(),
        yes_bid: 93,
        no_bid: 7,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 90 * 1000,
      openedAt: now - 15_000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle stale waits for min hold (~90s)');
  }

  // Settle: underwater past stale deadline — do not force sell (stop/settle only)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 90 * 1000).toISOString(),
        yes_bid: 84,
        no_bid: 16,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 90 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle does not force stale sell while red');
  }

  // Settle hold tier (≥90): no TP chase even at 96¢
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 91,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle ≥90¢ holds toward settlement');
  }

  // Edge: ≤5m cash-out when position PnL loss ≤ $0.75
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 3 * 60 * 1000).toISOString(),
        yes_bid: 48,
        no_bid: 52,
      }),
      {
        strategyMode: 'edge',
        stopLossCents: 40,
        edgePreCloseSmallLossCents: 75,
        edgePreCloseMinutes: 5,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'edge',
      side: 'yes',
      entryPriceCents: 50,
      contracts: 10,
      windowCloseTime: now + 3 * 60 * 1000,
      openedAt: now - 60 * 1000,
    });
    // (48-50)*10 = -20¢ ≥ -75 → cash out
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'pre_close_small_loss', 'edge cash-out on ≤$0.75 loss in final 5m');
  }

  // Edge: deeper than $0.75 loss does not use pre_close_small_loss
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 3 * 60 * 1000).toISOString(),
        yes_bid: 40,
        no_bid: 60,
      }),
      {
        strategyMode: 'edge',
        stopLossCents: 40,
        takeProfitCents: 40,
        edgePreCloseSmallLossCents: 75,
        edgePreCloseMinutes: 5,
        minConfidence: 99,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'edge',
      side: 'yes',
      entryPriceCents: 50,
      contracts: 10,
      windowCloseTime: now + 3 * 60 * 1000,
      openedAt: now - 60 * 1000,
    });
    // (40-50)*10 = -100¢ < -75 → stay unless stop
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'edge keeps ticket when loss > $0.75 in final 5m');
  }

  // Edge: after 3m hold, stop rises to breakeven
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 50,
        no_bid: 50,
      }),
      {
        strategyMode: 'edge',
        stopLossCents: 23,
        edgeBreakevenAfterMinutes: 3,
        takeProfitCents: 40,
        minConfidence: 99,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'edge',
      side: 'yes',
      entryPriceCents: 55,
      contracts: 10,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now - 4 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'breakeven', 'edge BE stop after 3m hold exits at/under entry');
  }

  // Settle weak ticket: peak <80 + strong lean against → settle_weak_switch
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 70,
        no_bid: 30,
      }),
      { settleStopLossCents: 40, settleTieredExits: 'on', settleStuckHoldMinutes: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 72,
      peakHeldBidCents: 75,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now - 2 * 60 * 1000,
    });
    await bot._manageOpenTrade(
      trade,
      predictions(3000, {
        w5: win(30, 70),
        w10: win(30, 70),
        w15: win(30, 70),
      })
    );
    checkEq(trade.exitReason, 'settle_weak_switch', 'weak ticket exits on lean switch');
    checkEq(trade.status, 'closed', 'weak switch closes the trade');
    const weakSit = checkSameSideExitCooldown({
      lastTrade: trade,
      exitReasons: ['settle_weak_switch'],
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      cooldownMs: 2.5 * 60 * 1000,
      now: Date.now(),
      reasonVerb: 'weak-switched',
    });
    check(!weakSit.ok, 'weak switch blocks same-side reopen during sit-out');
  }

  // Settle confirmed (≥80 peak): lean switch does not force exit
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 78,
        no_bid: 22,
      }),
      { settleStopLossCents: 40, settleTieredExits: 'on', settleStuckHoldMinutes: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 72,
      peakHeldBidCents: 82,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now - 2 * 60 * 1000,
    });
    await bot._manageOpenTrade(
      trade,
      predictions(3000, {
        w5: win(30, 70),
        w10: win(30, 70),
        w15: win(30, 70),
      })
    );
    checkEq(trade.status, 'open', 'confirmed ≥80 peak ignores lean-switch exit');
    check(!trade.exitReason, 'no weak-switch exit after confirm');
  }

  // Second open only when an existing hold is green
  {
    const now = Date.now();
    const redClient = mockClient({
      status: 'open',
      close_time: new Date(now + 10 * 60 * 1000).toISOString(),
      yes_bid: 84,
      no_bid: 16,
    });
    const redBot = makeBot(redClient, {
      maxOpenPositions: 2,
      secondOpenRequiresGreen: 'on',
    });
    openTrade(redBot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 89,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    const blocked = await redBot._canOpenAdditionalPosition();
    check(!blocked.ok, 'second open blocked while only hold is red');
    check(/green/i.test(blocked.reason || ''), 'block reason mentions green');

    const greenClient = mockClient({
      status: 'open',
      close_time: new Date(now + 10 * 60 * 1000).toISOString(),
      yes_bid: 92,
      no_bid: 8,
    });
    const greenBot = makeBot(greenClient, {
      maxOpenPositions: 2,
      secondOpenRequiresGreen: 'on',
    });
    openTrade(greenBot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 89,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    const allowed = await greenBot._canOpenAdditionalPosition();
    check(allowed.ok, 'second open allowed when hold is green');
  }

  // Breakeven in final 5 without confidence hold
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 3 * 60 * 1000).toISOString(),
        yes_bid: 40,
        no_bid: 55,
      }),
      { minConfidence: 80, stopLossCents: 40, takeProfitCents: 40, edgePreCloseSmallLossCents: 0 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 3 * 60 * 1000,
    });
    await bot._manageOpenTrade(
      trade,
      predictions(3000, { w5: win(40, 40) }) // low confidence in our favor
    );
    checkEq(trade.exitReason, 'breakeven', 'breakeven in final 5');
  }

  // Signal flip in final 5
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 45,
        no_bid: 50,
      }),
      { minConfidence: 55, stopLossCents: 40, takeProfitCents: 40 }
    );
    const trade = openTrade(bot, { side: 'no', windowCloseTime: now + 2 * 60 * 1000, entryPriceCents: 50 });
    await bot._manageOpenTrade(trade, predictions(3000, { w5: win(70, 60) })); // UP favored → against NO
    checkEq(trade.exitReason, 'signal_flip', 'signal_flip');
  }

  // Strong reversal (w10+w15)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 40,
        no_bid: 55,
      }),
      { stopLossCents: 40, takeProfitCents: 40 }
    );
    const trade = openTrade(bot, { side: 'no', windowCloseTime: now + 12 * 60 * 1000 });
    await bot._manageOpenTrade(
      trade,
      predictions(3000, {
        w5: win(50, 50),
        w10: win(70, 70), // UP against NO
        w15: win(68, 70),
      })
    );
    checkEq(trade.exitReason, 'reversal_signal', 'reversal_signal');
  }

  // Settled timeout scratch
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'closed',
        result: '',
        close_time: new Date(now - 1000).toISOString(),
        yes_bid: null,
        no_bid: null,
        floor_strike: null,
      })
    );
    const trade = openTrade(bot, {
      windowCloseTime: now - 1000,
      floorStrike: null,
      entryPriceCents: 44,
    });
    await bot._manageOpenTrade(trade, { ETH: { ready: true, price: null, windows: { w5: win(50, 50), w10: win(50, 50), w15: win(50, 50) } } });
    checkEq(trade.exitReason, 'settled_timeout', 'settled_timeout scratch');
    checkEq(trade.exitPriceCents, 44, 'scratch at entry');
  }

  // Hold through TP when final-5 confidence high
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 20,
        no_bid: 80,
      }),
      { stopLossCents: 40, takeProfitCents: 15, minConfidence: 55, edgePreCloseSmallLossCents: 0 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 2 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000, { w5: win(30, 80) })); // DOWN favored strongly for NO
    checkEq(trade.status, 'open', 'hold through TP when confident');
  }

  // Last ~1 minute: bank green bid even if confidence would have held for settle
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 50 * 1000).toISOString(),
        yes_bid: 20,
        no_bid: 70,
      }),
      { stopLossCents: 40, takeProfitCents: 40, minConfidence: 55 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 50 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000, { w5: win(30, 80) }));
    checkEq(trade.exitReason, 'pre_close_bank', 'pre_close_bank in last minute when green');
  }

  // Near-certain ~97¢: bank even mid-window / during confidence hold
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 8 * 60 * 1000).toISOString(),
        yes_bid: 2,
        no_bid: 97,
      }),
      { stopLossCents: 40, takeProfitCents: 40, minConfidence: 55, nearCertainExitCents: 97 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 8 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'near_certain', 'near_certain at 97¢');
  }

  // Watchdog: forceSettleOverdue closes past-deadline opens without waiting on full manage
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'active',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        result: '',
        floor_strike: 3000,
        yes_bid: 40,
        no_bid: 55,
      })
    );
    // Hang getMarket to prove settle still happens via timeout + scratch/strike
    bot.client.getMarket = () => new Promise(() => {});
    const trade = openTrade(bot, {
      side: 'no',
      floorStrike: 3000,
      windowCloseTime: now - 2000,
    });
    const n = await bot.forceSettleOverdue(predictions(2950));
    check(n >= 1, 'forceSettleOverdue settled at least one');
    checkEq(trade.status, 'closed', 'overdue trade closed by watchdog path');
  }
}

// ───────────────────────────── bot: open / runCycle / skim / stake ─────────────────────────────

async function testBotTradingFlow() {
  section('bot.js open + runCycle + skim + stake');

  const now = Date.now();
  const market = {
    ticker: 'KXETH15M-LIVE',
    status: 'open',
    floor_strike: 3000,
    close_time: new Date(now + 12 * 60 * 1000).toISOString(),
    yes_bid: 40,
    yes_ask: 42,
    no_bid: 58,
    no_ask: 60,
  };
  const client = mockClient(market);
  const bot = makeBot(client, {
    symbol: 'ETH',
    edgeThresholdPct: 5,
    minConfidence: 50,
    stakeDollars: 10,
    skimMode: 'fixed',
    skimFixedDollars: 2,
  });

  // Strong YES edge: engine UP >> kalshi mid (~41)
  const preds = {
    ETH: {
      ready: true,
      price: 3010,
      windows: {
        w5: win(80, 80),
        w10: win(75, 75),
        w15: win(70, 70),
      },
    },
  };
  await bot.runCycle(preds);
  check(bot.openTrades.length === 1, 'runCycle opened a paper trade');
  check(bot.openTrades[0].side === 'yes', 'opened YES on positive edge');
  check(Number.isFinite(bot.openTrades[0].windowCloseTime), 'windowCloseTime stored');

  // Guardrail / max positions block second
  await bot.runCycle(preds);
  checkEq(bot.openTrades.length, 1, 'maxOpenPositions blocks second open');

  // One open per coin: max 2 slots must not stack both on ETH
  {
    const diversifyClient = {
      hasCredentials: false,
      async getOpenMarkets(series) {
        const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
        if (series.includes('ETH')) {
          return [{ ticker: 'ETH-A', close_time: close, floor_strike: 3000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
        }
        if (series.includes('BTC')) {
          return [{ ticker: 'BTC-A', close_time: close, floor_strike: 60000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
        }
        return [];
      },
      async getMarket() {
        return null;
      },
      async createOrder() {
        throw new Error('no');
      },
      async getBalance() {
        return { balance: 0, portfolio_value: 0 };
      },
    };
    const diversifyBot = makeBot(diversifyClient, {
      symbol: 'AUTO',
      maxOpenPositions: 2,
      edgeThresholdPct: 5,
      minConfidence: 50,
      stakeDollars: 10,
      skimMode: 'off',
    });
    const multiStrong = {
      ETH: { ready: true, price: 3010, windows: { w5: win(85, 90), w10: win(80, 85), w15: win(75, 80) } },
      BTC: { ready: true, price: 60100, windows: { w5: win(80, 85), w10: win(75, 80), w15: win(70, 75) } },
    };
    await diversifyBot.runCycle(multiStrong);
    checkEq(diversifyBot.openTrades.length, 1, 'first AUTO open fills one slot');
    const firstSym = diversifyBot.openTrades[0].symbol;
    await diversifyBot.runCycle(multiStrong);
    checkEq(diversifyBot.openTrades.length, 2, 'second slot opens on a different coin');
    const symbols = diversifyBot.openTrades.map((t) => t.symbol).sort();
    checkEq(symbols.join(','), 'BTC,ETH', 'max 2 diversifies across BTC+ETH, not same coin twice');
    check(!diversifyBot.openTrades.every((t) => t.symbol === firstSym), 'second open is not the same coin as first');

    // Explicit same-symbol stack still blocked even if forced
    await diversifyBot._openPosition({
      symbol: firstSym,
      ticker: `${firstSym}-DUP`,
      side: 'yes',
      priceCents: 42,
      floorStrike: 1,
      closeTime: Date.now() + 600_000,
      engineProbability: 70,
      engineConfidence: 70,
    });
    checkEq(diversifyBot.openTrades.length, 2, 'hard guard blocks third open on an occupied coin');
  }

  // Post-stop max-1: time-limited (default 1.5m), then maxOpenPositions again
  {
    const nowMs = Date.now();
    checkEq(postStopMaxOneAgeMs({}), Math.round(1.5 * 60 * 1000), 'post-stop max-1 defaults to 1.5 minutes');
    checkEq(postStopMaxOneAgeMs({ postStopMaxOneMinutes: 0 }), 0, 'post-stop max-1 0 disables cap');
    checkEq(postStopMaxOneAgeMs({ postStopMaxOneMinutes: 2 }), 2 * 60 * 1000, 'post-stop max-1 uses configured minutes');
    check(
      isPostStopMaxOneActive(
        { exitReason: 'stop_loss', closedAt: nowMs - 30_000 },
        { postStopMaxOneMinutes: 1.5 },
        nowMs
      ),
      'max-1 active within 1.5m of stop closedAt'
    );
    check(
      !isPostStopMaxOneActive(
        { exitReason: 'stop_loss', closedAt: nowMs - 100_000 },
        { postStopMaxOneMinutes: 1.5 },
        nowMs
      ),
      'max-1 inactive after 1.5m from stop closedAt'
    );
    check(
      !isPostStopMaxOneActive(
        { exitReason: 'stop_loss', closedAt: nowMs - 10_000 },
        { postStopMaxOneMinutes: 0 },
        nowMs
      ),
      'max-1 disabled when postStopMaxOneMinutes is 0'
    );

    const maxOneClient = {
      hasCredentials: false,
      async getOpenMarkets(series) {
        const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
        if (series.includes('ETH')) {
          return [{ ticker: 'ETH-M1', close_time: close, floor_strike: 3000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
        }
        if (series.includes('BTC')) {
          return [{ ticker: 'BTC-M1', close_time: close, floor_strike: 60000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
        }
        return [];
      },
      async getMarket() {
        return null;
      },
      async createOrder() {
        throw new Error('no');
      },
      async getBalance() {
        return { balance: 0, portfolio_value: 0 };
      },
    };
    const calmPreds = {
      ETH: { ready: true, price: 3010, windows: { w5: win(85, 90), w10: win(80, 85), w15: win(75, 80) } },
      BTC: { ready: true, price: 60100, windows: { w5: win(80, 85), w10: win(75, 80), w15: win(70, 75) } },
    };

    const youngStopBot = makeBot(maxOneClient, {
      symbol: 'AUTO',
      maxOpenPositions: 2,
      edgeThresholdPct: 5,
      minConfidence: 50,
      stakeDollars: 10,
      skimMode: 'off',
      stopRecoveryCents: 0,
      postStopMaxOneMinutes: 1.5,
    });
    youngStopBot.ledger.trades = [
      {
        id: 'open-btc',
        status: 'open',
        symbol: 'BTC',
        ticker: 'BTC-OPEN',
        side: 'yes',
        contracts: 10,
        stakeDollars: 10,
        entryPriceCents: 42,
        floorStrike: 60000,
        openedAt: nowMs - 60_000,
        windowCloseTime: nowMs + 10 * 60_000,
        engineProbability: 70,
        engineConfidence: 80,
      },
      {
        // Stopped a coin we are not about to re-rank first — max-1 still applies
        // from "latest closed is stop", independent of which symbol stopped.
        id: 'stop-xrp',
        status: 'closed',
        exitReason: 'stop_loss',
        symbol: 'XRP',
        side: 'yes',
        pnlCents: -200,
        entryPriceCents: 55,
        exitPriceCents: 42,
        closedAt: nowMs - 30_000,
        windowCloseTime: nowMs + 8 * 60_000,
      },
    ];
    await youngStopBot.runCycle(calmPreds);
    checkEq(youngStopBot.openTrades.length, 1, 'max-1 blocks 2nd open within 1.5m after stop');
    check(/max 1 open until post-stop/i.test(youngStopBot.lastDecision || ''), 'max-1 Waiting cites post-stop calm');
    checkEq(youngStopBot._lastProtectionGateKey, 'post-stop-max1', 'max-1 notes protection gate');

    const agedStopBot = makeBot(maxOneClient, {
      symbol: 'AUTO',
      maxOpenPositions: 2,
      edgeThresholdPct: 5,
      minConfidence: 50,
      stakeDollars: 10,
      skimMode: 'off',
      stopRecoveryCents: 0,
      postStopMaxOneMinutes: 1.5,
    });
    agedStopBot.ledger.trades = [
      {
        id: 'open-btc-aged',
        status: 'open',
        symbol: 'BTC',
        ticker: 'BTC-OPEN2',
        side: 'yes',
        contracts: 10,
        stakeDollars: 10,
        entryPriceCents: 42,
        floorStrike: 60000,
        openedAt: nowMs - 3 * 60_000,
        windowCloseTime: nowMs + 10 * 60_000,
        engineProbability: 70,
        engineConfidence: 80,
      },
      {
        id: 'stop-xrp-aged',
        status: 'closed',
        exitReason: 'stop_loss',
        symbol: 'XRP',
        side: 'yes',
        pnlCents: -200,
        entryPriceCents: 55,
        exitPriceCents: 42,
        closedAt: nowMs - 100_000, // > 1.5m
        windowCloseTime: nowMs + 8 * 60_000,
      },
    ];
    agedStopBot._lastProtectionGateKey = 'post-stop-max1';
    await agedStopBot.runCycle(calmPreds);
    checkEq(agedStopBot.openTrades.length, 2, 'after 1.5m post-stop, 2nd open allowed (maxOpenPositions)');
    check(
      agedStopBot.openTrades.some((t) => t.symbol === 'ETH'),
      'aged max-1 allows ETH as second slot'
    );
    check(agedStopBot._lastProtectionGateKey == null, 'max-1 protection clears after window ages out');
  }

  // Settle and skim (stop entries so a replacement trade isn't opened same cycle)
  const trade = bot.openTrades[0];
  const tradeId = trade.id;
  trade.windowCloseTime = now - 1000;
  client.getMarket = async () => ({
    ...market,
    status: 'closed',
    result: 'yes',
    close_time: new Date(now - 1000).toISOString(),
  });
  bot.setRunning(false);
  await bot.runCycle(preds);
  checkEq(bot.openTrades.length, 0, 'settled trade no longer open');
  const closed = bot.ledger.trades.find((t) => t.id === tradeId);
  check(closed && closed.status === 'closed', 'original trade marked closed');
  check(closed && closed.pnlCents > 0, 'winning settle has positive PnL');
  check(closed.skimmedCents === 200 || bot.ledger.reserveCents >= 200, 'fixed skim applied');

  // Insurance: 20/40/40; hysteresis arm $10 / floor $6; soft overflow $15
  {
    const insSettings = {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 6,
      insuranceOverflowDollars: 15,
    };

    const win = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 0,
      insuranceCents: 0,
      insuranceReady: false,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(win.skimmedCents, 400, 'insurance win: 40% wallet');
    checkEq(win.insuranceAddedCents, 200, 'insurance win: 20% to fund');
    checkEq(win.insuranceCents, 200, 'insurance fund balance');
    checkEq(win.insuranceOverflowCents, 0, 'under overflow: no overflow');
    checkEq(win.insuranceReady, false, 'under arm: not ready after small win');

    const keepGoing = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: 1000,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(keepGoing.insuranceAddedCents, 200, 'keeps taking 20% past arm');
    checkEq(keepGoing.insuranceCents, 1200, 'fund can grow above $10 toward overflow');
    checkEq(keepGoing.insuranceOverflowCents, 0, 'past arm but under overflow: no overflow');
    checkEq(keepGoing.insuranceReady, true, 'stays ready above arm');

    // Fill exactly to $15 overflow ceiling
    const fillToOverflow = applyProfitBuckets({
      pnlCents: 1500,
      reserveCents: 0,
      insuranceCents: 1200,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(fillToOverflow.insuranceAddedCents, 300, 'fills remaining room to $15');
    checkEq(fillToOverflow.insuranceCents, 1500, 'fund at overflow cap $15');
    checkEq(fillToOverflow.insuranceOverflowCents, 0, 'exact fill: no overflow skim');
    checkEq(fillToOverflow.skimmedCents, 600, 'wallet still 40% at exact fill');

    // At cap: full 20% → Available
    const atCapOverflow = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: 1500,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(atCapOverflow.insuranceAddedCents, 0, 'at overflow: no insurance add');
    checkEq(atCapOverflow.insuranceCents, 1500, 'at overflow: fund stays at $15 (no auto-empty)');
    checkEq(atCapOverflow.insuranceOverflowCents, 200, 'at overflow: 20% → available');
    checkEq(atCapOverflow.skimmedCents, 400, 'at overflow: wallet still 40%');

    // Partial overflow: fill up to $15, remainder of 20% → Available
    const partialOverflow = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 0,
      insuranceCents: 1400,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(partialOverflow.insuranceAddedCents, 100, 'partial: fills $1 to cap');
    checkEq(partialOverflow.insuranceCents, 1500, 'partial: fund at $15');
    checkEq(partialOverflow.insuranceOverflowCents, 100, 'partial: remainder of 20% → available');
    checkEq(partialOverflow.skimmedCents, 400, 'partial: wallet still 40%');

    // Resume fill after a loss draws fund below $15
    const afterDraw = applyProfitBuckets({
      pnlCents: -300,
      reserveCents: 400,
      insuranceCents: 1500,
      insuranceReady: true,
      settings: insSettings,
    });
    checkEq(afterDraw.insuranceDrawnCents, 300, 'draw from full fund');
    checkEq(afterDraw.insuranceCents, 1200, 'after draw: below overflow');
    checkEq(afterDraw.insuranceReady, true, 'after modest draw: still ready');

    const resumeFill = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: afterDraw.insuranceCents,
      insuranceReady: afterDraw.insuranceReady,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(resumeFill.insuranceAddedCents, 200, 'resume: 20% fills again after draw');
    checkEq(resumeFill.insuranceCents, 1400, 'resume: fund rebuilding toward $15');
    checkEq(resumeFill.insuranceOverflowCents, 0, 'resume: under cap, no overflow');

    const absorbEarly = applyProfitBuckets({
      pnlCents: -800,
      reserveCents: 400,
      insuranceCents: 500,
      insuranceReady: false,
      settings: insSettings,
    });
    checkEq(absorbEarly.insuranceDrawnCents, 0, 'not ready: hold fund, do not absorb yet');
    checkEq(absorbEarly.insuranceCents, 500, 'not ready: insurance unchanged on loss');
    checkEq(absorbEarly.insuranceReady, false, 'not ready stays not ready under arm');

    const absorbAtArm = applyProfitBuckets({
      pnlCents: -800,
      reserveCents: 400,
      insuranceCents: 1000,
      insuranceReady: false,
      settings: insSettings,
    });
    checkEq(absorbAtArm.insuranceDrawnCents, 800, 'at arm: sync arms then absorbs loss');
    checkEq(absorbAtArm.insuranceCents, 200, 'at arm: insurance reduced');
    checkEq(absorbAtArm.insuranceReady, false, 'drawn below floor → not ready');
    checkEq(absorbAtArm.reserveCents, 400, 'wallet untouched by loss');

    // Wallet append-only across win → loss → win
    let walletLock = 0;
    const w1 = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: walletLock,
      insuranceCents: 0,
      insuranceReady: false,
      settings: insSettings,
    });
    walletLock = w1.reserveCents;
    checkEq(walletLock, 400, 'win locks 40% into wallet');
    const lossHit = applyProfitBuckets({
      pnlCents: -500,
      reserveCents: walletLock,
      insuranceCents: w1.insuranceCents,
      insuranceReady: w1.insuranceReady,
      settings: insSettings,
    });
    checkEq(lossHit.reserveCents, walletLock, 'loss never debits wallet');
    const w2 = applyProfitBuckets({
      pnlCents: 500,
      reserveCents: lossHit.reserveCents,
      insuranceCents: lossHit.insuranceCents,
      insuranceReady: lossHit.insuranceReady,
      settings: insSettings,
    });
    check(w2.reserveCents > walletLock, 'next win only adds to wallet');
    checkEq(w2.reserveCents, walletLock + 200, 'wallet grows by 40% of second win');

    // Absorb at $8 while ready (hysteresis band)
    const absorbMid = applyProfitBuckets({
      pnlCents: -200,
      reserveCents: 400,
      insuranceCents: 800,
      insuranceReady: true,
      settings: insSettings,
    });
    checkEq(absorbMid.insuranceDrawnCents, 200, 'ready at $8: still absorbs');
    checkEq(absorbMid.insuranceCents, 600, 'ready at $8: balance after draw');
    checkEq(absorbMid.insuranceReady, true, 'exactly at floor: still ready');

    // Drop below $6 → stop absorbing / disarm
    const absorbBelow = applyProfitBuckets({
      pnlCents: -200,
      reserveCents: 400,
      insuranceCents: 600,
      insuranceReady: true,
      settings: insSettings,
    });
    checkEq(absorbBelow.insuranceDrawnCents, 200, 'at floor: still absorbs once');
    checkEq(absorbBelow.insuranceCents, 400, 'below floor after draw');
    checkEq(absorbBelow.insuranceReady, false, 'below $6: not ready');

    const noAbsorbDisarmed = applyProfitBuckets({
      pnlCents: -100,
      reserveCents: 400,
      insuranceCents: 800,
      insuranceReady: false,
      settings: insSettings,
    });
    checkEq(noAbsorbDisarmed.insuranceDrawnCents, 0, 'disarmed at $8: Available takes loss');
    checkEq(noAbsorbDisarmed.insuranceCents, 800, 'disarmed: insurance unchanged');
    checkEq(noAbsorbDisarmed.insuranceReady, false, 're-arm only at $10, not at $8');

    // Re-arm only when balance ≥ $10
    const rearm = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: 900,
      insuranceReady: false,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(rearm.insuranceCents, 1100, 'win brings fund to arm');
    checkEq(rearm.insuranceReady, true, 're-arms at $10');

    const insBot = makeBot(mockClient(market), {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 6,
      insuranceOverflowDollars: 15,
      stakeDollars: 10,
    });
    const tBoot = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tBoot, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 200, 'first win takes 20% from the start');
    checkEq(insBot.ledger.reserveCents, 400, 'first win wallets 40%');
    for (let i = 0; i < 6; i += 1) {
      const t = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
      await insBot._closePosition(t, 60, 'take_profit');
    }
    // 7 wins × $2 = $14
    checkEq(insBot.ledger.insuranceCents, 1400, 'bot fills toward overflow ($14)');
    check(insBot.ledger.insuranceCents >= 1000, 'fills arm $10');
    checkEq(insBot.ledger.insuranceReady, true, 'marked ready after arm');
    const tToCap = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tToCap, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 1500, 'bot fills to overflow cap $15');
    checkEq(tToCap.insuranceAddedCents, 100, 'bot partial: $1 into fund');
    checkEq(tToCap.insuranceOverflowCents, 100, 'bot partial: $1 → available');
    const tOverflow = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tOverflow, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 1500, 'bot at cap: fund unchanged');
    checkEq(tOverflow.insuranceAddedCents, 0, 'bot at cap: no insurance add');
    checkEq(tOverflow.insuranceOverflowCents, 200, 'bot at cap: full 20% → available');
    check(/Insurance full — \$2\.00 → available/.test(insBot.lastDecision), 'activity notes overflow to available');

    // Resume after draw below $15
    insBot.ledger.insuranceCents = 1200;
    insBot.ledger.insuranceReady = true;
    const tResume = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tResume, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 1400, 'bot resume fill after draw below cap');
    checkEq(tResume.insuranceOverflowCents, 0, 'bot resume: no overflow under cap');

    // Bot path: absorb while ready in the $6–$10 band, then disarm below floor
    // Loss of $2: 20 contracts × 10¢ drop (50→40)
    insBot.ledger.insuranceCents = 800;
    insBot.ledger.insuranceReady = true;
    const tLossMid = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 20 });
    await insBot._closePosition(tLossMid, 40, 'stop_loss');
    checkEq(insBot.ledger.insuranceCents, 600, 'bot: absorb at $8 while ready → $6');
    checkEq(insBot.ledger.insuranceReady, true, 'bot: still ready at floor');
    const tLossFloor = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 20 });
    await insBot._closePosition(tLossFloor, 40, 'stop_loss');
    checkEq(insBot.ledger.insuranceCents, 400, 'bot: draw below floor');
    checkEq(insBot.ledger.insuranceReady, false, 'bot: disarmed below $6');

    // Floor clamp when floor >= arm
    const clamped = makeBot(mockClient(market), {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 15,
      insuranceOverflowDollars: 15,
    });
    check(clamped.config.insuranceFloorDollars < clamped.config.insuranceCapDollars, 'floor clamped below arm');
    checkEq(clamped.config.insuranceFloorDollars, 9, 'floor clamped to arm-1');
    checkEq(clamped.config.insuranceOverflowDollars, 15, 'overflow default preserved');
  }

  // Manual external insurance seed / top-up
  {
    const seedBot = makeBot(mockClient(market), {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 6,
      paperStartingBalanceDollars: 100,
    });
    seedBot.config.insuranceCapDollars = 10;
    seedBot.config.insuranceFloorDollars = 6;
    const beforeCap = seedBot._capitalStatus();
    checkEq(beforeCap.insuranceCents, 0, 'starts with empty insurance');
    checkEq(beforeCap.paperAvailableCents, 10000, 'starts with full Available');
    checkEq(beforeCap.insuranceCapCents, 1000, 'capital reports arm cents');
    checkEq(beforeCap.insuranceFloorCents, 600, 'capital reports floor cents');
    checkEq(beforeCap.insuranceOverflowCents, 1500, 'capital reports overflow cents');

    const badZero = seedBot.depositInsurance(0);
    checkEq(badZero.ok, false, 'rejects zero deposit');
    const badNeg = seedBot.depositInsurance(-5);
    checkEq(badNeg.ok, false, 'rejects negative deposit');
    const badHuge = seedBot.depositInsurance(501);
    checkEq(badHuge.ok, false, 'rejects over $500 per call');

    const underArm = seedBot.depositInsurance(8);
    checkEq(underArm.ok, true, 'accepts $8 seed');
    checkEq(seedBot.ledger.insuranceCents, 800, 'under-arm seed credits insurance');
    checkEq(seedBot.ledger.insuranceReady, false, 'under arm: deposit does not arm');

    const seeded = seedBot.depositInsurance(2);
    checkEq(seeded.ok, true, 'accepts top-up to arm');
    checkEq(seedBot.ledger.insuranceCents, 1000, 'seed credits insurance to $10');
    checkEq(seedBot.ledger.insuranceDepositedCents, 1000, 'tracks external deposit');
    checkEq(seedBot.ledger.insuranceReady, true, 'ready flips at arm via deposit');
    const afterSeed = seedBot._capitalStatus();
    checkEq(afterSeed.paperAvailableCents, beforeCap.paperAvailableCents, 'Available unchanged by external seed');
    checkEq(afterSeed.insuranceCents, 1000, 'capital shows seeded insurance');
    checkEq(afterSeed.paperTotalCents, beforeCap.paperTotalCents + 1000, 'total capital rises by deposit');
    check(
      (seedBot.ledger.activityLog || []).some((e) => /Insurance seeded \+\$2\.00/.test(e.message)),
      'activity log records manual seed'
    );

    const topUp = seedBot.depositInsurance(2.5);
    checkEq(topUp.ok, true, 'accepts top-up');
    checkEq(seedBot.ledger.insuranceCents, 1250, 'top-up adds to insurance');
    checkEq(seedBot.ledger.insuranceDepositedCents, 1250, 'top-up tracked in deposits');
    const afterTop = seedBot._capitalStatus();
    checkEq(afterTop.paperAvailableCents, beforeCap.paperAvailableCents, 'Available still unchanged after top-up');

    // Persist + reload so UI status refresh would see the seeded fund.
    seedBot._persist();
    const ledgerPath = dataPath('bot-ledger.json');
    check(fs.existsSync(ledgerPath), 'ledger file written after insurance deposit');
    const reloaded = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    checkEq(reloaded.insuranceCents, 1250, 'persisted insuranceCents survives reload');
    checkEq(reloaded.insuranceDepositedCents, 1250, 'persisted insuranceDepositedCents survives reload');

    // String dollars (JSON body / form-like) must still credit.
    const fromString = seedBot.depositInsurance('1.00');
    checkEq(fromString.ok, true, 'accepts string dollar amount');
    checkEq(seedBot.ledger.insuranceCents, 1350, 'string deposit credits cents');
  }

  // UI: insurance deposit controls must not duplicate ids across dashboard + overlay
  {
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    check(
      /buildCapitalLedgerHtml\(capital,\s*\{\s*depositControls:\s*true\s*\}\)/.test(appSrc),
      'overlay status uses depositControls: true'
    );
    check(
      /buildCapitalLedgerHtml\(capital,\s*\{\s*depositControls:\s*false\s*\}\)/.test(appSrc),
      'dashboard uses depositControls: false (no duplicate ids)'
    );
    check(
      /function insuranceDepositEls\(/.test(appSrc) && /getElementById\('bot-overlay'\)/.test(appSrc),
      'deposit UI scopes lookups to bot-overlay'
    );
    const depositIdHits = (appSrc.match(/id="bot-insurance-deposit"/g) || []).length;
    checkEq(depositIdHits, 1, 'deposit input id template appears once in app.js');
  }

  // Reject bad entry prices
  const badBot = makeBot(client);
  await badBot._openPosition({
    symbol: 'ETH',
    ticker: 'X',
    side: 'yes',
    priceCents: null,
    floorStrike: 1,
    closeTime: now + 600_000,
    engineProbability: 60,
    engineConfidence: 60,
  });
  checkEq(badBot.openTrades.length, 0, 'rejects null entry price');

  await badBot._openPosition({
    symbol: 'ETH',
    ticker: 'X',
    side: 'yes',
    priceCents: 50,
    floorStrike: 1,
    closeTime: now - 1000,
    engineProbability: 60,
    engineConfidence: 60,
  });
  checkEq(badBot.openTrades.length, 0, 'rejects already-ending close time');

  // Relative stops allow cheap entries (no absolute floor); stop is entry−drop
  {
    const stopBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-CHEAP',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        yes_bid: 90,
        yes_ask: 96,
        no_bid: 4,
        no_ask: 10,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        stopLossCents: 10,
        takeProfitCents: 15,
        minEntryCents: 1,
        stakeDollars: 10,
      }
    );
    const fadePreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: win(70, 80),
          w10: win(68, 75),
          w15: win(65, 70),
        },
      },
    };
    const cheapOpp = await stopBot._evaluateSymbolForEdge('ETH', fadePreds);
    check(cheapOpp && cheapOpp.side === 'no', 'relative stop still allows cheap NO fade entry');
    checkEq(stopBot._stopLevelCents({ entryPriceCents: 10 }), 1, 'cheap entry stop clamps to 1¢');
    checkEq(stopBot._takeProfitLevelCents({ entryPriceCents: 10 }), 25, 'cheap entry TP is entry+rise');
  }

  // Min entry ban blocks longshots even with high confidence
  {
    const banBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-CHEAP2',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        yes_bid: 90,
        yes_ask: 96,
        no_bid: 4,
        no_ask: 10,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        minEntryCents: 25,
        stakeDollars: 10,
      }
    );
    const fadePreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: { w5: win(70, 80), w10: win(68, 75), w15: win(65, 70) },
      },
    };
    const banned = await banBot._evaluateSymbolForEdge('ETH', fadePreds);
    checkEq(banned, null, 'min entry ban skips ~10¢ NO');
    check(/min entry|longshot/i.test(banBot.lastDecision || ''), 'decision mentions min entry');
  }

  // Post-stop recovery: same-side blocked until bid bounces (not a timer)
  {
    checkEq(stopRecoveryCentsRequired({ stopRecoveryCents: 0 }), 0, 'recovery 0 disables gate');
    checkEq(stopRecoveryCentsRequired({ stopRecoveryCents: 6 }), 6, 'recovery uses configured cents');
    check(stopRecoveryCentsRequired({ stopLossCents: 23 }) >= 5, 'auto recovery floors at 5¢');

    const blocked = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
      },
      side: 'yes',
      priceCents: 42,
      window: { probabilityUp: 60, probabilityDown: 40 },
      recoveryCents: 8,
      symbol: 'ETH',
    });
    check(!blocked.ok, 'blocks same-side when bid has not bounced enough');
    check(/bounce|recovery|stopped/i.test(blocked.reason || ''), 'block reason mentions recovery');

    const flipped = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'ETH',
      },
      side: 'yes',
      priceCents: 42,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'ETH',
      forCandidateSymbol: 'BTC',
    });
    check(!flipped.ok, 'blocks opposite-coin entry until stopped coin recovers (no instant side-flip)');

    const recovered = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'ETH',
      },
      side: 'yes',
      priceCents: 49,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 8,
      symbol: 'ETH',
    });
    check(recovered.ok, 'allows entry after bounce + engine favor');

    const crossBlocked = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'ETH',
      },
      side: 'yes',
      priceCents: 42,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 8,
      symbol: 'ETH',
      forCandidateSymbol: 'BTC',
    });
    check(!crossBlocked.ok, 'same recovery blocks other-coin entry until stopped coin bounces');
    check(/BTC/i.test(crossBlocked.reason || ''), 'cross-coin block mentions the candidate');

    const noFavor = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'ETH',
      },
      side: 'yes',
      priceCents: 55,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'ETH',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
    });
    check(!noFavor.ok, 'blocks when bid bounced but engine flipped against stopped side');
    check(/knife-catch|no longer favors/i.test(noFavor.reason || ''), 'same-coin thesis block mentions knife-catch');

    // Screenshot bug: SOL bounce cleared but thesis flipped — must NOT freeze ETH/peers.
    const peerAfterBounce = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'SOL',
        closedAt: Date.now() - 5 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 55,
      window: { probabilityUp: 35, probabilityDown: 65 },
      recoveryCents: 8,
      symbol: 'SOL',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
    });
    check(peerAfterBounce.ok, 'peer coin unlocks after stopped-coin bounce even if thesis flipped');

    const oppositeSameCoin = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'SOL',
      },
      side: 'yes',
      priceCents: 55,
      window: { probabilityUp: 35, probabilityDown: 65 },
      recoveryCents: 8,
      symbol: 'SOL',
      forCandidateSymbol: 'SOL',
      forCandidateSide: 'no',
    });
    check(oppositeSameCoin.ok, 'opposite side on stopped coin unlocks after bounce (no thesis hostage)');

    checkEq(postStopSameSideCooldownMs({}), 2 * 60 * 1000, 'same-side cooldown defaults to 2m');
    checkEq(postStopSameSideCooldownMs({ postStopSameSideCooldownMinutes: 0 }), 0, 'same-side cooldown 0 disables');
    checkEq(
      postStopSameSideCooldownMs({ postStopSameSideCooldownMinutes: 3 }),
      3 * 60 * 1000,
      'same-side cooldown uses configured minutes'
    );

    const knifeCatchSitOut = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: Date.now() - 30 * 1000,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 69,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 6,
      symbol: 'DOGE',
      forCandidateSymbol: 'DOGE',
      forCandidateSide: 'yes',
      sameSideCooldownMs: 2 * 60 * 1000,
    });
    check(!knifeCatchSitOut.ok, 'DOGE YES blocked for 2m sit-out even if bounce+thesis ok');
    check(/same-side sit-out/i.test(knifeCatchSitOut.reason || ''), 'sit-out reason mentions same-side');

    const ethAfterDogeStop = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: Date.now() - 30 * 1000,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 69,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 6,
      symbol: 'DOGE',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      sameSideCooldownMs: 2 * 60 * 1000,
    });
    check(ethAfterDogeStop.ok, 'ETH allowed during DOGE same-side sit-out (bounce met)');

    const dogeNoDuringSitOut = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: Date.now() - 30 * 1000,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 69,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 6,
      symbol: 'DOGE',
      forCandidateSymbol: 'DOGE',
      forCandidateSide: 'no',
      sameSideCooldownMs: 2 * 60 * 1000,
    });
    check(dogeNoDuringSitOut.ok, 'DOGE NO allowed during YES same-side sit-out');

    const dogeYesAfterSitOut = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: Date.now() - 3 * 60 * 1000,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 69,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 6,
      symbol: 'DOGE',
      forCandidateSymbol: 'DOGE',
      forCandidateSide: 'yes',
      sameSideCooldownMs: 2 * 60 * 1000,
    });
    check(dogeYesAfterSitOut.ok, 'DOGE YES allowed after 2m sit-out when bounce+thesis ok');

    const sitOutSurvivesSessionEnd = checkPostStopSameSideCooldown({
      lastStopTrade: {
        exitReason: 'stop_loss',
        side: 'yes',
        symbol: 'DOGE',
        closedAt: Date.now() - 30 * 1000,
        windowCloseTime: Date.now() - 5 * 1000,
      },
      forCandidateSymbol: 'DOGE',
      forCandidateSide: 'yes',
      cooldownMs: 2 * 60 * 1000,
    });
    check(!sitOutSurvivesSessionEnd.ok, 'same-side sit-out still applies after window end until 2m');

    checkEq(stopRecoveryMaxAgeMs({ stopRecoveryMaxMinutes: 0 }), 0, 'max age 0 disables expiry');
    checkEq(stopRecoveryMaxAgeMs({ stopRecoveryMaxMinutes: 15 }), 15 * 60 * 1000, 'max age uses configured minutes');
    checkEq(stopRecoveryMaxAgeMs({}), 15 * 60 * 1000, 'max age defaults to 15 minutes');

    const agedOut = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'SOL',
        closedAt: Date.now() - 20 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 41,
      window: { probabilityUp: 30, probabilityDown: 70 },
      recoveryCents: 8,
      symbol: 'SOL',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
    });
    check(agedOut.ok, 'recovery gate expires after max age even without bounce');

    const stillYoung = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'SOL',
        closedAt: Date.now() - 2 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 41,
      window: { probabilityUp: 30, probabilityDown: 70 },
      recoveryCents: 8,
      symbol: 'SOL',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
    });
    check(!stillYoung.ok, 'recovery gate still blocks peers before bounce within max age');

    // Prior session stop must not block next window (even before max-age expires).
    const priorWindowEnd = Date.now() - 2 * 60 * 1000;
    const priorSessionStop = {
      exitReason: 'stop_loss',
      side: 'no',
      exitPriceCents: 50,
      entryPriceCents: 65,
      symbol: 'BTC',
      closedAt: Date.now() - 5 * 60 * 1000,
      windowCloseTime: priorWindowEnd,
    };
    check(isPostStopRecoverySessionExpired(priorSessionStop), 'session expired once stop window closed');
    const nextSessionAllowed = checkPostStopRecovery({
      lastClosedForSymbol: priorSessionStop,
      side: 'no',
      priceCents: 42,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'BTC',
      forCandidateSymbol: 'XRP',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
    });
    check(nextSessionAllowed.ok, 'next-session candidate allowed without bounce after stop window closed');

    const sameSessionStillBlocks = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'no',
        exitPriceCents: 50,
        entryPriceCents: 65,
        symbol: 'BTC',
        closedAt: Date.now() - 2 * 60 * 1000,
        windowCloseTime: Date.now() + 8 * 60 * 1000,
      },
      side: 'no',
      priceCents: 52,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'BTC',
      forCandidateSymbol: 'XRP',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
    });
    check(!sameSessionStillBlocks.ok, 'same-session stop still blocks peers until bounce');
    check(/same-window cascade/i.test(sameSessionStillBlocks.reason || ''), 'block reason says same-window not forever');

    // Same-coin same-side sit-out after stop (knife-catch cooldown), even when bounce+thesis ok
    {
      checkEq(
        postStopSameSideCooldownMs({}),
        2 * 60 * 1000,
        'same-side cooldown defaults to 2 minutes'
      );
      checkEq(
        postStopSameSideCooldownMs({ postStopSameSideCooldownMinutes: 0 }),
        0,
        'same-side cooldown 0 disables'
      );
      checkEq(
        postStopSameSideCooldownMs({ postStopSameSideCooldownMinutes: 3 }),
        3 * 60 * 1000,
        'same-side cooldown uses configured minutes'
      );

      const dogeStopAt = Date.now() - 30_000;
      const dogeStop = {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: dogeStopAt,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      };
      const bouncedFavorYes = {
        lastClosedForSymbol: dogeStop,
        side: 'yes',
        priceCents: 69,
        window: { probabilityUp: 70, probabilityDown: 30 },
        recoveryCents: 6,
        symbol: 'DOGE',
        forCandidateSymbol: 'DOGE',
        forCandidateSide: 'yes',
        sameSideCooldownMs: 2 * 60 * 1000,
        now: dogeStopAt + 30_000,
      };
      const dogeYesBlocked = checkPostStopRecovery(bouncedFavorYes);
      check(!dogeYesBlocked.ok, 'DOGE YES blocked for 2m after stop even if bid bounced + thesis favors');
      check(
        /same-side sit-out ~2m/i.test(dogeYesBlocked.reason || ''),
        'same-side block message mentions sit-out ~2m'
      );
      checkEq(
        makeBot(mockClient({}))._protectionGateKey(dogeYesBlocked.reason),
        'same-side-cooldown',
        'protection gate key is same-side-cooldown'
      );

      // Symbol-scoped gates: other coins passing must not spam used/cleared.
      {
        const gateBot = makeBot(mockClient({}));
        const hypeReason =
          'Waiting: HYPE YES stopped (stop_loss) — same-side sit-out ~5m before re-entry.';
        gateBot._noteProtectionGate(hypeReason, { fromSymbol: 'HYPE' });
        const afterUsed = (gateBot.ledger.activityLog || []).filter((e) =>
          /Protection used \(same-side-cooldown\)/i.test(e.message || '')
        ).length;
        gateBot._noteProtectionGate(null, { fromSymbol: 'BNB' });
        gateBot._noteProtectionGate(null, { fromSymbol: 'NEAR' });
        gateBot._noteProtectionGate(hypeReason, { fromSymbol: 'HYPE' });
        const cleared = (gateBot.ledger.activityLog || []).filter((e) =>
          /Protection cleared \(same-side-cooldown\)/i.test(e.message || '')
        ).length;
        const usedAgain = (gateBot.ledger.activityLog || []).filter((e) =>
          /Protection used \(same-side-cooldown\)/i.test(e.message || '')
        ).length;
        checkEq(cleared, 0, 'other coins passing do not clear HYPE same-side gate');
        checkEq(usedAgain, afterUsed, 'HYPE same-side does not re-log every cycle');
        gateBot._noteProtectionGate(null, { fromSymbol: 'HYPE' });
        const clearedByHype = (gateBot.ledger.activityLog || []).filter((e) =>
          /Protection cleared \(same-side-cooldown\)/i.test(e.message || '')
        ).length;
        checkEq(clearedByHype, 1, 'HYPE itself clearing logs once when sit-out ends');
      }

      const dogeNoOk = checkPostStopRecovery({
        ...bouncedFavorYes,
        forCandidateSide: 'no',
        window: { probabilityUp: 30, probabilityDown: 70 },
      });
      check(dogeNoOk.ok, 'DOGE NO allowed after bounce (opposite side, cooldown does not apply)');

      const ethOk = checkPostStopRecovery({
        ...bouncedFavorYes,
        forCandidateSymbol: 'ETH',
        forCandidateSide: 'yes',
      });
      check(ethOk.ok, 'ETH allowed after DOGE bounce (peer coin, cooldown does not apply)');

      const afterCooldown = checkPostStopRecovery({
        ...bouncedFavorYes,
        now: dogeStopAt + 2 * 60 * 1000 + 1,
      });
      check(afterCooldown.ok, 'DOGE YES allowed after 2m same-side sit-out');

      const disabled = checkPostStopRecovery({
        ...bouncedFavorYes,
        sameSideCooldownMs: 0,
      });
      check(disabled.ok, 'same-side cooldown 0 allows knife-catch when bounce+thesis ok');

      // Cooldown from closedAt even after session expiry (prefer keep until 2m)
      const sessionEndedStop = {
        ...dogeStop,
        windowCloseTime: dogeStopAt + 10_000,
      };
      check(
        isPostStopRecoverySessionExpired(sessionEndedStop, dogeStopAt + 30_000),
        'session expired for cooldown-vs-session fixture'
      );
      const stillSitOut = checkPostStopRecovery({
        ...bouncedFavorYes,
        lastClosedForSymbol: sessionEndedStop,
        now: dogeStopAt + 30_000,
      });
      check(!stillSitOut.ok, 'same-side sit-out still blocks after session end until 2m from closedAt');
      check(
        checkPostStopSameSideCooldown({
          lastStopTrade: dogeStop,
          forCandidateSymbol: 'DOGE',
          forCandidateSide: 'yes',
          cooldownMs: 2 * 60 * 1000,
          now: dogeStopAt + 30_000,
        }).ok === false,
        'checkPostStopSameSideCooldown blocks DOGE YES inside window'
      );
    }

    checkEq(tradeWindowCloseMs({ closeTime: 12345 }), 12345, 'tradeWindowCloseMs reads backtest closeTime');

    const recBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-REC',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        yes_bid: 48,
        yes_ask: 50,
        no_bid: 50,
        no_ask: 52,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        minEntryCents: 20,
        stopRecoveryCents: 8,
        stopLossCents: 15,
      }
    );
    recBot.ledger.trades = [
      {
        id: 't1',
        status: 'closed',
        symbol: 'ETH',
        side: 'yes',
        exitReason: 'stop_loss',
        exitPriceCents: 45,
        entryPriceCents: 60,
        pnlCents: -150,
      },
    ];
    const recPreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: { w5: win(70, 80), w10: win(68, 75), w15: win(65, 70) },
      },
    };
    const blockedOpp = await recBot._evaluateSymbolForEdge('ETH', recPreds);
    checkEq(blockedOpp, null, 'evaluate blocks YES re-entry before recovery bounce');
    check(/stopped|bounce|recovery/i.test(recBot.lastDecision || ''), 'decision explains post-stop wait');
  }

  // No new entries in the final 3 minutes of a window
  {
    const now = Date.now();
    const lateBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-LATE',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 40,
        yes_ask: 42,
        no_bid: 58,
        no_ask: 60,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        minEntryCents: 20,
        minMinutesToOpen: 3,
      }
    );
    const latePreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: { w5: win(80, 80), w10: win(75, 75), w15: win(70, 70) },
      },
    };
    const lateOpp = await lateBot._evaluateSymbolForEdge('ETH', latePreds);
    checkEq(lateOpp, null, 'blocks open with only ~2 min left');
    check(/min left|to open/i.test(lateBot.lastDecision || ''), 'decision mentions min time to open');
  }

  // Relative TP: flat at entry does not take profit; need entry+rise
  {
    const flatBot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        yes_bid: 90,
        no_bid: 10,
      }),
      { stopLossCents: 40, takeProfitCents: 15 }
    );
    const flatTrade = openTrade(flatBot, {
      side: 'yes',
      entryPriceCents: 90,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    await flatBot._manageOpenTrade(flatTrade, predictions(3010));
    checkEq(flatTrade.status, 'open', 'does not take_profit at flat 90→90 (needs +15 → 99)');
  }

  // Expired markets skipped
  const expiredClient = mockClient(null, {
    openMarkets: [
      {
        ticker: 'OLD',
        close_time: new Date(now - 1000).toISOString(),
        floor_strike: 3000,
        yes_bid: 40,
        yes_ask: 42,
        no_bid: 58,
        no_ask: 60,
      },
    ],
  });
  const skipBot = makeBot(expiredClient, { symbol: 'ETH', minConfidence: 1, edgeThresholdPct: 1 });
  const opp = await skipBot._evaluateSymbolForEdge('ETH', preds);
  checkEq(opp, null, 'expired market not tradeable');

  // AUTO picks best ranked
  const autoClient = {
    hasCredentials: false,
    async getOpenMarkets(series) {
      const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
      if (series.includes('ETH')) {
        return [{ ticker: 'ETH', close_time: close, floor_strike: 3000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
      }
      if (series.includes('BTC')) {
        return [{ ticker: 'BTC', close_time: close, floor_strike: 60000, yes_bid: 48, yes_ask: 50, no_bid: 50, no_ask: 52 }];
      }
      return [];
    },
    async getMarket() {
      return null;
    },
    async createOrder() {
      throw new Error('no');
    },
  };
  const autoBot = makeBot(autoClient, { symbol: 'AUTO', minConfidence: 50, edgeThresholdPct: 5 });
  const multi = {
    ETH: { ready: true, price: 3000, windows: { w5: win(85, 90), w10: win(80, 85), w15: win(75, 80) } },
    BTC: { ready: true, price: 60000, windows: { w5: win(56, 60), w10: win(55, 58), w15: win(54, 56) } },
  };
  const best = await autoBot._findBestOpportunity(multi);
  check(best && best.symbol === 'ETH', 'AUTO ranks stronger ETH edge first');

  // After stop on ETH, prefer another crypto even if ETH still ranks highest
  autoBot.config.stopRecoveryCents = 0;
  autoBot.ledger.trades = [
    {
      status: 'closed',
      symbol: 'ETH',
      side: 'yes',
      exitReason: 'stop_loss',
      exitPriceCents: 30,
      entryPriceCents: 50,
      pnlCents: -200,
    },
  ];
  checkEq(autoBot._lastStopLossSymbol(), 'ETH', 'last stop symbol is ETH');
  const afterStop = await autoBot._findBestOpportunity(multi, { preferOtherThan: 'ETH' });
  check(afterStop && afterStop.symbol === 'BTC', 'after ETH stop, prefers other crypto (BTC) first');

  // Cross-coin: same recovery must pass on the *stopped* coin before entering another
  {
    const crossClient = {
      hasCredentials: false,
      async getOpenMarkets(series) {
        const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
        if (series.includes('ETH')) {
          return [{ ticker: 'ETH', close_time: close, floor_strike: 3000, yes_bid: 44, yes_ask: 46, no_bid: 54, no_ask: 56 }];
        }
        if (series.includes('BTC')) {
          return [{ ticker: 'BTC', close_time: close, floor_strike: 60000, yes_bid: 48, yes_ask: 50, no_bid: 50, no_ask: 52 }];
        }
        return [];
      },
      async getMarket() {
        return null;
      },
      async createOrder() {
        throw new Error('no');
      },
    };
    const crossBot = makeBot(crossClient, {
      symbol: 'AUTO',
      minConfidence: 50,
      edgeThresholdPct: 5,
      stopRecoveryCents: 8,
      minEntryCents: 20,
    });
    crossBot.ledger.trades = [
      {
        status: 'closed',
        symbol: 'ETH',
        side: 'yes',
        exitReason: 'stop_loss',
        exitPriceCents: 45,
        entryPriceCents: 60,
        pnlCents: -150,
      },
    ];
    const crossPreds = {
      ETH: { ready: true, price: 3000, windows: { w5: win(70, 80), w10: win(68, 75), w15: win(65, 70) } },
      BTC: { ready: true, price: 60000, windows: { w5: win(70, 80), w10: win(68, 75), w15: win(65, 70) } },
    };
    // ETH ask 46 < 45+8=53 → BTC same-side must wait on ETH recovery
    const blockedOther = await crossBot._evaluateSymbolForEdge('BTC', crossPreds);
    checkEq(blockedOther, null, 'blocks other-coin same-side until stopped coin recovers');
    check(/ETH|bounce|recovery|stopped/i.test(crossBot.lastDecision || ''), 'decision cites stopped-coin recovery');
  }

  // Peer cascade: after ANY stop, block all new entries while peers dump;
  // session expiry + short max age clear (do not freeze into the next window).
  {
    const now = Date.now();
    const xrpStop = {
      exitReason: 'stop_loss',
      symbol: 'XRP',
      side: 'yes',
      exitPriceCents: 42,
      entryPriceCents: 55,
      closedAt: now - 2 * 60 * 1000,
      windowCloseTime: now + 10 * 60 * 1000,
    };
    const dumpingPeers = {
      XRP: { ready: true, windows: { w5: { probabilityUp: 40, probabilityDown: 60, confidence: 70 } } },
      ETH: { ready: true, windows: { w5: { probabilityUp: 35, probabilityDown: 65, confidence: 70 } } },
      SOL: { ready: true, windows: { w5: { probabilityUp: 38, probabilityDown: 62, confidence: 70 } } },
      BTC: { ready: true, windows: { w5: { probabilityUp: 36, probabilityDown: 64, confidence: 70 } } },
    };
    const seriesAll = { XRP: 1, ETH: 1, SOL: 1, BTC: 1 };

    checkEq(peerCascadeMaxAgeMs({ peerCascadeMaxMinutes: 5 }), 5 * 60 * 1000, 'peer cascade uses dedicated minutes');
    checkEq(peerCascadeMaxAgeMs({ peerCascadeMaxMinutes: 8 }), 5 * 60 * 1000, 'peer cascade hard-caps dedicated at 5m');
    checkEq(peerCascadeMaxAgeMs({ stopRecoveryMaxMinutes: 15 }), 3 * 60 * 1000, 'peer cascade defaults to 3m vs recovery 15');
    checkEq(peerCascadeMaxAgeMs({ stopRecoveryMaxMinutes: 0 }), 3 * 60 * 1000, 'peer cascade still ages when recovery max disabled');
    checkEq(peerCascadeMaxAgeMs({}), 3 * 60 * 1000, 'peer cascade defaults to 3 minutes');

    const cascade = checkPostStopPeerCascade({
      lastStopTrade: xrpStop,
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(!cascade.ok, 'after stop, peers cascading blocks ETH/etc');
    check(
      /after XRP YES stop.*peers still cascading.*same window.*until calm/i.test(cascade.reason || ''),
      'cascade Waiting message cites same-window calm / max'
    );

    const fade = checkPostStopPeerCascade({
      lastStopTrade: { exitReason: 'stop_loss', symbol: 'BTC', side: 'yes', closedAt: now - 60_000, windowCloseTime: now + 8 * 60_000 },
      candidateSide: 'no',
      predictions: {
        BTC: { ready: true, windows: { w5: { probabilityUp: 40, probabilityDown: 60, confidence: 70 } } },
        ETH: { ready: true, windows: { w5: { probabilityUp: 35, probabilityDown: 65, confidence: 70 } } },
      },
      seriesBySymbol: { BTC: 1, ETH: 1 },
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(!fade.ok, 'peer cascade blocks opposite-side flip while peers still dump');

    const calm = checkPostStopPeerCascade({
      lastStopTrade: xrpStop,
      candidateSide: 'yes',
      predictions: {
        XRP: { ready: true, windows: { w5: { probabilityUp: 55, probabilityDown: 45, confidence: 70 } } },
        ETH: { ready: true, windows: { w5: { probabilityUp: 58, probabilityDown: 42, confidence: 70 } } },
        SOL: { ready: true, windows: { w5: { probabilityUp: 56, probabilityDown: 44, confidence: 70 } } },
      },
      seriesBySymbol: { XRP: 1, ETH: 1, SOL: 1 },
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(calm.ok, 'peer cascade clears when peers are no longer dumping');

    // Peers calm + bounce met → peer entry allowed (recovery unit + cascade unit).
    const bounceOk = checkPostStopRecovery({
      lastClosedForSymbol: xrpStop,
      side: 'yes',
      priceCents: 55,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'XRP',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
      now,
    });
    check(bounceOk.ok && calm.ok, 'peers calm + bounce met → allow peer entry');

    const sessionExpiredStop = {
      ...xrpStop,
      windowCloseTime: now - 60_000,
      closedAt: now - 5 * 60_000,
    };
    const afterSession = checkPostStopPeerCascade({
      lastStopTrade: sessionExpiredStop,
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(afterSession.ok, 'session expired → allow even if peers still look cascading');

    const agedOutCascade = checkPostStopPeerCascade({
      lastStopTrade: {
        ...xrpStop,
        closedAt: now - (3 * 60 * 1000 + 1000),
        windowCloseTime: now + 6 * 60 * 1000,
      },
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(agedOutCascade.ok, 'peer cascade clears after short max age even if peers still dump');

    const afterHardClamp = checkPostStopPeerCascade({
      lastStopTrade: {
        ...xrpStop,
        closedAt: now - (5 * 60 * 1000 + 1000),
        windowCloseTime: now + 6 * 60 * 1000,
      },
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: 15 * 60 * 1000,
      now,
    });
    check(afterHardClamp.ok, 'hard max 5m clears even if caller passed 15m maxAgeMs');

    const stillYoungCascade = checkPostStopPeerCascade({
      lastStopTrade: xrpStop,
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(!stillYoungCascade.ok, 'peer cascade still blocks shortly after stop while peers dump');

    const noTimestamps = checkPostStopPeerCascade({
      lastStopTrade: { exitReason: 'stop_loss', symbol: 'XRP', side: 'yes' },
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(noTimestamps.ok, 'peer cascade fails open when stop has no closedAt/openedAt');

    const openedOnlyAged = checkPostStopPeerCascade({
      lastStopTrade: {
        exitReason: 'stop_loss',
        symbol: 'XRP',
        side: 'yes',
        openedAt: now - (3 * 60 * 1000 + 1000),
        windowCloseTime: now + 5 * 60 * 1000,
      },
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(openedOnlyAged.ok, 'peer cascade ages out using openedAt when closedAt missing');

    // Live evaluate path: XRP stop + dumping peers → ETH blocked with cascade message
    // (before bounce messaging — peers gate runs first).
    const cascadeBot = makeBot(
      {
        hasCredentials: false,
        async getOpenMarkets(series) {
          const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
          if (String(series).includes('ETH')) {
            return [{
              ticker: 'KXETH15M-CASC',
              status: 'open',
              floor_strike: 3000,
              close_time: close,
              yes_bid: 48,
              yes_ask: 50,
              no_bid: 50,
              no_ask: 52,
            }];
          }
          // XRP quote would be used for bounce — but peer cascade should block first.
          return [{
            ticker: 'KXXRP15M-CASC',
            status: 'open',
            floor_strike: 0.5,
            close_time: close,
            yes_bid: 30,
            yes_ask: 32,
            no_bid: 68,
            no_ask: 70,
          }];
        },
        async getMarket() { return null; },
        async createOrder() { throw new Error('no orders in test'); },
        async getOrder() { return null; },
      },
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        minEntryCents: 20,
        stopRecoveryCents: 8,
        stopLossCents: 15,
        peerCascadeMaxMinutes: 3,
      }
    );
    cascadeBot.ledger.trades = [
      {
        id: 'xrp-stop',
        status: 'closed',
        symbol: 'XRP',
        side: 'yes',
        exitReason: 'stop_loss',
        exitPriceCents: 42,
        entryPriceCents: 55,
        pnlCents: -130,
        closedAt: now - 2 * 60 * 1000,
        windowCloseTime: now + 10 * 60 * 1000,
      },
    ];
    const cascadePreds = {
      XRP: { ready: true, price: 0.5, windows: { w5: win(40, 70), w10: win(42, 68), w15: win(45, 65) } },
      ETH: { ready: true, price: 3000, windows: { w5: win(35, 70), w10: win(38, 68), w15: win(40, 65) } },
      SOL: { ready: true, price: 140, windows: { w5: win(36, 70), w10: win(38, 68), w15: win(40, 65) } },
      BTC: { ready: true, price: 60000, windows: { w5: win(34, 70), w10: win(36, 68), w15: win(38, 65) } },
    };
    const ethBlocked = await cascadeBot._evaluateSymbolForEdge('ETH', cascadePreds);
    checkEq(ethBlocked, null, 'evaluate blocks ETH while peers cascade after XRP stop');
    check(
      /after XRP YES stop.*peers still cascading.*until calm/i.test(cascadeBot.lastDecision || ''),
      'evaluate decision uses post-stop peer-cascade Waiting text'
    );
    check(
      (cascadeBot.ledger.activityLog || []).some((e) =>
        /Protection used \(peer-cascade\)/i.test(e.message || '')
      ),
      'activity log records peer-cascade protection used'
    );
    const beforeRepeat = (cascadeBot.ledger.activityLog || []).filter((e) =>
      /Protection used \(peer-cascade\)/i.test(e.message || '')
    ).length;
    await cascadeBot._evaluateSymbolForEdge('ETH', cascadePreds);
    const afterRepeat = (cascadeBot.ledger.activityLog || []).filter((e) =>
      /Protection used \(peer-cascade\)/i.test(e.message || '')
    ).length;
    checkEq(afterRepeat, beforeRepeat, 'peer-cascade activity log does not spam every poll');

    // After max age, evaluate must not stay stuck on cascade (bounce may still apply).
    cascadeBot.ledger.trades[0].closedAt = now - 4 * 60 * 1000;
    cascadeBot.config.peerCascadeMaxMinutes = 3;
    const ethAfterAge = await cascadeBot._evaluateSymbolForEdge('ETH', {
      ...cascadePreds,
      // XRP bounced enough that recovery gate can clear for peer entry.
      XRP: { ready: true, price: 0.5, windows: { w5: win(60, 70), w10: win(58, 68), w15: win(55, 65) } },
    });
    // Peer cascade aged out; ETH may still be blocked by XRP bounce if quote is low —
    // ensure decision is NOT the sticky cascade message.
    check(
      !/peers still cascading/i.test(cascadeBot.lastDecision || ''),
      'after peer-cascade max age, decision is not sticky cascade wait'
    );
    void ethAfterAge;
  }

  // Staking halve-after-win
  const stakeBot = makeBot(mockClient({}), { stakeDollars: 10, stakingStrategy: 'halve-after-win' });
  stakeBot.ledger.trades = [
    { status: 'closed', pnlCents: 500, stakeDollars: 10, closedAt: Date.now() },
  ];
  checkEq(stakeBot._computeNextStake(), 5, 'halve-after-win halves next stake');
  stakeBot.ledger.trades = [
    { status: 'closed', pnlCents: -200, stakeDollars: 10, closedAt: Date.now() },
  ];
  checkEq(stakeBot._computeNextStake(), 10, 'halve-after-win resets after loss');

  {
    const halfBot = makeBot(mockClient({}), {
      stakeDollars: 10,
      halfStakeNear: 'on',
      strategyMode: 'settle',
    });
    halfBot.config.strategyMode = 'settle';
    halfBot.config.halfStakeNear = 'on';
    checkEq(halfBot._stakeDollarsForEntry(85, { settle: true, symbol: 'BNB' }), 10, 'BNB full stake at 85');
    checkEq(halfBot._stakeDollarsForEntry(80, { settle: true, symbol: 'BTC' }), 10, 'BTC full stake at exactly 80');
    checkEq(halfBot._stakeDollarsForEntry(79, { settle: true, symbol: 'BTC' }), 2.5, 'BTC quarter stake below 80');
    checkEq(halfBot._stakeDollarsForEntry(72, { settle: true, symbol: 'BNB' }), 2.5, 'BNB quarter stake late');
    checkEq(halfBot._stakeDollarsForEntry(88, { settle: true, symbol: 'NEAR' }), 5, 'NEAR half stake at 88');
    checkEq(halfBot._stakeDollarsForEntry(65, { settle: true, symbol: 'NEAR' }), 2.5, 'NEAR under 80 is quarter not half');
    checkEq(halfBot._stakeDollarsForEntry(65, { settle: false, symbol: 'NEAR' }), 10, 'edge mode ignores settle sizing');
    halfBot.config.halfStakeNear = 'off';
    checkEq(halfBot._stakeDollarsForEntry(88, { settle: true, symbol: 'NEAR' }), 10, 'NEAR half-stake off at 88');
    checkEq(halfBot._stakeDollarsForEntry(79, { settle: true, symbol: 'NEAR' }), 2.5, 'under 80 still quarter when NEAR half off');
    checkEq(
      halfBot._stakeDollarsForEntry(85, { settle: true, symbol: 'BNB', thirdSlot: true }),
      5,
      '3rd open half stake at 85'
    );
    checkEq(
      halfBot._stakeDollarsForEntry(72, { settle: true, symbol: 'BNB', thirdSlot: true }),
      2.5,
      '3rd under 80 stays quarter (no stack)'
    );
    checkEq(
      halfBot._stakeDollarsForEntry(88, { settle: true, symbol: 'NEAR', thirdSlot: true }),
      5,
      '3rd + NEAR at 88 still half'
    );
    halfBot.ledger.trades = [
      { status: 'open', symbol: 'BTC', settleTouched90: true },
      { status: 'open', symbol: 'ETH', settleTouched90: false },
    ];
    halfBot.config.maxOpenPositions = 2;
    checkEq(halfBot._effectiveMaxOpenPositions(), 3, 'touched 90 soft-caps to 3');
    halfBot.ledger.trades = [{ status: 'open', symbol: 'BTC', settleTouched90: false }];
    checkEq(halfBot._effectiveMaxOpenPositions(), 2, 'without touched 90 stay at maxOpen');
  }

  {
    const modelStakeBot = makeBot(mockClient({}), {
      stakeDollars: 10,
      strategyMode: 'model',
      modelLowPriceMaxCents: 90,
      modelLowPriceStakeQuarters: 1,
      modelRichAskCents: 78,
    });
    checkEq(
      modelStakeBot._stakeDollarsForEntry(69, { model: true }),
      10,
      'model full stake under 70 (half-stake off)'
    );
    checkEq(
      modelStakeBot._stakeDollarsForEntry(70, { model: true }),
      10,
      'model full stake at 70'
    );
    checkEq(
      modelStakeBot._stakeDollarsForEntry(85, { model: true }),
      10,
      'model full stake above 70'
    );
    checkEq(
      modelStakeBot._stakeDollarsForEntry(80, { model: true }),
      10,
      'model does not half-stake rich asks'
    );
    checkEq(
      modelStakeBot._stakeDollarsForEntry(50, { model: true, symbol: 'NEAR' }),
      10,
      'model under 70 full stake — not NEAR/quarter extra'
    );
  }

  // Available-only funding: stop bot instead of spending Wallet / Insurance
  {
    const haltBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-HALT',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        yes_bid: 70,
        yes_ask: 72,
        no_bid: 28,
        no_ask: 30,
      }),
      {
        strategyMode: 'model',
        stakeDollars: 10,
        paperStartingBalanceDollars: 20,
        modelMinConfidence: 50,
        modelMinEntryCents: 65,
      }
    );
    haltBot.setRunning(true);
    haltBot.ledger.reserveCents = 1500; // $15 Wallet
    haltBot.ledger.insuranceCents = 400; // $4 Insurance
    // Total $20 − $15 − $4 = $1 Available — can't fund ~$5–10 stake
    const avail = haltBot._capitalStatus().paperAvailableCents;
    check(avail > 0 && avail < 500, 'fixture has tiny Available under stake');
    const opened = await haltBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-HALT',
      side: 'yes',
      priceCents: 72,
      floorStrike: 3000,
      closeTime: Date.now() + 12 * 60 * 1000,
      engineProbability: 70,
      engineConfidence: 70,
      strategy: 'model',
      modelWindowKey: 'w5',
      modelDirection: 'UP',
    });
    checkEq(opened, false, 'refuses entry that would spend Wallet/Insurance');
    checkEq(haltBot.isRunning, false, 'bot hard-stops when Available cannot fund');
    check(/STOPPED/i.test(haltBot.lastDecision || ''), 'decision explains Available halt');
    checkEq(haltBot.openTrades.length, 0, 'no position opened on halt');
  }

  {
    const skimSettings = { skimMode: 'insurance', insuranceCapDollars: 10, insuranceFloorDollars: 6, insuranceOverflowDollars: 15 };
    const ledger = {
      trades: [
        { status: 'closed', pnlCents: 1000, closedAt: 1 },
        { status: 'closed', pnlCents: -200, closedAt: 2 },
      ],
      insuranceDepositedCents: 0,
    };
    const raw = summarizeLedgerCapital(ledger, 100, { skimMode: 'off' });
    const skim = summarizeLedgerCapital(ledger, 100, skimSettings);
    check(raw.paperAvailableCents > skim.paperAvailableCents, 'skim lowers shadow avail vs raw pnl');
    checkEq(skim.reserveCents, 400, 'shadow skim wallet from $10 win');
    checkEq(skim.insuranceCents, 200, 'shadow skim insurance from $10 win');
    rebuildLedgerSkimFromTrades(ledger, skimSettings);
    checkEq(ledger.reserveCents, 400, 'rebuildLedgerSkimFromTrades syncs wallet');
  }

  {
    check(isForceRetryExitReason('take_profit'), 'TP is force-retry exit');
    check(isForceRetryExitReason('breakeven'), 'BE is force-retry exit');
    check(isForceRetryExitReason('model_against'), 'model_against is force-retry exit');
    check(isForceRetryExitReason('model_lean_stop'), 'lean-stop is force-retry exit');
    check(isForceRetryExitReason('stop_loss'), 'stop_loss is force-retry exit');
    check(!isForceRetryExitReason('settled'), 'settled is not a live sell retry');
  }

  {
    const swapBot = makeBot(mockClient({}), {
      strategyMode: 'model',
      activeSetupId: 'core',
      paperStartingBalanceDollars: 100,
      skimMode: 'insurance',
    });
    swapBot.config.activeSetupId = 'core';
    swapBot.ledger.trades = [{ status: 'closed', pnlCents: -3000, closedAt: 1 }];
    swapBot.ledger.reserveCents = 0;
    swapBot.ledger.insuranceCents = 0;
    const tight = modelSetupById('tight');
    check(!!tight, 'tight setup exists for swap test');
    swapBot._ensureShadowBook(tight);
    swapBot._shadowBooks.tight.ledger = {
      trades: [{ status: 'closed', pnlCents: 2000, closedAt: 1 }],
      reserveCents: 800,
      insuranceCents: 400,
      insuranceReady: false,
      insuranceDepositedCents: 0,
      periodStartTime: Date.now(),
      activityLog: [],
    };
    const beforeLiveAvail = swapBot._capitalStatus().paperAvailableCents;
    const result = swapBot.applyModelSetup('tight');
    check(result.ok, 'applyModelSetup swap ok');
    checkEq(swapBot.config.activeSetupId, 'tight', 'active setup becomes tight');
    const afterLiveAvail = swapBot._capitalStatus().paperAvailableCents;
    check(afterLiveAvail > beforeLiveAvail, 'switch brings healthier shadow avail into live');
    check(!!swapBot._shadowBooks.core, 'old live core is parked as shadow');
    check(!swapBot._shadowBooks.tight, 'promoted tight shadow is not double-counted');
    const coreShadow = summarizeLedgerCapital(swapBot._shadowBooks.core.ledger, 100, swapBot.config);
    check(coreShadow.paperAvailableCents < afterLiveAvail, 'parked core shadow keeps scarred avail');
  }

  {
    const rotBot = makeBot(mockClient({}), {
      strategyMode: 'model',
      paperStartingBalanceDollars: 100,
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 6,
      insuranceOverflowDollars: 15,
    });
    rotBot.ledger.trades = [
      { id: 'w1', status: 'closed', pnlCents: 1000, closedAt: 1 },
      { id: 'w2', status: 'closed', pnlCents: 500, closedAt: 2 },
    ];
    rotBot.ledger.reserveCents = 600;
    rotBot.ledger.insuranceCents = 300;
    rotBot.ledger.retainedClosedPnlCents = 0;
    rotBot.ledger.periodStartTime = Date.now() - 13 * 60 * 60 * 1000;
    const before = rotBot._capitalStatus().paperAvailableCents;
    rotBot._maybeRotateLedger(Date.now());
    checkEq(rotBot.ledger.trades.length, 0, 'rotation clears closed trades from live ledger');
    checkEq(rotBot.ledger.retainedClosedPnlCents, 1500, 'rotation keeps closed PnL in retained');
    const after = rotBot._capitalStatus().paperAvailableCents;
    checkEq(after, before, 'Available unchanged across 12h rotation');
  }

  // Live: official Kalshi result books 0/100 with NO sell order
  let liveOrders = 0;
  let getOrderCalls = 0;
  const liveClient = {
    hasCredentials: true,
    async getMarket() {
      return {
        status: 'closed',
        result: 'yes',
        close_time: new Date(Date.now() - 1000).toISOString(),
        floor_strike: 3000,
      };
    },
    async getOpenMarkets() {
      return [];
    },
    async createOrder() {
      liveOrders += 1;
      return { order: { order_id: `oid-${liveOrders}` } };
    },
    async getOrder(orderId) {
      getOrderCalls += 1;
      return {
        order: {
          order_id: orderId,
          status: 'executed',
          // Match openTrade default contracts (10) — never invent fills from status alone.
          fill_count_fp: '10.00',
          yes_price: 42,
        },
      };
    },
    async cancelOrder() {
      return {};
    },
    async getBalance() {
      return { balance: 10000, portfolio_value: 10000 };
    },
  };
  const liveBot = makeBot(liveClient, { mode: 'live', liveAuthorized: true });
  liveBot.config.mode = 'live';
  liveBot.config.liveAuthorized = true;
  const liveTrade = openTrade(liveBot, {
    mode: 'live',
    liveOrderId: 'entry-1',
    side: 'yes',
    windowCloseTime: Date.now() - 1000,
  });
  await liveBot._manageOpenTrade(liveTrade, predictions(3100));
  checkEq(liveTrade.status, 'closed', 'live trade settles on official result');
  checkEq(liveTrade.exitReason, 'settled', 'live official settle reason');
  checkEq(liveOrders, 0, 'official settle places no live sell');

  // Live stop: sell + fill confirm before ledger close
  liveOrders = 0;
  getOrderCalls = 0;
  const stopBot = makeBot(liveClient, {
    mode: 'live',
    liveAuthorized: true,
    stopLossCents: 10,
    takeProfitCents: 50,
  });
  stopBot.config.mode = 'live';
  stopBot.config.liveAuthorized = true;
  const stopTrade = openTrade(stopBot, {
    mode: 'live',
    liveOrderId: 'entry-stop',
    side: 'yes',
    entryPriceCents: 60,
    windowCloseTime: Date.now() + 10 * 60 * 1000,
  });
  liveClient.getMarket = async () => ({
    status: 'active',
    yes_bid: 45,
    yes_ask: 47,
    no_bid: 53,
    no_ask: 55,
    close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    floor_strike: 3000,
  });
  await stopBot._manageOpenTrade(stopTrade, predictions(3100));
  checkEq(stopTrade.status, 'closed', 'live stop closes after fill');
  checkEq(stopTrade.exitReason, 'stop_loss', 'live stop reason');
  check(liveOrders >= 1, 'live stop places sell order');
  check(getOrderCalls >= 1, 'live stop polls fill');

  // Failed live sell leaves position open
  liveOrders = 0;
  const failClient = {
    ...liveClient,
    async createOrder() {
      liveOrders += 1;
      throw new Error('simulated sell failure');
    },
    async getMarket() {
      return {
        status: 'active',
        yes_bid: 45,
        yes_ask: 47,
        close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        floor_strike: 3000,
      };
    },
  };
  const failBot = makeBot(failClient, {
    mode: 'live',
    liveAuthorized: true,
    stopLossCents: 10,
  });
  failBot.config.mode = 'live';
  failBot.config.liveAuthorized = true;
  const failTrade = openTrade(failBot, {
    mode: 'live',
    liveOrderId: 'entry-fail',
    side: 'yes',
    entryPriceCents: 60,
    windowCloseTime: Date.now() + 10 * 60 * 1000,
  });
  await failBot._manageOpenTrade(failTrade, predictions(3100));
  checkEq(failTrade.status, 'open', 'failed live sell leaves position open');
  checkEq(failTrade.pendingForceExit, 'stop_loss', 'failed stop sets pendingForceExit');
  checkEq(liveOrders, 3, 'failed stop_loss retries sell up to 3 times');
  check(
    /will retry next cycle/i.test(String(failBot.lastDecision || '')),
    'failed stop decision mentions retry next cycle'
  );

  // pendingForceExit: retry forced close even when bid bounced above stop
  {
    let forceOrders = 0;
    const forcePrices = [];
    const forceClient = {
      hasCredentials: true,
      async createOrder({ action, priceCents }) {
        forceOrders += 1;
        forcePrices.push(priceCents);
        checkEq(action, 'sell', 'pendingForceExit issues sell');
        // Fail first manage cycle (3 attempts), succeed on second cycle.
        if (forceOrders <= 3) throw new Error('simulated force-exit miss');
        return { order: { order_id: `force-${forceOrders}`, fill_count_fp: '10.00', yes_price: priceCents } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '10.00',
            yes_price: 55,
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getMarket() {
        // Bid above stop (entry 60, stopLoss 10 → stop at 50) so normal stop would NOT fire.
        return {
          status: 'active',
          yes_bid: 55,
          yes_ask: 57,
          no_bid: 43,
          no_ask: 45,
          close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          floor_strike: 3000,
        };
      },
      async getOpenMarkets() {
        return [];
      },
    };
    const forceBot = makeBot(forceClient, {
      mode: 'live',
      liveAuthorized: true,
      stopLossCents: 10,
      takeProfitCents: 50,
    });
    forceBot.config.mode = 'live';
    forceBot.config.liveAuthorized = true;
    const forceTrade = openTrade(forceBot, {
      mode: 'live',
      liveOrderId: 'entry-force',
      side: 'yes',
      entryPriceCents: 60,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
      pendingForceExit: 'stop_loss',
    });
    await forceBot._manageOpenTrade(forceTrade, predictions(3100));
    checkEq(forceTrade.status, 'open', 'pendingForceExit still open after failed retry cycle');
    checkEq(forceTrade.pendingForceExit, 'stop_loss', 'pendingForceExit kept after failed retry');
    checkEq(forceOrders, 3, 'pendingForceExit cycle retries 3 sells');
    checkEq(forcePrices[0], 55, 'force exit attempt 1 at current bid');
    checkEq(forcePrices[1], 54, 'force exit attempt 2 one cent more aggressive');
    checkEq(forcePrices[2], 53, 'force exit attempt 3 two cents more aggressive');

    await forceBot._manageOpenTrade(forceTrade, predictions(3100));
    checkEq(forceTrade.status, 'closed', 'successful pendingForceExit closes trade');
    checkEq(forceTrade.exitReason, 'stop_loss', 'pendingForceExit close reason stop_loss');
    checkEq(forceTrade.pendingForceExit, undefined, 'successful close clears pendingForceExit');
    check(forceOrders >= 4, 'second cycle placed the filling sell');
  }

  // Live entry: partial fill still records inventory (does not orphan Kalshi fills)
  {
    let entryOrders = 0;
    const partialEntryClient = {
      hasCredentials: true,
      async createOrder({ count }) {
        entryOrders += 1;
        return { order: { order_id: `entry-partial-${entryOrders}`, requested: count } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '3.00',
            yes_price: 50,
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getOpenMarkets() {
        return [];
      },
      async getMarket() {
        return null;
      },
    };
    const entryBot = makeBot(partialEntryClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 10,
      minEntryCents: 1,
      skimMode: 'off',
    });
    entryBot.config.mode = 'live';
    entryBot.config.liveAuthorized = true;
    entryBot.setRunning(true);
    await entryBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-PARTIAL',
      side: 'yes',
      priceCents: 50,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    checkEq(entryBot.openTrades.length, 1, 'partial live entry records a trade');
    checkEq(entryBot.openTrades[0].contracts, 3, 'partial live entry keeps filled size');
    checkEq(entryOrders, 1, 'partial live entry placed one buy');
  }

  // Live entry: one attempt — miss demotes coin; no same-second chase spam
  {
    let entryOrders = 0;
    const prices = [];
    const retryEntryClient = {
      hasCredentials: true,
      async createOrder({ count, priceCents }) {
        entryOrders += 1;
        prices.push(priceCents);
        return { order: { order_id: `entry-retry-${entryOrders}`, requested: count } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '0.00',
            yes_price: 50,
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getOpenMarkets() {
        return [];
      },
      async getMarket() {
        return { yes_ask: 50, yes_bid: 49, no_ask: 51, no_bid: 50, status: 'open' };
      },
    };
    const retryBot = makeBot(retryEntryClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 5,
      minEntryCents: 1,
      skimMode: 'off',
    });
    retryBot.config.mode = 'live';
    retryBot.config.liveAuthorized = true;
    retryBot.setRunning(true);
    const opened = await retryBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-RETRY',
      side: 'yes',
      priceCents: 50,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    checkEq(opened, false, 'unfilled entry returns false');
    checkEq(retryBot.openTrades.length, 0, 'unfilled entry leaves no trade');
    checkEq(entryOrders, 2, 'unfilled entry retries IOC up to 2 times');
    check(retryBot._hasRecentEntryMiss('ETH', null, 'yes'), 'fill miss demotes ETH YES briefly');
    check(!retryBot._hasRecentEntryMiss('ETH', null, 'no'), 'ETH NO still allowed after YES miss');
    check(/skipping this YES|other cryptos\/sides/i.test(retryBot.lastError || ''), 'miss message mentions side skip');
    check(/miss #1/i.test(retryBot.lastError || ''), 'first miss labeled #1');
    check(/~7s/i.test(retryBot.lastError || ''), 'first miss cools ~7s');
    const firstOnly = makeBot(mockClient({}), { mode: 'live', liveAuthorized: true });
    const m0 = firstOnly._noteEntryMiss('SOL', null, null, 'yes');
    checkEq(m0.cooldownMs, 7_000, 'first miss cools 7s');
    const m1 = retryBot._noteEntryMiss('ETH', null, Date.now() + 600_000, 'yes');
    check(m1.streak >= 2, 'second miss increments streak');
    checkEq(m1.cooldownMs, 7_000, 'second miss still cools 7s');
    const m2 = retryBot._noteEntryMiss('ETH', null, Date.now() + 600_000, 'yes');
    checkEq(m2.cooldownMs, 7_000, 'third miss still cools 7s');
    const m3 = retryBot._noteEntryMiss('ETH', null, Date.now() + 600_000, 'yes');
    checkEq(m3.cooldownMs, 7_000, 'fourth miss still cools 7s');
    // Session end (or new window) clears streak + cooldown
    const sessionBot = makeBot(mockClient({}), { mode: 'live', liveAuthorized: true });
    const sessionClose = Date.now() + 60_000;
    sessionBot._noteEntryMiss('BNB', null, sessionClose, 'yes');
    sessionBot._noteEntryMiss('BNB', null, sessionClose, 'yes');
    checkEq(sessionBot._entryMissStreak['BNB:yes'], 2, 'streak is 2 mid-session');
    check(
      sessionBot._expireEntryMissIfSessionEnded('BNB', sessionClose + 1, null, 'yes'),
      'expire returns true after session close'
    );
    check(!sessionBot._hasRecentEntryMiss('BNB', null, 'yes'), 'no cooldown after session end');
    checkEq(sessionBot._entryMissStreak['BNB:yes'], undefined, 'streak cleared after session end');
    const mFresh = sessionBot._noteEntryMiss('BNB', null, Date.now() + 600_000, 'no');
    checkEq(mFresh.streak, 1, 'next session starts at miss #1 again');
    checkEq(mFresh.cooldownMs, 7_000, 'next session first miss is 7s again');
    // YES miss must not block NO on same coin
    const sideBot = makeBot(mockClient({}), { mode: 'live', liveAuthorized: true });
    sideBot._noteEntryMiss('HYPE', null, Date.now() + 600_000, 'yes');
    check(sideBot._hasRecentEntryMiss('HYPE', null, 'yes'), 'HYPE YES cooling');
    check(!sideBot._hasRecentEntryMiss('HYPE', null, 'no'), 'HYPE NO free after YES miss');
  }

  // Live entry: all attempts miss → no trade (single attempt)
  {
    let entryOrders = 0;
    const missClient = {
      hasCredentials: true,
      async createOrder({ count }) {
        entryOrders += 1;
        return { order: { order_id: `entry-miss-${entryOrders}`, requested: count } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '0.00',
            yes_price: 50,
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getOpenMarkets() {
        return [];
      },
      async getMarket() {
        return { yes_ask: 50, yes_bid: 49, status: 'open' };
      },
    };
    const missBot = makeBot(missClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 5,
      minEntryCents: 1,
      skimMode: 'off',
    });
    missBot.config.mode = 'live';
    missBot.config.liveAuthorized = true;
    await missBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-MISS',
      side: 'yes',
      priceCents: 50,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    checkEq(missBot.openTrades.length, 0, 'unfilled entry after miss leaves no trade');
    checkEq(entryOrders, 2, 'unfilled entry attempted 2 buys');
    check(/did not fill/i.test(missBot.lastError || ''), 'unfilled entry error mentions did not fill');
  }

  // Settle dual-entry: empty book + maxOpen 2 opens top 2 in parallel (paper)
  {
    const closeMs = Date.now() + 8 * 60 * 1000;
    const dualBot = makeBot(
      {
        hasCredentials: false,
        async getMarket() {
          return {};
        },
        async getOpenMarkets() {
          return [];
        },
        async createOrder() {
          throw new Error('paper dual-entry should not order');
        },
        async getBalance() {
          return { balance: 0, portfolio_value: 0 };
        },
      },
      {
        strategyMode: 'settle',
        symbol: 'AUTO',
        maxOpenPositions: 2,
        settleEntryMinCents: 80,
        settleEntryMaxCents: 92,
        settleMinMinutesToOpen: 0.5,
        settleMaxMinutesToOpen: 12,
        settleMinUpsideCents: 8,
        stakeDollars: 10,
        paperStartingBalanceDollars: 200,
      }
    );
    dualBot.config.strategyMode = 'settle';
    dualBot.config.maxOpenPositions = 2;
    const mkOpp = (symbol, ticker) => ({
      symbol,
      side: 'yes',
      priceCents: 85,
      closeTime: closeMs,
      market: { ticker, floor_strike: 100 },
      window: { probabilityUp: 70, probabilityDown: 30, confidence: 60 },
    });
    const t0 = Date.now();
    await dualBot._openSettleRanked([mkOpp('BTC', 'KXBTC15M-A'), mkOpp('ETH', 'KXETH15M-A'), mkOpp('SOL', 'KXSOL15M-A')]);
    const elapsed = Date.now() - t0;
    checkEq(dualBot.openTrades.length, 2, 'settle dual-entry opens two from empty book');
    const syms = dualBot.openTrades.map((t) => t.symbol).sort();
    checkEq(syms.join(','), 'BTC,ETH', 'settle dual-entry took top-2 ranked coins');
    check(elapsed < 500, 'settle dual-entry paper path stays fast (parallel, not long sleeps)');
    check(/dual-entry|Opened/i.test(dualBot.lastDecision || ''), 'dual-entry left a decision note');
  }

  // Late fill after poll timeout: polls empty → cancel → getOrder then shows fills
  {
    let polls = 0;
    let canceled = false;
    const lateFillClient = {
      hasCredentials: true,
      async createOrder() {
        return { order_id: 'late-fill-oid', fill_count: '0.00', remaining_count: '8.00' };
      },
      async getOrder(orderId) {
        polls += 1;
        if (!canceled) {
          return {
            order: {
              order_id: orderId,
              status: 'resting',
              fill_count_fp: '0.00',
              remaining_count_fp: '8.00',
            },
          };
        }
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '8.00',
            remaining_count_fp: '0.00',
            average_fill_price: '0.5500',
          },
        };
      },
      async cancelOrder() {
        canceled = true;
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getOpenMarkets() {
        return [];
      },
      async getMarket() {
        return null;
      },
    };
    const lateBot = makeBot(lateFillClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 10,
      minEntryCents: 1,
      skimMode: 'off',
    });
    lateBot.config.mode = 'live';
    lateBot.config.liveAuthorized = true;
    lateBot.setRunning(true);
    await lateBot._openPosition({
      symbol: 'BTC',
      ticker: 'KXBTC15M-LATE',
      side: 'yes',
      priceCents: 55,
      floorStrike: 60000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    check(canceled, 'late-fill path cancels after poll timeout');
    checkEq(lateBot.openTrades.length, 1, 'late fill after timeout still ledgers trade');
    checkEq(lateBot.openTrades[0].contracts, 8, 'late fill uses recovered fill count');
    checkEq(lateBot.openTrades[0].liveOrderId, 'late-fill-oid', 'late fill stores liveOrderId');
    check(polls >= 2, 'late fill polled getOrder more than once');
  }

  // Fill detected only on post-cancel getOrder (cancel race)
  {
    let polls = 0;
    let canceled = false;
    const raceClient = {
      hasCredentials: true,
      async createOrder() {
        return { order: { order_id: 'cancel-race-oid' } };
      },
      async getOrder(orderId) {
        polls += 1;
        if (!canceled) {
          return {
            order: {
              order_id: orderId,
              status: 'resting',
              fill_count_fp: '0.00',
            },
          };
        }
        // After cancel: exchange reports the race fill that landed.
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '2.00',
            yes_price: 48,
          },
        };
      },
      async cancelOrder() {
        canceled = true;
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getOpenMarkets() {
        return [];
      },
      async getMarket() {
        return null;
      },
    };
    const raceBot = makeBot(raceClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 5,
      minEntryCents: 1,
      skimMode: 'off',
    });
    raceBot.config.mode = 'live';
    raceBot.config.liveAuthorized = true;
    // Directly exercise await helper with short polls.
    const fill = await raceBot._awaitOrderFill('cancel-race-oid', {
      minFill: 5,
      attempts: 2,
      delayMs: 5,
    });
    check(canceled, 'cancel-race issues cancel');
    checkEq(fill.filled, 2, 'fill detected after cancel');
    check(fill.recovered === true, 'cancel-race marks recovered');
    check(fill.ok === false, 'partial after cancel is not full ok');
  }

  // Seed from Create Order V2 immediate fill skips orphaning when polls would fail
  {
    let getOrderCalls = 0;
    const seedClient = {
      hasCredentials: true,
      async createOrder({ count }) {
        return normalizeCreateOrderResponse({
          order_id: 'seed-immediate',
          fill_count: `${count}.00`,
          remaining_count: '0.00',
          average_fill_price: '0.5000',
        });
      },
      async getOrder() {
        getOrderCalls += 1;
        throw new Error('getOrder should not be required for immediate V2 fill');
      },
      async cancelOrder() {
        throw new Error('cancel should not run for immediate V2 fill');
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getOpenMarkets() {
        return [];
      },
      async getMarket() {
        return null;
      },
    };
    const seedBot = makeBot(seedClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 10,
      minEntryCents: 1,
      skimMode: 'off',
    });
    seedBot.config.mode = 'live';
    seedBot.config.liveAuthorized = true;
    await seedBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-SEED',
      side: 'yes',
      priceCents: 50,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    checkEq(seedBot.openTrades.length, 1, 'V2 immediate fill records trade from create seed');
    checkEq(seedBot.openTrades[0].contracts, 20, 'V2 immediate fill uses create fill_count');
    checkEq(seedBot.openTrades[0].entryPriceCents, 50, 'V2 immediate fill uses average_fill_price');
    checkEq(getOrderCalls, 0, 'V2 immediate fill does not need getOrder');
  }

  // IOC create seed with remaining 0: trust seed, do not poll getOrder (avoids 404 spam)
  {
    let getOrderCalls = 0;
    const iocSeedBot = makeBot(
      {
        hasCredentials: true,
        async getOrder() {
          getOrderCalls += 1;
          throw new Error('getOrder should not run for terminal IOC seed');
        },
        async cancelOrder() {
          throw new Error('cancelOrder should not run for terminal IOC seed');
        },
        async createOrder() {
          throw new Error('unused');
        },
        async getBalance() {
          return { balance: 0, portfolio_value: 0 };
        },
        async getMarket() {
          return {};
        },
        async getOpenMarkets() {
          return [];
        },
      },
      { mode: 'live', liveAuthorized: true }
    );
    const miss = await iocSeedBot._awaitOrderFill('ioc-miss-oid', {
      minFill: 1,
      attempts: 4,
      delayMs: 1,
      seedOrder: {
        order_id: 'ioc-miss-oid',
        fill_count: '0.00',
        remaining_count: '0.00',
      },
      heldSide: 'yes',
      action: 'buy',
    });
    checkEq(miss.filled, 0, 'terminal IOC seed with 0 fill reports 0');
    checkEq(miss.ok, false, 'terminal IOC miss is not ok');
    checkEq(getOrderCalls, 0, 'terminal IOC seed skips getOrder');

    const partial = await iocSeedBot._awaitOrderFill('ioc-partial-oid', {
      minFill: 1,
      attempts: 4,
      delayMs: 1,
      seedOrder: {
        order_id: 'ioc-partial-oid',
        fill_count: '4.00',
        remaining_count: '0.00',
        average_fill_price: '0.8500',
      },
      heldSide: 'yes',
      action: 'buy',
    });
    checkEq(partial.filled, 4, 'terminal IOC partial fill uses create seed');
    checkEq(partial.ok, true, 'terminal IOC partial fill is ok');
    checkEq(getOrderCalls, 0, 'terminal IOC partial skips getOrder');
  }

  // Live exit: partial sell books sold slice + shrinks open remainder (no inventory desync)
  {
    let sellCalls = 0;
    const partialExitClient = {
      hasCredentials: true,
      async createOrder({ action, count }) {
        sellCalls += 1;
        checkEq(action, 'sell', 'partial exit issues sell');
        checkEq(count, 10, 'partial exit attempts full size first');
        return { order: { order_id: `sell-partial-${sellCalls}` } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '4.00',
            yes_price: 40,
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
    };
    const exitBot = makeBot(partialExitClient, {
      mode: 'live',
      liveAuthorized: true,
      skimMode: 'off',
    });
    exitBot.config.mode = 'live';
    exitBot.config.liveAuthorized = true;
    const partialTrade = openTrade(exitBot, {
      mode: 'live',
      liveOrderId: 'entry-partial-exit',
      side: 'yes',
      entryPriceCents: 50,
      contracts: 10,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const closed = await exitBot._closePosition(partialTrade, 40, 'stop_loss', {
      liveSellPriceCents: 40,
    });
    checkEq(closed, false, 'partial live sell does not fully close');
    checkEq(partialTrade.status, 'open', 'remainder stays open after partial sell');
    checkEq(partialTrade.contracts, 6, 'open size shrunk by filled sell count');
    const closedSlices = exitBot.ledger.trades.filter(
      (t) => t.status === 'closed' && t.partialExitOf === partialTrade.id
    );
    checkEq(closedSlices.length, 1, 'partial sell books a closed slice');
    checkEq(closedSlices[0].contracts, 4, 'closed slice matches fill count');
    checkEq(closedSlices[0].exitPriceCents, 40, 'closed slice uses sell fill price');
    checkEq(partialTrade.pendingForceExit, 'stop_loss', 'partial stop sets pendingForceExit');
    check(sellCalls >= 1, 'partial sell placed an order');
  }

  // V2 sell YES stop_loss: ask-book average_fill_price must not book false win/skim
  {
    const stopMisparseClient = {
      hasCredentials: true,
      async createOrder({ action, side, priceCents, count }) {
        checkEq(action, 'sell', 'stop misparse exit sells');
        checkEq(side, 'yes', 'stop misparse exit side yes');
        checkEq(priceCents, 18, 'stop misparse sells at bid limit');
        return normalizeCreateOrderResponse({
          order_id: 'stop-misparse-exit',
          fill_count: `${count}.00`,
          remaining_count: '0.00',
          average_fill_price: '0.8200',
          side: 'ask',
        });
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '14.00',
            average_fill_price: '0.8200',
            side: 'ask',
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
    };
    const stopBot = makeBot(stopMisparseClient, {
      mode: 'live',
      liveAuthorized: true,
      skimMode: 'insurance',
    });
    stopBot.config.mode = 'live';
    stopBot.config.liveAuthorized = true;
    stopBot.ledger.insuranceCents = 2000;
    stopBot.ledger.insuranceReady = true;
    const stopTrade = openTrade(stopBot, {
      mode: 'live',
      liveOrderId: 'entry-stop-misparse',
      side: 'yes',
      entryPriceCents: 42,
      contracts: 14,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const closed = await stopBot._closePosition(stopTrade, 18, 'stop_loss', {
      liveSellPriceCents: 18,
    });
    checkEq(closed, true, 'stop misparse exit closes');
    checkEq(stopTrade.exitPriceCents, 18, 'stop misparse books YES exit not ask complement');
    checkEq(stopTrade.pnlCents, (18 - 42) * 14, 'stop misparse PnL reflects real loss');
    check(stopTrade.pnlCents < 0, 'stop misparse is a loss');
    checkEq(stopTrade.skimmedCents || 0, 0, 'loss on stop misparse gets no wallet skim');
  }

  // V2 sell YES take_profit: average_fill_price already YES — must not complement to fake loss
  {
    const tpMisparseClient = {
      hasCredentials: true,
      async createOrder({ action, side, priceCents, count }) {
        checkEq(action, 'sell', 'TP exit sells');
        checkEq(side, 'yes', 'TP exit side yes');
        checkEq(priceCents, 57, 'TP sells at take-profit limit');
        return normalizeCreateOrderResponse({
          order_id: 'tp-misparse-exit',
          fill_count: `${count}.00`,
          remaining_count: '0.00',
          average_fill_price: '0.5700',
          side: 'ask',
        });
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '10.00',
            average_fill_price: '0.5700',
            side: 'ask',
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
    };
    const tpBot = makeBot(tpMisparseClient, {
      mode: 'live',
      liveAuthorized: true,
      skimMode: 'off',
    });
    tpBot.config.mode = 'live';
    tpBot.config.liveAuthorized = true;
    const tpTrade = openTrade(tpBot, {
      mode: 'live',
      liveOrderId: 'entry-tp-misparse',
      side: 'yes',
      entryPriceCents: 42,
      contracts: 10,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const closed = await tpBot._closePosition(tpTrade, 57, 'take_profit', {
      liveSellPriceCents: 57,
    });
    checkEq(closed, true, 'TP misparse exit closes');
    checkEq(tpTrade.exitPriceCents, 57, 'TP books 57¢ not blind complement 43¢');
    checkEq(tpTrade.pnlCents, (57 - 42) * 10, 'TP PnL is a real gain');
    check(tpTrade.pnlCents > 0, 'TP is a win');
  }

  // XRP false +$10.32: sell fill with misleading taker_fill_cost must book near
  // sell limit; maker entry with taker cost "0.00" must keep real entry (not 1¢).
  // PnL is gross (Kalshi-style); fees are a note only.
  {
    const xrpEntry = bot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.6900',
        taker_fill_cost_dollars: '0.00',
        maker_fill_cost_dollars: '9.66',
        fill_count: '14.00',
        side: 'bid',
      },
      'yes',
      'buy',
      69
    );
    checkEq(xrpEntry, 69, 'XRP-style maker entry books 69¢ not 1¢');
    // Old bug: entry=1 → (76−1)×14 = 1050 (~$10.50). Real gross: (76−69)×14 = 98.
    checkEq(
      bot._netPnlCents(1, 76, 14, 8, 10),
      1050 - 18,
      'sanity: 1¢ entry would invent the false ~$10.50 before fees'
    );
    checkEq(
      bot._netPnlCents(xrpEntry, 76, 14, 8, 10),
      98 - 18,
      'XRP-style PnL is fee-net cash ($0.98 − $0.18)'
    );

    const xrpClient = {
      hasCredentials: true,
      async createOrder({ action, side, priceCents, count }) {
        checkEq(action, 'sell', 'XRP TP exit sells');
        checkEq(side, 'yes', 'XRP TP exit side yes');
        checkEq(priceCents, 76, 'XRP TP sells at pre_close/bid fill');
        return normalizeCreateOrderResponse({
          order_id: 'xrp-false-pnl-exit',
          fill_count: `${count}.00`,
          remaining_count: '0.00',
          average_fill_price: '0.7600',
          // Misleading: implies ~143¢/contract if trusted blindly (clamped 99).
          taker_fill_cost_dollars: '20.00',
          taker_fees_dollars: '0.10',
          side: 'ask',
        });
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '14.00',
            average_fill_price: '0.7600',
            taker_fill_cost_dollars: '20.00',
            taker_fees_dollars: '0.10',
            side: 'ask',
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
    };
    const xrpBot = makeBot(xrpClient, {
      mode: 'live',
      liveAuthorized: true,
      skimMode: 'insurance',
    });
    xrpBot.config.mode = 'live';
    xrpBot.config.liveAuthorized = true;
    const xrpTrade = openTrade(xrpBot, {
      mode: 'live',
      liveOrderId: 'entry-xrp-false-pnl',
      side: 'yes',
      entryPriceCents: xrpEntry,
      contracts: 14,
      entryFeesCents: 8,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const xrpClosed = await xrpBot._closePosition(xrpTrade, 76, 'take_profit', {
      liveSellPriceCents: 76,
    });
    checkEq(xrpClosed, true, 'XRP-style TP closes');
    checkEq(xrpTrade.exitPriceCents, 76, 'XRP-style TP books avg/sell limit not cost-derived 99¢');
    checkEq(xrpTrade.pnlGrossCents, 98, 'XRP-style TP gross is $0.98');
    checkEq(xrpTrade.pnlCents, 80, 'XRP-style TP cash PnL is $0.80 after fees');
    checkEq(xrpTrade.feesCents, 18, 'XRP-style fees still recorded for the note');
    check(xrpTrade.pnlCents < 200, 'XRP-style TP must not invent huge PnL');
    // 40% wallet of $0.80 = $0.32
    checkEq(xrpTrade.skimmedCents, 32, 'XRP-style wallet skim matches fee-net $0.80 win');
  }

  // ETH: avg entry improvement; cash PnL = gross − fees
  {
    const ethEntry = bot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.5200',
        taker_fill_cost_dollars: '9.52',
        fill_count: '17.00',
        side: 'bid',
      },
      'yes',
      'buy',
      56
    );
    const ethExit = bot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.7900',
        taker_fill_cost_dollars: '13.43',
        fill_count: '17.00',
        side: 'ask',
      },
      'yes',
      'sell',
      79
    );
    checkEq(ethEntry, 52, 'ETH-style entry uses avg improvement (52) not limit cost (56)');
    checkEq(ethExit, 79, 'ETH-style exit uses average_fill_price');
    checkEq(bot._grossPnlCents(56, 79, 17), 391, 'limit prices gross');
    checkEq(
      bot._netPnlCents(56, 79, 17, 24, 25),
      391 - 49,
      'limit prices fee-net'
    );
    checkEq(bot._grossPnlCents(ethEntry, ethExit, 17), 459, 'ETH-style gross ~$4.59');
    checkEq(
      bot._netPnlCents(ethEntry, ethExit, 17, 24, 25),
      459 - 49,
      'ETH-style cash PnL nets fees (~$4.10)'
    );
  }

  // Fees reduce cash PnL; estimated when order omits fee fields
  {
    checkEq(
      bot._orderFeesCents({
        taker_fees_dollars: '0.12',
        maker_fees_dollars: '0.03',
        fill_count: '10',
      }),
      15,
      'taker+maker fees → cents'
    );
    checkEq(
      bot._orderFeesCents({
        average_fee_paid: '0.0200',
        fill_count: '10.00',
      }),
      20,
      'V2 average_fee_paid × fills → cents'
    );
    checkEq(bot._estimateTakerFeesCents(50, 100), 175, 'estimate 100@50¢ → $1.75');
    checkEq(bot._estimateTakerFeesCents(10, 100), 63, 'estimate 100@10¢ → $0.63');
    checkEq(
      bot._netPnlCents(42, 57, 10, 12, 15),
      (57 - 42) * 10 - 27,
      'PnL is fee-net cash'
    );

    const feeClient = {
      hasCredentials: true,
      async getMarket() {
        return {
          status: 'active',
          yes_bid: 57,
          yes_ask: 59,
          close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          floor_strike: 3000,
        };
      },
      async getOpenMarkets() {
        return [];
      },
      async createOrder() {
        return {
          order: {
            order_id: 'oid-fee-exit',
            fill_count: '10.00',
            average_fill_price: '0.5700',
            taker_fees_dollars: '0.15',
          },
        };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '10.00',
            average_fill_price: '0.5700',
            taker_fees_dollars: '0.15',
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
    };
    const feeBot = makeBot(feeClient, { mode: 'live', liveAuthorized: true, skimMode: 'off' });
    feeBot.config.mode = 'live';
    feeBot.config.liveAuthorized = true;
    const feeTrade = openTrade(feeBot, {
      mode: 'live',
      liveOrderId: 'entry-fee',
      side: 'yes',
      entryPriceCents: 42,
      contracts: 10,
      entryFeesCents: 12,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const feeClosed = await feeBot._closePosition(feeTrade, 57, 'take_profit', {
      liveSellPriceCents: 57,
    });
    checkEq(feeClosed, true, 'fee-aware TP closes');
    checkEq(feeTrade.exitFeesCents, 15, 'exit fees booked from order');
    checkEq(feeTrade.feesCents, 27, 'total fees = entry + exit');
    checkEq(feeTrade.pnlGrossCents, (57 - 42) * 10, 'gross price PnL stored');
    checkEq(feeTrade.pnlCents, (57 - 42) * 10 - 27, 'cash PnL nets fees');
    check(
      feeBot.lastDecision.includes('fees $0.27') && feeBot.lastDecision.includes('cash P&L'),
      'decision mentions cash P&L and fees'
    );
  }

  // Live exit refuses 0/100 sell prices
  {
    const refuseBot = makeBot(
      {
        hasCredentials: true,
        async createOrder() {
          throw new Error('createOrder must not run for invalid sell price');
        },
      },
      { mode: 'live', liveAuthorized: true }
    );
    refuseBot.config.mode = 'live';
    const t = openTrade(refuseBot, {
      mode: 'live',
      liveOrderId: 'entry-refuse',
      side: 'yes',
      contracts: 2,
    });
    const ok = await refuseBot._closePosition(t, 0, 'settled_timeout', { liveSellPriceCents: 0 });
    checkEq(ok, false, 'refuse sell at 0¢');
    checkEq(t.status, 'open', 'invalid sell price leaves position open');
  }

  // Status payload shape
  const status = bot.status();
  check(status.config && status.stats && status.capital, 'status() shape');
  check(Array.isArray(status.openTrades), 'status openTrades array');
  check(Object.keys(SERIES_BY_SYMBOL).includes('ETH'), 'ETH series mapped');
  check(Object.keys(SERIES_BY_SYMBOL).includes('BTC'), 'BTC series mapped');
  check(Object.keys(SERIES_BY_SYMBOL).includes('DOGE'), 'DOGE series kept for exit management');
  check(Object.keys(SERIES_BY_SYMBOL).includes('HYPE'), 'HYPE series kept for exit management');
  check(Object.keys(SERIES_BY_SYMBOL).includes('NEAR'), 'NEAR series kept for exit management');
  check(isKalshiTradeEnabled('BTC'), 'BTC tradeable by default');
  check(!isKalshiTradeEnabled('BNB'), 'BNB opted out by default');
  check(!isKalshiTradeEnabled('SOL'), 'SOL opted out by default');
  check(isKalshiTradeEnabled('ETH'), 'ETH tradeable by default');
  check(!isKalshiTradeEnabled('DOGE'), 'DOGE opted out by default');
  check(!isKalshiTradeEnabled('NEAR'), 'NEAR opted out by default');
  check(!isKalshiTradeEnabled('HYPE'), 'HYPE opted out by default');
  check(tradeableKalshiSymbols().includes('ETH'), 'AUTO includes ETH by default');
  check(!tradeableKalshiSymbols().includes('BNB'), 'AUTO excludes BNB by default');
  check(!tradeableKalshiSymbols().includes('SOL'), 'AUTO excludes SOL by default');
  check(tradeableKalshiSymbols().includes('BTC'), 'AUTO includes BTC by default');
  {
    const onlyTrade = symbolsNeedingKalshiTargets({
      config: { autoTradeSymbols: 'BTC,ETH', symbol: 'AUTO' },
      openTrades: [],
    });
    checkEq(onlyTrade.join(','), 'BTC,ETH', 'trade-active symbol set is BTC,ETH');
    check(!onlyTrade.includes('SOL'), 'trade-active set skips SOL when not traded');
    const withOpen = symbolsNeedingKalshiTargets({
      config: { autoTradeSymbols: 'BTC,ETH', symbol: 'AUTO' },
      openTrades: [{ symbol: 'SOL', status: 'open' }],
    });
    check(withOpen.includes('SOL'), 'open SOL stays in trade-active set while held');
    check(withOpen.includes('BTC') && withOpen.includes('ETH'), 'tradeable kept with open hold');
    const engineSol = symbolsNeedingEngineCompute({
      config: { autoTradeSymbols: 'SOL', symbol: 'AUTO' },
      openTrades: [],
    });
    check(engineSol.includes('SOL'), 'engine runs SOL when traded');
    check(engineSol.includes('BTC'), 'engine keeps BTC as alt cross-check');
    check(!engineSol.includes('ETH'), 'engine skips ETH when not traded/held');
    const kalshiSol = symbolsNeedingKalshiTargets({
      config: { autoTradeSymbols: 'SOL', symbol: 'AUTO' },
      openTrades: [],
    });
    checkEq(kalshiSol.join(','), 'SOL', 'trade-active SOL-only has no silent BTC');
  }
  check(
    isKalshiTradeEnabled('BNB', { autoTradeSymbols: 'BTC,BNB,SOL' }),
    'BNB tradeable when listed in autoTradeSymbols'
  );
  check(
    isKalshiTradeEnabled('ETH', { autoTradeSymbols: 'BTC,ETH,SOL' }),
    'ETH tradeable when listed in autoTradeSymbols'
  );
  check(
    isKalshiTradeEnabled('DOGE', { autoTradeSymbols: 'BTC,DOGE' }),
    'DOGE tradeable when listed in autoTradeSymbols'
  );
  check(
    tradeableKalshiSymbols({ autoTradeSymbols: 'BTC,NEAR' }).includes('NEAR'),
    'AUTO includes NEAR when enabled'
  );
  {
    const sample = [
      { strategy: 'model', status: 'closed', symbol: 'ETH', engineConfidence: 68, pnlCents: -16 },
      { strategy: 'model', status: 'closed', symbol: 'BTC', engineConfidence: 78, pnlCents: 12 },
      { strategy: 'model', status: 'closed', symbol: 'SOL', engineConfidence: 54, pnlCents: 36 },
      { strategy: 'model', status: 'closed', symbol: 'BNB', engineConfidence: 54, pnlCents: -16 },
    ];
    const scored = scoreModelSetupsAgainstLog(sample);
    const core = scored.find((s) => s.id === 'core');
    check(core && core.score.trades === 2, 'core setup keeps BTC+ETH fills');
    check(core && core.score.pnlCents === 12 - 16, 'core setup PnL is BTC+ETH');
    check(modelSetupById('core').recommended === true, 'core is recommended setup');
  }
  checkEq(SERIES_BY_SYMBOL.NEAR, 'KXNEAR15M', 'NEAR Kalshi series');
  checkEq(SERIES_BY_SYMBOL.HYPE, 'KXHYPE15M', 'HYPE Kalshi series');

  section('settle strategy helpers');
  checkEq(
    classifyStopVerdictFromResult('yes', 'no'),
    'prevented_loss',
    'YES stop + NO settle = prevented further loss'
  );
  checkEq(
    classifyStopVerdictFromResult('yes', 'yes'),
    'missed_opportunity',
    'YES stop + YES settle = missed opportunity'
  );
  checkEq(
    classifyStopVerdictFromBids({
      entryCents: 88,
      exitCents: 68,
      lastBid: 55,
    }),
    'prevented_loss',
    'bid kept falling after stop → prevented'
  );
  checkEq(
    classifyStopVerdictFromBids({
      entryCents: 88,
      exitCents: 68,
      lastBid: 90,
    }),
    'missed_opportunity',
    'bid recovered above entry after stop → missed'
  );
  check(/prevented further loss/i.test(stopVerdictLabel('prevented_loss')), 'stop verdict label helped');
  {
    const now = Date.parse('2026-08-10T18:30:00.000Z');
    const hour = 60 * 60 * 1000;
    const buckets = buildHourlyPnlBuckets(
      [
        { status: 'closed', closedAt: now - 30 * 60 * 1000, pnlCents: 200 },
        { status: 'closed', closedAt: now - 2.5 * hour, pnlCents: -150 },
        { status: 'closed', closedAt: now - 7 * hour, pnlCents: 999 },
        { status: 'open', closedAt: now, pnlCents: 50 },
      ],
      { hours: 6, now }
    );
    checkEq(buckets.length, 6, 'hourly pnl returns 6 buckets');
    const total = buckets.reduce((s, b) => s + b.pnlCents, 0);
    checkEq(total, 50, 'hourly pnl sums only last 6h closed trades');
    checkEq(
      buckets.reduce((s, b) => s + b.trades, 0),
      2,
      'hourly pnl counts 2 closed trades in window'
    );
  }
  {
    const now = Date.now();
    const mk = (minsLeft, pnl, reason, agoMin = 30) => ({
      status: 'closed',
      strategy: 'settle',
      exitReason: reason,
      pnlCents: pnl,
      openedAt: now - agoMin * 60_000 - minsLeft * 60_000,
      windowCloseTime: now - agoMin * 60_000,
      closedAt: now - agoMin * 60_000,
    });
    const thin = recommendSettleOpenWindow([mk(4, 50, 'settled')], { now, currentMode: 'settle' });
    checkEq(thin.light, 'neutral', 'settle window rec neutral with too few trades');
    checkEq(thin.suggestedMode, null, 'neutral has no mode target');

    const healthy = recommendSettleOpenWindow(
      [
        mk(4, 120, 'settled', 20),
        mk(3, 80, 'take_profit', 25),
        mk(5, 60, 'settled', 40),
        mk(4, 40, 'near_certain', 50),
      ],
      { now, currentMode: 'settle' }
    );
    checkEq(healthy.light, 'green', 'healthy recent settle book → green settle');
    checkEq(healthy.suggestedMode, 'settle', 'green suggests settle mode');

    const rough = recommendSettleOpenWindow(
      [
        mk(4, -200, 'stop_loss', 15),
        mk(3, -180, 'settle_weak_switch', 20),
        mk(5, -90, 'stop_loss', 25),
        mk(4, 30, 'settle_stuck', 35),
      ],
      { now, currentMode: 'settle' }
    );
    checkEq(rough.light, 'red', 'rough recent settle book → red edge');
    checkEq(rough.suggestedMode, 'edge', 'red suggests edge mode');
    check(/prefer edge/i.test(rough.reason || ''), 'red reason mentions edge');

    const midBetter = recommendSettleOpenWindow(
      [
        mk(7, 150, 'settled', 10),
        mk(6.5, 120, 'take_profit', 20),
        mk(4, -100, 'stop_loss', 30),
        mk(3.5, -80, 'stop_loss', 40),
      ],
      { now, currentMode: 'edge' }
    );
    checkEq(midBetter.light, 'green', 'mid-window avg beats late → green');
    checkEq(midBetter.suggestedMode, 'settle', 'mid-better suggests settle');
  }

  // Live 15m candle regime: choppy → edge, calm one-sided → settle
  {
    const now = Date.now();
    const mkWindow = ({ open, trendPerBar, noise = 0, bars = 15 }) => {
      const out = [];
      let px = open;
      for (let i = 0; i < bars; i += 1) {
        const next = px + trendPerBar + (i % 2 === 0 ? noise : -noise);
        const high = Math.max(px, next) + Math.abs(noise) * 0.25;
        const low = Math.min(px, next) - Math.abs(noise) * 0.25;
        out.push({
          time: now - (bars - i) * 60_000,
          open: px,
          high,
          low,
          close: next,
          volume: 1,
        });
        px = next;
      }
      return out;
    };
    const choppy = {
      BTC: mkWindow({ open: 100000, trendPerBar: 5, noise: 400, bars: 15 }),
      ETH: mkWindow({ open: 3500, trendPerBar: -2, noise: 25, bars: 15 }),
      SOL: mkWindow({ open: 150, trendPerBar: 0.2, noise: 2.5, bars: 15 }),
    };
    const chopScore = scoreMarketRegime(choppy, { now });
    check(chopScore.ready, 'choppy regime ready');
    checkEq(chopScore.light, 'red', 'choppy 15m → red/edge');
    checkEq(chopScore.suggestedMode, 'edge', 'choppy suggests edge');

    const calm = {
      BTC: mkWindow({ open: 100000, trendPerBar: 8, noise: 0.5, bars: 15 }),
      ETH: mkWindow({ open: 3500, trendPerBar: 0.4, noise: 0.05, bars: 15 }),
      SOL: mkWindow({ open: 150, trendPerBar: 0.02, noise: 0.002, bars: 15 }),
    };
    const calmScore = scoreMarketRegime(calm, { now });
    check(calmScore.ready, 'calm regime ready');
    checkEq(calmScore.light, 'green', 'calm one-sided 15m → green/settle');
    checkEq(calmScore.suggestedMode, 'settle', 'calm suggests settle');

    const fromCandles = recommendSettleOpenWindow([], {
      now,
      currentMode: 'settle',
      candlesBySymbol: choppy,
    });
    checkEq(fromCandles.light, 'red', 'recommend prefers candle regime over empty trade book');
    checkEq(fromCandles.suggestedMode, 'edge', 'candle regime suggests edge');
  }

  checkEq(strategyModeForLight('red'), 'edge', 'red maps to edge');
  checkEq(strategyModeForLight('green'), 'settle', 'green maps to settle');
  checkEq(EDGE_MAX_ENTRY_DEFAULT_CENTS, 95, 'edge max entry default 95');
  checkEq(EDGE_PRE_CLOSE_SMALL_LOSS_DEFAULT_CENTS, 75, 'edge pre-close loss default 75¢');
  checkEq(EDGE_PRE_CLOSE_MINUTES_DEFAULT, 5, 'edge pre-close minutes default 5');
  {
    const bot = makeBot(mockClient(null), { strategyMode: 'settle' });
    bot.getSettleWindowRecommendation = () => ({
      light: 'red',
      suggestedMode: 'edge',
      reason: 'rough',
    });
    const applied = bot.applySettleWindowRecommendation();
    check(applied.ok, 'red apply ok');
    checkEq(bot.config.strategyMode, 'edge', 'red apply → edge');

    bot.getSettleWindowRecommendation = () => ({
      light: 'green',
      suggestedMode: 'settle',
      reason: 'healthy',
    });
    const green = bot.applySettleWindowRecommendation();
    check(green.ok, 'green apply ok');
    checkEq(bot.config.strategyMode, 'settle', 'green apply → settle');
  }
  {
    const bot = makeBot(mockClient(null), { strategyMode: 'settle' });
    bot.getSettleWindowRecommendation = () => ({
      light: 'neutral',
      suggestedMode: null,
      reason: 'Need more trades',
    });
    const blocked = bot.applySettleWindowRecommendation();
    check(!blocked.ok, 'neutral without force cannot apply');
    const forced = bot.applySettleWindowRecommendation({ light: 'edge' });
    check(forced.ok, 'manual edge apply ok while neutral');
    check(forced.forced === true, 'manual apply marked forced');
    checkEq(bot.config.strategyMode, 'edge', 'manual edge → edge');
    const settle = bot.applySettleWindowRecommendation({ light: 'settle' });
    check(settle.ok, 'manual settle apply ok while neutral');
    checkEq(bot.config.strategyMode, 'settle', 'manual settle → settle');
  }

  checkEq(settleEntryBand({}).min, 80, 'settle band default min 80');
  checkEq(settleEntryBand({}).max, 94, 'settle band default max 94');
  checkEq(settleMinUpsideCents({}), 6, 'settle min upside defaults to 6¢');
  checkEq(
    settleMinUpsideCents({ settleStopLossCents: 20 }),
    6,
    'wide settle stop does not force min upside = 20'
  );
  check(isSettleEntryPriceCents(87), '87¢ inside settle band');
  check(isSettleEntryPriceCents(92), '92¢ inside settle band');
  check(isSettleEntryPriceCents(94), '94¢ at settle band max (hold-to-settle)');
  check(!isSettleEntryPriceCents(95), '95¢ outside settle band');
  check(isSettleEntryPriceCents(84), '84¢ inside settle band');
  check(!isSettleEntryPriceCents(79), '79¢ outside settle band');
  check(!isSettleEntryPriceCents(96), '96¢ outside settle band');
  check(!isSettleEntryPriceCents(72, {}, 10), '72¢ blocked with 10m left (late not open)');
  check(isSettleEntryPriceCents(72, {}, 3), '72¢ allowed with 3m left (late fallback)');
  checkEq(settleEffectiveEntryBand({}, 3).min, 70, 'late effective band floor 70');
  checkEq(settleEffectiveEntryBand({}, 3).late, true, 'late flag on at 3m');
  checkEq(settleEffectiveEntryBand({}, 5).late, false, 'late flag off at 5m');
  check(isSettleStrategyMode({ strategyMode: 'settle' }), 'settle mode flag');
  check(!isSettleStrategyMode({ strategyMode: 'edge' }), 'edge mode flag');
  check(isSettleTrade({ strategy: 'settle' }), 'settle trade tag');
  {
    const settleBot = new TradingBot({
      kalshiClient: { hasCredentials: false },
      config: {
        mode: 'paper',
        liveAuthorized: false,
        strategyMode: 'settle',
        stopLossCents: 23,
        settleStopLossCents: 8,
      },
    });
    // Saved overrides can win in constructor — pin the value under test.
    settleBot.config.settleStopLossCents = 8;
    checkEq(
      settleBot._stopLevelCents({ strategy: 'settle', entryPriceCents: 87 }),
      79,
      'settle stop uses settleStopLossCents (87−8)'
    );
    settleBot.updateConfig({ settleStopLossCents: 2 });
    checkEq(settleBot.config.settleStopLossCents, 8, 'settle stop cannot go below 8¢ floor');
    settleBot.updateConfig({ settleStopLossCents: 60 });
    checkEq(settleBot.config.settleStopLossCents, 60, 'settle stop allows 60¢ max');
    settleBot.updateConfig({ settleStopLossCents: 61 });
    checkEq(settleBot.config.settleStopLossCents, 60, 'settle stop clamps above 60¢');
    settleBot.config.settleStopLossCents = 20;
    checkEq(
      settleBot._stopLevelCents({ strategy: 'settle', entryPriceCents: 87 }),
      67,
      'settle stop 20¢ → level 67'
    );
    checkEq(
      settleBot._stopLevelCents({ strategy: 'edge', entryPriceCents: 55 }),
      32,
      'edge stop still uses stopLossCents'
    );
    checkEq(
      settleBot._stopLevelCents(
        { strategy: 'edge', entryPriceCents: 55, openedAt: Date.now() - 4 * 60 * 1000 },
        Date.now()
      ),
      55,
      'edge stop rises to breakeven after 3m hold'
    );
    checkEq(
      settleBot._stopLevelCents(
        { strategy: 'edge', entryPriceCents: 55, openedAt: Date.now() - 60 * 1000 },
        Date.now()
      ),
      32,
      'edge stop stays wide before 3m hold'
    );
    checkEq(
      settleBot._sanityCheckEntryFillCents(59, 81),
      81,
      'settle entry fill far below limit uses limit (not 59¢ ghost)'
    );
    settleBot.config.strategyMode = 'settle';
    settleBot.config.settlePostStopSameSideCooldownMinutes = 5;
    const stopAt = Date.now() - 10_000;
    settleBot.ledger.trades = [
      {
        status: 'closed',
        exitReason: 'stop_loss',
        symbol: 'SOL',
        side: 'yes',
        closedAt: stopAt,
        exitPriceCents: 37,
        windowCloseTime: stopAt + 10 * 60 * 1000,
      },
    ];
    const sameSideBlocked = await settleBot._stoppedCoinRecoveryGate('SOL', 'yes', 90, null, {});
    check(!sameSideBlocked.ok, 'settle mode blocks same-side re-entry during sit-out');
    check(/same-side sit-out/i.test(sameSideBlocked.reason || ''), 'settle sit-out reason mentions cooldown');
    const peerOk = await settleBot._stoppedCoinRecoveryGate('BNB', 'yes', 90, null, {});
    // Peer may still hit bounce/cascade; at minimum same-side must not apply to BNB.
    check(
      peerOk.ok || !/same-side sit-out/i.test(peerOk.reason || ''),
      'settle same-side sit-out does not apply to other coins'
    );
  checkEq(
      postStopSameSideCooldownMs({ strategyMode: 'settle' }),
      2.5 * 60 * 1000,
      'settle default same-side cooldown is 2.5m'
    );
  }

  // Bug: BNB TP in front of ledger hid HYPE stop → same-second HYPE reopen
  {
    const now = Date.now();
    const hideBot = makeBot(mockClient({}), {
      strategyMode: 'settle',
      settlePostStopSameSideCooldownMinutes: 5,
      maxOpenPositions: 2,
    });
    hideBot.config.strategyMode = 'settle';
    hideBot.ledger.trades = [
      {
        status: 'closed',
        exitReason: 'take_profit',
        symbol: 'BNB',
        side: 'yes',
        closedAt: now - 10_000,
      },
      {
        status: 'closed',
        exitReason: 'stop_loss',
        symbol: 'HYPE',
        side: 'yes',
        closedAt: now - 1_000,
        windowCloseTime: now + 10 * 60 * 1000,
      },
    ];
    checkEq(hideBot._lastStopLossTrade()?.symbol, 'HYPE', 'last stop uses closedAt not array order');
    const gate = await hideBot._stoppedCoinRecoveryGate('HYPE', 'yes', 88, null, {});
    check(!gate.ok, 'HYPE YES blocked after stop even when BNB TP is first in ledger');
    check(/same-side sit-out/i.test(gate.reason || ''), 'hidden-stop still triggers same-side sit-out');

    hideBot._stoppedSymbolsThisCycle = new Set(['HYPE']);
    const sameTurn = await hideBot._openPosition({
      symbol: 'HYPE',
      ticker: 'KXHYPE15M-REOPEN',
      side: 'yes',
      priceCents: 88,
      floorStrike: 40,
      closeTime: now + 10 * 60 * 1000,
      engineProbability: 60,
      engineConfidence: 70,
      strategy: 'settle',
    });
    checkEq(sameTurn, false, 'same-cycle stop blocks HYPE reopen');
    check(/same-turn|earlier this cycle/i.test(hideBot.lastDecision || ''), 'same-turn skip message');
  }

  {
    check(liquidityPriority('BTC') > liquidityPriority('XRP'), 'BTC ranked more liquid than XRP');
    check(
      settleRankAskScore(90) > settleRankAskScore(95),
      'settle AUTO prefers 90¢ ask over 95¢ (rich demotion)'
    );
    check(
      settleRankAskScore(94) > settleRankAskScore(88),
      'among sub-95 asks, higher still ranks better'
    );
    checkEq(settleExitPlan(91).targetCents, null, 'entry 91¢ holds to settle');
    checkEq(settleExitPlan(91).tier, 'hold', 'entry 91¢ is hold tier');
    checkEq(settleExitPlan(87).targetCents, 96, 'entry 87¢ aims for 96¢');
    checkEq(settleExitPlan(87).staleMinutesLeft, 2, 'entry 87¢ stale @ 2m left');
    checkEq(settleExitPlan(82).targetCents, 94, 'entry 82¢ aims for 94¢');
    checkEq(settleExitPlan(77).targetCents, 93, 'entry 77¢ aims for 93¢');
    checkEq(settleExitPlan(77).tier, 'low', 'entry 77¢ is low tier');
    checkEq(settleExitPlan(72).targetCents, 88, 'late entry 72¢ aims for 88¢');
    checkEq(settleExitPlan(72).staleMinutesLeft, 2.5, 'late 70–74 stale @ 2.5m');
    checkEq(settleExitPlan(72).tier, 'late', 'entry 72¢ is late tier');
    checkEq(settleExitPlan(65).targetCents, 85, 'deep late 65¢ aims for 85¢');
    checkEq(settleExitPlan(65).staleMinutesLeft, 4, 'deep late stale @ 4m');
    checkEq(settleExitPlan(65).tier, 'deep', 'entry 65¢ is deep tier');
    const dashTiers = settleExitTiersForDashboard();
    checkEq(dashTiers.length, SETTLE_EXIT_TIERS.length, 'dashboard tiers match SETTLE_EXIT_TIERS');
    checkEq(dashTiers[0].entryLabel, '≥90¢', 'dashboard first tier ≥90¢');
    checkEq(dashTiers[4].aimLabel, '88¢', 'dashboard 70–74 tier aims 88¢');
    checkEq(dashTiers[5].aimLabel, '85¢', 'dashboard deep late aims 85¢');
    checkEq(settleExitPlan(94).targetCents, null, 'entry 94¢ holds to settle (no TP chase)');
    checkEq(settleExitPlan(90).tier, 'hold', 'entry 90¢ is hold tier');
    check(isSettleTieredExitsEnabled({}), 'tiered exits default on');
    check(isSettleTieredExitsEnabled({ settleTieredExits: 'on' }), 'tiered exits on');
    check(!isSettleTieredExitsEnabled({ settleTieredExits: 'off' }), 'tiered exits off');
  }

  // Settle stuck: flat at entry for 3m → breakeven
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 80,
        no_bid: 20,
      }),
      { settleStopLossCents: 20, settleStuckHoldMinutes: 3 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 80,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
      _settleNearEntrySince: now - 5 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'breakeven', 'settle stuck flat exits breakeven');
  }

  // Settle stuck: must not BE early when near-since was null (Number(null)===0 bug)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 80,
        no_bid: 20,
      }),
      { settleStopLossCents: 20, settleStuckHoldMinutes: 3 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 80,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now - 30_000,
      _settleNearEntrySince: null,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'null near-since does not instant-breakeven');
    check(trade._settleNearEntrySince > 1e12, 'near-since armed to real timestamp');
  }

  // Settle stuck: +1¢ green is settle_stuck after hold, not breakeven
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 85,
        no_bid: 15,
      }),
      { settleStopLossCents: 20, settleStuckHoldMinutes: 3 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 84,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'settle_stuck', 'settle +1¢ parked banks as stuck not BE');
  }

  // Settle stuck: small green parked under target → settle_stuck
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 83,
        no_bid: 17,
      }),
      { settleStopLossCents: 20, settleStuckHoldMinutes: 3 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 80,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'settle_stuck', 'settle stuck banks small green');
    checkEq(trade.exitPriceCents, 83, 'settle stuck sells at live bid');
  }

  // Settle: touched 90¢ then dipped — with >3:30 left, not forced to hold (stale clock not due yet)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 5 * 60 * 1000).toISOString(),
        yes_bid: 87,
        no_bid: 13,
      }),
      { settleStopLossCents: 20, settleStuckHoldMinutes: 3 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 84,
      windowCloseTime: now + 5 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
      settleTouched90: true,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'touched-90 with >3:30 left does not force hold-to-settle yet');
    checkEq(trade.exitReason, undefined, 'no early exit when >3:30 and stale clock not due');
  }

  // Settle: touched 90 and ≤3:30 left — hold (no stuck / stale), stop still on
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 90 * 1000).toISOString(),
        yes_bid: 87,
        no_bid: 13,
      }),
      { settleStopLossCents: 20, settleStuckHoldMinutes: 3 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 84,
      windowCloseTime: now + 90 * 1000,
      openedAt: now - 5 * 60 * 1000,
      settleTouched90: true,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'after tagging 90¢ with ≤3:30 left, dip holds (no stale)');
    checkEq(trade.exitReason, undefined, 'touched-90 hold has no early exit in final 3:30');
  }

  // Settle: after tagging 90 with >3:30 left, tier TP can still bank
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { settleStopLossCents: 20 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now,
      settleTouched90: true,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'take_profit', 'touched-90 with >3:30 left banks tier TP');
  }

  // Settle: after tagging 90 with ≤3:30 left, hold to settle (ignore TP) — stop still on
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { settleStopLossCents: 20 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 2 * 60 * 1000,
      openedAt: now,
      settleTouched90: true,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'touched-90 with ≤3:30 left holds through tier TP');
    checkEq(trade.exitReason, undefined, 'no TP while holding to settle in final 3:30 after 90');
  }

  // Settle: stop still fires after tagging 90 with time left
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 60,
        no_bid: 40,
      }),
      { settleStopLossCents: 20 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 2 * 60 * 1000,
      openedAt: now,
      settleTouched90: true,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'stop_loss', 'stop still applies after touched-90 hold');
  }

  // Late low-aim: bank 88 before 90; once 90 prints with ≤3:30 left, wait for settle
  {
    const now = Date.now();
    const bankBot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 88,
        no_bid: 12,
      }),
      { settleStopLossCents: 20 }
    );
    const bankTrade = openTrade(bankBot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 72,
      windowCloseTime: now + 10 * 60 * 1000,
      openedAt: now,
    });
    await bankBot._manageOpenTrade(bankTrade, predictions(3000));
    checkEq(bankTrade.exitReason, 'take_profit', 'late 72¢ banks 88¢ TP before tagging 90');

    const waitBot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 90,
        no_bid: 10,
      }),
      { settleStopLossCents: 20 }
    );
    const waitTrade = openTrade(waitBot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 72,
      windowCloseTime: now + 2 * 60 * 1000,
      openedAt: now,
    });
    await waitBot._manageOpenTrade(waitTrade, predictions(3000));
    checkEq(waitTrade.status, 'open', 'late 72¢ at 90¢ with ≤3:30 left stays open (wait for settle)');
    checkEq(waitTrade.settleTouched90, true, 'late 72¢ latches touched-90 at 90¢');
    checkEq(waitTrade.exitReason, undefined, 'late 72¢ does not bank low TP in final 3:30 after 90');
  }

  // Settle Kalshi-only: no Coinbase ready still opens when ask is in band
  {
    const now = Date.now();
    const hypeMarket = {
      ticker: 'KXHYPE15M-KONLY',
      status: 'open',
      floor_strike: 40,
      close_time: new Date(now + 8 * 60 * 1000).toISOString(),
      yes_bid: 86,
      yes_ask: 88,
      no_bid: 12,
      no_ask: 14,
    };
    const kalshiOnlyBot = makeBot(mockClient(hypeMarket), {
      symbol: 'HYPE',
      strategyMode: 'settle',
      settleEntryMinCents: 80,
      settleEntryMaxCents: 92,
      settleMinMinutesToOpen: 0.5,
      settleMaxMinutesToOpen: 12,
      settleStopLossCents: 20,
      settleMinUpsideCents: 8,
      minEntryCents: 1,
    });
    kalshiOnlyBot.config.strategyMode = 'settle';
    kalshiOnlyBot.config.symbol = 'HYPE';
    const noFeedOpp = await kalshiOnlyBot._evaluateSymbolForSettle('HYPE', {
      HYPE: { ready: false, price: null },
    });
    check(noFeedOpp, 'settle allows Kalshi-only when Coinbase not ready');
    checkEq(noFeedOpp && noFeedOpp.side, 'yes', 'Kalshi-only picks YES in band');
    checkEq(noFeedOpp && noFeedOpp.engineReady, false, 'Kalshi-only marks engineReady false');
    checkEq(noFeedOpp && noFeedOpp.priceCents, 88, 'Kalshi-only uses yes ask');

    // Ready + lean against: still take the in-band side (lean is preference, not veto)
    const leanNo = await kalshiOnlyBot._evaluateSymbolForSettle('HYPE', {
      HYPE: {
        ready: true,
        price: 40,
        windows: {
          w5: { probabilityUp: 35, probabilityDown: 65, confidence: 70 },
          w10: { probabilityUp: 35, probabilityDown: 65, confidence: 70 },
          w15: { probabilityUp: 35, probabilityDown: 65, confidence: 70 },
        },
      },
    });
    check(leanNo, 'settle takes in-band ask even when spot lean disagrees');
    checkEq(leanNo && leanNo.side, 'yes', 'only YES in band → YES despite lean NO');

    // NO priced in band (YES cheap) + lean YES → still take NO
    const downMarket = {
      ticker: 'KXHYPE15M-DOWN',
      status: 'open',
      floor_strike: 40,
      close_time: new Date(now + 8 * 60 * 1000).toISOString(),
      yes_bid: 8,
      yes_ask: 10,
      no_bid: 90,
      no_ask: 92,
    };
    const downBot = makeBot(mockClient(downMarket), {
      symbol: 'HYPE',
      strategyMode: 'settle',
      settleEntryMinCents: 80,
      settleEntryMaxCents: 94,
      settleMinMinutesToOpen: 0.5,
      settleMaxMinutesToOpen: 12,
      settleStopLossCents: 40,
      settleMinUpsideCents: 6,
      settleRichAskFloorCents: 95,
      minEntryCents: 1,
    });
    downBot.config.strategyMode = 'settle';
    downBot.config.symbol = 'HYPE';
    const downOpp = await downBot._evaluateSymbolForSettle('HYPE', {
      HYPE: {
        ready: true,
        price: 40,
        windows: {
          w5: { probabilityUp: 60, probabilityDown: 40, confidence: 70 },
          w10: { probabilityUp: 60, probabilityDown: 40, confidence: 70 },
          w15: { probabilityUp: 60, probabilityDown: 40, confidence: 70 },
        },
      },
    });
    check(downOpp, 'settle takes NO when NO ask is in band');
    checkEq(downOpp && downOpp.side, 'no', 'NO-in-band pick is NO even if spot leans YES');
    checkEq(downOpp && downOpp.priceCents, 92, 'NO ask prefers market.no_ask');

    // NO in the 80s (below YES primary min 85) still qualifies
    const no80Market = {
      ticker: 'KXHYPE15M-NO80',
      status: 'open',
      floor_strike: 40,
      close_time: new Date(now + 8 * 60 * 1000).toISOString(),
      yes_bid: 17,
      yes_ask: 19,
      no_bid: 81,
      no_ask: 83,
    };
    const no80Bot = makeBot(mockClient(no80Market), {
      symbol: 'HYPE',
      strategyMode: 'settle',
      settleEntryMinCents: 85,
      settleEntryMaxCents: 94,
      settleNoEntryMinCents: 80,
      settleMinMinutesToOpen: 0.5,
      settleMaxMinutesToOpen: 12,
      settleStopLossCents: 40,
      settleMinUpsideCents: 6,
      settleRichAskFloorCents: 95,
      minEntryCents: 1,
    });
    no80Bot.config.strategyMode = 'settle';
    const no80Opp = await no80Bot._evaluateSymbolForSettle('HYPE', {
      HYPE: { ready: false, price: null },
    });
    check(no80Opp, 'settle allows NO in the 80s');
    checkEq(no80Opp && no80Opp.side, 'no', '80s down pick is NO');
    checkEq(no80Opp && no80Opp.priceCents, 83, 'NO 80s uses market.no_ask (or 100−yes_bid)');
    check(
      !isSettleEntryPriceCents(83, no80Bot.config, 8, 'yes'),
      'YES still blocked at 83 with primary min 85'
    );
    check(
      isSettleEntryPriceCents(83, no80Bot.config, 8, 'no'),
      'NO allowed at 83 with no-min 80'
    );

    // Missing YES bid but real no_ask in band → still take NO
    const noAskOnlyMarket = {
      ticker: 'KXHYPE15M-NOASK',
      status: 'open',
      floor_strike: 40,
      close_time: new Date(now + 8 * 60 * 1000).toISOString(),
      yes_bid: null,
      yes_ask: null,
      no_bid: 10,
      no_ask: 88,
    };
    const noAskOnlyBot = makeBot(mockClient(noAskOnlyMarket), {
      symbol: 'HYPE',
      strategyMode: 'settle',
      settleEntryMinCents: 80,
      settleEntryMaxCents: 94,
      settleMinMinutesToOpen: 0.5,
      settleMaxMinutesToOpen: 12,
      settleStopLossCents: 40,
      settleMinUpsideCents: 6,
      settleRichAskFloorCents: 95,
      minEntryCents: 1,
    });
    noAskOnlyBot.config.strategyMode = 'settle';
    noAskOnlyBot.config.symbol = 'HYPE';
    const noAskOnlyOpp = await noAskOnlyBot._evaluateSymbolForSettle('HYPE', {
      HYPE: { ready: false, price: null },
    });
    check(noAskOnlyOpp, 'settle takes NO when only no_ask is quoted');
    checkEq(noAskOnlyOpp && noAskOnlyOpp.side, 'no', 'no_ask-only pick is NO');
    checkEq(noAskOnlyOpp && noAskOnlyOpp.priceCents, 88, 'uses market.no_ask directly');

    // Rank scan includes not-ready coins (not stuck on "Not ready")
    const rankBot = makeBot(
      {
        hasCredentials: false,
        async getMarket() {
          return hypeMarket;
        },
        async getOpenMarkets(series) {
          if (series === 'KXHYPE15M') return [hypeMarket];
          return [];
        },
        async createOrder() {
          throw new Error('unused');
        },
        async getBalance() {
          return { balance: 0, portfolio_value: 0 };
        },
      },
      {
        symbol: 'AUTO',
        strategyMode: 'settle',
        settleEntryMinCents: 80,
        settleEntryMaxCents: 92,
        settleMinMinutesToOpen: 0.5,
        settleMaxMinutesToOpen: 12,
        settleStopLossCents: 20,
        settleMinUpsideCents: 8,
        minEntryCents: 1,
      }
    );
    rankBot.config.strategyMode = 'settle';
    rankBot.config.symbol = 'AUTO';
    const ranked = await rankBot._rankSettleOpportunities({
      BTC: { ready: false },
      ETH: { ready: false },
      SOL: { ready: false },
      XRP: { ready: false },
      BNB: { ready: false },
      NEAR: { ready: false },
      HYPE: { ready: false },
    });
    check(ranked.some((o) => o.symbol === 'HYPE'), 'settle rank includes Kalshi-only HYPE');
    check(/Kalshi-only/i.test(rankBot.lastDecision || ''), 'decision notes Kalshi-only coins');
  }

  // Settle toggle off: ignore entry-tiered TP even when target bid prints
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { settleStopLossCents: 8, settleTieredExits: 'off' }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 91,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle tiered off holds through target bid');
  }
}

async function testModelStrategy() {
  section('model strategy tab (window-only)');

  checkEq(pickModelWindowKey(12), 'w5', '>10m → w5');
  checkEq(pickModelWindowKey(10.01), 'w5', 'just over 10 → w5');
  checkEq(pickModelWindowKey(10), 'w10', '10m → w10');
  checkEq(pickModelWindowKey(7), 'w10', '5–10m → w10');
  checkEq(pickModelWindowKey(5.01), 'w10', 'just over 5 → w10');
  checkEq(pickModelWindowKey(5), 'w15', '≤5m → w15 (long horizon)');
  checkEq(pickModelWindowKey(1), 'w15', 'late → w15');

  const asset = {
    ready: true,
    windows: {
      w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
      w10: { ...win(40, 70), tracking: { predictedDirection: 'DOWN' } },
      w15: win(50, 60),
    },
  };
  checkEq(pickModelWindow(asset, 12).key, 'w5', 'pick early window key');
  checkEq(pickModelWindow(asset, 12).direction, 'UP', 'early follows live UP (matches lock)');
  checkEq(pickModelWindow(asset, 8).direction, 'DOWN', 'mid follows live DOWN');
  checkEq(modelWindowDirection(win(49, 60)), 'DOWN', 'live lean DOWN under 50');
  checkEq(
    modelWindowDirection({ ...win(25, 80), tracking: { predictedDirection: 'UP' } }),
    'DOWN',
    'live 75% DOWN overrides stale UP lock'
  );
  checkEq(
    modelWindowDirection({ ...win(50, 80), tracking: { predictedDirection: 'DOWN' } }),
    'DOWN',
    '50/50 tie keeps tracking lock'
  );
  check(modelDirectionAgainstHeld('DOWN', 'yes'), 'DOWN against YES');
  check(!modelDirectionAgainstHeld('UP', 'yes'), 'UP not against YES');
  check(isModelStrategyMode({ strategyMode: 'model' }), 'model mode helper');
  check(isModelTrade({ strategy: 'model' }), 'model trade helper');
  checkEq(MODEL_MAX_ENTRY_DEFAULT_CENTS, 88, 'model max entry default 88¢');
  checkEq(MODEL_MIN_ENTRY_DEFAULT_CENTS, 65, 'model min entry default 65¢');
  checkEq(MODEL_KALSHI_FAVORITE_CENTS_DEFAULT, 75, 'Kalshi favorite floor 75¢');
  {
    const mkt = { yes_ask: 24, yes_bid: 22, no_ask: 78, no_bid: 76 };
    checkEq(modelKalshiFavoriteSide(mkt, {}), 'no', 'NO ≥75 is Kalshi favorite');
    checkEq(
      modelKalshiFavoriteGate({ market: mkt, side: 'yes', priceCents: 24, config: {} }).ok,
      false,
      'blocks YES longshot while NO is ≥75¢ favorite'
    );
    checkEq(
      modelKalshiFavoriteGate({ market: mkt, side: 'no', priceCents: 78, config: {} }).ok,
      true,
      'allows NO when it is the ≥75¢ favorite'
    );
  }
  checkEq(MODEL_PERFECT_MIN_ENTRY_DEFAULT_CENTS, 65, 'perfect floor matches min (no sub-60)');
  checkEq(MODEL_CONFIRM_CROSS_CENTS_DEFAULT, 50, 'confirm cross default 50¢');
  checkEq(MODEL_CONFIRM_MAX_EXTENSION_CENTS_DEFAULT, 15, 'confirm max extension +15¢');
  checkEq(MODEL_TRAIL_CENTS_DEFAULT, 0, 'trail off by default (simplified exits)');

  // Confirm gate: OFF until a MODEL close in this run (old ledger must not arm it)
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-WARMUP',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 84,
        yes_ask: 86,
        no_bid: 14,
        no_ask: 16,
      }),
      {
        strategyMode: 'model',
        modelMinConfidence: 55,
        modelMinEntryCents: 60,
        modelConfirmCrossCents: 50,
        modelConfirmMaxExtensionCents: 15,
        modelConfirmMinContinueCents: 2,
      }
    );
    // Old closed MODEL on ledger — must NOT arm the gate.
    bot.ledger.trades.unshift({
      id: 'old-model-rt',
      strategy: 'model',
      status: 'closed',
      symbol: 'SOL',
      side: 'yes',
      entryPriceCents: 60,
      exitPriceCents: 70,
      closedAt: Date.now() - 86_400_000,
    });
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(88, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    const warmup = await bot._evaluateSymbolForModel('ETH', preds);
    check(
      warmup && warmup.side === 'yes' && warmup.priceCents === 86,
      'confirm gate off before first MODEL close this run (even with old ledger RT)'
    );
    checkEq(bot._modelConfirmGateArmed, false, 'armed flag still false');
    checkEq(
      bot._hasCompletedModelRoundTrip('ETH'),
      false,
      'ETH not armed before its own RT'
    );
    // Closing another coin must not arm ETH.
    bot._modelConfirmProcessStartedAt = Date.now() - 60_000;
    bot._resetModelConfirmGatesForTrade({
      strategy: 'model',
      symbol: 'BTC',
      ticker: 'KXBTC15M-X',
      openedAt: Date.now() - 1000,
      status: 'closed',
    });
    checkEq(bot._hasCompletedModelRoundTrip('BTC'), true, 'BTC armed after its RT');
    checkEq(bot._hasCompletedModelRoundTrip('ETH'), false, 'ETH still unarmed after BTC RT');
  }

  // Confirm gate: must see below 50, cross, then continue — not buy the top
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-CONFIRM',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 84,
        yes_ask: 86,
        no_bid: 14,
        no_ask: 16,
      }),
      {
        strategyMode: 'model',
        modelMinConfidence: 55,
        modelMinEntryCents: 60,
        modelConfirmCrossCents: 50,
        modelConfirmMaxExtensionCents: 15,
        modelConfirmMinContinueCents: 2,
      }
    );
    // Gate only arms for THAT coin after a MODEL buy+sell opened this run.
    bot._modelConfirmArmedSymbols = new Set(['ETH']);
    bot._modelConfirmGateArmed = true;
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(88, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    const top = await bot._evaluateSymbolForModel('ETH', preds);
    checkEq(top, null, '86¢ without under-50 print → blocked (no buy top)');
    check(/fresh print under|never saw|under 50/i.test(bot.lastDecision || ''), 'cites need fresh under-50');

    bot.client = mockClient({
      ticker: 'KXETH15M-CONFIRM',
      status: 'open',
      floor_strike: 3000,
      close_time: new Date(closeMs).toISOString(),
      yes_bid: 44,
      yes_ask: 46,
      no_bid: 54,
      no_ask: 56,
    });
    const below = await bot._evaluateSymbolForModel('ETH', preds);
    checkEq(below, null, '46¢ under confirm — waiting to cross');
    check(/need cross of 50|below 60|min entry|skip entry/i.test(bot.lastDecision || ''), 'cites need cross or min entry');

    bot.client = mockClient({
      ticker: 'KXETH15M-CONFIRM',
      status: 'open',
      floor_strike: 3000,
      close_time: new Date(closeMs).toISOString(),
      yes_bid: 50,
      yes_ask: 51,
      no_bid: 49,
      no_ask: 50,
    });
    const crossed = await bot._evaluateSymbolForModel('ETH', preds);
    checkEq(crossed, null, 'cross tick waits for continuation');

    bot.client = mockClient({
      ticker: 'KXETH15M-CONFIRM',
      status: 'open',
      floor_strike: 3000,
      close_time: new Date(closeMs).toISOString(),
      yes_bid: 61,
      yes_ask: 62,
      no_bid: 38,
      no_ask: 39,
    });
    const ready = await bot._evaluateSymbolForModel('ETH', preds);
    check(ready && ready.side === 'yes' && ready.priceCents === 62, 'after cross+continue enters at 62¢');
  }
  checkEq(MODEL_MAX_ADVERSE_CENTS_DEFAULT, 0, 'soft dip off by default');
  checkEq(MODEL_HARD_ADVERSE_CENTS_DEFAULT, 8, 'hard max-loss cliff 8¢');
  checkEq(MODEL_BANK_GREEN_CENTS_DEFAULT, 11, 'bank / momentum arm at ≥11¢ green');
  checkEq(MODEL_MIN_TP_CENTS_DEFAULT, 11, 'min TP 11¢ — no micro banks');
  checkEq(MODEL_STAGNATION_SECONDS_DEFAULT, 60, 'stagnation check default 60s');
  checkEq(MODEL_RAPID_ADVERSE_CENTS_DEFAULT, 0, 'rapid adverse off by default');
  {
    check(
      modelStagnationExitReady({
        heldMs: 65_000,
        peakProgressCents: 0,
        modelDeteriorating: true,
        config: {},
      }).ready,
      '60s + 0 peak + decaying → stagnation cut'
    );
    check(
      !modelStagnationExitReady({
        heldMs: 65_000,
        peakProgressCents: 0,
        modelDeteriorating: false,
        config: {},
      }).ready,
      '60s + 0 peak but firm model → hold'
    );
    check(
      modelStagnationExitReady({
        heldMs: 65_000,
        peakProgressCents: 2,
        modelDeteriorating: true,
        config: {},
      }).ready,
      '60s + peaked +2¢ (under +3 trail) + decaying → stagnation cut'
    );
    check(
      !modelStagnationExitReady({
        heldMs: 65_000,
        peakProgressCents: 3,
        modelDeteriorating: true,
        config: {},
      }).ready,
      '60s + peaked +3¢ → not stagnant'
    );
    check(
      !modelStagnationExitReady({
        heldMs: 20_000,
        peakProgressCents: 0,
        modelDeteriorating: true,
        config: {},
      }).ready,
      '20s alone never cuts'
    );
    check(
      modelRapidAdverseExitReady({
        trueAdverseCents: 6,
        modelAgainst: true,
        inOpenGrace: false,
        config: {},
      }).ready,
      '−6¢ + against → rapid cut'
    );
    check(
      !modelRapidAdverseExitReady({
        trueAdverseCents: 6,
        modelAgainst: false,
        inOpenGrace: false,
        config: {},
      }).ready,
      '−6¢ but firm model → no rapid cut'
    );
    check(
      !modelRapidAdverseExitReady({
        trueAdverseCents: 6,
        modelAgainst: true,
        inOpenGrace: true,
        config: {},
      }).ready,
      'rapid cut waits for open grace'
    );
    checkEq(modelPeakProgressCents({ entryPriceCents: 70 }, 72), 2, 'peak progress +2¢');
  }
  checkEq(MODEL_TRAIL_ARM_CENTS_DEFAULT, 3, 'trail arm at ≥3¢ green');
  checkEq(
    modelTakeProfitMeetsFloor({ entryPriceCents: 85 }, 87, { modelMinTpCents: 7 }),
    false,
    '85→87 blocked as micro TP'
  );
  checkEq(
    modelTakeProfitMeetsFloor({ entryPriceCents: 85 }, 92, { modelMinTpCents: 7 }),
    true,
    '85→92 (+7) allowed'
  );
  checkEq(
    modelTakeProfitMeetsFloor({ entryPriceCents: 85 }, 96, { modelMinTpCents: 7 }),
    true,
    'rich 96¢ always allowed'
  );
  checkEq(MODEL_MOMENTUM_STALL_MS_DEFAULT, 4_000, 'stall flat ~4s');
  checkEq(MODEL_MOMENTUM_PULLBACK_CENTS_DEFAULT, 2, 'stall pullback 2¢');
  checkEq(MODEL_MIN_MINUTES_TO_OPEN_DEFAULT, 0, 'model late entry cutoff off');

  // Unconditional bank at slider green — don't wait for a stall while still climbing.
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 72,
        yes_ask: 74,
        no_bid: 26,
        no_ask: 28,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelBankGreenCents: 7,
        modelMinTpCents: 7,
        modelMomentumStallSeconds: 60,
        modelMomentumPullbackCents: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 65,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 72,
      peakHeldBidAt: now,
      modelEntryHeldProb: 70,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(72, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(65, 70),
          w15: win(60, 65),
        },
      },
    });
    checkEq(trade.status, 'closed', 'banks at +7¢ green without waiting for stall');
    checkEq(trade.exitReason, 'take_profit', 'unconditional bank is take_profit');
  }
  checkEq(MODEL_LIVE_LEAN_MARGIN_DEFAULT, 1, 'live lean margin 1pt (preemptive)');
  checkEq(MODEL_ENTRY_LIVE_LEAN_MARGIN_DEFAULT, 4, 'entry live lean margin 4pts');
  checkEq(MODEL_RED_GIVEUP_MS_DEFAULT, 8_000, 'red give-up 8s (preemptive)');
  checkEq(MODEL_SOFT_BANK_MS_DEFAULT, 0, 'soft+green bank immediately');
  checkEq(MODEL_DUMP_PULLBACK_CENTS_DEFAULT, 3, 'bid dump cut at 3¢ off peak');
  checkEq(MODEL_FAST_RED_CENTS_DEFAULT, 2, 'fast red stop at −2¢');
  checkEq(MODEL_PROB_DRIFT_PTS_DEFAULT, 3, 'model prob drift exit 3pts');
  check(modelLiveProbNotWithUs(win(50, 70), 'yes'), '50/50 live prob not with YES');
  check(modelSignalTurningAgainst({ ...win(55, 70), signalScore: { netDominance: -0.5, trend: 'weakening' } }, 'yes'), 'bearish netDominance turns YES hold');
  check(
    modelProbDriftAgainst(win(58, 70), 'yes', 62, 3),
    'held-side prob drift ≥3pts triggers'
  );

  check(
    !modelPriceAllowed(30, win(60, 70), {}).ok,
    '30¢ blocked without perfect conf/lean'
  );
  check(
    !modelPriceAllowed(55, { ...win(70, 85), confidence: 85 }, {}).ok,
    '55¢ blocked under default 65¢ min even with high conf'
  );
  check(
    modelPriceAllowed(30, { ...win(70, 85), confidence: 85 }, {
      modelMinEntryCents: 45,
      modelPerfectMinEntryCents: 25,
      modelPerfectConfidence: 80,
      modelPerfectLeanPts: 15,
    }).ok,
    '30¢ allowed when config still permits perfect exception'
  );
  check(!modelPriceAllowed(20, { ...win(70, 85), confidence: 85 }, {}).ok, '20¢ under perfect floor');

  // Low-ask near-certain gate is off by default; can be re-enabled via slider
  {
    const off = modelLowAskConvictionGate({
      priceCents: 65,
      window: { ...win(56, 60), confidence: 60 },
      signalSide: 'yes',
      config: {},
    });
    check(off.ok === true && off.skipped === true, '65¢ allowed when near-certain gate off');
    const weak = modelLowAskConvictionGate({
      priceCents: 65,
      window: { ...win(56, 60), confidence: 60 },
      signalSide: 'yes',
      config: { modelLowAskMinConfidence: 75 },
    });
    check(weak.ok === false, '65¢ blocked when gate on and conf/favor are soft');
    const strong = modelLowAskConvictionGate({
      priceCents: 65,
      window: { ...win(72, 75), confidence: 75 },
      signalSide: 'yes',
      config: { modelLowAskMinConfidence: 75 },
    });
    check(strong.ok === true, '65¢ allowed at conf 75 / favor≥4 / held≥72 when gate on');
    const softFavor = modelLowAskConvictionGate({
      priceCents: 65,
      window: { ...win(72, 80), confidence: 80 },
      signalSide: 'yes',
      config: { modelLowAskLiveFavorPts: 4, modelLowAskMinConfidence: 75 },
    });
    // win(72) → 72 vs 28 = +44 favor — still ok; need near-tie to fail favor
    check(softFavor.ok === true, '65¢ ok with wide live favor under 4pt rule');
    const noFavor = modelLowAskConvictionGate({
      priceCents: 65,
      window: { ...win(51, 80), confidence: 80 },
      signalSide: 'yes',
      config: { modelLowAskLiveFavorPts: 4, modelLowAskMinConfidence: 75, modelLowAskHeldProbMin: 50 },
    });
    check(noFavor.ok === false, '65¢ blocked when live favor <4pts');
    const rich = modelLowAskConvictionGate({
      priceCents: 75,
      window: { ...win(56, 60), confidence: 60 },
      signalSide: 'yes',
      config: {},
    });
    check(rich.ok === true && rich.skipped === true, '≥70¢ skips low-ask conviction gate');
  }

  // Entry: UP → YES with 12m left (w5) — only when model prices ≥ ask and strengthening
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-MODEL',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 62,
        yes_ask: 65,
        no_bid: 35,
        no_ask: 38,
      }),
      { strategyMode: 'model', modelMinConfidence: 55 }
    );
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(68, 70), tracking: { predictedDirection: 'UP' } },
          w10: { ...win(40, 70), tracking: { predictedDirection: 'DOWN' } },
          w15: win(50, 60),
        },
      },
    };
    const opp = await bot._evaluateSymbolForModel('ETH', preds);
    check(opp && opp.side === 'yes', 'model UP → YES entry when lean strong vs ask');
    checkEq(opp && opp.windowKey, 'w5', '12m left uses w5');
  }

  // Soft live favor → no entry (need a real lead)
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-SOFT',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 62,
        yes_ask: 65,
        no_bid: 35,
        no_ask: 38,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelEntryLiveLeanMarginPct: 3 }
    );
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(51, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(50, 60),
        },
      },
    };
    const soft = await bot._evaluateSymbolForModel('ETH', preds);
    checkEq(soft, null, 'blocks entry when live favor under margin');
    check(/live favor|live lean/i.test(bot.lastDecision || ''), 'decision cites live favor');
  }

  // Fade: lock UP still requires live UP lean, but buys NO
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-FADE',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 34,
        yes_ask: 38,
        no_bid: 62,
        no_ask: 65,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelInvertSide: 'on' }
    );
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(50, 60),
        },
      },
    };
    const opp = await bot._evaluateSymbolForModel('ETH', preds);
    check(opp && opp.side === 'no' && opp.invert === true, 'fade UP → NO entry');
    checkEq(opp && opp.priceCents, 65, 'fade buys NO ask');
    checkEq(opp && opp.signalSide, 'yes', 'fade signal side is YES (lean UP)');
    checkEq(opp && opp.signalPriceCents, 38, 'fade stamps YES ask for −7 TP');
  }

  checkEq(modelSignalDropCents(70, 63), 7, 'fade TP: UP 70→63 is −7 on lean side');
  checkEq(modelSignalDropCents(70, 71), 0, 'fade TP: lean side up is not a drop');

  // Fade must not TP when the held ticket is red (lean-side drop is not cash)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 30,
        yes_ask: 32,
        no_bid: 50,
        no_ask: 52,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelBankGreenCents: 7 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'no',
      entryPriceCents: 65,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      modelInverted: true,
      modelSignalSide: 'yes',
      modelSignalEntryCents: 38,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'fade signal drop does not TP a red NO ticket');
  }

  // Stale UP lock but live lean flipped DOWN → bid NO (follow live)
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-STALE',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 28,
        yes_ask: 30,
        no_bid: 68,
        no_ask: 70,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelMinEntryCents: 65 }
    );
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          // Lock still UP; live probs already DOWN hard (75% NO).
          w5: { ...win(25, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    };
    const opp = await bot._evaluateSymbolForModel('ETH', preds);
    check(opp && opp.side === 'no', 'live 75% DOWN overrides stale UP lock → NO');
    checkEq(opp && opp.priceCents, 70, 'bids NO ask when live leans NO');
  }

  // Never enter above 93¢
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-RICH',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 93,
        yes_ask: 95,
        no_bid: 5,
        no_ask: 7,
      }),
      { strategyMode: 'model', modelMinConfidence: 50 }
    );
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(96, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    const rich = await bot._evaluateSymbolForModel('ETH', preds);
    checkEq(rich, null, 'blocks model entry above 88¢');
    check(/max entry 88/i.test(bot.lastDecision || ''), 'decision cites model max entry');
  }

  // Never enter below 60¢ (default floor)
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-CHEAP',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 35,
        yes_ask: 38,
        no_bid: 62,
        no_ask: 65,
      }),
      { strategyMode: 'model', modelMinConfidence: 50 }
    );
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    const cheap = await bot._evaluateSymbolForModel('ETH', preds);
    checkEq(cheap, null, 'blocks model entry at 38¢ under 60¢ min');
    check(/below 60/i.test(bot.lastDecision || ''), 'decision cites 60¢ min');
  }

  // Wide spread: synthetic 100−yesAsk must not mask a real NO bid gap (62 ask / 49 bid).
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXBTC15M-GAP',
        status: 'open',
        floor_strike: 100000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 37,
        yes_ask: 38,
        // no_bid omitted — old code used 100−38=62 and looked tight
        no_ask: 62,
      }),
      { strategyMode: 'model', modelMinConfidence: 50, modelMaxEntrySpreadCents: 4 }
    );
    const preds = {
      BTC: {
        ready: true,
        price: 100010,
        windows: {
          w5: { ...win(38, 62), tracking: { predictedDirection: 'DOWN' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    const gap = await bot._evaluateSymbolForModel('BTC', preds);
    checkEq(gap, null, 'blocks model entry when side bid missing (no blind ask fill)');
    check(/no live bid|wide spread/i.test(bot.lastDecision || ''), 'decision cites bid/spread');
  }

  // Pre-entry dump: model fair << ask (would buy NO at 62¢ while only ~54% DOWN)
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXBTC15M-DUMP',
        status: 'open',
        floor_strike: 100000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 48,
        yes_ask: 52,
        no_bid: 80,
        no_ask: 85,
      }),
      { strategyMode: 'model', modelMinConfidence: 44 }
    );
    const preds = {
      BTC: {
        ready: true,
        price: 99990,
        windows: {
          w5: { ...win(46, 54), tracking: { predictedDirection: 'DOWN' } },
          w10: win(48, 50),
          w15: win(50, 50),
        },
      },
    };
    const dump = await bot._evaluateSymbolForModel('BTC', preds);
    checkEq(dump, null, 'blocks entry on extreme overpay (model << ask)');
    check(/overpay|skip entry|live lean|live favor/i.test(bot.lastDecision || ''), 'decision cites overpay or lean');
  }

  // Pre-entry: steady signalScore is allowed (only weakening blocks)
  {
    const risk = modelEntryDumpRisk({
      window: {
        ...win(70, 70),
        signalScore: { upScore: 1.2, downScore: 0.8, netDominance: 0.4, trend: 'steady' },
        tracking: { predictedDirection: 'UP' },
      },
      direction: 'UP',
      side: 'yes',
      priceCents: 65,
      minConf: 44,
    });
    check(risk.dump === false, 'steady signalScore allows entry when lean is good');
  }

  // Pre-entry: signalScore weakening no longer blocks entries (exit-only when slider on)
  {
    const risk = modelEntryDumpRisk({
      window: {
        ...win(40, 60),
        signalScore: { upScore: 0.8, downScore: 1.2, netDominance: -0.4, trend: 'weakening' },
        tracking: { predictedDirection: 'DOWN' },
      },
      direction: 'DOWN',
      side: 'no',
      priceCents: 61,
      minConf: 44,
      config: { modelSignalDominanceMin: 1 },
    });
    check(risk.dump === false, 'weakening signalScore does not block entry');
  }

  // +7¢+ green → TP immediately (no momentum ride / stall wait)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 64,
        no_bid: 36,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelBankGreenCents: 7,
        modelMomentumStallSeconds: 12,
        modelMomentumPullbackCents: 1,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 64,
      peakHeldBidAt: now - 1_000,
    });
    const stillUp = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, stillUp);
    checkEq(trade.status, 'open', '+9¢ at a fresh peak still follows (no stall yet)');
  }

  // +7¢+ green but 1¢ off peak → TP (momentum stalled)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 63,
        no_bid: 37,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelBankGreenCents: 7,
        modelMomentumStallSeconds: 12,
        modelMomentumPullbackCents: 1,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 35_000,
      peakHeldBidCents: 64,
      peakHeldBidAt: now - 2_000,
    });
    const stillUp = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, stillUp);
    checkEq(trade.exitReason, 'take_profit', '+8¢ (≥ bank green / minTp) → TP');
    checkEq(trade.exitPriceCents, 63, 'TP at live bid');
  }

  // Stall while green but below target → bank at spot
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 60,
        no_bid: 40,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelBankGreenCents: 7,
        modelMinTpCents: 7,
        modelMomentumStallSeconds: 8,
        modelMomentumPullbackCents: 2,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 20_000,
      peakHeldBidCents: 63,
      peakHeldBidAt: now - 10_000,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.exitReason, 'take_profit', '+3¢ stalled below +7 target → bank at bid');
    checkEq(trade.exitPriceCents, 60, 'stall bank at live bid');
  }

  // Peak +8 with +11 target → stall banks at bid (don't greed for +11)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 78,
        no_bid: 22,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelBankGreenCents: 11,
        modelMinTpCents: 11,
        modelNearTargetBankCents: 8,
        modelMomentumStallSeconds: 4,
        modelMomentumPullbackCents: 2,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 70,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 45_000,
      peakHeldBidCents: 78,
      peakHeldBidAt: now - 5_000,
    });
    trade.modelArmHadMomentum = true;
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.exitReason, 'take_profit', 'peak +8 near +11 target stalls → bank at bid');
    checkEq(trade.exitPriceCents, 78, 'stall bank at +8 live bid');
  }

  // 96¢ held bid banks immediately
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 70,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 20_000,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(70, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.exitReason, 'take_profit', '96¢ held bid TPs immediately');
    checkEq(trade.exitPriceCents, 96, 'rich TP at 96¢');
  }

  // 52¢ entry: +4¢ after peak — under minTp, must NOT micro-TP on stall
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 56,
        no_bid: 44,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelBankGreenCents: 7,
        modelMinTpCents: 7,
        modelMomentumStallSeconds: 30,
        modelMomentumPullbackCents: 2,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 52,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 8_000,
      peakHeldBidCents: 58,
      peakHeldBidAt: now - 2_000,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', '52→56 (+4¢) stall does not micro-TP under +7 minTp');
  }

  // Mid underwater with firm lean: deep red stops via fast-red / dump cut
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 48,
        no_bid: 52,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelMaxAdverseCents: 0,
        modelHardAdverseCents: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 74,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
      peakHeldBidCents: 74,
    });
    const stillUp = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, stillUp);
    checkEq(trade.status, 'open', 'deep red + firm lean holds (no price lean-stop)');
  }

  // Small red + firm lean (<8s) still holds — bounce window
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 53,
        no_bid: 47,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelMaxAdverseCents: 0,
        modelHardAdverseCents: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 55,
      modelEntryHeldProb: 62,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'small red (−2¢) + firm lean holds under fast-red');
  }

  // Hard cliff config no longer price-stops MODEL — firm lean holds
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 48,
        no_bid: 52,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 90,
        modelMaxAdverseCents: 0,
        modelHardAdverseCents: 25,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 74,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 20_000,
      peakHeldBidCents: 74,
    });
    const stillUp = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, stillUp);
    checkEq(trade.status, 'open', 'firm lean ignores legacy hard-cliff config');
  }

  // Soft lean (50/50) while flat → hold for stagnation (soft BE off)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 55,
        no_bid: 45,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelMinConfidence: 55, modelStagnationSeconds: 60, modelRapidAdverseCents: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 55,
    });
    const soft = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(50, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, soft);
    checkEq(trade.status, 'open', '50/50 soft lean flat holds (soft BE off — stagnation owns it)');
  }

  // 50/50 + spread-flat → hold (soft BE off); stagnation still uses mush lean as decaying
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 53,
        no_bid: 47,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 60,
        modelMinConfidence: 55,
        modelOpenGraceSeconds: 8,
        modelLeanAgainstBeSeconds: 5,
        modelStagnationSeconds: 60,
        modelRapidAdverseCents: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      modelEntryBidCents: 53,
      modelEntrySpreadCents: 2,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 15_000,
      peakHeldBidCents: 55,
    });
    check(modelNearFlatCents(trade, 53), 'bid within entry spread counts as near-flat');
    check(modelBreakevenExitAllowed(trade, 53), 'model BE allowed within spread');
    const soft = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(50, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, soft);
    checkEq(trade.status, 'open', '50/50 spread-flat holds (soft BE off)');
  }

  // After model BE: same-cycle reopen allowed (scalp recycle). Sit-out is the ~30s cooldown.
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const client = mockClient({
      ticker: 'KXETH15M-REOPEN',
      status: 'open',
      floor_strike: 3000,
      close_time: new Date(closeMs).toISOString(),
      yes_bid: 62,
      yes_ask: 65,
      no_bid: 35,
      no_ask: 38,
    });
    const bot = makeBot(client, {
      strategyMode: 'model',
      modelMinConfidence: 50,
      modelPostExitCooldownMinutes: 0,
    });
    bot._stoppedSymbolsThisCycle = new Set();
    const opened = await bot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-REOPEN',
      side: 'yes',
      priceCents: 65,
      floorStrike: 3000,
      closeTime: closeMs,
      engineProbability: 62,
      engineConfidence: 70,
      strategy: 'model',
      modelWindowKey: 'w5',
      modelDirection: 'UP',
    });
    check(opened, 'first model open ok');
    const trade = bot.openTrades[0];
    check(trade, 'model trade on book');
    await bot._closePosition(trade, 65, 'breakeven', { skipLiveSell: true });
    checkEq(
      !!(bot._stoppedSymbolsThisCycle && bot._stoppedSymbolsThisCycle.has('ETH')),
      false,
      'BE does not lock ETH for the whole cycle'
    );
    const again = await bot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-REOPEN',
      side: 'yes',
      priceCents: 65,
      floorStrike: 3000,
      closeTime: closeMs,
      engineProbability: 62,
      engineConfidence: 70,
      strategy: 'model',
      modelWindowKey: 'w5',
      modelDirection: 'UP',
    });
    check(again, 'model can re-enter same cycle after BE (cooldown/confirm gate handle chop)');
  }

  // Confidence floor blocks weak calls
  {
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXETH15M-CONF',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 52,
        yes_ask: 55,
        no_bid: 45,
        no_ask: 48,
      }),
      { strategyMode: 'model', modelMinConfidence: 80 }
    );
    const preds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    const blocked = await bot._evaluateSymbolForModel('ETH', preds);
    checkEq(blocked, null, 'confidence floor blocks entry');
    check(/confidence/i.test(bot.lastDecision || ''), 'decision cites confidence');
  }

  // Min entry lean blocks soft tickets (e.g. 72% NO when floor is 78%)
  {
    check(
      !modelMinEntryLeanGate({
        window: win(28, 70),
        side: 'no',
        config: { modelMinEntryLeanPct: 78 },
      }).ok,
      '72% held lean blocked at 78% floor'
    );
    check(
      modelMinEntryLeanGate({
        window: win(18, 70),
        side: 'no',
        config: { modelMinEntryLeanPct: 78 },
      }).ok,
      '82% held lean passes 78% floor'
    );
    check(
      modelMinEntryLeanGate({
        window: win(28, 70),
        side: 'no',
        config: { modelMinEntryLeanPct: 0 },
      }).skipped,
      '0 = lean floor off'
    );
    const closeMs = Date.now() + 12 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        ticker: 'KXBTC15M-LEAN',
        status: 'open',
        floor_strike: 90000,
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 28,
        yes_ask: 30,
        no_bid: 70,
        no_ask: 72,
      }),
      { strategyMode: 'model', modelMinConfidence: 41, modelMinEntryLeanPct: 78 }
    );
    const preds = {
      BTC: {
        ready: true,
        price: 90100,
        windows: {
          w5: { ...win(28, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(28, 70),
          w15: win(28, 70),
        },
      },
    };
    const blocked = await bot._evaluateSymbolForModel('BTC', preds);
    checkEq(blocked, null, 'min entry lean blocks soft NO');
    check(/held-side lean/i.test(bot.lastDecision || ''), 'decision cites lean floor');
  }

  // Underwater + locked lean against → stop ASAP (TP not happening)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 50,
        no_bid: 50,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelMaxAdverseCents: 8, modelStagnationSeconds: 0, modelRapidAdverseCents: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
    });
    checkEq(bot._stopLevelCents(trade), null, 'model has no hard ¢ stop');
    checkEq(bot._takeProfitLevelCents(trade), null, 'model has no fixed take-profit');
    const against = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(35, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, against);
    checkEq(trade.exitReason, 'model_against', 'underwater + lean against → cut at bid');
    checkEq(trade.exitPriceCents, 50, 'paper against-cut books live bid');
  }

  // Underwater + live lean against (lock still with us) → stop ASAP
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 50,
        no_bid: 50,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelMinHoldSeconds: 0, modelMaxAdverseCents: 8, modelStagnationSeconds: 0, modelRapidAdverseCents: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
    });
    check(modelLiveLeanAgainstHeld(win(35, 70), 'yes'), 'live DOWN lean against YES with margin');
    check(
      !modelLiveLeanAgainstHeld(win(50, 70), 'yes'),
      '50/50 live lean does not flip YES (needs ≥2pts against)'
    );
    checkEq(MODEL_LIVE_LEAN_MARGIN_DEFAULT, 1, 'live lean margin default 1pt (preemptive)');
    checkEq(MODEL_MIN_TP_CENTS_DEFAULT, 11, 'model min TP 11¢');
    const liveFlip = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(35, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, liveFlip);
    checkEq(trade.exitReason, 'model_against', 'red + live lean against → cut at bid');
  }

  // Green + engine against but under minTp → hold (no micro TP)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 57,
        no_bid: 43,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelMinTpCents: 7 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 10_000,
      peakHeldBidCents: 57,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(35, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'engine against + only +2¢ green does not micro-TP');
  }

  // Fade hold is supposed to sit against the lock — no lean-stop
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 40,
        no_bid: 50,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'no',
      entryPriceCents: 65,
      windowCloseTime: now + 12 * 60 * 1000,
      modelInverted: true,
      modelSignalSide: 'yes',
      modelSignalEntryCents: 38,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'fade does not lean-stop while lock is still UP');
  }

  // Underwater + weak confidence → hold (conf wick alone is not hard against)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 52,
        no_bid: 48,
      }),
      { strategyMode: 'model', modelMinConfidence: 70, modelMinHoldSeconds: 0, modelMaxAdverseCents: 8, modelStagnationSeconds: 0, modelRapidAdverseCents: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 55,
      modelEntryHeldProb: 58,
      modelEntryBidCents: 55,
      modelEntrySpreadCents: 0,
    });
    const weakRed = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(58, 40), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, weakRed);
    checkEq(trade.status, 'open', 'weak confidence while shallow red → hold (not MODEL_AGAINST)');
  }

  // Red + firm model still with us (high conf) → brief bounce window
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 52,
        no_bid: 48,
      }),
      { strategyMode: 'model', modelMinConfidence: 70, modelMinHoldSeconds: 0, modelMaxAdverseCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 55,
      modelEntryHeldProb: 58,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(58, 72), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'red + firm model holds under fast-red (−3¢)');
  }

  // signalScore weakening + still green → preemptive TP
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 86,
        no_bid: 14,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 84,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 86,
      modelEntryHeldProb: 74,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: {
            ...win(62, 74),
            tracking: { predictedDirection: 'UP' },
            signalScore: { upScore: 1.2, downScore: 0.8, netDominance: 0.4, trend: 'weakening' },
          },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'signalScore weakening + only +2¢ does not micro-TP');
  }

  // Held-side prob drift from entry → exit before deep red
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 86,
        no_bid: 14,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 84,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 4_000,
      peakHeldBidCents: 86,
      modelEntryHeldProb: 74,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: {
            ...win(70, 72),
            tracking: { predictedDirection: 'UP' },
            signalScore: { upScore: 1.5, downScore: 0.5, netDominance: 1, trend: 'steady' },
          },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'held-side prob drift + only +2¢ does not micro-TP');
  }

  // Green +7¢ + lean against → bank now (don't sit for more)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 62,
        no_bid: 38,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelMinHoldSeconds: 0, modelMinTpCents: 7 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
    });
    const against = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(35, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, against);
    checkEq(trade.exitReason, 'take_profit', 'green +7¢ + lean against banks immediately');
  }

  // Soft red, not on pace to 55 → hold (don't lean-stop)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 66,
        no_bid: 34,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelMaxLossCents: 20 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 70,
      modelEntryBidCents: 68,
      modelEntrySpreadCents: 2,
      peakHeldBidCents: 68,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 30_000,
      modelEntryHeldProb: 70,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(50, 60), tracking: { predictedDirection: 'UP' } },
          w10: win(50, 60),
          w15: win(50, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'soft red not on pace to 55 → hold');
  }

  // 84→79 noise must NOT lean-stop (pace would falsely project under 55)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 79,
        no_bid: 21,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 84,
      modelEntryBidCents: 82,
      modelEntrySpreadCents: 2,
      peakHeldBidCents: 82,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 11_000,
      modelEntryHeldProb: 70,
      engineConfidence: 70,
    });
    checkEq(
      modelShouldLeanStopRed(trade, 79, 11_000, {}),
      false,
      '84→79 in 11s is not lean-stop threat'
    );
    await bot._manageOpenTrade(trade, {
      BTC: {
        ready: true,
        price: 60000,
        windows: {
          w5: { ...win(50, 60), tracking: { predictedDirection: 'UP' } },
          w10: win(50, 60),
          w15: win(50, 60),
        },
      },
    });
    checkEq(trade.status, 'open', '84→79 stays open toward hard floor 55');
  }

  // 78→67 must NOT lean-stop — still far above hard floor 55
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 67,
        no_bid: 33,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 78,
      modelEntryBidCents: 76,
      modelEntrySpreadCents: 2,
      peakHeldBidCents: 76,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 30_000,
      modelEntryHeldProb: 78,
      engineConfidence: 78,
    });
    checkEq(modelShouldLeanStopRed(trade, 67, 30_000, {}), false, '78→67 is not near floor');
    await bot._manageOpenTrade(trade, {
      BTC: {
        ready: true,
        price: 60000,
        windows: {
          w5: { ...win(48, 55), tracking: { predictedDirection: 'UP' } },
          w10: win(48, 55),
          w15: win(48, 55),
        },
      },
    });
    checkEq(trade.status, 'open', '78→67 stays open toward hard floor 55');
  }

  // Fast dump near floor + firm lean → hold (no pace lean-stop)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 58,
        no_bid: 42,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelMaxLossCents: 20 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 70,
      modelEntryBidCents: 68,
      modelEntrySpreadCents: 2,
      peakHeldBidCents: 68,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 12_000,
      modelEntryHeldProb: 70,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'fast dump near floor + firm lean → hold');
  }

  // Bid ≤55 + firm lean → hold (lean-stop / hard-floor cut removed; stagnation owns it)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 48,
        no_bid: 52,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 62,
      modelEntryBidCents: 60,
      modelEntrySpreadCents: 2,
      peakHeldBidCents: 60,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 20_000,
      modelEntryHeldProb: 62,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'bid ≤55 + firm lean holds — no lean-stop');
  }

  // BE chase: flat 8s without +3 → scratch
  {
    const now = Date.now();
    const trade = { entryPriceCents: 72, modelEntryBidCents: 70, modelEntrySpreadCents: 2 };
    const r1 = modelBeChaseExitReady(trade, {
      nearFlat: true,
      flatOrGreen: true,
      peakProgressCents: 1,
      now,
      config: { modelBeChaseSeconds: 8 },
    });
    check(r1.started, 'BE chase starts on cross');
    const r2 = modelBeChaseExitReady(trade, {
      nearFlat: true,
      flatOrGreen: true,
      peakProgressCents: 2,
      now: now + 8100,
      config: { modelBeChaseSeconds: 8 },
    });
    check(r2.ready, 'BE chase times out without +3');
    const rising = modelUpwardMomentumEvidence(
      trade,
      {
        greenCents: 2,
        heldSideBidCents: 74,
        peakHeldBidCents: 74,
        peakHeldBidAt: now + 8100,
        now: now + 8100,
        config: { modelMomentumStallSeconds: 4, modelMomentumPullbackCents: 2 },
      }
    );
    check(rising, 'upward momentum at fresh peak');
    check(
      modelUpwardMomentumEvidence(trade, {
        greenCents: 4,
        heldSideBidCents: 76,
        peakHeldBidCents: 76,
        peakHeldBidAt: Date.now(),
        now: Date.now(),
        config: { modelMomentumStallSeconds: 4, modelMomentumPullbackCents: 2 },
      }),
      'upward momentum above +3 arm at peak'
    );
    const r3 = modelBeChaseExitReady(trade, {
      nearFlat: true,
      flatOrGreen: true,
      peakProgressCents: 2,
      now: now + 8100,
      config: { modelBeChaseSeconds: 8 },
      upwardEvidence: rising,
    });
    check(!r3.ready && r3.holdingRise, 'BE chase holds while still rising');
    delete trade.modelBeChaseStartedAt;
    modelBeChaseExitReady(trade, {
      nearFlat: false,
      flatOrGreen: false,
      peakProgressCents: 0,
      now: now + 9000,
      config: { modelBeChaseSeconds: 8 },
    });
    check(!trade.modelBeChaseStartedAt, 'BE chase resets when bid dips red');
    const stillRed = { entryPriceCents: 72 };
    const nearOnly = modelBeChaseExitReady(stillRed, {
      nearFlat: true,
      flatOrGreen: false,
      peakProgressCents: 0,
      now,
      config: { modelBeChaseSeconds: 8 },
    });
    check(nearOnly.reset && !stillRed.modelBeChaseStartedAt, 'spread-padded near-flat does not start BE chase');
  }

  check(
    modelOnPaceBelowBarrier({ fromBid: 68, currentBid: 58, elapsedMs: 5_000, barrierCents: 55, horizonMs: 90_000 }),
    'pace helper: steep drop projects under 55'
  );
  check(
    !modelOnPaceBelowBarrier({ fromBid: 68, currentBid: 66, elapsedMs: 30_000, barrierCents: 55, horizonMs: 90_000 }),
    'pace helper: slow drip does not project under 55'
  );
  checkEq(MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT, 55, 'lean-stop barrier default 55¢');
  {
    const trade = { entryPriceCents: 84 };
    checkEq(modelLeanStopMinAdverseCents(trade, {}), 10, '84¢ needs 35% of room (~10¢) before pace');
    checkEq(
      modelLeanStopMinAdverseCents(trade, { modelLeanStopPaceDrawdownPct: 55 }),
      16,
      '55% drawdown slider raises min adverse'
    );
    check(
      !modelEntryRoomToFloorGate(57, {}).ok,
      '57¢ entry blocked — only 2¢ room to 55 floor (need 10)'
    );
    check(modelEntryRoomToFloorGate(66, {}).ok, '66¢ entry ok — 11¢ room to floor');
    check(
      !modelPriceAllowed(57, { confidence: 90, probabilityUp: 20, probabilityDown: 80 }, {}).ok,
      'modelPriceAllowed rejects near-floor 57¢'
    );
  }

  // Red + lean with us for >8s → hold (no price lean-stop)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 48,
        no_bid: 52,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 52,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 9_000,
      modelEntryHeldProb: 62,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'still red after 8s + firm lean → hold');
  }

  // Bid dump off peak while lean still UP → hold (no price dump cut)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 63,
        no_bid: 37,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 68,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 6_000,
      peakHeldBidCents: 68,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 74), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'peak slide + firm lean → hold');
  }

  // Fast red while lean still with us → hold
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 30,
        no_bid: 70,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'no',
      entryPriceCents: 74,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 3_000,
      peakHeldBidCents: 74,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(38, 72), tracking: { predictedDirection: 'DOWN' } },
          w10: win(45, 60),
          w15: win(45, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'fast red + firm lean → hold');
  }

  // Soft lean + still green under minTp → hold (don't scratch 84→86 as TP)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 86,
        no_bid: 14,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelMinTpCents: 7 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 84,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 86,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          // Soft: 50/50 — not clearly with us (≥2pts)
          w5: { ...win(50, 60), tracking: { predictedDirection: 'UP' } },
          w10: win(50, 60),
          w15: win(50, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'soft lean + only +2¢ green does not micro-TP');
  }

  // Green +7¢ + lean against → TP (real bank)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 62,
        no_bid: 38,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelMinHoldSeconds: 0, modelMinTpCents: 7 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
      peakHeldBidCents: 62,
    });
    const against = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(35, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, against);
    checkEq(trade.exitReason, 'take_profit', 'green +7¢ + lean against → model TP');
    checkEq(trade.exitPriceCents, 62, 'model TP banks the bid');
  }

  // +1¢ green with lean still firm → hold (noise, not a predicted fall)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 56,
        no_bid: 44,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
      peakHeldBidCents: 56,
      modelEntryHeldProb: 62,
    });
    const stillFirm = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, stillFirm);
    checkEq(trade.status, 'open', '+1¢ green holds while lean still firm');
  }

  // BE chase timed out but lean still firm → hold (no easy BE)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 56,
        no_bid: 44,
      }),
      {
        strategyMode: 'model',
        modelMinConfidence: 55,
        modelMinHoldSeconds: 0,
        modelBeChaseSeconds: 8,
        modelLeanAgainstBeSeconds: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
      peakHeldBidCents: 56,
      modelEntryHeldProb: 62,
      modelBeChaseStartedAt: now - 20_000,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'BE chase timeout + firm lean does not scratch');
  }

  // BE chase timed out + lean decaying → scratch
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 55,
        no_bid: 45,
      }),
      {
        strategyMode: 'model',
        modelMinConfidence: 55,
        modelMinHoldSeconds: 0,
        modelBeChaseSeconds: 8,
        modelLeanAgainstBeSeconds: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
      peakHeldBidCents: 56,
      modelEntryHeldProb: 62,
      modelBeChaseStartedAt: now - 20_000,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(50, 40), tracking: { predictedDirection: 'UP' } },
          w10: win(50, 40),
          w15: win(50, 40),
        },
      },
    });
    checkEq(trade.exitReason, 'breakeven', 'BE chase timeout + decaying lean scratches');
  }

  // Exactly flat + lean against → breakeven scratch
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 55,
        no_bid: 45,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
    });
    const against = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(35, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, against);
    checkEq(trade.exitReason, 'breakeven', 'flat + lean against → breakeven');
    checkEq(trade.exitPriceCents, 55, 'paper BE books entry');
  }

  // Red + model against → cut (don't hold for pace)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 52,
        no_bid: 48,
      }),
      { strategyMode: 'model', modelMinConfidence: 55, modelMinHoldSeconds: 0, modelOpenGraceSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 15_000,
      modelEntryHeldProb: 62,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(35, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    });
    check(trade.exitReason === 'model_against', 'red + lean against → cut at bid (not firm hold)');
  }

  // Soft 49/50 lean + red → hold (soft MODEL_AGAINST off; stagnation owns mush)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 52,
        no_bid: 48,
      }),
      {
        strategyMode: 'model',
        modelMinConfidence: 55,
        modelMinHoldSeconds: 30,
        modelOpenGraceSeconds: 0,
        modelLeanAgainstBeSeconds: 0,
        modelMaxLossCents: 8,
        modelStagnationSeconds: 60,
        modelRapidAdverseCents: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 15_000,
      modelEntryHeldProb: 55,
      modelEntryBidCents: 55,
      modelEntrySpreadCents: 0,
    });
    const softLean = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: {
            ...win(50, 70),
            probabilityUp: 49,
            probabilityDown: 50,
            tracking: { predictedDirection: 'UP' },
          },
          w10: { ...win(50, 70), probabilityUp: 49, probabilityDown: 50 },
          w15: { ...win(50, 70), probabilityUp: 49, probabilityDown: 50 },
        },
      },
    };
    await bot._manageOpenTrade(trade, softLean);
    checkEq(trade.status, 'open', 'soft/50-50 + −3¢ holds (soft against off)');
  }

  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 47,
        no_bid: 53,
      }),
      {
        strategyMode: 'model',
        modelMinConfidence: 55,
        modelMinHoldSeconds: 30,
        modelOpenGraceSeconds: 0,
        modelLeanAgainstBeSeconds: 0,
        modelMaxLossCents: 8,
        modelStagnationSeconds: 60,
        modelRapidAdverseCents: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 15_000,
      modelEntryHeldProb: 55,
      modelEntryBidCents: 55,
      modelEntrySpreadCents: 0,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: {
            ...win(50, 70),
            probabilityUp: 49,
            probabilityDown: 50,
            tracking: { predictedDirection: 'UP' },
          },
          w10: { ...win(50, 70), probabilityUp: 49, probabilityDown: 50 },
          w15: { ...win(50, 70), probabilityUp: 49, probabilityDown: 50 },
        },
      },
    });
    checkEq(trade.status, 'open', 'soft/50-50 + −8¢ holds (soft against off — not max-loss soft cut)');
  }

  // Regression: 74→69 soft lean must not MODEL_AGAINST (user ETH YES case)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 69,
        no_bid: 31,
      }),
      {
        strategyMode: 'model',
        modelMinConfidence: 55,
        modelMinHoldSeconds: 0,
        modelOpenGraceSeconds: 0,
        modelLeanAgainstBeSeconds: 0,
        modelMaxLossCents: 8,
        modelStagnationSeconds: 0,
        modelRapidAdverseCents: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 74,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 20_000,
      modelEntryHeldProb: 65,
      modelEntryBidCents: 72,
      modelEntrySpreadCents: 2,
      peakHeldBidCents: 74,
      engineConfidence: 65,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: {
            ...win(50, 55),
            probabilityUp: 50,
            probabilityDown: 50,
            tracking: { predictedDirection: 'UP' },
          },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', '74→69 soft lean holds (not MODEL_AGAINST)');
  }

  // Rapid adverse −6¢ + model against → cut (cliff protection)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 62,
        no_bid: 38,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelOpenGraceSeconds: 0,
        modelLeanAgainstBeSeconds: 0,
        modelRapidAdverseCents: 6,
        modelStagnationSeconds: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 70,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 10_000,
      modelEntryBidCents: 70,
      modelEntrySpreadCents: 0,
      modelEntryHeldProb: 70,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(40, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(42, 70),
          w15: win(45, 60),
        },
      },
    });
    checkEq(trade.exitReason, 'model_rapid_adverse', '−6¢ true adverse + against → rapid cut');
  }

  // Stagnation 40s + no peak progress + soft lean → cut
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 69,
        no_bid: 31,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelOpenGraceSeconds: 0,
        modelLeanAgainstBeSeconds: 0,
        modelStagnationSeconds: 40,
        modelStagnationMinProgressCents: 3,
        modelRapidAdverseCents: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 70,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 45_000,
      peakHeldBidCents: 70,
      peakHeldBidAt: now - 40_000,
      modelEntryHeldProb: 70,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: {
            ...win(50, 70),
            probabilityUp: 49,
            probabilityDown: 50,
            tracking: { predictedDirection: 'UP' },
          },
          w10: { ...win(50, 70), probabilityUp: 49, probabilityDown: 50 },
          w15: { ...win(50, 70), probabilityUp: 49, probabilityDown: 50 },
        },
      },
    });
    checkEq(trade.exitReason, 'model_stagnation', '45s no progress + soft lean → stagnation cut');
  }

  // Lean decay 99→85 while still favoring → zone only (no cut); mushy lean → cut
  {
    const now = Date.now();
    const trade = {
      strategy: 'model',
      side: 'yes',
      modelEntryHeldProb: 99,
      peakModelHeldProb: 99,
    };
    const stillStrong = { probabilityUp: 85, probabilityDown: 15, confidence: 80 };
    const stateStrong = modelLeanDecayCutState(trade, stillStrong, 'yes', now, {});
    check(stateStrong.inDecayZone, '99→85 in decay zone');
    check(!stateStrong.cutReady, '99→85 still favoring → do not cut yet');
    const mush = { probabilityUp: 50, probabilityDown: 50, confidence: 80 };
    const trade2 = {
      strategy: 'model',
      side: 'yes',
      modelEntryHeldProb: 99,
      peakModelHeldProb: 99,
    };
    const stateMush = modelLeanDecayCutState(trade2, mush, 'yes', now, {});
    check(stateMush.inDecayZone, '99→50 in decay zone');
    check(stateMush.cutReady, '99→50 soft lean → cut ready');
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 72,
        no_bid: 28,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 60,
        modelOpenGraceSeconds: 0,
        modelStagnationSeconds: 0,
        modelRapidAdverseCents: 0,
      }
    );
    const open = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 78,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 30_000,
      modelEntryHeldProb: 99,
      peakModelHeldProb: 99,
    });
    await bot._manageOpenTrade(open, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(50, 80), probabilityUp: 50, probabilityDown: 50 },
          w10: { ...win(50, 80), probabilityUp: 50, probabilityDown: 50 },
          w15: { ...win(50, 80), probabilityUp: 50, probabilityDown: 50 },
        },
      },
    });
    checkEq(open.exitReason, 'model_against', 'lean decay 99→50 soft + red → cut');
  }

  checkEq(modelPostExitCooldownMs({ modelPostExitCooldownSeconds: 45 }), 45_000, 'post-exit cooldown reads seconds first');
  checkEq(modelPostExitCooldownMs({}), 45_000, 'post-exit default 45s');

  // Post-exit cooldown blocks reopen briefly (~60s scalp recycle)
  {
    const now = Date.now();
    check(
      !checkModelPostExitCooldown({
        trades: [
          {
            strategy: 'model',
            symbol: 'ETH',
            status: 'closed',
            exitReason: 'model_lean_flip',
            closedAt: now - 5_000,
          },
        ],
        symbol: 'ETH',
        cooldownMs: 60_000,
        now,
      }).ok,
      'post-exit cooldown active (~60s)'
    );
    check(
      checkModelPostExitCooldown({
        trades: [
          {
            strategy: 'model',
            symbol: 'ETH',
            status: 'closed',
            exitReason: 'take_profit',
            closedAt: now - 65_000,
          },
        ],
        symbol: 'ETH',
        cooldownMs: 60_000,
        now,
      }).ok,
      'post-exit cooldown clears after ~60s'
    );
    check(
      !checkModelPostExitCooldown({
        trades: [
          {
            strategy: 'model',
            symbol: 'XRP',
            status: 'closed',
            exitReason: 'model_lean_stop',
            closedAt: now - 40_000,
          },
        ],
        symbol: 'XRP',
        cooldownMs: 30_000,
        leanStopCooldownMs: 120_000,
        now,
      }).ok,
      'lean-stop sit-out still active at 40s (2m knife-catch block)'
    );
    check(
      checkModelPostExitCooldown({
        trades: [
          {
            strategy: 'model',
            symbol: 'XRP',
            status: 'closed',
            exitReason: 'model_lean_stop',
            closedAt: now - 125_000,
          },
        ],
        symbol: 'XRP',
        cooldownMs: 30_000,
        leanStopCooldownMs: 120_000,
        now,
      }).ok,
      'lean-stop sit-out clears after 2m'
    );
    check(
      !checkModelPostExitCooldown({
        trades: [
          {
            strategy: 'model',
            symbol: 'ETH',
            status: 'closed',
            exitReason: 'model_against',
            closedAt: now - 30_000,
          },
        ],
        symbol: 'ETH',
        cooldownMs: 45_000,
        leanStopCooldownMs: 120_000,
        now,
      }).ok,
      'model_against uses sit-out slider (45s), not 120s lean-stop'
    );
    check(
      checkModelPostExitCooldown({
        trades: [
          {
            strategy: 'model',
            symbol: 'ETH',
            status: 'closed',
            exitReason: 'model_against',
            closedAt: now - 50_000,
          },
        ],
        symbol: 'ETH',
        cooldownMs: 45_000,
        leanStopCooldownMs: 120_000,
        now,
      }).ok,
      'model_against sit-out clears after 45s'
    );
    check(
      !checkModelGlobalPostExitCooldown({
        trades: [
          {
            strategy: 'model',
            symbol: 'ETH',
            status: 'closed',
            exitReason: 'take_profit',
            closedAt: now - 5_000,
          },
        ],
        cooldownMs: 20_000,
        now,
      }).ok,
      'global sit-out blocks any coin for ~20s after a close'
    );
    check(
      checkModelGlobalPostExitCooldown({
        trades: [
          {
            strategy: 'model',
            symbol: 'ETH',
            status: 'closed',
            exitReason: 'take_profit',
            closedAt: now - 25_000,
          },
        ],
        cooldownMs: 20_000,
        now,
      }).ok,
      'global sit-out clears after 20s'
    );
  }

  // Ask→bid haircut alone must not instant lean-stop (paper entry=ask, mark=bid)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 64,
        no_bid: 36,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelOpenGraceMs: 8_000 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 66,
      modelEntryBidCents: 64,
      modelEntrySpreadCents: 2,
      peakHeldBidCents: 64,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 500,
      modelEntryHeldProb: 70,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(70, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'ask→bid haircut in open grace does not scratch');
  }

  // Ask→bid haircut after open grace + soft lean must HOLD (not fake BE at bid < entry)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 82,
        no_bid: 18,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0, modelOpenGraceMs: 8_000 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 89,
      modelEntryBidCents: 82,
      modelEntrySpreadCents: 7,
      peakHeldBidCents: 82,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 35_000,
      modelEntryHeldProb: 70,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: { ...win(50, 55), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', '89→82 haircut + soft lean holds (no fake BE)');
    checkEq(trade.exitReason, undefined, 'no exit reason on haircut hold');
  }

  // Gap dump while model against → BE/cut (no max-loss lean-stop)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 40,
        no_bid: 60,
      }),
      { strategyMode: 'model', mode: 'paper', modelMinHoldSeconds: 0, modelMaxLossCents: 8, modelStagnationSeconds: 0, modelRapidAdverseCents: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'no',
      entryPriceCents: 83,
      modelEntryBidCents: 81,
      modelEntrySpreadCents: 2,
      peakHeldBidCents: 81,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 15_000,
      modelEntryHeldProb: 84,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(45, 60),
          w15: win(45, 60),
        },
      },
    });
    checkEq(trade.exitReason, 'model_against', 'gap dump + model against → cut at bid');
    checkEq(trade.exitPriceCents, 60, 'paper against-cut books live bid');
    checkEq(MODEL_MAX_LOSS_CENTS_DEFAULT, 0, 'default max loss off');
    checkEq(modelAdverseExitFillCents({ entryPriceCents: 83 }, 60, {}, 'paper'), 60, 'adverse fill uncapped when max loss off');
  }

  // Hard floor 55 for all (incl. 78+/80/85); rich 68 no longer early-stops
  {
    checkEq(MODEL_HARD_STOP_FLOOR_CENTS_DEFAULT, 55, 'hard stop floor 55¢');
    checkEq(MODEL_RICH_STOP_FLOOR_CENTS_DEFAULT, 0, 'rich stop floor off by default');
    checkEq(MODEL_LEAN_STOP_BARRIER_CENTS_DEFAULT, 55, 'lean barrier tracks hard floor');
    checkEq(
      modelEffectiveMaxLossCents({ entryPriceCents: 60, engineConfidence: 80 }, {}),
      8,
      '60¢ entry: room to 55 is 5¢ → still base −8¢'
    );
    checkEq(
      modelEffectiveMaxLossCents({ entryPriceCents: 70, engineConfidence: 60 }, {}),
      8,
      '70¢ entry: max-loss slider caps at −8¢ (not ride to 55)'
    );
    checkEq(
      modelEffectiveMaxLossCents({ entryPriceCents: 75, engineConfidence: 80 }, {}),
      8,
      '75¢ entry: max-loss slider caps at −8¢'
    );
    checkEq(
      modelEffectiveMaxLossCents({ entryPriceCents: 78, engineConfidence: 80 }, {}),
      8,
      '78¢ entry: max-loss slider caps at −8¢'
    );
    checkEq(
      modelEffectiveMaxLossCents({ entryPriceCents: 80, engineConfidence: 75 }, {}),
      8,
      '80¢ entry: max-loss slider caps at −8¢'
    );
    checkEq(
      modelEffectiveMaxLossCents({ entryPriceCents: 85, engineConfidence: 72 }, {}),
      8,
      '85¢ entry: max-loss slider caps at −8¢'
    );
    checkEq(
      modelEffectiveMaxLossCents(
        { entryPriceCents: 85, engineConfidence: 72 },
        { modelRichStopFloorCents: 68, modelRichStopEntryMinCents: 80 }
      ),
      8,
      'saved rich floor 68 is ignored when above hard 55'
    );
    checkEq(
      modelAdverseExitFillCents({ entryPriceCents: 75, engineConfidence: 78 }, 50, {}, 'paper'),
      67,
      'paper 75¢ gap books max-loss cap 67 (not floor 55)'
    );
    checkEq(
      modelAdverseExitFillCents({ entryPriceCents: 82, engineConfidence: 78 }, 50, {}, 'paper'),
      74,
      'paper 82¢ gap books max-loss cap 74'
    );
    checkEq(modelSideSwitchConfirmMs(12), 15_000, 'early window: 15s side-switch confirm');
    checkEq(modelSideSwitchConfirmMs(7), 8_000, 'mid window: 8s confirm');
    checkEq(modelSideSwitchConfirmMs(3), 5_000, 'late window: 5s confirm');
    checkEq(modelSideSwitchConfirmMs(1), 3_000, 'final minutes: 3s confirm');
    checkEq(modelSideSwitchConfirmTicks(12), 3, 'early: 3 confirm ticks');
    checkEq(modelSideSwitchConfirmTicks(3), 2, 'late: 2 confirm ticks');
  }


  // Pre-settle: last minute always cash out (never ride to SETTLED)
  {
    const now = Date.now();
    const closeMs = now + 45 * 1000;
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 52,
        no_bid: 48,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelPreCloseForceMinutes: 1,
        modelSettleCloseMinutes: 3,
        modelLateBarrierMinutes: 2,
        modelOpenGraceSeconds: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      modelEntryBidCents: 53,
      modelEntrySpreadCents: 2,
      windowCloseTime: closeMs,
      openedAt: now - 6 * 60 * 1000,
      modelEntryHeldProb: 62,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 80), tracking: { predictedDirection: 'UP' } },
          w10: win(60, 75),
          w15: win(58, 70),
        },
      },
    });
    check(
      trade.status === 'closed' &&
        (trade.exitReason === 'model_pre_close' || trade.exitReason === 'model_late_exit'),
      'last minute forces pre-settle exit even when lean still firm'
    );
  }

  // Settle-close window (~3m left): cash out red instead of holding to settlement
  {
    const now = Date.now();
    const closeMs = now + 2.5 * 60 * 1000;
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(closeMs).toISOString(),
        yes_bid: 50,
        no_bid: 50,
      }),
      {
        strategyMode: 'model',
        modelMinHoldSeconds: 0,
        modelSettleCloseMinutes: 3,
        modelLateBarrierMinutes: 2,
        modelPreCloseForceMinutes: 1,
        modelLateExtendMinConfidence: 95,
        modelOpenGraceSeconds: 0,
      }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 65,
      windowCloseTime: closeMs,
      openedAt: now - 5 * 60 * 1000,
      modelEntryHeldProb: 62,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(58, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 65),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'closed', 'settle-close window exits before settlement');
    check(
      trade.exitReason === 'model_late_exit' || trade.exitReason === 'model_pre_close',
      'late exit reason is model_late_exit/pre_close'
    );
  }

  // Flat/green + confidence collapse → model exit (green → TP, flat → BE)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 55,
        no_bid: 45,
      }),
      { strategyMode: 'model', modelMinConfidence: 70, modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
    });
    const weak = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(58, 40), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, weak);
    checkEq(trade.status, 'open', 'weak confidence while flat → hold (soft BE off)');
  }

  // Dump + lean still with us: small red holds under fast-red threshold
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 53,
        no_bid: 47,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5_000,
      peakHeldBidCents: 55,
      modelEntryHeldProb: 60,
    });
    const stillWith = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(60, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, stillWith);
    checkEq(trade.status, 'open', 'small red (−2¢) + lean with us holds under fast-red');
  }

  // Dump past give-up: lean still UP but still red → stop (don't ride 84→68)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 52,
        no_bid: 48,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 10_000,
      peakHeldBidCents: 55,
      modelEntryHeldProb: 60,
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(60, 70), tracking: { predictedDirection: 'UP' } },
          w10: win(55, 60),
          w15: win(55, 60),
        },
      },
    });
    checkEq(trade.status, 'open', 'red >8s + firm lean → hold');
  }

  // Stale pending BE while red: promote to model_against and cut (don't loop to settle)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 60,
        no_bid: 40,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 78,
      modelEntryBidCents: 76,
      modelEntrySpreadCents: 2,
      windowCloseTime: now + 12 * 60 * 1000,
      openedAt: now - 5 * 60 * 1000,
      pendingForceExit: 'breakeven',
    });
    await bot._manageOpenTrade(trade, {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(40, 70), tracking: { predictedDirection: 'DOWN' } },
          w10: win(40, 70),
          w15: win(45, 60),
        },
      },
    });
    checkEq(trade.exitReason, 'model_against', 'stale BE force-retry promotes to against-cut');
    checkEq(trade.exitPriceCents, 60, 'cut books red bid not fake BE');
    checkEq(trade.pendingForceExit, undefined, 'force-exit cleared after cut');
  }

  // Mid-session window switch: w10 DOWN against underwater YES → BE/cut
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 8 * 60 * 1000).toISOString(),
        yes_bid: 50,
        no_bid: 50,
      }),
      { strategyMode: 'model', modelMinHoldSeconds: 0 }
    );
    const trade = openTrade(bot, {
      strategy: 'model',
      side: 'yes',
      entryPriceCents: 55,
      windowCloseTime: now + 8 * 60 * 1000,
      openedAt: now - 15_000,
    });
    const mid = {
      ETH: {
        ready: true,
        price: 3000,
        windows: {
          w5: { ...win(62, 70), tracking: { predictedDirection: 'UP' } },
          w10: { ...win(40, 70), tracking: { predictedDirection: 'DOWN' } },
          w15: win(50, 60),
        },
      },
    };
    await bot._manageOpenTrade(trade, mid);
    checkEq(trade.exitReason, 'model_against', 'w10 locked DOWN → cut underwater YES');
  }

  // Reentrant lock: shadow cycle holds the lock, then _openPosition takes it again.
  {
    const bot = makeBot(mockClient({ status: 'open' }), { strategyMode: 'model' });
    let innerRan = false;
    await bot._withTradeLock(async () => {
      await bot._withTradeLock(async () => {
        innerRan = true;
      });
    });
    check(innerRan, 'trade lock is reentrant (shadow + openPosition)');
  }

  // Shadow books: Core trades live; Majors (+ETH) simulates on the same quotes.
  {
    const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
    const mk = (symbol, yesAsk = 65, yesBid = 63) => ({
      ticker: `KX${symbol}15M-SH`,
      status: 'open',
      floor_strike: 1000,
      close_time: close,
      yes_bid: yesBid,
      yes_ask: yesAsk,
      no_bid: 100 - yesAsk,
      no_ask: 100 - yesBid,
    });
    const books = {
      BTC: mk('BTC'),
      ETH: mk('ETH'),
      SOL: mk('SOL'),
      BNB: mk('BNB'),
      XRP: mk('XRP'),
      DOGE: mk('DOGE'),
      NEAR: mk('NEAR'),
      HYPE: mk('HYPE'),
    };
    let createCalls = 0;
    const client = {
      hasCredentials: false,
      async getOpenMarkets(series) {
        const s = String(series || '').toUpperCase();
        for (const [sym, m] of Object.entries(books)) {
          if (s.includes(sym)) return [m];
        }
        return [];
      },
      async getMarket(ticker) {
        return Object.values(books).find((m) => m.ticker === ticker) || null;
      },
      async createOrder() {
        createCalls += 1;
        throw new Error('createOrder must not be called for shadow or paper');
      },
      async getBalance() {
        return { balance: 0, portfolio_value: 0 };
      },
    };
    const strong = (price) => ({
      ready: true,
      price,
      windows: {
        w5: { ...win(78, 82), tracking: { predictedDirection: 'UP' } },
        w10: win(72, 76),
        w15: win(68, 72),
      },
    });
    const preds = {
      BTC: strong(60100),
      ETH: strong(3010),
      SOL: strong(150),
      BNB: strong(600),
    };
    const bot = makeBot(client, {
      strategyMode: 'model',
      symbol: 'AUTO',
      activeSetupId: 'core',
      autoTradeSymbols: 'BTC,BNB,SOL',
      modelMinConfidence: 58,
      modelConfirmCrossCents: 0,
      maxOpenPositions: 2,
      modelMinHoldSeconds: 0,
    });
    const liveDecisionBefore = bot.lastDecision;
    const cycle = bot.runCycle(preds);
    const hung = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('runCycle hung (likely nested trade lock)')), 8000);
    });
    await Promise.race([cycle, hung]);
    checkEq(createCalls, 0, 'shadow/paper never calls createOrder');
    const liveSyms = bot.openTrades.map((t) => t.symbol).sort();
    check(!liveSyms.includes('ETH'), 'live Core book does not open ETH');
    check(liveSyms.includes('BTC'), 'live Core opens BTC');
    checkEq(
      bot.openTrades.every((t) => !t.shadow),
      true,
      'live fills are not tagged shadow'
    );
    const majors = bot._shadowBooks && bot._shadowBooks.majors;
    const majorsOpen = ((majors && majors.ledger && majors.ledger.trades) || []).filter(
      (t) => t && t.status === 'open'
    );
    const majorsSyms = majorsOpen.map((t) => t.symbol).sort();
    check(majorsOpen.length >= 1, 'majors shadow opened at least one ticket');
    check(majorsSyms.includes('ETH'), 'majors shadow (+ETH) opens ETH while Core is live');
    check(
      majorsOpen.every((t) => t.shadow === true && t.mode === 'paper'),
      'shadow fills are paper + tagged'
    );
    const tight = bot._shadowBooks && bot._shadowBooks.tight;
    const tightOpen = ((tight && tight.ledger && tight.ledger.trades) || []).filter(
      (t) => t && t.status === 'open'
    );
    check(tightOpen.length <= 1, 'tight shadow respects maxOpen 1');
    check(
      !bot.openTrades.some((t) => t.symbol === 'ETH'),
      'ETH did not leak into the live ledger'
    );
    let tradeLogHasShadow = false;
    try {
      const raw = JSON.parse(fs.readFileSync(dataPath('trade-log.json'), 'utf8'));
      const rows = Array.isArray(raw) ? raw : raw.trades || [];
      tradeLogHasShadow = rows.some((t) => t && t.shadow);
    } catch {
      tradeLogHasShadow = false;
    }
    checkEq(tradeLogHasShadow, false, 'shadow fills stay off the permanent trade log');
    check(bot.lastDecision !== liveDecisionBefore, 'live lastDecision still updates');
    check(!/shadow/i.test(String(bot.lastDecision || '')), 'live decision is not a shadow message');

    const board = bot._modelSetupScoreboard();
    const coreRow = board.find((r) => r.id === 'core');
    const majorsRow = board.find((r) => r.id === 'majors');
    check(coreRow && coreRow.active && coreRow.shadow == null, 'scoreboard marks Core live (no shadow line)');
    check(majorsRow && !majorsRow.active && majorsRow.shadow, 'scoreboard exposes majors shadow stats');
    checkEq(majorsRow.shadow.openCount, majorsOpen.length, 'scoreboard open count matches majors book');
    check(
      majorsRow.shadow.paperAvailableCents != null && majorsRow.shadow.paperAvailableCents >= 0,
      'majors shadow reports available remaining'
    );
    const hitsRow = board.find((r) => r.id === 'hits');
    const holdRow = board.find((r) => r.id === 'hold');
    const cut6Row = board.find((r) => r.id === 'cut6');
    check(hitsRow && hitsRow.shadow && hitsRow.shadow.paperAvailableCents != null, 'hits shadow reports remaining cash');
    check(holdRow && holdRow.shadow && holdRow.shadow.paperAvailableCents != null, 'hold shadow reports remaining cash');
    check(cut6Row && cut6Row.shadow && cut6Row.shadow.paperAvailableCents != null, 'cut6 shadow reports remaining cash');
  }
}

// ───────────────────────────── UI countdown logic (mirrored) ─────────────────────────────

function testCountdownLogic() {
  section('countdown / window-gap logic');
  const labelFor = (target, now) => {
    if (!target) return '—';
    const remainingMs = target - now;
    if (remainingMs <= 0) return 'Next window…';
    const totalSeconds = Math.round(remainingMs / 1000);
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };
  checkEq(labelFor(0, Date.now()), '—', 'missing target → dash');
  checkEq(labelFor(Date.now() - 5000, Date.now()), 'Next window…', 'past close → Next window');
  check(/^\d+:\d{2}$/.test(labelFor(Date.now() + 125_000, Date.now())), 'future close → mm:ss');

  // Wall-clock fallback close filter (engine no longer polls Kalshi for strikes)
  const now = Date.now();
  const markets = [
    { close_time: new Date(now - 1000).toISOString(), ticker: 'OLD' },
    { close_time: new Date(now + 600_000).toISOString(), ticker: 'NEW' },
  ];
  const picked = markets.find((m) => new Date(m.close_time).getTime() > now + 1500);
  checkEq(picked.ticker, 'NEW', 'expired open markets filtered');
}

// ───────────────────────────── optional online public APIs ─────────────────────────────

async function testOnlinePublicApis() {
  section('online public APIs (Coinbase + Kalshi read-only)');
  const fetch = globalThis.fetch;
  check(typeof fetch === 'function', 'global fetch available');
  if (typeof fetch !== 'function') return;

  try {
    const candleRes = await fetch(
      'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60',
      { headers: { 'User-Agent': 'crypto-prediction-engine-selftest' } }
    );
    check(candleRes.ok, `Coinbase candles HTTP ${candleRes.status}`);
    if (candleRes.ok) {
      const rows = await candleRes.json();
      check(Array.isArray(rows) && rows.length > 10, 'Coinbase returned candle rows');
    }
  } catch (err) {
    check(false, `Coinbase reachable (${err.cause?.code || err.message})`);
  }

  const kalshi = new KalshiClient({});
  try {
    const markets = await kalshi.getOpenMarkets('KXBTC15M', 3);
    check(Array.isArray(markets), 'Kalshi open markets array');
    if (markets[0]) {
      check(markets[0].ticker && markets[0].close_time, 'Kalshi market has ticker+close_time');
      const detail = await kalshi.getMarket(markets[0].ticker);
      check(detail && detail.ticker === markets[0].ticker, 'Kalshi getMarket matches');
      check(detail.yes_bid == null || Number.isFinite(detail.yes_bid), 'yes_bid normalized finite or null');
    } else {
      check(true, 'no open KXBTC15M market right now (gap ok)');
    }
  } catch (err) {
    check(false, `Kalshi public API reachable (${err.cause?.code || err.message})`);
  }
}

// ───────────────────────────── run ─────────────────────────────

function testBotCoordination() {
  section('bot coordination (primary / backup)');
  const prevRole = process.env.BOT_ROLE;
  const now = Date.now();
  process.env.BOT_ROLE = 'primary';
  publishPrimaryCoordination({
    openTrades: [
      {
        id: 't1',
        ticker: 'KXETH15M-TEST',
        symbol: 'ETH',
        side: 'yes',
        status: 'open',
        windowCloseTime: now + 600_000,
        pendingForceExit: 'take_profit',
        pendingForceExitSince: now - 20_000,
        entryPriceCents: 75,
        contracts: 4,
        strategy: 'model',
        mode: 'live',
      },
    ],
  });
  const coord = loadCoordination();
  check(isCoordinationFresh(coord, now), 'primary coordination fresh');
  checkEq(coord.openTrades.length, 1, 'primary publishes one open');

  process.env.BOT_ROLE = 'backup';
  const blocked = checkBackupEntryAllowed({
    coord,
    ticker: 'KXETH15M-TEST',
    symbol: 'ETH',
    windowCloseTime: now + 600_000,
    now,
  });
  check(!blocked.ok, 'backup blocked on same ticker/window');
  const rescue = backupRescueCandidates(coord, { now });
  check(rescue.length === 1, 'backup sees stuck TP rescue candidate');

  process.env.BOT_ROLE = prevRole;
}

async function run() {
  console.log(`Full self-test`);
  console.log(`DATA_DIR=${tmpDir}`);
  console.log(`ONLINE=${ONLINE ? 'yes' : 'no (set ONLINE=1 for live public API checks)'}`);

  testPaths();
  testIndicators();
  testCandlesAndBook();
  testSignalAccumulator();
  testTracker();
  testPrediction();
  await testKalshiClient();
  testBacktest();
  testBotControls();
  await testBotExits();
  await testBotTradingFlow();
  await testModelStrategy();
  testBotCoordination();
  testCountdownLogic();
  if (ONLINE) await testOnlinePublicApis();

  console.log(`\n════════════════════════════`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failed:');
    for (const f of failures) console.log(`  - ${f}`);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\nFatal self-test error:', err);
  process.exit(1);
});
