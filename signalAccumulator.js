'use strict';

/**
 * Time-aware, exponentially decaying aggregation of independent signals.
 * A signal keeps influence between refreshes, but its influence halves after
 * the configured half-life for the prediction window.
 */
class SignalAccumulator {
  constructor(halfLifeMs) {
    this.halfLifeMs = halfLifeMs;
    this.upScore = 0;
    this.downScore = 0;
    this.lastUpdatedAt = null;
    this.previousDominance = 0;
  }

  update(contributions, now = Date.now()) {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    const elapsed = this.lastUpdatedAt == null ? 0 : Math.max(0, timestamp - this.lastUpdatedAt);
    const decay = this.lastUpdatedAt == null ? 0 : Math.exp((-Math.LN2 * elapsed) / this.halfLifeMs);

    let incomingUp = 0;
    let incomingDown = 0;
    for (const contribution of contributions) {
      const value = Number(contribution);
      if (!Number.isFinite(value)) continue;
      if (value >= 0) incomingUp += value;
      else incomingDown += -value;
    }

    // The current reading has full weight; preceding readings decay by real
    // elapsed time. The normalization keeps output on the input-score scale.
    const currentWeight = this.lastUpdatedAt == null ? 1 : 1 - decay;
    this.upScore = this.upScore * decay + incomingUp * currentWeight;
    this.downScore = this.downScore * decay + incomingDown * currentWeight;
    const netDominance = this.upScore - this.downScore;
    const change = netDominance - this.previousDominance;
    this.previousDominance = netDominance;
    this.lastUpdatedAt = timestamp;

    return {
      upScore: this.upScore,
      downScore: this.downScore,
      netDominance,
      trend: Math.abs(change) < 0.01 ? 'steady' : change > 0 ? 'strengthening' : 'weakening',
    };
  }
}

class SignalAccumulatorManager {
  constructor(halfLivesByWindow = {}) {
    this.halfLivesByWindow = halfLivesByWindow;
    this.accumulators = new Map();
  }

  get(symbol, windowKey, sessionKey = null) {
    const key = `${symbol}:${windowKey}`;
    const session = sessionKey == null || sessionKey === '' ? null : String(sessionKey);
    let slot = this.accumulators.get(key);
    // New Kalshi 15m session → fresh red/green bars vs the new strike.
    if (!slot || (session != null && slot.session !== session)) {
      const halfLifeMs = this.halfLivesByWindow[windowKey] || 2 * 60 * 1000;
      const acc = new SignalAccumulator(halfLifeMs);
      this.accumulators.set(key, { session, acc });
      return acc;
    }
    return slot.acc;
  }
}

module.exports = { SignalAccumulator, SignalAccumulatorManager };
