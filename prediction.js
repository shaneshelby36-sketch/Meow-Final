'use strict';

const {
  rsi,
  macd,
  atr,
  momentum,
  volatility,
  correlation,
  trendStrength,
  volumeSpike,
  candlePattern,
} = require('./indicators');
const {
  applyWindowConsensus,
  applyCalibrationToWindow,
} = require('./engineCalibration');

const WINDOWS = [
  { key: 'w5', label: '0-5 min', minutes: 5 },
  { key: 'w10', label: '5-10 min', minutes: 10 },
  { key: 'w15', label: '10-15 min', minutes: 15 },
];

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Logistic squash: turns an unbounded score into a 0..1 probability.
// Softer k (0.9 vs 2.0) so modest trend+distance scores read ~75–88%, not false 99/1.
const LEAN_LOGISTIC_K = 0.9;

function logistic(x, k = LEAN_LOGISTIC_K) {
  return 1 / (1 + Math.exp(-k * x));
}

/**
 * Gathers every raw indicator reading for one product's candle/orderbook state.
 * Returns null if there isn't enough history yet to compute reliably.
 */
function gatherIndicators(series, book) {
  if (!series.ready(210)) return null;
  const closes = series.closes();
  const volumes = series.volumes();
  const candles = series.candles;

  const trend = trendStrength(closes);
  const rsiVal = rsi(closes, 14);
  const macdVal = macd(closes);
  const atrVal = atr(candles, 14);
  const mom3 = momentum(closes, 3);
  const mom10 = momentum(closes, 10);
  const vol = volatility(closes, 20);
  const volSpike = volumeSpike(volumes, 20);
  const pattern = candlePattern(candles);
  const price = series.latestClose();

  const imbalance = book && book.ready ? book.imbalance(0.5) : null;
  const spread = book && book.ready ? book.spread() : null;
  const liquidity = book && book.ready ? book.liquidity(0.5) : null;

  if (!trend || rsiVal == null || !macdVal || atrVal == null) return null;

  // Major trend-change detection: compare current EMA alignment against
  // where it was ~10 candles (about 10 minutes) ago. Using a short 1-candle
  // lookback would make this fire for only a moment — too brief for the
  // signal accumulator (which builds influence over real elapsed time) to
  // ever register it as the major event it actually is. A ~10-minute
  // lookback keeps a genuine crossover flagged as "recent" long enough to
  // actually dominate while it's fresh, fading out naturally afterward.
  let trendChangePulse = 0; // 0 = no recent change; else +1/-1 = direction of the new trend
  if (closes.length > 220) {
    const priorTrend = trendStrength(closes.slice(0, -10));
    if (priorTrend && Math.sign(priorTrend.alignment) !== Math.sign(trend.alignment) && trend.alignment !== 0) {
      trendChangePulse = Math.sign(trend.alignment);
    }
  }

  // Breakout detection: meaningfully elevated volume together with a real
  // short-term price move — distinct from "trend" (which is about EMA
  // structure) and from plain "momentum" (which fires on any rate-of-change,
  // however quiet). This only fires when both conditions hold together.
  let breakoutSignal = 0;
  if (volSpike && volSpike.ratio >= 2 && mom3 != null && Math.abs(mom3) >= 0.15) {
    breakoutSignal = Math.sign(mom3);
  }

  return {
    price,
    trend,
    rsi: rsiVal,
    macd: macdVal,
    atr: atrVal,
    atrPct: (atrVal / price) * 100,
    momentumShort: mom3,
    momentumLong: mom10,
    volatility: vol,
    volumeSpike: volSpike,
    pattern,
    imbalance,
    spread,
    liquidity,
    trendChangePulse,
    breakoutSignal,
  };
}

// Per-window weight TIERS for each independent signal family. Consolidated
// so correlated indicators never get counted twice: EMA alignment, MACD,
// and EMA-slope all measure "trend" and are blended into ONE family below
// rather than three separate additive terms. Major, distinct events
// (order-book imbalance, a real breakout, a fresh trend-change) carry much
// higher weight than minor ones (RSI, small volume shifts), so one strong
// independent signal can outweigh several weak ones — matching how actual
// evidence should combine rather than just counting indicators.
const SIGNAL_WEIGHT_PROFILES = {
  //           trend  change  momentum rsi   pattern breakout imbalance
  w5:  { trend: 1.3, trendChange: 3.0, momentum: 1.6, rsi: 0.5, pattern: 1.0, breakout: 3.0, imbalance: 2.6 },
  w10: { trend: 1.8, trendChange: 2.6, momentum: 1.2, rsi: 0.5, pattern: 0.6, breakout: 2.4, imbalance: 1.4 },
  w15: { trend: 2.2, trendChange: 2.2, momentum: 0.9, rsi: 0.45, pattern: 0.35, breakout: 1.8, imbalance: 0.8 },
};

/**
 * Computes each independent signal family's raw, unweighted reading in
 * roughly [-1, 1] (positive = bullish, negative = bearish). These are the
 * building blocks fed into the signal accumulator — kept separate from
 * weighting so the same raw readings can be reused for the flat one-cycle
 * score (backtest-compatible) or accumulated over real time (live engine).
 */
function computeSignalFamilies(ind) {
  const families = {};

  // Consolidated "trend" family: EMA alignment, EMA50 slope, and MACD
  // histogram all measure the same underlying thing (is price trending up
  // or down), so they're blended into one weighted AVERAGE — one vote —
  // instead of three separate additive contributions.
  const alignmentNorm = ind.trend.alignment / 2;
  const slopeNorm = clamp(ind.trend.slope / 0.5, -1, 1);
  const macdNorm = clamp(ind.macd.histogram / (ind.price * 0.0015), -1, 1);
  families.trend = alignmentNorm * 0.45 + slopeNorm * 0.25 + macdNorm * 0.3;

  families.trendChange = ind.trendChangePulse; // -1, 0, or 1
  families.breakout = ind.breakoutSignal; // -1, 0, or 1

  const momBlend = (ind.momentumShort ?? 0) * 0.6 + (ind.momentumLong ?? 0) * 0.4;
  families.momentum = clamp(momBlend / 0.4, -1, 1);

  families.rsi = clamp((ind.rsi - 50) / 25, -1, 1);
  families.pattern = ind.pattern.lean;
  families.imbalance = ind.imbalance ? ind.imbalance.ratio : 0;

  return families;
}

/**
 * Applies this window's weight tiers to the raw signal families, producing
 * both the flat one-cycle score (used directly by the backtester, and as
 * the pre-accumulation reading for the live engine) and a breakdown of
 * weighted contributions (fed into the signal accumulator) plus
 * human-readable explanation text — one line per family, never duplicated
 * across correlated indicators.
 */
function directionalScore(ind, windowKey) {
  const w = SIGNAL_WEIGHT_PROFILES[windowKey];
  const families = computeSignalFamilies(ind);
  const weighted = {};
  const contributions = [];
  let score = 0;

  for (const key of Object.keys(families)) {
    const raw = families[key];
    const weight = w[key] ?? 0;
    const wv = raw * weight;
    weighted[key] = wv;
    score += wv;
  }

  if (Math.abs(families.trend) > 0.35) {
    contributions.push({
      text: `Trend indicators (EMA/MACD/slope) leaning ${families.trend > 0 ? 'bullish' : 'bearish'}`,
      weight: Math.abs(weighted.trend),
    });
  }
  if (families.trendChange !== 0) {
    contributions.push({
      text: `Major trend shift happened recently (now ${families.trendChange > 0 ? 'bullish' : 'bearish'})`,
      weight: Math.abs(weighted.trendChange),
    });
  }
  if (families.breakout !== 0) {
    contributions.push({
      text: `Volume breakout with strong momentum, ${families.breakout > 0 ? 'bullish' : 'bearish'}`,
      weight: Math.abs(weighted.breakout),
    });
  }
  if (Math.abs(families.momentum) > 0.35) {
    contributions.push({
      text: `Price momentum ${families.momentum > 0 ? 'up' : 'down'} recently`,
      weight: Math.abs(weighted.momentum),
    });
  }
  if (ind.rsi >= 70) contributions.push({ text: `RSI ${ind.rsi.toFixed(0)} (overbought)`, weight: Math.abs(weighted.rsi) });
  if (ind.rsi <= 30) contributions.push({ text: `RSI ${ind.rsi.toFixed(0)} (oversold)`, weight: Math.abs(weighted.rsi) });
  if (Math.abs(families.pattern) >= 0.4) {
    contributions.push({ text: `Recent candles show ${ind.pattern.label}`, weight: Math.abs(weighted.pattern) });
  }
  if (Math.abs(families.imbalance) > 0.15) {
    contributions.push({
      text: `Order book ${families.imbalance > 0 ? 'buy' : 'sell'}-side pressure (${(Math.abs(families.imbalance) * 100).toFixed(0)}% skew)`,
      weight: Math.abs(weighted.imbalance),
    });
  }

  const maxWeightSum = Object.values(w).reduce((a, b) => a + Math.abs(b), 0);

  return { score, contributions, families, weighted, maxWeightSum };
}

// Confidence starts high and is docked for anything that makes the
// prediction less trustworthy, per the spec's explicit list of conditions.
function computeConfidence(ind, contributions, crossCorrelation, agreementWithOther, symbol) {
  let confidence = 78;
  const notes = [];
  let riskPoints = 0;

  const dock = (points, note) => {
    confidence -= points;
    riskPoints += points;
    notes.push(note);
  };

  // Rising volatility
  if (ind.volatility != null) {
    if (ind.volatility > 0.35) dock(14, `Elevated volatility (${ind.volatility.toFixed(2)}%)`);
    else if (ind.volatility > 0.2) dock(7, `Moderate volatility (${ind.volatility.toFixed(2)}%)`);
  }

  // Weakening momentum: histogram shrinking toward zero or momentum near zero
  if (ind.macd.prevHistogram != null) {
    const weakening =
      Math.abs(ind.macd.histogram) < Math.abs(ind.macd.prevHistogram) &&
      Math.sign(ind.macd.histogram) === Math.sign(ind.macd.prevHistogram);
    if (weakening) dock(6, 'MACD momentum weakening');
  }
  if (ind.momentumShort != null && Math.abs(ind.momentumShort) < 0.03) {
    dock(5, 'Very little short-term price movement');
  }

  // Short vs medium momentum fight — common false-confidence setup
  if (
    ind.momentumShort != null &&
    ind.momentumLong != null &&
    Math.sign(ind.momentumShort) !== 0 &&
    Math.sign(ind.momentumLong) !== 0 &&
    Math.sign(ind.momentumShort) !== Math.sign(ind.momentumLong) &&
    Math.abs(ind.momentumShort) >= 0.08 &&
    Math.abs(ind.momentumLong) >= 0.08
  ) {
    dock(8, 'Short-term and medium momentum disagree');
  }

  // Large sell (or buy) pressure that conflicts with the trend direction
  if (ind.imbalance) {
    const trendSign = Math.sign(ind.trend.alignment) || Math.sign(ind.momentumLong ?? 0);
    const flowSign = Math.sign(ind.imbalance.ratio);
    if (trendSign !== 0 && flowSign !== 0 && trendSign !== flowSign && Math.abs(ind.imbalance.ratio) > 0.25) {
      dock(10, 'Order flow conflicts with prevailing trend');
    }
    if (Math.abs(ind.imbalance.ratio) > 0.6) {
      dock(6, `Heavy ${ind.imbalance.ratio < 0 ? 'sell' : 'buy'}-side pressure in the book`);
    }
  }

  // Correlation breakdown between this asset and BTC (its benchmark)
  if (crossCorrelation != null) {
    if (Math.abs(crossCorrelation) < 0.3) {
      dock(10, `${symbol || 'This asset'}/BTC correlation has broken down (${crossCorrelation.toFixed(2)})`);
    }
  }

  // Conflicting indicators: do the contributions disagree in direction?
  const signs = contributions.map((c) => c.text);
  const posCount = signs.filter((t) => /bullish|buy|rising|oversold/i.test(t)).length;
  const negCount = signs.filter((t) => /bearish|sell|falling|overbought/i.test(t)).length;
  if (posCount > 0 && negCount > 0) {
    dock(8, 'Indicators are giving conflicting signals');
  }

  // Wide spread / thin liquidity
  if (ind.spread && ind.spread.percent > 0.05) {
    dock(5, `Wider than normal bid/ask spread (${ind.spread.percent.toFixed(3)}%)`);
  }
  if (ind.liquidity != null && Number.isFinite(ind.liquidity) && ind.liquidity < 0.15) {
    dock(8, `Thin order-book liquidity (${(ind.liquidity * 100).toFixed(0)}% depth)`);
  } else if (ind.liquidity != null && Number.isFinite(ind.liquidity) && ind.liquidity < 0.28) {
    dock(4, `Below-average book depth (${(ind.liquidity * 100).toFixed(0)}%)`);
  }

  // Agreement with the other asset's directional lean nudges confidence up
  if (agreementWithOther != null && crossCorrelation != null && Math.abs(crossCorrelation) >= 0.3) {
    if (agreementWithOther) {
      confidence += 4;
      notes.push('Confirms direction with correlated asset');
    } else {
      dock(6, 'Diverges from usually-correlated asset');
    }
  }

  confidence = clamp(confidence, 8, 95);
  return { confidence, notes, riskPoints: clamp(riskPoints, 0, 100) };
}

function recommend(pUp, confidence) {
  // Labels are UP/DOWN vs the Kalshi strike — not "buy/sell the coin".
  if (confidence < 32) return 'Wait';
  if (pUp >= 0.66 && confidence >= 55) return 'Strong UP';
  if (pUp >= 0.55) return 'UP';
  if (pUp <= 0.34 && confidence >= 55) return 'Strong DOWN';
  if (pUp <= 0.45) return 'DOWN';
  return 'Wait';
}

function buildWindowPrediction(windowDef, ind, otherInd, crossCorrelation, targetPrice, symbol, accumulator, now) {
  const { score: flatScore, contributions, weighted, maxWeightSum } = directionalScore(ind, windowDef.key);

  // Feed this cycle's weighted signal contributions through the accumulator
  // so influence builds up (and fades) over real elapsed time rather than
  // resetting fresh every refresh. Normalized by the window's max possible
  // weight sum so it stays on the same scale as the old flat score
  // regardless of how many signal families happen to be active.
  let trendScore = flatScore;
  let accumulatorOutput = null;
  if (accumulator) {
    const contributionValues = Object.values(weighted);
    accumulatorOutput = accumulator.update(contributionValues, now ?? Date.now());
    // The EMA accumulator is a convex combination of past/present weighted
    // contributions, so netDominance is already naturally bounded to
    // roughly [-maxWeightSum, +maxWeightSum] — the same scale the old flat
    // score used. This clamp is just a numerical safety margin, not a
    // rescale.
    trendScore = clamp(accumulatorOutput.netDominance, -maxWeightSum, maxWeightSum);
  }

  // Distance-to-target: important, but previously dominated short windows and
  // produced overconfident "already above strike" calls that still flipped.
  const distanceRatio = (ind.price - targetPrice) / targetPrice;
  const atrFrac = Math.max(ind.atrPct / 100, 0.0005); // guard against a near-zero ATR
  const distanceScore = clamp(distanceRatio / (atrFrac * 2), -1, 1);

  const DISTANCE_WEIGHT = { w5: 1.15, w10: 0.9, w15: 0.65 };
  const TREND_WEIGHT = { w5: 0.75, w10: 0.9, w15: 1.05 };
  const score = trendScore * TREND_WEIGHT[windowDef.key] + distanceScore * DISTANCE_WEIGHT[windowDef.key];

  if (Math.abs(distanceScore) > 0.3) {
    contributions.push({
      text: `Price is already ${Math.abs(distanceRatio * 100).toFixed(2)}% ${distanceRatio >= 0 ? 'above' : 'below'} the target`,
      weight: Math.abs(distanceScore * DISTANCE_WEIGHT[windowDef.key]),
    });
  }

  let otherAgrees = null;
  if (otherInd) {
    const { score: otherScore } = directionalScore(otherInd, windowDef.key);
    otherAgrees = Math.sign(flatScore) === Math.sign(otherScore);
  }

  const { confidence, notes, riskPoints } = computeConfidence(ind, contributions, crossCorrelation, otherAgrees, symbol);

  const pUp = logistic(score, LEAN_LOGISTIC_K);
  const pDown = 1 - pUp;

  const topReasons = contributions
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((c) => c.text);
  const riskNotes = notes.slice(0, 3);

  return {
    window: windowDef.label,
    minutes: windowDef.minutes,
    probabilityUp: +(pUp * 100).toFixed(1),
    probabilityDown: +(pDown * 100).toFixed(1),
    probabilityUpRaw: +(pUp * 100).toFixed(1),
    probabilityDownRaw: +(pDown * 100).toFixed(1),
    confidence: +confidence.toFixed(0),
    riskAdjustmentPct: +riskPoints.toFixed(0),
    recommendation: recommend(pUp, confidence),
    // Accumulated signal scores — how much bullish vs bearish evidence has
    // built up over real time for this window, with decay, plus whether
    // that lean is currently strengthening or weakening.
    signalScore: accumulatorOutput
      ? {
          upScore: +accumulatorOutput.upScore.toFixed(2),
          downScore: +accumulatorOutput.downScore.toFixed(2),
          netDominance: +accumulatorOutput.netDominance.toFixed(2),
          trend: accumulatorOutput.trend,
        }
      : null,
    explanation: topReasons.length
      ? `${topReasons.join('; ')}.${riskNotes.length ? ' Risk factors: ' + riskNotes.join('; ') + '.' : ''}`
      : 'No strong signals either direction; indicators are roughly neutral.',
  };
}

/**
 * Top-level entry point. `data` = { BTC: {series, book}, XRP: {series, book} }
 * `kalshiTargets` (optional) = { BTC: {price, closeTime, ticker}, XRP: {...} } —
 * the real strike price from Kalshi's live 15-minute market, when available.
 * `options.calibration` (optional) = tracker engine-calibration map used to
 * remap raw logistic probs toward empirical hit rates.
 * Falls back to the current price itself (a neutral distance of zero) when
 * Kalshi data isn't available, so the engine still works standalone.
 * Returns null (per product) until enough candle history has been seeded.
 */
function buildPredictions(data, kalshiTargets = {}, accumulatorManager = null, options = {}) {
  const now = Date.now();
  const calibration = options && options.calibration ? options.calibration : null;
  const indicators = {};
  for (const symbol of Object.keys(data)) {
    indicators[symbol] = gatherIndicators(data[symbol].series, data[symbol].book);
  }

  const closesBySymbol = {};
  for (const symbol of Object.keys(data)) {
    closesBySymbol[symbol] = data[symbol].series.closes();
  }
  const symbols = Object.keys(data);
  // Every altcoin's cross-check reference is BTC specifically (the natural
  // benchmark most alts move with) rather than an arbitrary "other" symbol —
  // this scales cleanly whether we're tracking 2 symbols or 7. BTC itself
  // has no reference (correlating BTC with itself is meaningless).
  const correlations = {};
  for (const symbol of symbols) {
    if (symbol === 'BTC' || !indicators['BTC'] || !indicators[symbol]) continue;
    correlations[symbol] = correlation(closesBySymbol['BTC'], closesBySymbol[symbol], 30);
  }

  const result = {};
  for (const symbol of symbols) {
    const ind = indicators[symbol];
    if (!ind) {
      result[symbol] = { ready: false, price: data[symbol].series.latestClose() };
      continue;
    }
    const other = symbol === 'BTC' ? null : 'BTC';
    const otherInd = other ? indicators[other] : null;
    const crossCorrelation = other ? correlations[symbol] : null;

    const kalshiTarget = kalshiTargets[symbol];
    const strike = kalshiTarget ? Number(kalshiTarget.price) : NaN;
    const hasKalshiStrike = Number.isFinite(strike) && strike > 0;
    const targetPrice = hasKalshiStrike ? strike : ind.price;
    const targetSource = hasKalshiStrike
      ? kalshiTarget.source === 'manual'
        ? 'manual'
        : 'kalshi'
      : 'current_price';

    // Always bind accumulators to a 15m session. Without this, sessionKey was
    // null whenever Kalshi strikes weren't injected → signal EMA never reset
    // and stale leans bled across windows (looked permanently inverted/skewed).
    const fifteenMs = 15 * 60 * 1000;
    const wallBucket = Math.floor(now / fifteenMs) * fifteenMs;
    const sessionKey =
      (kalshiTarget && kalshiTarget.ticker) ||
      (kalshiTarget && Number.isFinite(Number(kalshiTarget.closeTime))
        ? `CLOSE-${symbol}-${Number(kalshiTarget.closeTime)}`
        : null) ||
      `WALL-${symbol}-${wallBucket}`;

    const windows = {};
    for (const w of WINDOWS) {
      const accumulator = accumulatorManager ? accumulatorManager.get(symbol, w.key, sessionKey) : null;
      windows[w.key] = buildWindowPrediction(w, ind, otherInd, crossCorrelation, targetPrice, symbol, accumulator, now);
    }

    // Remap logistic probs toward historical hit rates when buckets are mature.
    if (calibration) {
      for (const w of WINDOWS) {
        applyCalibrationToWindow(windows[w.key], {
          symbol,
          windowKey: w.key,
          calibration,
        });
      }
    }

    // Multi-horizon agreement after calibration (shrink outliers, boost unanimity).
    const consensus = applyWindowConsensus(windows);

    for (const w of WINDOWS) {
      const p = windows[w.key].probabilityUp / 100;
      windows[w.key].recommendation = recommend(p, windows[w.key].confidence);
    }

    // Blended overall view across all three windows, weighted by each
    // window's own confidence (a window the engine trusts more pulls the
    // overall call toward it more). This is a summary on top of the three
    // real per-window predictions, not a replacement for them.
    const totalConfidence = WINDOWS.reduce((sum, w) => sum + windows[w.key].confidence, 0) || 1;
    const overallProbUp = WINDOWS.reduce(
      (sum, w) => sum + windows[w.key].probabilityUp * windows[w.key].confidence,
      0
    ) / totalConfidence;
    const overallConfidence = totalConfidence / WINDOWS.length;
    const overall = {
      probabilityUp: +overallProbUp.toFixed(1),
      probabilityDown: +(100 - overallProbUp).toFixed(1),
      confidence: +overallConfidence.toFixed(0),
      recommendation: recommend(overallProbUp / 100, overallConfidence),
      consensus,
    };

    result[symbol] = {
      ready: true,
      price: ind.price,
      targetPrice: +targetPrice.toFixed(ind.price > 100 ? 2 : 4),
      targetSource,
      targetCloseTime: kalshiTarget && kalshiTarget.closeTime ? kalshiTarget.closeTime : null,
      kalshiTicker: kalshiTarget && kalshiTarget.ticker ? kalshiTarget.ticker : null,
      overall,
      consensus,
      indicatorsSnapshot: {
        rsi: +ind.rsi.toFixed(1),
        macdHistogram: +ind.macd.histogram.toFixed(4),
        atrPct: +ind.atrPct.toFixed(3),
        volatilityPct: ind.volatility != null ? +ind.volatility.toFixed(3) : null,
        ema20: +ind.trend.ema20.toFixed(2),
        ema50: +ind.trend.ema50.toFixed(2),
        ema200: ind.trend.ema200 != null ? +ind.trend.ema200.toFixed(2) : null,
        trendAlignment: ind.trend.alignment,
        momentumShortPct: ind.momentumShort != null ? +ind.momentumShort.toFixed(3) : null,
        volumeSpikeRatio: ind.volumeSpike ? +ind.volumeSpike.ratio.toFixed(2) : null,
        orderBookImbalance: ind.imbalance ? +ind.imbalance.ratio.toFixed(3) : null,
        spreadPct: ind.spread ? +ind.spread.percent.toFixed(4) : null,
        liquidity: ind.liquidity != null ? +ind.liquidity.toFixed(3) : null,
        candlePattern: ind.pattern.label,
      },
      windows,
    };
  }

  // Per-symbol correlation vs BTC, as a percentage (0-100 scale, matching
  // the old single `correlation` field's convention).
  result.correlations = Object.fromEntries(
    Object.entries(correlations)
      .filter(([, v]) => v != null)
      .map(([sym, v]) => [sym, +(v * 100).toFixed(1)])
  );
  // Backward-compatible single field: BTC/XRP correlation specifically, if
  // both are being tracked (this is what earlier dashboard versions read).
  result.correlation = result.correlations.XRP ?? null;
  result.timestamp = new Date().toISOString();
  return result;
}

module.exports = {
  buildPredictions,
  WINDOWS,
  // Exported so the backtester can replay the *exact* same scoring logic
  // against historical candles rather than re-implementing it separately.
  gatherIndicators,
  directionalScore,
  buildWindowPrediction,
  computeConfidence,
  logistic,
  LEAN_LOGISTIC_K,
};
