'use strict';

/**
 * Pure, dependency-free technical indicator functions.
 * All functions take plain arrays of numbers (or candle objects) and
 * return either a single latest value or an array aligned to the input.
 * No indicator here invents data — every output is a deterministic
 * function of the inputs passed in.
 */

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Returns the full EMA series (same length as input, leading nulls until seeded)
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const seed = sma(values.slice(0, period), period);
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    const val = values[i] * k + prev * (1 - k);
    out[i] = val;
    prev = val;
  }
  return out;
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  // Wilder's smoothing, seeded with a simple average over the first `period` changes
  const start = closes.length - period - 1;
  for (let i = start + 1; i <= start + period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = start + period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (fastSeries[i] != null && slowSeries[i] != null) {
      macdLine.push(fastSeries[i] - slowSeries[i]);
    }
  }
  if (macdLine.length < signalPeriod) return null;
  const signalSeries = emaSeries(macdLine, signalPeriod);
  const signal = signalSeries[signalSeries.length - 1];
  const macdVal = macdLine[macdLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevSignalSeries = signalSeries[signalSeries.length - 2];
  return {
    macd: macdVal,
    signal,
    histogram: macdVal - signal,
    prevHistogram:
      prevMacd != null && prevSignalSeries != null ? prevMacd - prevSignalSeries : null,
  };
}

// candles: [{high, low, close}], oldest -> newest
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trs.push(tr);
  }
  return sma(trs, period) ?? trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
}

// Rate of change (%) between the latest close and the close `lookback` periods ago
function momentum(closes, lookback) {
  if (closes.length <= lookback) return null;
  const past = closes[closes.length - 1 - lookback];
  const now = closes[closes.length - 1];
  if (!past) return null;
  return ((now - past) / past) * 100;
}

// Standard deviation of simple returns, annualization-free (raw volatility measure)
function volatility(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const returns = [];
  const slice = closes.slice(closes.length - period - 1);
  for (let i = 1; i < slice.length; i++) {
    returns.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100; // percent
}

// Pearson correlation coefficient between two aligned return series
function correlation(closesA, closesB, period = 30) {
  const n = Math.min(closesA.length, closesB.length);
  if (n < period + 1) return null;
  const a = closesA.slice(closesA.length - period - 1);
  const b = closesB.slice(closesB.length - period - 1);
  const ra = [];
  const rb = [];
  for (let i = 1; i < a.length; i++) {
    ra.push((a[i] - a[i - 1]) / a[i - 1]);
    rb.push((b[i] - b[i - 1]) / b[i - 1]);
  }
  const meanA = ra.reduce((x, y) => x + y, 0) / ra.length;
  const meanB = rb.reduce((x, y) => x + y, 0) / rb.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < ra.length; i++) {
    const da = ra[i] - meanA;
    const db = rb[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

// Simple trend strength: normalized slope of EMA50 plus EMA alignment bonus
function trendStrength(closes) {
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  if (ema20 == null || ema50 == null) return null;
  const last = closes[closes.length - 1];

  // Slope of EMA50 over the last 10 periods, normalized by price
  const ema50Series = emaSeries(closes, 50);
  let slope = 0;
  const validSeries = ema50Series.filter((v) => v != null);
  if (validSeries.length >= 11) {
    const recent = validSeries.slice(-11);
    slope = ((recent[recent.length - 1] - recent[0]) / recent[0]) * 100;
  }

  let alignment = 0; // -2..2
  if (ema200 != null) {
    if (ema20 > ema50 && ema50 > ema200) alignment = 2;
    else if (ema20 > ema50) alignment = 1;
    else if (ema20 < ema50 && ema50 < ema200) alignment = -2;
    else if (ema20 < ema50) alignment = -1;
  } else {
    alignment = ema20 > ema50 ? 1 : ema20 < ema50 ? -1 : 0;
  }

  return {
    ema20,
    ema50,
    ema200,
    slope,
    alignment,
    priceVsEma20: ((last - ema20) / ema20) * 100,
  };
}

// Volume spike: current volume vs. rolling average volume
function volumeSpike(volumes, period = 20) {
  if (volumes.length < period + 1) return null;
  const avg = sma(volumes.slice(0, -1), period);
  const current = volumes[volumes.length - 1];
  if (!avg) return null;
  return { ratio: current / avg, average: avg, current };
}

// Very small candlestick-pattern classifier on the last 1-3 candles.
// Returns a short label and a directional lean in [-1, 1].
function candlePattern(candles) {
  if (candles.length < 3) return { label: 'insufficient data', lean: 0 };
  const [c3, c2, c1] = candles.slice(-3); // c3 oldest of the three, c1 latest
  const body = (c) => Math.abs(c.close - c.open);
  const range = (c) => Math.max(c.high - c.low, 1e-9);
  const isBull = (c) => c.close > c.open;
  const isBear = (c) => c.close < c.open;

  // Bullish engulfing
  if (isBear(c2) && isBull(c1) && c1.close >= c2.open && c1.open <= c2.close) {
    return { label: 'bullish engulfing', lean: 0.8 };
  }
  // Bearish engulfing
  if (isBull(c2) && isBear(c1) && c1.open >= c2.close && c1.close <= c2.open) {
    return { label: 'bearish engulfing', lean: -0.8 };
  }
  // Doji (indecision)
  if (body(c1) / range(c1) < 0.1) {
    return { label: 'doji (indecision)', lean: 0 };
  }
  // Three rising / falling candles
  if (isBull(c3) && isBull(c2) && isBull(c1)) {
    return { label: 'three rising candles', lean: 0.5 };
  }
  if (isBear(c3) && isBear(c2) && isBear(c1)) {
    return { label: 'three falling candles', lean: -0.5 };
  }
  // Hammer-ish / shooting-star-ish based on wick ratio
  const lowerWick = Math.min(c1.open, c1.close) - c1.low;
  const upperWick = c1.high - Math.max(c1.open, c1.close);
  if (lowerWick > body(c1) * 2 && upperWick < body(c1)) {
    return { label: 'hammer (potential reversal up)', lean: 0.4 };
  }
  if (upperWick > body(c1) * 2 && lowerWick < body(c1)) {
    return { label: 'shooting star (potential reversal down)', lean: -0.4 };
  }
  return { label: isBull(c1) ? 'plain bullish candle' : 'plain bearish candle', lean: isBull(c1) ? 0.15 : -0.15 };
}

module.exports = {
  sma,
  ema,
  emaSeries,
  rsi,
  macd,
  atr,
  momentum,
  volatility,
  correlation,
  trendStrength,
  volumeSpike,
  candlePattern,
};
