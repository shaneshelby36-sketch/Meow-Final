# Crypto Prediction Engine

Server-side Coinbase prediction feed + optional Kalshi trading bot, with a dashboard UI.

## Important: always-on behavior

The **Node server** (`server.js`) owns:

- Coinbase websocket + candle seeding
- Prediction recompute loop
- Kalshi bot cycles (when `KALSHI_ENABLED=true`)

Closing the browser does **not** stop trading or predictions. Keep `node server.js` running (Render Web Service, VPS systemd, etc.).

```bash
npm install
cp .env.example .env   # edit as needed
npm start
```

## Render Web Service (recommended for always-on)

Yes — use a **Web Service**, not a static site. The bot only runs while `node server.js` is alive.

### Why settings reset after restart

Dashboard settings / paper ledger / credentials are saved as files under `DATA_DIR`.

Render’s default disk is **ephemeral**: every deploy or restart wipes local files, so the bot boots with defaults again. That is expected without a Persistent Disk.

### Fix: attach a Persistent Disk

1. In the Render service → **Disks** → add a disk (e.g. 1 GB).
2. Mount path: `/var/data`
3. Environment → add:
   - `DATA_DIR=/var/data` (optional if the disk is mounted at `/var/data` — the app auto-detects that path)
   - `KALSHI_ENABLED=true` (if you want the bot on)
   - plus any Kalshi live-trading vars you need
4. Redeploy.

Settings auto-save from the dashboard (and again on every server boot) into `bot-config.json` under that data dir, so reboots keep your current edge/confidence/stake/etc.

Check `/api/health` — you want `"dataDirEphemeral": false` and `"configFileExists": true`.

Disk use: live `trade-log.json` is capped at 5000 events; the 12h ledger/tracker rotations write into `data/archive/`. Those archive files are **auto-deleted after 14 days** by default (`ARCHIVE_RETENTION_DAYS`). Set that env to `0` to keep archives forever, or another number of days if you want a different retention window. Live config, open trades, reserve, and calibration are never pruned.

### Optional: bake defaults into env

You can also set starting defaults via env (the dashboard can still override them once `DATA_DIR` persists):

- `KALSHI_SYMBOL`, `KALSHI_EDGE_THRESHOLD_PCT`, `KALSHI_MIN_CONFIDENCE`, etc. (see `bot.js` / server boot)
- Insurance mode (default skim): **20% Insurance / 40% Wallet / 40% Available** on wins; arm **$10** / floor **$6** hysteresis (`KALSHI_INSURANCE_CAP_DOLLARS`, `KALSHI_INSURANCE_FLOOR_DOLLARS`)
- Post-stop bounce default: **+6¢** (`KALSHI_STOP_RECOVERY_CENTS`)

## Dashboard windows

At most **3** browser windows: best crypto, second-best, bot. Use **Open other windows**.

## Backtests

Bot settings: **1 / 2 / 3 day** runs, plus **Auto** and **Hunt best**.

## Before putting real money in

1. Keep `KALSHI_LIVE_TRADING=false` (paper mode). Paper uses live Kalshi quotes but never places orders.
2. Run the full offline suite (paths, indicators, candles, order book, tracker, predictions, backtest, every bot exit/settle/open path):

```bash
npm test
```

3. Optional live public-API smoke (Coinbase candles + Kalshi market read — still no orders):

```bash
ONLINE=1 npm test
```

4. In the dashboard, run **1 / 2 / 3 day** backtests (and **Hunt best**) with the settings you plan to use.
5. Let paper mode run through several full 15-minute windows and confirm:
   - open trades close (settled / stop / TP) instead of carrying forever
   - countdown moves to the next window (not stuck)
   - P&L / win rate look sane
6. Only then set live env vars + confirm string, restart, and start with a tiny stake.
