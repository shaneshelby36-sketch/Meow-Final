{
  "name": "crypto-prediction-engine",
  "version": "1.2.259",
  "description": "Crypto prediction engine using Coinbase market data",
  "main": "server.js",
  "private": true,
  "scripts": {
    "start": "node server.js",
    "test": "node self-test.js"
  },
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "node-fetch": "^2.7.0",
    "ws": "^8.18.0"
  }
}
