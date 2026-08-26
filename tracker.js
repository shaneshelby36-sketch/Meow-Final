'use strict';

const fs = require('fs');
const path = require('path');
const { dataPath, ensureDataDir, pruneArchiveFiles } = require('./paths');

ensureDataDir();

const MAX_HISTORY = 250; // ~2.5 days of 15m checkpoints per window
const CHECKPOINTS = [
  { key: 'w5', minutes: 5 },
  { key: 'w10', minutes: 10 },
  { key: 'w15', minutes: 15 },
];
const WINDOW_KEYS = CHECKPOINTS.map((c) => c.key);

const ROTATION_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours — keep yesterday beside today
const PERIOD_STATE_PATH = dataPath('tracker-period-start.json');
const ARCHIVE_DIR = dataPath('archive');
const CALIBRATION_PATH = dataPath('engine-calibration.json');
const LEGACY_CALIBRATION_PATH = dataPath('calibration.json');
const HISTORY_PATH = dataPath('tracker-history.json');

function bucketLabel(probabilityOfCalledDirection) {
  if (probabilityOfCalledDirection >= 90) return '90-100%';
  const floor = Math.floor(probabilityOfCalledDirection / 10) * 10;
  return `${floor}-${floor + 9}%`;
}

function looksLikeEngineCalibration(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.buckets) return false;
  return Object.values(obj).some(
    (v) => v && typeof v === 'object' && (v.w5 || v.w10 || v.w15)
  );
}

function loadCalibration() {
  try {
    if (fs.existsSync(CALIBRATION_PATH)) {
      return JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
    }
    // Migrate from the old shared calibration.json when it holds engine buckets
    // (bot trade buckets live under { buckets: {...} } and must not be used here).
    if (fs.existsSync(LEGACY_CALIBRATION_PATH)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CALIBRATION_PATH, 'utf8'));
      if (looksLikeEngineCalibration(legacy)) {
        saveCalibration(legacy);
        console.log('[tracker] migrated engine calibration → engine-calibration.json');
        return legacy;
      }
    }
  } catch (err) {
    console.error('[tracker] failed to load calibration stats, starting fresh:', err.message);
  }
  return {}; // symbol -> window -> bucketLabel -> { trades, wins }
}

function saveCalibration(calibration) {
  try {
    fs.mkdirSync(path.dirname(CALIBRATION_PATH), { recursive: true });
    fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(calibration, null, 2));
  } catch (err) {
    console.error('[tracker] failed to persist calibration stats:', err.message);
  }
}

function loadPeriodStart() {
  try {
    if (fs.existsSync(PERIOD_STATE_PATH)) {
      const n = Number(JSON.parse(fs.readFileSync(PERIOD_STATE_PATH, 'utf8')).periodStartTime);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // fall through — infer from history so a missing file doesn't zero today
  }
  return null;
}

function savePeriodStart(periodStartTime) {
  try {
    fs.mkdirSync(path.dirname(PERIOD_STATE_PATH), { recursive: true });
    fs.writeFileSync(PERIOD_STATE_PATH, JSON.stringify({ periodStartTime }));
  } catch (err) {
    console.error('[tracker] failed to persist period start:', err.message);
  }
}

function emptyWindowBags() {
  return { w5: [], w10: [], w15: [] };
}

function summarizeWindowRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const sampleSize = list.length;
  const correctCount = list.filter((h) => h && h.correct).length;
  return {
    sampleSize,
    correctCount,
    accuracyPct: sampleSize ? +((correctCount / sampleSize) * 100).toFixed(1) : null,
  };
}

function rowsInRange(rows, fromMs, toMs) {
  return (Array.isArray(rows) ? rows : []).filter((h) => {
    const t = Number(h && h.windowOpenTime);
    return Number.isFinite(t) && t >= fromMs && t < toMs;
  });
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      const map = new Map();
      for (const [symbol, windows] of Object.entries(raw)) {
        map.set(symbol, {
          w5: (windows.w5 || []).slice(0, MAX_HISTORY),
          w10: (windows.w10 || []).slice(0, MAX_HISTORY),
          w15: (windows.w15 || []).slice(0, MAX_HISTORY),
        });
      }
      console.log('[tracker] loaded previous settlement history from disk');
      return map;
    }
  } catch (err) {
    console.error('[tracker] failed to load settlement history:', err.message);
  }
  return new Map();
}

function saveHistory(history) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(Object.fromEntries(history), null, 2));
  } catch (err) {
    console.error('[tracker] failed to persist settlement history:', err.message);
  }
}

/**
 * Tracks ONE cycle per symbol, tied to Kalshi's actual rolling 15-minute
 * market — not three independent per-window timers. All three checkpoints
 * (0-5 / 5-10 / 10-15 min) are measured from the SAME window-open time and
 * checked against the SAME target/strike price, exactly matching how
 * Kalshi's own contract works: one strike, one 15-minute clock, checked at
 * three points along the way.
 *
 * A new cycle only starts when Kalshi's ticker actually changes (a new
 * 15-minute market has opened) — never mid-window — so the countdown shown
 * for the 10-15 min checkpoint is always identical to the real Kalshi
 * window's own close time.
 *
 * Every 24 hours the track-record display rolls: today starts at 0 again
 * and yesterday's probability stays beside it. History is archived, not
 * wiped — a restart / missing period file must not randomly zero the
 * counters. Rows older than two periods are pruned.
 * Also maintains probability-bucketed calibration stats (e.g. "when we
 * called 70-79% confidence, how often were we actually right?") — this
 * accumulates FOREVER, deliberately never reset or rotated, per the intent
 * of "keep updating the statistics as every new prediction settles" — it's
 * meant to answer a different question than the 12h rolling history: not
 * "how have we done recently" but "how trustworthy is a given probability
 * level in this system, based on everything it's ever seen."
 */
class PredictionTracker {
  constructor() {
    this.cycles = new Map(); // symbol -> current cycle
    this.history = loadHistory(); // symbol -> { w5: [...], w10: [...], w15: [...] }, persisted to disk
    const loadedStart = loadPeriodStart();
    const hasHistory = [...this.history.values()].some(
      (w) => (w.w5 && w.w5.length) || (w.w10 && w.w10.length) || (w.w15 && w.w15.length)
    );
    this.periodStartTime = Number.isFinite(loadedStart)
      ? loadedStart
      : hasHistory
        ? Date.now() - ROTATION_PERIOD_MS
        : Date.now();
    if (!Number.isFinite(loadedStart)) savePeriodStart(this.periodStartTime);
    this.calibration = loadCalibration(); // symbol -> window -> bucketLabel -> { trades, wins } — never rotated
  }

  _historyFor(symbol) {
    if (!this.history.has(symbol)) {
      this.history.set(symbol, { w5: [], w10: [], w15: [] });
    }
    return this.history.get(symbol);
  }

  _maybeRotate(now) {
    let start = Number(this.periodStartTime) || now - ROTATION_PERIOD_MS;
    if (now - start < ROTATION_PERIOD_MS) return;

    while (now - start >= ROTATION_PERIOD_MS) {
      const periodEnd = start + ROTATION_PERIOD_MS;
      try {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        const slice = {};
        for (const [symbol, windows] of this.history.entries()) {
          slice[symbol] = emptyWindowBags();
          for (const key of WINDOW_KEYS) {
            slice[symbol][key] = rowsInRange(windows[key], start, periodEnd);
          }
        }
        const archive = {
          periodStart: new Date(start).toISOString(),
          periodEnd: new Date(periodEnd).toISOString(),
          history: slice,
        };
        const fileName = `tracker-${new Date(start).toISOString().replace(/[:.]/g, '-')}.json`;
        fs.writeFileSync(path.join(ARCHIVE_DIR, fileName), JSON.stringify(archive, null, 2));
        console.log(`[tracker] archived 24h accuracy history to data/archive/${fileName}`);
        pruneArchiveFiles({ now });
      } catch (err) {
        console.error('[tracker] failed to archive history before rotation:', err.message);
      }
      start = periodEnd;
    }

    this.periodStartTime = start;
    savePeriodStart(start);
    this._pruneOldHistory(start - ROTATION_PERIOD_MS);
    saveHistory(this.history);
    // In-progress Kalshi windows keep tracking through the 24h boundary.
  }

  _pruneOldHistory(cutoffMs) {
    const cut = Number(cutoffMs);
    if (!Number.isFinite(cut)) return;
    for (const [symbol, windows] of this.history.entries()) {
      for (const key of WINDOW_KEYS) {
        const rows = Array.isArray(windows[key]) ? windows[key] : [];
        windows[key] = rows.filter((h) => Number(h && h.windowOpenTime) >= cut);
      }
      this.history.set(symbol, windows);
    }
  }

  _accuracyFor(histRows, periodStart) {
    const todayEnd = periodStart + ROTATION_PERIOD_MS;
    const today = summarizeWindowRows(rowsInRange(histRows, periodStart, todayEnd));
    const previous = summarizeWindowRows(
      rowsInRange(histRows, periodStart - ROTATION_PERIOD_MS, periodStart)
    );
    return {
      ...today,
      previous: previous.sampleSize > 0 ? previous : null,
      periodHours: 24,
    };
  }

  /**
   * Call once per compute cycle per symbol.
   * ticker: Kalshi's current market ticker for this symbol (identifies the cycle)
   * targetPrice: the one static strike/target price for this cycle
   * closeTime: when this Kalshi market closes (ms epoch) — also the 10-15 min checkpoint
   * currentPrice: live price right now
   * windows: this cycle's fresh { w5, w10, w15 } prediction objects (need .probabilityUp)
   * now: Date.now()
   *
   * Returns { w5: {...}, w10: {...}, w15: {...} } — one tracking/history/accuracy
   * bundle per window, all sharing the same baseline price and window-open time.
   */
  update(symbol, { ticker, targetPrice, closeTime, currentPrice, windows, now }) {
    this._maybeRotate(now);

    let cycle = this.cycles.get(symbol);
    const isNewCycle = !cycle || cycle.ticker !== ticker;

    if (isNewCycle) {
      const windowOpenTime = closeTime - 15 * 60 * 1000;
      const lockProb = (w) => {
        // Prefer raw logistic probs so empirical calibration doesn't feed itself.
        const up = Number(w && (w.probabilityUpRaw != null ? w.probabilityUpRaw : w.probabilityUp));
        const down = Number(
          w && (w.probabilityDownRaw != null ? w.probabilityDownRaw : w.probabilityDown)
        );
        const pUp = Number.isFinite(up) ? up : 50;
        const pDown = Number.isFinite(down) ? down : 100 - pUp;
        return {
          direction: pUp >= 50 ? 'UP' : 'DOWN',
          called: Math.max(pUp, pDown),
        };
      };
      const l5 = lockProb(windows.w5);
      const l10 = lockProb(windows.w10);
      const l15 = lockProb(windows.w15);
      cycle = {
        ticker,
        baselinePrice: targetPrice,
        windowOpenTime,
        closeTime,
        predictedDirection: {
          w5: l5.direction,
          w10: l10.direction,
          w15: l15.direction,
        },
        predictedProbability: {
          // Probability OF the called direction (always >=50 by
          // construction) — this is what gets bucketed for calibration.
          w5: l5.called,
          w10: l10.called,
          w15: l15.called,
        },
        resolved: { w5: false, w10: false, w15: false },
      };
      this.cycles.set(symbol, cycle);
    }

    const hist = this._historyFor(symbol);
    const result = {};

    for (const { key, minutes } of CHECKPOINTS) {
      const checkpointTime = cycle.windowOpenTime + minutes * 60 * 1000;

      if (!cycle.resolved[key] && now >= checkpointTime) {
        const actualDirection = currentPrice >= cycle.baselinePrice ? 'UP' : 'DOWN';
        const correct = actualDirection === cycle.predictedDirection[key];
        const changePct = ((currentPrice - cycle.baselinePrice) / cycle.baselinePrice) * 100;

        hist[key].unshift({
          windowOpenTime: cycle.windowOpenTime,
          checkpointTime,
          windowMinutes: minutes,
          baselinePrice: cycle.baselinePrice,
          predictedDirection: cycle.predictedDirection[key],
          actualPrice: currentPrice,
          actualDirection,
          changePct: +changePct.toFixed(4),
          correct,
        });
        if (hist[key].length > MAX_HISTORY) hist[key].length = MAX_HISTORY;
        cycle.resolved[key] = true;
        saveHistory(this.history);

        // Calibration: bucket by the probability we actually called at
        // entry, and update forever (never rotated/reset).
        const bucket = bucketLabel(cycle.predictedProbability[key]);
        this.calibration[symbol] = this.calibration[symbol] || {};
        this.calibration[symbol][key] = this.calibration[symbol][key] || {};
        const cell = (this.calibration[symbol][key][bucket] = this.calibration[symbol][key][bucket] || {
          trades: 0,
          wins: 0,
        });
        cell.trades += 1;
        if (correct) cell.wins += 1;
        saveCalibration(this.calibration);
      }

      const secondsRemaining = Math.max(0, Math.round((checkpointTime - now) / 1000));

      result[key] = {
        tracking: {
          madeAt: cycle.windowOpenTime,
          targetTime: checkpointTime,
          secondsRemaining,
          baselinePrice: cycle.baselinePrice,
          predictedDirection: cycle.predictedDirection[key],
        },
        lastResult: hist[key][0] || null,
        accuracy: this._accuracyFor(hist[key], this.periodStartTime),
        history: hist[key].slice(0, 10),
      };
    }

    return result;
  }

  /**
   * Returns calibration stats for one symbol, all windows, with a maturity
   * label per bucket so it's clear how much to trust each number:
   *   < 40 trades:  'insufficient' - not enough data to trust yet
   *   40-99:        'developing'   - a reasonable starting signal
   *   100-199:      'good'         - reasonably trustworthy
   *   200+:         'reliable'     - well-supported by data
   */
  getCalibration(symbol) {
    const data = this.calibration[symbol] || {};
    const withMaturity = {};
    for (const windowKey of Object.keys(data)) {
      withMaturity[windowKey] = {};
      for (const [bucket, cell] of Object.entries(data[windowKey])) {
        const winRatePct = cell.trades ? +((cell.wins / cell.trades) * 100).toFixed(1) : null;
        let maturity = 'insufficient';
        if (cell.trades >= 200) maturity = 'reliable';
        else if (cell.trades >= 100) maturity = 'good';
        else if (cell.trades >= 40) maturity = 'developing';
        withMaturity[windowKey][bucket] = { trades: cell.trades, wins: cell.wins, winRatePct, maturity };
      }
    }
    return withMaturity;
  }
}

module.exports = { PredictionTracker, ROTATION_PERIOD_MS, bucketLabel };
