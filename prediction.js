'use strict';

/**
 * Maintains a live order book (bids/asks) from Coinbase's level2 channel.
 * Bids and asks are stored as price -> size maps. Snapshot loads the
 * initial book; update() applies incremental l2update changes.
 */
class OrderBook {
  constructor(productId) {
    this.productId = productId;
    this.bids = new Map(); // price -> size
    this.asks = new Map();
    this.ready = false;
  }

  loadSnapshot(bidsArr, asksArr) {
    this.bids.clear();
    this.asks.clear();

    for (const [price, size] of bidsArr) {
      const s = parseFloat(size);
      if (s > 0) this.bids.set(parseFloat(price), s);
    }

    for (const [price, size] of asksArr) {
      const s = parseFloat(size);
      if (s > 0) this.asks.set(parseFloat(price), s);
    }

    this.ready = true;
  }

  applyChange(side, priceStr, sizeStr) {
    const price = parseFloat(priceStr);
    const size = parseFloat(sizeStr);
    const book = side === 'buy' ? this.bids : this.asks;

    if (size === 0) {
      book.delete(price);
    } else {
      book.set(price, size);
    }
  }

  bestBid() {
    if (this.bids.size === 0) return null;
    return Math.max(...this.bids.keys());
  }

  bestAsk() {
    if (this.asks.size === 0) return null;
    return Math.min(...this.asks.keys());
  }

  midPrice() {
    const bb = this.bestBid();
    const ba = this.bestAsk();

    if (bb == null || ba == null) return null;

    return (bb + ba) / 2;
  }

  spread() {
    const bb = this.bestBid();
    const ba = this.bestAsk();

    if (bb == null || ba == null) return null;

    return {
      absolute: ba - bb,
      percent: ((ba - bb) / ((ba + bb) / 2)) * 100,
    };
  }

  /**
   * Sums size within `depthPct` percent of the mid price on each side,
   * then reports imbalance in [-1, 1]
   * Positive = buy pressure
   * Negative = sell pressure
   */
  imbalance(depthPct = 0.5) {
    const mid = this.midPrice();
    if (mid == null) return null;

    const lowerBound = mid * (1 - depthPct / 100);
    const upperBound = mid * (1 + depthPct / 100);

    let bidVol = 0;
    for (const [price, size] of this.bids) {
      if (price >= lowerBound) bidVol += size;
    }

    let askVol = 0;
    for (const [price, size] of this.asks) {
      if (price <= upperBound) askVol += size;
    }

    const total = bidVol + askVol;

    if (total === 0) {
      return {
        ratio: 0,
        bidVolume: 0,
        askVolume: 0,
      };
    }

    return {
      ratio: (bidVol - askVol) / total,
      bidVolume: bidVol,
      askVolume: askVol,
    };
  }

  /**
   * Total resting liquidity within `depthPct`
   */
  liquidity(depthPct = 0.5) {
    const imb = this.imbalance(depthPct);
    if (!imb) return null;

    return imb.bidVolume + imb.askVolume;
  }
}

module.exports = {
  OrderBook,
};
