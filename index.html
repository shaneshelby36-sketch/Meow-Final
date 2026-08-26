'use strict';

const fetch = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : require('node-fetch');

const CANDLE_SECONDS = 60; // 1-minute candles
const MAX_CANDLES = 300; // enough history for EMA200 + lookback

/**
 * Maintains a rolling series of 1-minute OHLCV candles for one product,
 * seeded from Coinbase's public REST candle endpoint and then kept live
 * by folding in individual trade prints from the WebSocket feed.
 */
class CandleSeries {
  constructor(productId) {
    this.productId = productId;
    this.candles = []; // oldest -> newest, each {time, open, high, low, close, volume}
  }

  async seed() {
    const end = new Date();
    const start = new Date(end.getTime() - MAX_CANDLES * CANDLE_SECONDS * 1000);
    const url = `https://api.exchange.coinbase.com/products/${this.productId}/candles?granularity=${CANDLE_SECONDS}&start=${start.toISOString()}&end=${end.toISOString()}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'crypto-prediction-engine' } });
      if (!res.ok) throw new Error(`Coinbase candles HTTP ${res.status}`);
      const raw = await res.json();
      // raw rows: [time, low, high, open, close, volume], newest first
      const rows = raw
        .slice()
        .sort((a, b) => a[0] - b[0])
        .map((r) => ({
          time: r[0] * 1000,
          low: r[1],
          high: r[2],
          open: r[3],
          close: r[4],
          volume: r[5],
        }));
      this.candles = rows.slice(-MAX_CANDLES);
      return true;
    } catch (err) {
      console.error(`[candles:${this.productId}] seed failed:`, err.message);
      return false;
    }
  }

  // Fold a live trade (price, size, timestamp ms) into the current or a new candle
  addTrade(price, size, timeMs) {
    const bucketStart = Math.floor(timeMs / (CANDLE_SECONDS * 1000)) * (CANDLE_SECONDS * 1000);
    const last = this.candles[this.candles.length - 1];

    if (last && last.time === bucketStart) {
      last.high = Math.max(last.high, price);
      last.low = Math.min(last.low, price);
      last.close = price;
      last.volume += size;
    } else if (!last || bucketStart > last.time) {
      // Starting a fresh candle. Carry the previous close forward as the open
      // if we skipped time (e.g. after a quiet period).
      const open = last ? last.close : price;
      this.candles.push({
        time: bucketStart,
        open,
        high: Math.max(open, price),
        low: Math.min(open, price),
        close: price,
        volume: size,
      });
      if (this.candles.length > MAX_CANDLES) this.candles.shift();
    }
    // Late/out-of-order trades for a bucket in the past are ignored — negligible
    // impact on indicators and keeps this path allocation-free and simple.
  }

  closes() {
    return this.candles.map((c) => c.close);
  }

  volumes() {
    return this.candles.map((c) => c.volume);
  }

  latestClose() {
    const last = this.candles[this.candles.length - 1];
    return last ? last.close : null;
  }

  ready(minLength = 210) {
    return this.candles.length >= minLength;
  }
}

module.exports = { CandleSeries, CANDLE_SECONDS };

/**
 * Fetches up to `hours` of 1-minute candles for a product, paginating
 * through Coinbase's 300-candles-per-request limit. Used only for
 * backtesting — independent of the live CandleSeries so it never touches
 * live prediction state.
 */
async function fetchHistoricalRange(productId, hours) {
  const totalMinutes = Math.round(hours * 60);
  const chunks = [];
  let end = new Date();
  let remaining = totalMinutes;

  while (remaining > 0) {
    const chunkMinutes = Math.min(remaining, MAX_CANDLES);
    const start = new Date(end.getTime() - chunkMinutes * CANDLE_SECONDS * 1000);
    const url = `https://api.exchange.coinbase.com/products/${productId}/candles?granularity=${CANDLE_SECONDS}&start=${start.toISOString()}&end=${end.toISOString()}`;
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, { headers: { 'User-Agent': 'crypto-prediction-engine-backtest' } });
    if (!res.ok) {
      if (res.status === 429) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      throw new Error(`Coinbase historical candles HTTP ${res.status}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const raw = await res.json();
    const rows = raw.map((r) => ({
      time: r[0] * 1000,
      low: r[1],
      high: r[2],
      open: r[3],
      close: r[4],
      volume: r[5],
    }));
    chunks.push(...rows);
    end = start;
    remaining -= chunkMinutes;
    // Be polite to Coinbase's public (unauthenticated, rate-limited) endpoint.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 350));
  }

  return chunks.sort((a, b) => a.time - b.time);
}

module.exports.fetchHistoricalRange = fetchHistoricalRange;
