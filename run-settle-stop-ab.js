'use strict';

/**
 * A/B: settle stop 8¢ vs 20¢ with the same tight entry filters.
 *   node run-settle-stop-ab.js [hours]
 */

const { fetchHistoricalRange } = require('./candles');
const { backtestWithSettings } = require('./backtest');

const HOURS = Math.max(48, Number(process.argv[2]) || 168);
const PRODUCTS = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  XRP: 'XRP-USD',
  BNB: 'BNB-USD',
};
const START = { BTC: 65000, ETH: 3400, SOL: 160, XRP: 0.62, BNB: 580 };

function syntheticCandles(symbol, hours, seed = 7) {
  const n = Math.round(hours * 60);
  const start = Date.now() - n * 60 * 1000;
  let price = START[symbol] || 100;
  let s = seed + symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const shock = (rand() - 0.5) * 0.003 + (rand() < 0.04 ? (rand() - 0.5) * 0.012 : 0);
    const open = price;
    const close = Math.max(0.0001, open * (1 + shock));
    out.push({
      time: start + i * 60 * 1000,
      open,
      high: Math.max(open, close) * (1 + rand() * 0.0007),
      low: Math.min(open, close) * (1 - rand() * 0.0007),
      close,
      volume: 10 + rand() * 100,
    });
    price = close;
  }
  return out;
}

const FILTERS = {
  strategyMode: 'settle',
  settleTieredExits: true,
  minConfidence: 55,
  settleEntryMinCents: 85,
  settleEntryMaxCents: 92,
  settleMinMinutesToOpen: 0.5,
  settleMaxMinutesToOpen: 12,
  settleLateEntryMinutes: 3.5,
  settleLateEntryMinCents: 70,
  stakeDollars: 5,
  maxOpenPositions: 1,
  paperStartingBalanceDollars: 150,
  skimMode: 'off',
  stopRecoveryCents: 0,
  postStopSameSideCooldownMinutes: 0,
};

function fmt(cents) {
  return `${(Number(cents) || 0) >= 0 ? '+' : ''}$${((Number(cents) || 0) / 100).toFixed(2)}`;
}

function row(label, r) {
  const stops = r.stopLossExits || 0;
  const trades = r.trades || 0;
  return {
    label,
    trades,
    winRatePct: r.winRatePct,
    netPnl: fmt(r.netPnlCents),
    netPnlCents: r.netPnlCents,
    stops,
    stopRatePct: trades ? +((stops / trades) * 100).toFixed(1) : null,
    takeProfits: r.takeProfitExits || 0,
    settleStale: r.settleStaleExits || 0,
    settled: r.settledExits || 0,
  };
}

async function loadCandles() {
  const candlesBySymbol = {};
  let source = 'coinbase';
  try {
    for (const [sym, product] of Object.entries(PRODUCTS)) {
      candlesBySymbol[sym] = await fetchHistoricalRange(product, HOURS);
    }
  } catch (err) {
    source = 'synthetic';
    console.warn(`Coinbase fetch failed (${err.message}) — seeded synthetic paths.`);
    for (const sym of Object.keys(PRODUCTS)) {
      candlesBySymbol[sym] = syntheticCandles(sym, HOURS);
    }
  }
  return { candlesBySymbol, source };
}

async function main() {
  const { candlesBySymbol, source } = await loadCandles();
  const opts = { stepMinutes: 1, mode: 'AUTO', continuousSearch: true };

  console.log(`\nSettle stop A/B · ${HOURS}h · candles=${source}`);
  console.log('Filters: band 85–92, late→70, tiered exits on, conf≥55, max 1 open\n');

  const stops = [8, 12, 16, 20, 25];
  const rows = [];
  for (const settleStopLossCents of stops) {
    const r = backtestWithSettings(
      candlesBySymbol,
      { ...FILTERS, settleStopLossCents },
      opts
    );
    rows.push(row(`stop −${settleStopLossCents}¢`, r));
  }

  console.log(JSON.stringify({ hours: HOURS, candleSource: source, results: rows }, null, 2));

  const a = rows.find((r) => r.label === 'stop −8¢');
  const b = rows.find((r) => r.label === 'stop −20¢');
  if (a && b) {
    console.log('\n── 8¢ vs 20¢ ──');
    console.log(`Net PnL: ${a.netPnl} → ${b.netPnl} (Δ ${fmt(b.netPnlCents - a.netPnlCents)})`);
    console.log(
      `Stops: ${a.stops}/${a.trades} (${a.stopRatePct}%) → ${b.stops}/${b.trades} (${b.stopRatePct}%)`
    );
    console.log(
      `WR: ${a.winRatePct}% → ${b.winRatePct}% | TP/stale/settle: ${a.takeProfits}/${a.settleStale}/${a.settled} → ${b.takeProfits}/${b.settleStale}/${b.settled}`
    );
    if (b.stopRatePct != null && a.stopRatePct != null && b.stopRatePct < a.stopRatePct) {
      console.log('Verdict: wider stop cut noise stop-outs under these filters (sim marks, not live books).');
    } else if (b.netPnlCents > a.netPnlCents) {
      console.log('Verdict: wider stop improved net PnL in this sim.');
    } else {
      console.log('Verdict: wider stop did not clearly win this path — treat as directional only.');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
