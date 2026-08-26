'use strict';

/**
 * Maps raw engine probabilities to empirically observed hit rates from the
 * tracker (when enough samples exist). Without this, a logistic "72%" is just
 * a score — not a real chance of being right vs the Kalshi strike.
 *
 * Blend grows with bucket maturity so thin samples don't yank live probs.
 */

const MIN_TRADES_TO_BLEND = 40;
const FULL_BLEND_TRADES = 200;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function bucketLabel(probabilityOfCalledDirection) {
  const p = Number(probabilityOfCalledDirection);
  if (!Number.isFinite(p)) return '50-59%';
  if (p >= 90) return '90-100%';
  const floor = Math.floor(p / 10) * 10;
  return `${floor}-${floor + 9}%`;
}

function maturityForTrades(trades) {
  const n = Number(trades) || 0;
  if (n >= 200) return 'reliable';
  if (n >= 100) return 'good';
  if (n >= 40) return 'developing';
  return 'insufficient';
}

function blendWeight(trades) {
  const n = Number(trades) || 0;
  if (n < MIN_TRADES_TO_BLEND) return 0;
  return clamp((n - MIN_TRADES_TO_BLEND) / (FULL_BLEND_TRADES - MIN_TRADES_TO_BLEND), 0, 1);
}

/**
 * Look up empirical P(correct | called-direction bucket) for one window.
 * Returns null when there isn't enough data to trust.
 */
function lookupEmpiricalCalledRate(calibration, symbol, windowKey, calledProbPct) {
  const bySym = calibration && calibration[symbol];
  const byWin = bySym && bySym[windowKey];
  if (!byWin || typeof byWin !== 'object') return null;
  const label = bucketLabel(calledProbPct);
  const cell = byWin[label];
  if (!cell) return null;
  const trades = Number(cell.trades) || 0;
  const wins = Number(cell.wins) || 0;
  if (trades < MIN_TRADES_TO_BLEND || wins < 0) return null;
  return {
    label,
    trades,
    wins,
    rate: wins / trades,
    maturity: maturityForTrades(trades),
    weight: blendWeight(trades),
  };
}

/**
 * Calibrate a 0..1 P(up). Softens confidence toward historical hit rate for
 * that bucket — but NEVER flips the call. If the bucket is historically
 * wrong (<50%), we shrink toward a coin-flip, not reverse Buy↔Sell.
 */
function calibrateProbabilityUp(pUp01, { symbol, windowKey, calibration } = {}) {
  const raw = clamp(Number(pUp01), 0, 1);
  if (!Number.isFinite(raw) || !calibration || !symbol || !windowKey) {
    return { probabilityUp: raw, calibrated: false };
  }
  const calledUp = raw >= 0.5;
  const calledProbPct = Math.max(raw, 1 - raw) * 100;
  const emp = lookupEmpiricalCalledRate(calibration, symbol, windowKey, calledProbPct);
  if (!emp || emp.weight <= 0) {
    return { probabilityUp: raw, calibrated: false, bucket: bucketLabel(calledProbPct) };
  }
  const rawCalled = calledProbPct / 100;
  // Reliability floored at 50%: bad buckets only erase edge, they don't invert.
  const reliableRate = Math.max(0.5, emp.rate);
  const blendedCalled = rawCalled * (1 - emp.weight) + reliableRate * emp.weight;
  const calledClamped = clamp(Math.max(0.5, blendedCalled), 0.5, 0.98);
  const probabilityUp = calledUp ? calledClamped : 1 - calledClamped;
  return {
    probabilityUp: clamp(probabilityUp, 0.02, 0.98),
    calibrated: true,
    bucket: emp.label,
    empiricalRate: emp.rate,
    blendWeight: emp.weight,
    maturity: emp.maturity,
    trades: emp.trades,
    directionPreserved: true,
  };
}

/**
 * Mutate a window prediction in place: keep raw probs, overwrite displayed
 * probabilityUp/Down with the calibrated values when available.
 */
function applyCalibrationToWindow(windowPred, { symbol, windowKey, calibration } = {}) {
  if (!windowPred || typeof windowPred !== 'object') return windowPred;
  const rawUp = Number(windowPred.probabilityUpRaw != null
    ? windowPred.probabilityUpRaw
    : windowPred.probabilityUp);
  if (!Number.isFinite(rawUp)) return windowPred;
  if (windowPred.probabilityUpRaw == null) {
    windowPred.probabilityUpRaw = +rawUp.toFixed(1);
    windowPred.probabilityDownRaw = +(100 - rawUp).toFixed(1);
  }
  const result = calibrateProbabilityUp(rawUp / 100, { symbol, windowKey, calibration });
  const pUp = result.probabilityUp * 100;
  windowPred.probabilityUp = +pUp.toFixed(1);
  windowPred.probabilityDown = +(100 - pUp).toFixed(1);
  windowPred.calibrated = result.calibrated === true;
  if (result.calibrated) {
    windowPred.calibration = {
      bucket: result.bucket,
      empiricalRatePct: +(result.empiricalRate * 100).toFixed(1),
      blendWeight: +result.blendWeight.toFixed(2),
      maturity: result.maturity,
      trades: result.trades,
    };
  } else {
    windowPred.calibration = { bucket: result.bucket || null, maturity: 'insufficient' };
  }
  return windowPred;
}

/**
 * After all three windows exist: reward unanimous lean, shrink/dock outliers.
 * Operates on percentage probs (mutates windows).
 */
function applyWindowConsensus(windows) {
  if (!windows || !windows.w5 || !windows.w10 || !windows.w15) {
    return { agreeCount: 0, unanimous: false };
  }
  const keys = ['w5', 'w10', 'w15'];
  const dirs = keys.map((k) => (Number(windows[k].probabilityUp) >= 50 ? 1 : -1));
  const upVotes = dirs.filter((d) => d > 0).length;
  const majorityDir = upVotes >= 2 ? 1 : -1;
  const agreeCount = dirs.filter((d) => d === majorityDir).length;
  const unanimous = agreeCount === 3;

  for (let i = 0; i < keys.length; i++) {
    const w = windows[keys[i]];
    const agrees = dirs[i] === majorityDir;
    let conf = Number(w.confidence);
    let pUp = Number(w.probabilityUp);
    if (!Number.isFinite(conf) || !Number.isFinite(pUp)) continue;

    if (unanimous) {
      conf = Math.min(95, conf + 4);
      // Slightly sharpen lean when all horizons agree (still bounded).
      const edge = pUp - 50;
      pUp = 50 + edge * 1.06;
    } else if (!agrees) {
      conf = Math.max(8, conf - 12);
      // Pull disagreeing window toward coin-flip — often the noisy short horizon.
      pUp = 50 + (pUp - 50) * 0.55;
      const notes = Array.isArray(w.consensusNotes) ? w.consensusNotes : [];
      notes.push('Disagrees with majority of horizons — shrunk toward 50%');
      w.consensusNotes = notes;
    } else if (agreeCount === 2) {
      conf = Math.min(95, conf + 1);
    }

    w.confidence = Math.round(clamp(conf, 8, 95));
    w.probabilityUp = +clamp(pUp, 1, 99).toFixed(1);
    w.probabilityDown = +(100 - w.probabilityUp).toFixed(1);
  }

  const consensus = {
    agreeCount,
    unanimous,
    majorityDirection: majorityDir > 0 ? 'UP' : 'DOWN',
  };
  for (const k of keys) {
    windows[k].consensus = consensus;
  }
  return consensus;
}

/** Entry helper: does this side match the multi-window majority? */
function windowConsensusSupportsSide(windows, side) {
  if (!windows || !windows.w5 || !windows.w10 || !windows.w15) return true;
  const c = windows.w5.consensus || applyWindowConsensus(windows);
  if (!c || c.agreeCount < 2) return false;
  if (side === 'yes') return c.majorityDirection === 'UP';
  if (side === 'no') return c.majorityDirection === 'DOWN';
  return false;
}

/**
 * Skip entries when this confidence bucket historically loses money / is wrong,
 * once we have developing+ samples. Thin data → allow (don't starve early).
 */
function modelCalibrationEntryGate({
  symbol,
  windowKey,
  probabilityUp,
  side,
  calibration,
  minWinRatePct = 52,
} = {}) {
  if (!calibration || !symbol || !windowKey) return { ok: true };
  const pUp = Number(probabilityUp);
  if (!Number.isFinite(pUp)) return { ok: true };
  const heldProb = side === 'yes' ? pUp : 100 - pUp;
  const calledProb = Math.max(heldProb, 100 - heldProb);
  const emp = lookupEmpiricalCalledRate(calibration, symbol, windowKey, calledProb);
  if (!emp) return { ok: true };
  const winRatePct = emp.rate * 100;
  if (winRatePct + 1e-9 < minWinRatePct) {
    return {
      ok: false,
      reason:
        `calibrated ${emp.label} only ${winRatePct.toFixed(0)}% historically ` +
        `(need ≥${minWinRatePct}%, n=${emp.trades})`,
      winRatePct,
      trades: emp.trades,
      maturity: emp.maturity,
    };
  }
  return { ok: true, winRatePct, trades: emp.trades, maturity: emp.maturity };
}

module.exports = {
  bucketLabel,
  maturityForTrades,
  blendWeight,
  lookupEmpiricalCalledRate,
  calibrateProbabilityUp,
  applyCalibrationToWindow,
  applyWindowConsensus,
  windowConsensusSupportsSide,
  modelCalibrationEntryGate,
  MIN_TRADES_TO_BLEND,
  FULL_BLEND_TRADES,
};
