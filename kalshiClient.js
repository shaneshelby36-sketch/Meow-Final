'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fetch = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : require('node-fetch');

// Kalshi's current market endpoints return decimal-dollar strings such as
// "0.5600" in `yes_bid_dollars`; older responses used integer-cent fields
// such as `yes_bid`. Normalize both shapes so the trading bot always sees
// integer cents.
function priceInCents(legacyCents, dollarValue) {
  // Treat null/undefined/'' as "missing" — Number(null)===0 would wrongly
  // prefer a fake 0¢ bid over a valid dollar-string quote.
  if (legacyCents != null && legacyCents !== '') {
    const legacy = Number(legacyCents);
    if (Number.isFinite(legacy)) {
      const cents = Math.round(legacy);
      // Kalshi uses 0 for "no quote" on empty books — not a tradable 0¢.
      return cents >= 1 ? cents : null;
    }
  }
  const dollars = Number.parseFloat(dollarValue);
  if (!Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  return cents >= 1 ? cents : null;
}

function parseMarketCloseMs(market) {
  if (!market || typeof market !== 'object') return NaN;
  const closeRaw = market.close_time != null ? market.close_time : market.expected_expiration_time;
  if (closeRaw == null || closeRaw === '') return NaN;
  if (typeof closeRaw === 'number' && Number.isFinite(closeRaw)) {
    return closeRaw < 1e12 ? closeRaw * 1000 : closeRaw;
  }
  const ms = new Date(closeRaw).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Kalshi 15m crypto strike. List payloads sometimes omit `floor_strike`
 * (subtitle still has "Target Price: $63,048.28") or use cap-only `less`
 * markets. Never treat TBD / missing as 0.
 */
function marketStrikePrice(market) {
  if (!market || typeof market !== 'object') return null;
  const type = String(market.strike_type || market.strikeType || '').toLowerCase();
  const ordered =
    type === 'less' || type === 'less_or_equal'
      ? [market.cap_strike, market.capStrike, market.floor_strike, market.floorStrike]
      : [market.floor_strike, market.floorStrike, market.cap_strike, market.capStrike];
  ordered.push(market.strike_price, market.strikePrice, market.strike);
  for (const raw of ordered) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const subtitle = String(
    market.yes_sub_title || market.yesSubTitle || market.subtitle || market.title || ''
  );
  const m = subtitle.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function sizeFromFp(legacy, fpValue) {
  if (legacy != null && legacy !== '') {
    const n = Number(legacy);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const fp = Number.parseFloat(fpValue);
  return Number.isFinite(fp) && fp >= 0 ? Math.floor(fp) : null;
}

function clampQuoteCents(n) {
  if (!Number.isFinite(n)) return null;
  const c = Math.round(n);
  if (c < 1 || c > 99) return null;
  return c;
}

function normalizeMarketPrices(market) {
  if (!market) return market;
  let yes_bid = priceInCents(market.yes_bid, market.yes_bid_dollars);
  let yes_ask = priceInCents(market.yes_ask, market.yes_ask_dollars);
  let no_bid = priceInCents(market.no_bid, market.no_bid_dollars);
  let no_ask = priceInCents(market.no_ask, market.no_ask_dollars);
  const last_price = priceInCents(market.last_price, market.last_price_dollars);

  // Fill missing YES from the NO book (and vice versa). Thin 15m books often
  // publish only one side; complement keeps entries from dying as "no quote".
  if (yes_bid == null && no_ask != null) yes_bid = clampQuoteCents(100 - no_ask);
  if (yes_ask == null && no_bid != null) yes_ask = clampQuoteCents(100 - no_bid);
  if (no_bid == null && yes_ask != null) no_bid = clampQuoteCents(100 - yes_ask);
  if (no_ask == null && yes_bid != null) no_ask = clampQuoteCents(100 - yes_bid);

  // Last trade can patch a single missing side when the book is one-sided.
  if (yes_bid == null && yes_ask != null && last_price != null && last_price <= yes_ask) {
    yes_bid = last_price;
  }
  if (yes_ask == null && yes_bid != null && last_price != null && last_price >= yes_bid) {
    yes_ask = last_price;
  }
  if (yes_bid != null && yes_ask != null && yes_bid > yes_ask) {
    // Crossed after complement — prefer the tighter last/mid if available.
    if (last_price != null && last_price >= 1 && last_price <= 99) {
      yes_bid = Math.min(yes_bid, last_price);
      yes_ask = Math.max(yes_ask, last_price);
    }
  }

  return {
    ...market,
    yes_bid,
    yes_ask,
    no_bid,
    no_ask,
    last_price,
    yes_ask_size: sizeFromFp(market.yes_ask_size, market.yes_ask_size_fp),
    no_ask_size: sizeFromFp(market.no_ask_size, market.no_ask_size_fp),
    yes_bid_size: sizeFromFp(market.yes_bid_size, market.yes_bid_size_fp),
    no_bid_size: sizeFromFp(market.no_bid_size, market.no_bid_size_fp),
  };
}

/** List/ticker payloads need a real (or complemented) two-sided YES book. */
function marketHasUsableTwoSidedQuote(market) {
  if (!market || typeof market !== 'object') return false;
  const yesBid = Number(market.yes_bid);
  const yesAsk = Number(market.yes_ask);
  return (
    Number.isFinite(yesBid) &&
    Number.isFinite(yesAsk) &&
    yesBid >= 1 &&
    yesAsk <= 99 &&
    yesBid <= yesAsk
  );
}

/**
 * Map legacy (action, side) to V2 book_side.
 * bid ≡ yes exposure, ask ≡ no exposure (Kalshi single-book convention).
 */
function bookSideFromLegacy(side, action) {
  const s = String(side || '').toLowerCase();
  const a = String(action || '').toLowerCase();
  if ((a === 'buy' && s === 'yes') || (a === 'sell' && s === 'no')) return 'bid';
  if ((a === 'buy' && s === 'no') || (a === 'sell' && s === 'yes')) return 'ask';
  throw new Error(`Invalid Kalshi order direction: action=${action} side=${side}`);
}

/** Min gap between unauthenticated public GETs (IP bucket is much tighter than Basic read). */
const UNAUTH_PUBLIC_SPACING_MS = 1200;
/** After repeated 429s, stay cache-only briefly even when short cooldown expires. */
const PUBLIC_QUIET_AFTER_429_MS = 8_000;
/** Public 429 backoff — keep short so we still trade off cache, then probe again. */
const PUBLIC_429_BACKOFF_BASE_MS = 6_000;
const PUBLIC_429_BACKOFF_MAX_MS = 20_000;
/** After this many consecutive 429s without a clean response, use a longer quiet period. */
const PUBLIC_429_PERSISTENT_STREAK = 4;
const PUBLIC_429_PERSISTENT_BACKOFF_MS = 90_000;
/** Series list cache — avoid re-listing KXBTC15M / KXETH15M every 5s tick. */
const OPEN_MARKETS_CACHE_MS = 45_000;
const OPEN_MARKETS_CACHE_LIMITED_MS = 120_000;
const TICKER_MARKET_CACHE_MS = 20_000;
const TICKER_MARKET_CACHE_LIMITED_MS = 120_000;

/** Default Kalshi endpoint cost (tokens). See GET /account/endpoint_costs for overrides. */
const DEFAULT_TOKEN_COST = 10;

/**
 * Client-side token bucket matching Kalshi's rate-limit model.
 * Basic tier: Read 200 tok/s (capacity 2s), Write 100 tok/s (capacity 1s).
 * We pace at ~85% of budget so we stay under the ceiling instead of 429-retrying.
 */
function createTokenBucket(refillPerSec, capacity) {
  return {
    refillPerSec: Math.max(1, Number(refillPerSec) || 1),
    capacity: Math.max(1, Number(capacity) || 1),
    tokens: Math.max(1, Number(capacity) || 1),
    updatedAt: Date.now(),
    refill() {
      const now = Date.now();
      const elapsed = (now - this.updatedAt) / 1000;
      if (!(elapsed > 0)) return;
      this.updatedAt = now;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    },
    async take(cost) {
      const need = Math.max(1, Number(cost) || DEFAULT_TOKEN_COST);
      for (;;) {
        this.refill();
        if (this.tokens >= need) {
          this.tokens -= need;
          return;
        }
        const deficit = need - this.tokens;
        const waitMs = Math.ceil((deficit / this.refillPerSec) * 1000) + 5;
        await new Promise((r) => setTimeout(r, Math.min(Math.max(waitMs, 5), 2500)));
      }
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build Create Order V2 body (POST /portfolio/events/orders).
 *
 * V2 uses a single YES-denominated book: `bid` = buy YES, `ask` = sell YES
 * (= buy NO at 1−price). `priceCents` from callers is always the traded
 * outcome limit (YES ¢ or NO ¢). For NO outcomes we convert to the YES-leg
 * wire price (100 − noCents) — sending the raw NO ¢ as `price` never crosses.
 */
function buildCreateOrderV2Body({
  ticker,
  side,
  action,
  count,
  priceCents,
  clientOrderId,
  timeInForce = 'good_till_canceled',
}) {
  const rounded = Math.round(Number(priceCents));
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > 99) {
    throw new Error(`Invalid Kalshi limit price: ${priceCents}`);
  }
  const contracts = Math.floor(Number(count));
  if (!Number.isFinite(contracts) || contracts < 1) {
    throw new Error(`Invalid Kalshi order count: ${count}`);
  }
  const outcome = String(side || '').toLowerCase();
  const yesLegCents = outcome === 'no' ? 100 - rounded : rounded;
  if (yesLegCents < 1 || yesLegCents > 99) {
    throw new Error(`Invalid Kalshi YES-leg price from ${outcome} ${rounded}¢`);
  }
  const tif = String(timeInForce || 'good_till_canceled').toLowerCase();
  const allowedTif = new Set(['good_till_canceled', 'immediate_or_cancel', 'fill_or_kill']);
  return {
    ticker,
    side: bookSideFromLegacy(side, action),
    count: `${contracts}.00`,
    price: (yesLegCents / 100).toFixed(4),
    time_in_force: allowedTif.has(tif) ? tif : 'good_till_canceled',
    self_trade_prevention_type: 'taker_at_cross',
    client_order_id: clientOrderId || crypto.randomUUID(),
  };
}

/**
 * Accept V2 flat `{ order_id, fill_count, ... }`, legacy `{ order: { order_id } }`,
 * or occasional `{ orders: [{ order_id }] }`. Always expose a nested `order`
 * with fill fields preserved so callers can seed fill polling from create.
 */
function normalizeCreateOrderResponse(data) {
  const fromArray =
    data &&
    Array.isArray(data.orders) &&
    data.orders[0] &&
    typeof data.orders[0] === 'object'
      ? data.orders[0]
      : null;
  const orderId =
    (data && data.order_id) ||
    (data && data.orderId) ||
    (data && data.order && (data.order.order_id || data.order.orderId)) ||
    (fromArray && (fromArray.order_id || fromArray.orderId)) ||
    null;
  if (!orderId) {
    throw new Error('create order response missing order_id');
  }
  const nested =
    data && data.order && typeof data.order === 'object'
      ? { ...data.order, order_id: orderId }
      : fromArray
        ? { ...fromArray, order_id: orderId }
        : { ...(data || {}), order_id: orderId };
  // Preserve V2 immediate-fill fields on the nested order for seed polling.
  // Create Order V2 uses `fill_count`; keep `fills_count` alias for callers/tests.
  if (nested.fills_count == null) {
    const fc =
      (data && data.fills_count != null ? data.fills_count : null) ??
      (data && data.fill_count != null ? data.fill_count : null) ??
      nested.fill_count;
    if (fc != null) nested.fills_count = fc;
  }
  if (nested.fill_count == null && nested.fills_count != null) {
    nested.fill_count = nested.fills_count;
  }
  if (nested.fill_count_fp == null && data && data.fill_count_fp != null) {
    nested.fill_count_fp = data.fill_count_fp;
  }
  if (nested.remaining_count == null && data && data.remaining_count != null) {
    nested.remaining_count = data.remaining_count;
  }
  if (nested.average_fill_price == null && data && data.average_fill_price != null) {
    nested.average_fill_price = data.average_fill_price;
  }
  if (nested.average_fee_paid == null && data && data.average_fee_paid != null) {
    nested.average_fee_paid = data.average_fee_paid;
  }
  if (nested.taker_fees_dollars == null && data && data.taker_fees_dollars != null) {
    nested.taker_fees_dollars = data.taker_fees_dollars;
  }
  if (nested.maker_fees_dollars == null && data && data.maker_fees_dollars != null) {
    nested.maker_fees_dollars = data.maker_fees_dollars;
  }
  return { ...(data || {}), order: nested, order_id: orderId };
}
