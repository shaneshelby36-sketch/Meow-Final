'use strict';

/**
 * A/B settle backtest: hold+stop vs entry-tiered TP/stale exits.
 * Prefers Coinbase 1m candles; falls back to seeded synthetic paths if fetch fails.
 * Kalshi books are always synthesized from spot (no historical order books).
 *
 *   node run-settle-backtest.js [hours]
 */

const { fetchHistoricalRange } = require('./candles');
const { backtestWithSettings } = require('./backtest');

const HOURS = Math.max(24, Number(process.argv[2]) || 168); // default 7 days
const PRODUCTS = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  XRP: 'XRP-USD',
};
const START_PRICES = { BTC: 65000, ETH: 3400, SOL: 160, XRP: 0.62 };

/** Deterministic minute bars so A/B compare is apples-to-apples offline. */
function syntheticCandles(symbol, hours, seed = 42) {
  const n = Math.round(hours * 60);
  const start = Date.now() - n * 60 * 1000;
  let price = START_PRICES[symbol] || 100;
  let s = seed + symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const out = [];
  for (let i = 0; i < n; i += 1) {
    // ~crypto-ish minute vol + mild mean reversion bursts
    const shock = (rand() - 0.5) * 0.0028 + (rand() < 0.03 ? (rand() - 0.5) * 0.01 : 0);
    const open = price;
    const close = Math.max(0.0001, open * (1 + shock));
    const high = Math.max(open, close) * (1 + rand() * 0.0006);
    const low = Math.min(open, close) * (1 - rand() * 0.0006);
    out.push({
      time: start + i * 60 * 1000,
      open,
      high,
      low,
      close,
      volume: 10 + rand() * 100,
    });
    price = close;
  }
  return out;
}

const BASE = {
  strategyMode: 'settle',
  minConfidence: 55,
  settleEntryMinCents: 80,
  settleEntryMaxCents: 95,
  settleStopLossCents: 8,
  settleMinMinutesToOpen: 0.5,
  settleMaxMinutesToOpen: 12,
  stakeDollars: 5,
  maxOpenPositions: 1,
  paperStartingBalanceDollars: 150,
  skimMode: 'off',
  stopRecoveryCents: 0,
  postStopSameSideCooldownMinutes: 0,
};

function fmt(cents) {
  const n = (Number(cents) || 0) / 100;
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
}

function summarize(label, r) {
  return {
    label,
    trades: r.trades,
    winRatePct: r.winRatePct,
    netPnl: fmt(r.netPnlCents),
    netPnlCents: r.netPnlCents,
    stopLossExits: r.stopLossExits,
    takeProfitExits: r.takeProfitExits,
    settleStaleExits: r.settleStaleExits,
    settledExits: r.settledExits,
    tradesBySymbol: r.tradesBySymbol,
  };
}

async function loadCandles() {
  const candlesBySymbol = {};
  let source = 'coinbase';
  console.log(`Loading ~${HOURS}h 1m candles for ${Object.keys(PRODUCTS).join(', ')}…`);
  try {
    for (const [sym, product] of Object.entries(PRODUCTS)) {
      process.stdout.write(`  ${sym}… `);
      candlesBySymbol[sym] = await fetchHistoricalRange(product, HOURS);
      console.log(`${candlesBySymbol[sym].length} bars`);
    }
  } catch (err) {
    source = 'synthetic';
    console.warn(`\nCoinbase fetch failed (${err.message}) — using seeded synthetic paths.`);
    for (const sym of Object.keys(PRODUCTS)) {
      candlesBySymbol[sym] = syntheticCandles(sym, HOURS);
      console.log(`  ${sym}: ${candlesBySymbol[sym].length} synthetic bars`);
    }
  }
  return { candlesBySymbol, source };
}

async function main() {
  const { candlesBySymbol, source } = await loadCandles();

  const opts = { stepMinutes: 1, mode: 'AUTO', continuousSearch: true };

  console.log('\nRunning settle HOLD (stop + settle only)…');
  const hold = backtestWithSettings(
    candlesBySymbol,
    { ...BASE, settleTieredExits: false },
    opts
  );

  console.log('Running settle TIERED (TP + stale by entry)…');
  const tiered = backtestWithSettings(
    candlesBySymbol,
    { ...BASE, settleTieredExits: true },
    opts
  );

  const a = summarize('hold+stop', hold);
  const b = summarize('tiered exits', tiered);
  const delta = (tiered.netPnlCents || 0) - (hold.netPnlCents || 0);

  console.log('\n══ Settle backtest (Kalshi marks synthesized from spot) ══');
  console.log(
    JSON.stringify(
      { hours: HOURS, candleSource: source, hold: a, tiered: b, tieredMinusHold: fmt(delta) },
      null,
      2
    )
  );
  console.log('\nNote:', tiered.note);
  console.log('\nRecent tiered exits:');
  for (const t of (tiered.recentTrades || []).slice(0, 12)) {
    console.log(
      `  ${t.symbol} ${String(t.side).toUpperCase()} conf ${t.confidence} → ${t.exitReason} ${t.pnlDollars >= 0 ? '+' : ''}$${Number(t.pnlDollars).toFixed(2)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
