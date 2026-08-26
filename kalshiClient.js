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

/**
 * Thin REST client for Kalshi's trading API.
 *
 * IMPORTANT: Kalshi's API surface (base URL, field names, endpoint paths)
 * has shifted between doc revisions in the past. Before relying on this in
 * production, cross-check every endpoint/field used below against the
 * current official reference at https://docs.kalshi.com and its
 * openapi.yaml — this file is written to be easy to patch if something
 * has moved.
 *
 * Auth: every private request is signed with RSA-PSS (SHA-256) over
 * `${timestampMs}${METHOD}${path}` (path only, no query string), using a
 * private key you generate yourself. Kalshi never sees the private key —
 * only the signature. Public market-data endpoints (GET /markets, GET
 * .../orderbook) do not require auth.
 */
class KalshiClient {
  constructor({ baseUrl, keyId, privateKeyPath, privateKeyPem }) {
    this.baseUrl = (baseUrl || 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/+$/, '');
    this.keyId = keyId || null;
    this.privateKey = privateKeyPem || (privateKeyPath && fs.existsSync(privateKeyPath)
      ? fs.readFileSync(privateKeyPath, 'utf8')
      : null);
    this._openMarketsCache = new Map();
    this._openMarketsInflight = new Map();
    this._marketByTickerCache = new Map();
    this._marketByTickerInflight = new Map();
    this._publicGate = Promise.resolve();
    this._lastPublicAt = 0;
    this._cooldownUntil = 0;
    this._429Streak = 0;
    this._429LogAt = 0;
    this._last429At = 0;
    // Basic-tier defaults at ~85% headroom (200 read / 100 write).
    this._readBudget = createTokenBucket(170, 340);
    this._writeBudget = createTokenBucket(85, 85);
    this._defaultTokenCost = DEFAULT_TOKEN_COST;
    this._limitsSyncedAt = 0;
    this._usageTier = 'basic';
  }

  /**
   * Apply live limits from GET /account/limits (or manual override).
   * Uses ~85% of refill/capacity so we stay under Kalshi's ceiling.
   */
  applyAccountLimits(limits = {}) {
    const read = limits.read || {};
    const write = limits.write || {};
    const readRate = Number(read.refill_rate);
    const readCap = Number(read.bucket_capacity);
    const writeRate = Number(write.refill_rate);
    const writeCap = Number(write.bucket_capacity);
    const headroom = 0.85;
    if (Number.isFinite(readRate) && readRate > 0) {
      const cap = Number.isFinite(readCap) && readCap > 0 ? readCap : readRate * 2;
      this._readBudget = createTokenBucket(readRate * headroom, cap * headroom);
    }
    if (Number.isFinite(writeRate) && writeRate > 0) {
      const cap = Number.isFinite(writeCap) && writeCap > 0 ? writeCap : writeRate;
      this._writeBudget = createTokenBucket(writeRate * headroom, cap * headroom);
    }
    if (limits.usage_tier) this._usageTier = String(limits.usage_tier);
    this._limitsSyncedAt = Date.now();
  }

  /** Fetch GET /account/limits and tune local buckets (authenticated). */
  async syncAccountLimits({ force = false } = {}) {
    if (!this.hasCredentials) return null;
    if (!force && this._limitsSyncedAt && Date.now() - this._limitsSyncedAt < 10 * 60_000) {
      return { usage_tier: this._usageTier, cached: true };
    }
    try {
      const data = await this._request('GET', '/account/limits', { auth: true });
      this.applyAccountLimits(data || {});
      return data;
    } catch (err) {
      console.warn('[kalshi] syncAccountLimits failed:', err && err.message ? err.message : err);
      return null;
    }
  }

  _isWriteMethod(method) {
    const m = String(method || '').toUpperCase();
    return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
  }

  async _acquireBudget(method, opts = {}) {
    if (opts.skipBudget) return;
    const cost = Math.max(1, Number(opts.tokenCost) || this._defaultTokenCost);
    const bucket = this._isWriteMethod(method) ? this._writeBudget : this._readBudget;
    await bucket.take(cost);
  }

  /** Use signed market GETs when credentials are available — account read bucket
   *  (170 req/s at basic tier) does not share the public IP pool that 429s. */
  _preferMarketAuth() {
    return this.hasCredentials;
  }

  getCachedMarket(ticker, maxAgeMs = Infinity) {
    const key = String(ticker || '');
    if (!key || !this._marketByTickerCache) return null;
    const hit = this._marketByTickerCache.get(key);
    if (!hit || !hit.market) return null;
    const age = Date.now() - Number(hit.at || 0);
    if (Number.isFinite(maxAgeMs) && age > maxAgeMs) return null;
    return hit.market;
  }

  get hasCredentials() {
    return !!(this.keyId && this.privateKey);
  }

  /**
   * Update credentials at runtime (e.g. from a dashboard input) instead of
   * only at construction time. Never logs or echoes the private key back —
   * callers should only ever report hasCredentials, not the key itself.
   */
  setCredentials({ keyId, privateKeyPem }) {
    if (keyId) this.keyId = keyId;
    if (privateKeyPem) this.privateKey = privateKeyPem;
  }

  _sign(method, path) {
    const timestamp = Date.now().toString();
    // Kalshi signs the full URL pathname, including /trade-api/v2.
    const apiPrefix = new URL(this.baseUrl).pathname.replace(/\/$/, '');
    const message = `${timestamp}${method.toUpperCase()}${apiPrefix}${path}`;
    const signature = crypto.sign('sha256', Buffer.from(message), {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return {
      'KALSHI-ACCESS-KEY': this.keyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    };
  }

  async _request(method, path, opts = {}) {
    const { query, body, auth = true } = opts;
    await this._acquireBudget(method, opts);
    const qs = query
      ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString()
      : '';
    const url = `${this.baseUrl}${path}${qs}`;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'crypto-prediction-engine',
      Accept: 'application/json',
    };
    if (auth) {
      if (!this.hasCredentials) throw new Error('Kalshi credentials not configured for an authenticated request');
      Object.assign(headers, this._sign(method, path));
    }
    const maxAttempts = opts.retryOn429 === false ? 1 : 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (res.status === 429) {
        this._noteRateLimit();
        lastErr = new Error(`Kalshi API ${method} ${path} -> HTTP 429: ${JSON.stringify(json)}`);
        lastErr.status = 429;
        lastErr.body = json;
        // Docs: no Retry-After; bucket keeps refilling. Wait ~one default cost at our write/read rate.
        const bucket = this._isWriteMethod(method) ? this._writeBudget : this._readBudget;
        const cost = Math.max(1, Number(opts.tokenCost) || this._defaultTokenCost);
        const waitMs = Math.min(2000, Math.ceil((cost / Math.max(1, bucket.refillPerSec)) * 1000) * attempt + 50);
        await sleep(waitMs);
        // Re-acquire so we don't stampede the empty bucket.
        await this._acquireBudget(method, opts);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`Kalshi API ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }
      // Auth successes (balance, orders) must not reset public-market 429 backoff.
      const isPublicMarket = !auth && String(path).startsWith('/markets');
      if (isPublicMarket) this._clearRateLimitStreak();
      return json;
    }
    throw lastErr || new Error(`Kalshi API ${method} ${path} -> HTTP 429`);
  }

  // ---------- public market data (no auth needed) ----------

  _maybeDecay429Streak() {
    const streak = Number(this._429Streak) || 0;
    const last = Number(this._last429At) || 0;
    if (streak > 0 && last > 0 && Date.now() - last > 45_000) {
      this._429Streak = 0;
    }
  }

  _noteRateLimit() {
    // Prefer cache; public IP bucket refills slowly — don't sit out for minutes.
    this._429Streak = Math.min(8, (Number(this._429Streak) || 0) + 1);
    this._last429At = Date.now();
    const streak = this._429Streak;
    // Persistent throttle: Kalshi is blocking this IP — back off much longer
    // instead of hammering every 20s and staying rate-limited indefinitely.
    const backoffMs = streak >= PUBLIC_429_PERSISTENT_STREAK
      ? PUBLIC_429_PERSISTENT_BACKOFF_MS
      : Math.min(PUBLIC_429_BACKOFF_MAX_MS, PUBLIC_429_BACKOFF_BASE_MS * Math.pow(1.25, streak - 1));
    this._cooldownUntil = Math.max(this._cooldownUntil || 0, Date.now() + backoffMs);
    if (Date.now() - this._429LogAt > 10_000) {
      this._429LogAt = Date.now();
      console.warn(
        `[kalshi] rate limited (429) — cache-only ${Math.round(backoffMs / 1000)}s, then retry` +
        (streak >= PUBLIC_429_PERSISTENT_STREAK ? ` (persistent streak ${streak} — backing off)` : '')
      );
    }
  }

  _clearRateLimitStreak() {
    this._429Streak = 0;
  }

  publicRateLimitRemainingMs() {
    if (this._preferMarketAuth()) return 0; // auth uses account bucket — not public IP limited
    this._maybeDecay429Streak();
    const rem = Number(this._cooldownUntil) - Date.now();
    if (rem > 0) return rem;
    const streak = Number(this._429Streak) || 0;
    const last = Number(this._last429At) || 0;
    if (streak >= 2 && last > 0) {
      const quietRem = PUBLIC_QUIET_AFTER_429_MS - (Date.now() - last);
      if (quietRem > 0) return quietRem;
    }
    return 0;
  }

  async _withPublicGate(fn) {
    const useAuth = this._preferMarketAuth();
    const run = this._publicGate.then(async () => {
      // Authenticated requests use the account token bucket — skip public IP cooldown/spacing.
      if (!useAuth) {
        const cooldownWait = Math.max(0, this._cooldownUntil - Date.now());
        const spacingWait = Math.max(0, this._lastPublicAt + UNAUTH_PUBLIC_SPACING_MS - Date.now());
        const wait = Math.max(cooldownWait, spacingWait);
        if (wait > 0) await sleep(wait);
        this._lastPublicAt = Date.now();
      }
      return fn();
    });
    this._publicGate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async _listOpenMarketsUncached(seriesTicker, limit) {
    const useAuth = this._preferMarketAuth();
    const fetchList = async (query) => {
      const data = await this._request('GET', '/markets', {
        query: { series_ticker: seriesTicker, limit, ...query },
        auth: useAuth,
        retryOn429: false,
      });
      return (data.markets || []).map(normalizeMarketPrices);
    };
    const usable = (list) =>
      (Array.isArray(list) ? list : []).filter((m) => {
        const s = String(m.status || '').toLowerCase();
        return !s || s === 'open' || s === 'active' || s === 'initialized' || s === 'unopened';
      });

    // One list GET per refresh — the old open-then-min_close_ts double-fetch was 429 fuel.
    return usable(
      await fetchList({
        status: 'open',
        min_close_ts: Math.floor(Date.now() / 1000),
      })
    );
  }

  async getOpenMarkets(seriesTicker, limit = 20) {
    if (!this._openMarketsCache) this._openMarketsCache = new Map();
    if (!this._openMarketsInflight) this._openMarketsInflight = new Map();
    const cacheKey = String(seriesTicker || '');
    const now = Date.now();
    const cached = this._openMarketsCache.get(cacheKey);
    // Public-IP 429 cooldown only applies to unauthenticated requests.
    const useAuth = this._preferMarketAuth();
    const limited = !useAuth && now < this._cooldownUntil;
    // Empty lists go stale fast — a real rollover must not look "rolling over" for 12s+.
    // During 429 cooldown, serve a non-empty list up to 60s so entries don't freeze on BTC.
    if (cached) {
      const n = Array.isArray(cached.markets) ? cached.markets.length : 0;
      let ttl = n > 0 ? OPEN_MARKETS_CACHE_MS : 1_500;
      if (limited && n > 0) ttl = OPEN_MARKETS_CACHE_LIMITED_MS;
      if (now - cached.at < ttl) return cached.markets;
    }

    const inflight = this._openMarketsInflight.get(cacheKey);
    if (inflight) return inflight;

    if (limited) {
      if (cached) return cached.markets;
      return [];
    }

    const work = this._withPublicGate(async () => {
      try {
        if (!useAuth && Date.now() < this._cooldownUntil) {
          const again = this._openMarketsCache.get(cacheKey);
          return again ? again.markets : [];
        }
        const markets = await this._listOpenMarketsUncached(seriesTicker, limit);
        this._openMarketsCache.set(cacheKey, { at: Date.now(), markets });
        // Only seed ticker cache when list rows include a real two-sided quote.
        // Incomplete list rows previously poisoned getMarket's 8s cache.
        if (!this._marketByTickerCache) this._marketByTickerCache = new Map();
        const stamped = Date.now();
        for (const m of markets) {
          if (m && m.ticker && marketHasUsableTwoSidedQuote(m)) {
            this._marketByTickerCache.set(String(m.ticker), { at: stamped, market: m });
          }
        }
        return markets;
      } catch (err) {
        if (err && err.status === 429) {
          this._noteRateLimit();
          if (cached) return cached.markets;
          return [];
        }
        if (cached && now - cached.at < 60_000) return cached.markets;
        console.warn(`[kalshi] getOpenMarkets ${seriesTicker}:`, err && err.message ? err.message : err);
        return cached ? cached.markets : [];
      } finally {
        this._openMarketsInflight.delete(cacheKey);
      }
    });

    this._openMarketsInflight.set(cacheKey, work);
    return work;
  }

  /** Drop cached series list so the next getOpenMarkets hits the network. */
  invalidateOpenMarkets(seriesTicker) {
    if (!this._openMarketsCache) return;
    this._openMarketsCache.delete(String(seriesTicker || ''));
  }

  isPublicRateLimited() {
    return this.publicRateLimitRemainingMs() > 0;
  }

  /**
   * Current tradeable 15m market for a series (soonest close still live).
   * Bust+retry once on miss — but not while rate-limited (cache already empty/useless).
   */
  async getLiveOpenMarket(seriesTicker, { minMsLeft = 1500, limit = 20 } = {}) {
    const pickFrom = (markets, floorMs) => {
      const nowMs = Date.now();
      const live = (Array.isArray(markets) ? markets : [])
        .map((m) => ({ m, closeMs: parseMarketCloseMs(m) }))
        .filter(({ closeMs }) => Number.isFinite(closeMs) && closeMs > nowMs + floorMs);
      if (!live.length) return null;
      live.sort((a, b) => a.closeMs - b.closeMs);
      return live[0].m;
    };
    const attempt = async (force) => {
      if (force) this.invalidateOpenMarkets(seriesTicker);
      const markets = await this.getOpenMarkets(seriesTicker, limit);
      return pickFrom(markets, minMsLeft) || pickFrom(markets, 0);
    };
    const first = await attempt(false);
    if (first) return first;
    // Cache-bust retry on miss when not rate-limited — stale list from the old
    // session would otherwise block entry for one or more full compute ticks.
    if (!this.isPublicRateLimited()) {
      return (await attempt(true)) || null;
    }
    return null;
  }

  async getMarket(ticker) {
    const key = String(ticker || '');
    if (!key) return null;
    if (!this._marketByTickerCache) this._marketByTickerCache = new Map();
    if (!this._marketByTickerInflight) this._marketByTickerInflight = new Map();
    const now = Date.now();
    const limited = now < this._cooldownUntil;
    const cached = this._marketByTickerCache.get(key);
    const cacheMaxMs = limited ? TICKER_MARKET_CACHE_LIMITED_MS : TICKER_MARKET_CACHE_MS;
    if (cached && now - cached.at < cacheMaxMs && marketHasUsableTwoSidedQuote(cached.market)) {
      return cached.market;
    }
    if (limited) {
      if (cached && cached.market) return normalizeMarketPrices(cached.market);
      return null;
    }

    const inflight = this._marketByTickerInflight.get(key);
    if (inflight) return inflight;

    const work = this._withPublicGate(async () => {
      try {
        if (Date.now() < this._cooldownUntil) {
          if (cached && cached.market) return normalizeMarketPrices(cached.market);
          return null;
        }
        const data = await this._request('GET', `/markets/${key}`, {
          auth: this._preferMarketAuth(),
          retryOn429: false,
        });
        const market = normalizeMarketPrices(data.market);
        if (marketHasUsableTwoSidedQuote(market)) {
          this._marketByTickerCache.set(key, { at: Date.now(), market });
        }
        return market;
      } catch (err) {
        if (err && err.status === 429) this._noteRateLimit();
        if (cached && cached.market) return normalizeMarketPrices(cached.market);
        if (err && err.status === 429) return null;
        throw err;
      } finally {
        this._marketByTickerInflight.delete(key);
      }
    });
    this._marketByTickerInflight.set(key, work);
    return work;
  }

  async getOrderbook(ticker) {
    return this._request('GET', `/markets/${ticker}/orderbook`, { auth: this._preferMarketAuth() });
  }

  // ---------- authenticated trading endpoints ----------

  async getBalance() {
    return this._request('GET', '/portfolio/balance');
  }

  async getPositions() {
    const data = await this._request('GET', '/portfolio/positions');
    return data.market_positions || [];
  }

  async getOrder(orderId) {
    // Get Order remains on /portfolio/orders/{id} (full Order object with fill_count_fp).
    return this._request('GET', `/portfolio/orders/${orderId}`);
  }

  /**
   * side: 'yes' | 'no'
   * action: 'buy' | 'sell'
   * priceCents: limit price in cents (1-99) on the traded outcome
   *
   * Uses Create Order V2 (POST /portfolio/events/orders). Returns a shape
   * compatible with legacy callers: `{ order: { order_id, ... } }`.
   */
  async createOrder({ ticker, side, action, count, priceCents, clientOrderId, timeInForce }) {
    const body = buildCreateOrderV2Body({
      ticker,
      side,
      action,
      count,
      priceCents,
      clientOrderId,
      timeInForce,
    });
    const data = await this._request('POST', '/portfolio/events/orders', { body });
    return normalizeCreateOrderResponse(data);
  }

  /** Sync read of last series list — no HTTP, safe during 429 cooldown. */
  peekOpenMarkets(seriesTicker, maxAgeMs = OPEN_MARKETS_CACHE_LIMITED_MS) {
    if (!this._openMarketsCache) return null;
    const cached = this._openMarketsCache.get(String(seriesTicker || ''));
    if (!cached || !Array.isArray(cached.markets)) return null;
    const age = Date.now() - Number(cached.at || 0);
    if (!(age >= 0) || age > maxAgeMs) return null;
    return cached.markets;
  }

  async cancelOrder(orderId) {
    return this._request('DELETE', `/portfolio/events/orders/${orderId}`);
  }
}

module.exports = {
  KalshiClient,
  normalizeMarketPrices,
  marketHasUsableTwoSidedQuote,
  priceInCents,
  marketStrikePrice,
  parseMarketCloseMs,
  bookSideFromLegacy,
  buildCreateOrderV2Body,
  normalizeCreateOrderResponse,
  createTokenBucket,
  DEFAULT_TOKEN_COST,
};
