'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');

const FEED_URL = 'wss://ws-feed.exchange.coinbase.com';

/**
 * Subscribes to Coinbase's public WebSocket feed for the given product IDs
 * and emits normalized events: 'trade' and 'l2snapshot' / 'l2update'.
 * Reconnects automatically with backoff if the connection drops.
 */
class CoinbaseFeed extends EventEmitter {
  constructor(productIds) {
    super();
    this.productIds = productIds;
    this.ws = null;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.closedByUser = false;
  }

  connect() {
    this.closedByUser = false;
    this.ws = new WebSocket(FEED_URL);

    this.ws.on('open', () => {
      this.reconnectDelay = 1000;
      const subscribeMsg = {
        type: 'subscribe',
        product_ids: this.productIds,
        channels: ['matches', 'level2_batch', 'ticker'],
      };
      this.ws.send(JSON.stringify(subscribeMsg));
      this.emit('connected');
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this._handleMessage(msg);
    });

    this.ws.on('close', () => {
      this.emit('disconnected');
      if (!this.closedByUser) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
      // 'close' will fire right after; reconnect handled there.
    });
  }

  _scheduleReconnect() {
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'match':
      case 'last_match':
        this.emit('trade', {
          productId: msg.product_id,
          price: parseFloat(msg.price),
          size: parseFloat(msg.size),
          time: new Date(msg.time).getTime(),
          side: msg.side,
        });
        break;
      case 'snapshot':
        this.emit('l2snapshot', {
          productId: msg.product_id,
          bids: msg.bids,
          asks: msg.asks,
        });
        break;
      case 'l2update':
        this.emit('l2update', {
          productId: msg.product_id,
          changes: msg.changes, // [[side, price, size], ...]
          time: msg.time,
        });
        break;
      case 'ticker':
        this.emit('ticker', {
          productId: msg.product_id,
          price: parseFloat(msg.price),
          bestBid: parseFloat(msg.best_bid),
          bestAsk: parseFloat(msg.best_ask),
          volume24h: parseFloat(msg.volume_24h),
          time: new Date(msg.time).getTime(),
        });
        break;
      case 'error':
        this.emit('error', new Error(msg.message || 'Coinbase feed error'));
        break;
      default:
        break;
    }
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
  }
}

module.exports = { CoinbaseFeed };
