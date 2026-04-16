# MoonBags

> Solana meme-token auto-trading bot with LLM-powered exit decisions.

MoonBags is the **execution and management layer** on top of [SCG Alpha](https://x.com/scg_alpha)'s discovery system. SCG Alpha runs the alpha-filtering brain — they curate meme-coin signals from the firehose using the GMGN API and surface the ones worth acting on. MoonBags consumes that filtered alert stream, buys via Jupiter Ultra, then manages exits with either a configurable trail/stop or — optionally — a MiniMax M2.7 LLM that reads live on-chain data (smart money flow, dev holdings, holder PnL, kline trends) every 30 seconds to decide when to sell.

In other words: **SCG Alpha picks the trades. MoonBags fires them, sizes them, watches them, and exits them.**

You operate the bot through a Telegram bot (`/start`, `/positions`, `/settings`, `/sellall`, etc.) or a local web dashboard.

---

## ⚠️ Disclaimers

**Not financial advice.** This software is released for educational and research purposes. Using it to trade real money is your decision and your risk alone. Meme coins are extremely volatile — **you will have losing trades, and you can lose your entire wallet balance**. Nothing in this repo, the dashboard, the Telegram bot, or the LLM advisor's output constitutes investment, legal, tax, or any other kind of professional advice. Do your own research.

**Critical upstream dependency — SCG Alpha (+ GMGN).** MoonBags does not discover trades on its own. The **entire signal layer is SCG Alpha's** ([@scg_alpha on X](https://x.com/scg_alpha)) — they run an alpha-filtering system on top of the [GMGN API](https://docs.gmgn.cc/) and feed the curated alerts into the public endpoint this bot polls. **I do not own, operate, or control SCG Alpha or GMGN** — all credit for signal quality goes to them. If either changes their API shape, rate-limits you, changes pricing, or shuts down, the bot's intake stops working until the code (or the upstream provider) is updated. You're also subject to whatever terms of service SCG Alpha and GMGN impose — please review them. If you want a different upstream, replace `src/scgPoller.ts` with your own integration; the rest of the bot is signal-source agnostic.

Other third-party services the bot depends on (any of which can break the bot if they change): **Jupiter Ultra** (swap execution + fees), **Helius RPC** (Solana reads), **OKX onchainos CLI** (on-chain data enrichment), **MiniMax** (LLM advisor, optional), **Telegram Bot API** (control + notifications).

Use at your own risk.

---

## Table of contents

1. [Where the trades come from — the discovery layer](#where-the-trades-come-from--the-discovery-layer)
2. [What it does](#what-it-does)
3. [Architecture at a glance](#architecture-at-a-glance)
4. [Prerequisites](#prerequisites)
5. [Quick start — the setup wizard (recommended)](#quick-start--the-setup-wizard-recommended)
6. [Manual setup (reference)](#manual-setup-reference)
   - [1. Solana wallet](#1-solana-wallet)
   - [2. Helius RPC](#2-helius-rpc)
   - [3. Jupiter API key](#3-jupiter-api-key)
   - [4. OKX onchainos CLI](#4-okx-onchainos-cli)
   - [5. Telegram bot](#5-telegram-bot)
   - [6. MiniMax (optional)](#6-minimax-optional--llm-advisor)
7. [Environment variables reference](#environment-variables-reference)
8. [Running the bot](#running-the-bot)
9. [Telegram commands](#telegram-commands)
10. [LLM exit advisor](#llm-exit-advisor)
11. [Milestone alerts](#milestone-alerts)
12. [Web dashboard](#web-dashboard)
13. [State files](#state-files)
14. [Operating day-to-day](#operating-day-to-day)
15. [Backtesting](#backtesting)
16. [Troubleshooting](#troubleshooting)
17. [Safety notes](#safety-notes)

---

## Where the trades come from — the discovery layer

The hardest part of meme-coin trading isn't execution — it's *discovery*. Out of the thousands of tokens minted on Solana every day, which ~10 are worth your SOL?

**That problem is fully solved upstream by [SCG Alpha](https://x.com/scg_alpha).** They run an alpha-filtering system that:

- Pulls a constant firehose of new mints, smart-money flow, holder data, and on-chain signals via the **[GMGN API](https://docs.gmgn.cc/)**
- Applies their own scoring + filtering logic (the secret sauce — that's their product, not mine)
- Surfaces only the alerts that pass their criteria via a public-facing alerts API

**MoonBags is downstream of that.** This bot does NOT decide which tokens are worth trading. It receives the already-curated alert stream from SCG Alpha and acts on it. Without SCG Alpha there is no MoonBags — the entire upstream "what should I buy?" question is theirs to answer.

If you want to see the signal quality firsthand, follow [@scg_alpha](https://x.com/scg_alpha). If you want to swap in your own discovery source, replace `src/scgPoller.ts` with your own integration — every other layer in this bot is signal-source agnostic.

---

## What it does

1. **Receives** filtered alerts from SCG Alpha's API every 3 seconds — these are pre-vetted by their alpha-filtering system on top of GMGN.
2. **Buys** new alerts that pass your local filters via Jupiter Ultra (Solana DEX aggregator), spending a fixed SOL amount per trade.
3. **Tracks** every open position every 3 seconds — pulls live prices, updates the running peak, and checks for arm/trail/stop conditions.
4. **Arms** a trailing stop once a position hits a profit threshold (default +50%).
5. **Exits** based on either:
   - **Static trail/stop logic** (default) — sells when price drops X% from the peak after arming, or hits the hard stop.
   - **LLM advisor** (optional) — every 30s after arming, sends an on-chain snapshot to MiniMax M2.7 which decides `hold` / `tighten_trail` / `exit_now` based on smart money flow, dev wallet activity, holder PnL, momentum, etc.
6. **Notifies** every buy, arm, sell, and LLM decision to your Telegram chat.
7. **Milestone alerts** — when a position crosses a PnL threshold you configured (default +100%, +200%, +500%, +1000%), fires a Telegram message with a one-tap sell button.
8. **Persists** all state to disk so a restart picks up where it left off.

---

## Architecture at a glance

```
        ┌──────────────────────────────────────────┐
        │   UPSTREAM — discovery / alpha source    │
        │   (NOT part of this repo, NOT mine)      │
        ├──────────────────────────────────────────┤
        │                                          │
        │     ┌──────────┐         ┌────────────┐  │
        │     │   GMGN   │ ──────▶ │ SCG Alpha  │  │
        │     │   API    │  signals│  filtering │  │
        │     │          │  + data │   engine   │  │
        │     └──────────┘         └─────┬──────┘  │
        │                                │ alerts  │
        └────────────────────────────────┼─────────┘
                                         │
                            poll every 3s ▼
   +-------------+   +-------------------+   +----------------+
   |   Jupiter   |<--+      MoonBags     +-->|   Solana RPC   |
   |  Ultra API  |   |  (this repo, the  |   |    (Helius)    |
   |  + 0.5% ref |   |   execution layer)|   +----------------+
   +-------------+   +-+-----------+-----+
                       |     |     |
       buy/sell swaps  |     |     |  on-chain data: smart money,
                       |     |     |  dev trades, holder PnL, klines
                       |     |     ▼
                       |     |   +----------------+
                       |     |   |  OKX onchainos |
                       |     |   |      CLI       |
                       |     |   +----------------+
                       |     |
                       |     ▼
                       |   +----------------+
                       |   |  MiniMax M2.7  |   (optional —
                       |   |  exit advisor  |    set LLM_EXIT_ENABLED=true)
                       |   +----------------+
                       ▼
                  +----------------+
                  |    Telegram    |   ← you control + receive alerts here
                  |  bot + alerts  |
                  +----------------+
```

---

## Prerequisites

- **macOS or Linux** (Windows untested)
- **Node.js 20+** ([install via nvm](https://github.com/nvm-sh/nvm))
- **A funded Solana wallet** (for live trading) — needs SOL for both trades and gas
- **Accounts for:** Helius, Jupiter, SCG Alpha, Telegram, OKX (free), and optionally MiniMax (paid)

---

## Quick start — the setup wizard (recommended)

There's an interactive CLI wizard that walks you through every credential, validates the services it can check live, **auto-detects your Telegram chat_id**, and can generate a fresh Solana keypair for you. It's the fastest path from `git clone` to a running bot.

```bash
# 1. Clone and install
git clone <your-fork-url> moonbags
cd moonbags
npm install

# 2. Install the OKX onchainos CLI (provides on-chain data)
npm install -g onchainos

# 3. Run the wizard
npm run setup
```

The wizard walks through:

| Step | What it does |
|------|--------------|
| 1 | Checks that the `onchainos` CLI is on `$PATH` |
| 2 | OKX OnchainOS credentials — links to the dev portal and stores API key, secret key, and passphrase |
| 3 | Jupiter API key — with link + live validation |
| 4 | Helius RPC key — with link + live validation |
| 5 | Solana wallet — offers to **generate a fresh keypair** (saves to `moonbags-keypair.json`) or accept a pasted base58 secret |
| 6 | Telegram bot token — verifies via `getMe`, then **auto-detects your chat_id** after you message the bot once |
| 7 | MiniMax API key (optional) + LLM advisor on/off toggle |
| 8 | Trading params — backtest-optimized defaults (BUY 0.02 SOL, arm +50%, trail 55%, stop -40%), editable |
| 9 | Writes `.env` (backs up existing one first) |

The wizard never writes anything until the final confirmation step, and any existing `.env` is backed up to `.env.backup.<timestamp>` before it's touched.

After the wizard finishes:

```bash
# Start the bot
npx tsx src/main.ts

# Open the dashboard
open http://localhost:8787/

# Control from Telegram — message your bot with:
/start
```

---

## Manual setup (reference)

> The wizard covers everything below. This section exists for people who want to understand what each credential does, or who need to configure something without running the wizard.

### 1. Solana wallet

You need a Solana keypair the bot can sign with. **Use a fresh wallet — don't use a wallet that holds anything important.** This wallet should hold only the SOL you're willing to deploy.

**Option A — generate one with the Solana CLI:**

```bash
solana-keygen new -o moonbags-keypair.json
```

Then convert to base58 (Phantom/Solflare format):

```bash
node -e "console.log(require('bs58').encode(Buffer.from(require('fs').readFileSync('moonbags-keypair.json','utf-8').match(/\d+/g).map(Number))))"
```

**Option B — export from Phantom/Solflare** as a base58 secret key.

Put the base58 string into `.env` as `PRIV_B58=...`.

**Fund the wallet:** transfer at least 0.5 SOL to the address. Each trade uses `BUY_SIZE_SOL` plus ~0.0005 SOL in fees.

### 2. Helius RPC

Solana's public RPC is rate-limited. You need a private endpoint.

1. Sign up at [dashboard.helius.dev](https://dashboard.helius.dev) (free tier works).
2. Copy your API key.
3. Set in `.env`:
   ```
   HELIUS_API_KEY=your-key-here
   ```

### 3. Jupiter API key

Jupiter Ultra provides the swap routing. The free tier is sufficient.

1. Get a key at [developers.jup.ag/portal](https://developers.jup.ag/portal).
2. Set in `.env`:
   ```
   JUP_API_KEY=jup_xxxxxxxxxxxxxxx
   ```

### 4. OKX OnchainOS

This is a **compiled Rust binary** (npm package) that wraps OKX's on-chain data API. It's used by both the price feed and the LLM advisor for smart-money trades, dev wallet activity, holder PnL, and kline data.

```bash
npm install -g onchainos
```

Verify it works:

```bash
onchainos --version
onchainos market price --address So11111111111111111111111111111111111111112 --chain solana
```

Then create OnchainOS API credentials at [web3.okx.com/onchain-os/dev-portal](https://web3.okx.com/onchain-os/dev-portal). Use a read-only key and save the passphrase you set during creation.

Set in `.env`:

```env
OKX_API_KEY=your-okx-api-key
OKX_SECRET_KEY=your-okx-secret-key
OKX_PASSPHRASE=your-okx-passphrase
```

The `onchainos` CLI expects `OKX_PASSPHRASE`. The bot also accepts the older local alias `OKX_API_PASSPHRASE` and passes it through as `OKX_PASSPHRASE` when spawning the CLI. It's IPv4-only.

### 5. Telegram bot

This is how you'll interact with MoonBags.

1. **Create a bot:** message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow prompts. Save the bot token.
2. **Get your chat ID:** message your new bot once (any text), then visit:
   ```
   https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
   ```
   Find `"chat":{"id":XXXXXXX}` in the JSON. That's your chat ID.
3. **Set in `.env`:**
   ```
   TELEGRAM_BOT_TOKEN=8775xxxxxxx:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TELEGRAM_CHAT_ID=518183629
   ```

The bot is **gated to your chat ID only** — random users who find it can't talk to it.

### 6. MiniMax (optional — LLM advisor)

If you want the LLM to manage exit decisions for armed positions:

1. Subscribe to a MiniMax Token Plan using the **referral link below for 10% off**:

   👉 **[https://platform.minimax.io/subscribe/token-plan?code=K0Q2oDUiwK&source=link](https://platform.minimax.io/subscribe/token-plan?code=K0Q2oDUiwK&source=link)**

   Starter plan (1500 M2.7 requests / 5h) is plenty for ~6 simultaneous armed positions.
2. Get your **Token Plan API Key** from [platform.minimax.io/user-center/payment/token-plan](https://platform.minimax.io/user-center/payment/token-plan).
3. Set in `.env`:
   ```
   MINIMAX_API_KEY=your-token-plan-key
   LLM_EXIT_ENABLED=true
   ```

You can leave `LLM_EXIT_ENABLED=false` and toggle it later from Telegram with `/llm`.

---

## Environment variables reference

Create `.env` in the project root with these values:

```env
# === REQUIRED ===
JUP_API_KEY=jup_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HELIUS_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
OKX_API_KEY=your-okx-api-key
OKX_SECRET_KEY=your-okx-secret-key
OKX_PASSPHRASE=your-okx-passphrase
PRIV_B58=base58-encoded-solana-keypair-secret

# === RPC ===
RPC_URL=https://beta.helius-rpc.com?api-key=${HELIUS_API_KEY}

# === TRADING PARAMS ===
BUY_SIZE_SOL=0.02              # SOL per trade
MAX_CONCURRENT_POSITIONS=10    # max open positions

# Trailing stop (decimals, NOT %)
ARM_PCT=0.5                    # arm trailing once PnL >= +50%
TRAIL_PCT=0.55                 # exit if drawdown from peak >= 55% (backtest-optimum)
STOP_PCT=0.4                   # hard stop if PnL <= -40%
MAX_HOLD_SECS=99999999999999   # time-based exit (effectively disabled)

# Optional moonbag (only used when LLM is OFF)
MOONBAG_PCT=0                  # fraction to keep as a runner after trail (0 = disabled)
MB_TRAIL_PCT=0.6               # moonbag's own trail
MB_TIMEOUT_SECS=7200           # moonbag max hold

# === ALERT FILTERS (0 = disabled) ===
MAX_ALERT_AGE_MINS=0
MIN_LIQUIDITY_USD=0
MIN_SCORE=0
MAX_RUG_RATIO=0
MAX_BUNDLER_PCT=0
MAX_TOP10_PCT=0
REQUIRE_RISING_LIQ=false

# === POLLING ===
SCG_POLL_MS=3000               # how often to poll SCG for new alerts
PRICE_POLL_MS=3000             # how often to update prices for open positions

# === EXECUTION ===
SLIPPAGE_BPS=2500              # fallback slippage for non-Ultra quotes
DRY_RUN=true                   # FALSE to enable real trades

# === DASHBOARD ===
DASHBOARD_PORT=8787            # localhost-only web dashboard

# === TELEGRAM ===
TELEGRAM_BOT_TOKEN=8775xxxxxxx:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=518183629

# === LLM EXIT ADVISOR ===
LLM_EXIT_ENABLED=false         # true to let MiniMax manage exits
MINIMAX_API_KEY=               # required when LLM_EXIT_ENABLED=true

# === MILESTONE ALERTS ===
# Send a Telegram notification (with inline sell button) the first time a
# position crosses each PnL threshold. Edit live via /settings, no restart.
MILESTONES_ENABLED=true
MILESTONE_PCTS=100,200,500,1000  # comma-separated % thresholds (2x/3x/6x/11x)
```

**Security note:** `.env` should never be committed. Add it to `.gitignore` (already present in this repo).

---

## Running the bot

### Dev mode (recommended for first run)

```bash
DRY_RUN=true npx tsx src/main.ts
```

In dry-run, the bot fetches alerts and prices but **does not submit any swap transactions**. Watch the logs to verify everything is wired correctly.

### Live trading

1. Set `DRY_RUN=false` in `.env`.
2. Make sure your wallet has enough SOL (at least 10× your `BUY_SIZE_SOL` plus ~0.01 SOL for fees).
3. Run:
   ```bash
   npx tsx src/main.ts
   ```

### Production (long-running)

Use a process manager so the bot survives crashes:

**Option A — `pm2`:**
```bash
npm install -g pm2
pm2 start "npx tsx src/main.ts" --name moonbags
pm2 logs moonbags
pm2 save           # persist across reboot
pm2 startup        # follow instructions to enable on boot
```

**Option B — `systemd`** (Linux):
Create `/etc/systemd/system/moonbags.service`:
```ini
[Unit]
Description=MoonBags trading bot
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/moonbags
ExecStart=/usr/bin/env npx tsx src/main.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now moonbags
journalctl -u moonbags -f
```

### Verify it's running

You should see in the logs:
```
{"level":30,"time":...,"msg":"memeautobuy starting","dryRun":false,"buySol":0.02}
{"level":30,"time":...,"msg":"[state] no prior state file, starting fresh"}
{"level":30,"time":...,"msg":"dashboard available","url":"http://localhost:8787/"}
{"level":30,"time":...,"msg":"[telegram] bot polling started"}
```

And in Telegram you'll get:
```
🌙 MoonBags online
mode: LIVE  |  buy: 0.02 SOL
arm: +50%  trail: 55%  stop: -50%
```

Send `/start` to your bot to confirm it responds.

---

## Telegram commands

Every command is gated to the `TELEGRAM_CHAT_ID` in `.env` — random users who find the bot can't talk to it.

| Command | Description |
|---------|-------------|
| `/start` | 🌙 MoonBags dashboard: mode (LIVE/DRY), SOL balance, open positions (with armed ⚡ count), realized PnL, config summary, LLM state, uptime, wallet address. Inline buttons for Positions / Settings / Refresh. |
| `/positions` | Open positions with one-tap force-sell buttons. Auto-refreshes 1.5s after a sell fires. |
| `/settings` | Interactive menu — tap **[Edit]** on any numeric setting for a reply prompt, **[Toggle]** for booleans. Changes save to `.env` and apply on next tick — **no restart**. |
| `/pnl` | Today's PnL + all-time stats, win/loss count, win rate, best + worst trade. Reads `state/closed.json`. |
| `/history [N]` | Last N closed trades (default 10, max 50) — name, PnL, exit reason, hold duration. |
| `/llm` | One-tap toggle for the LLM exit advisor. Warns if `MINIMAX_API_KEY` is empty. |
| `/pause` | Stop taking new SCG alerts. Open positions keep running. **Persists across restart.** |
| `/resume` | Resume taking new alerts. |
| `/sellall` | Emergency liquidation. Lists every open position, requires typing **`CONFIRM`** (exact, case-sensitive) within 60s. Any other reply cancels. |
| `/skip <mint>` | Blacklist a token (ignore future SCG alerts for it). `/skip` alone lists current. `/skip clear` resets. **Persists across restart.** |
| `/mint <mint>` | On-demand on-chain snapshot for any token: price + 5m/1h/4h/24h % changes, smart money / bundler / dev flow, top-10 holder PnL, dev hold %, LP burn, GMGN link. |
| `/wallet` | Full wallet address + SOL balance + Solscan link. |

### Notification behaviour

Sent to your Telegram chat as events happen. Dedupe is built in so you don't get spammed:

- `🟢 BUY` — every buy (mcap, spent, tx link)
- `⚡ ARMED` — when a position hits `ARM_PCT` and trailing activates
- `🤖 LLM watching` — fires **once per position** when the LLM advisor first picks it up
- `🤖 LLM tightened 55% → 25%` / `🤖 LLM loosened 25% → 55%` — only when the LLM actually changes the trail (≥1% delta), direction-aware copy
- `🚀 / 🌙 / 💎 / 👑 <TOKEN> hit +100%` — **milestone alerts** with an inline sell button when a position crosses each configured PnL % (fires once per threshold). Tap the button to close in one tap.
- `🟢 SELL` — every close, with reason + PnL. Includes the LLM's reasoning when it triggered the exit.
- `❌ BUY FAILED` — when a swap couldn't land
- `🚨 SELL STUCK` — after 10 sell retries failed (needs manual action)

**Settings you can edit live via `/settings`:**

- `BUY_SIZE_SOL` — SOL per trade
- `MAX_CONCURRENT_POSITIONS` — max open positions
- `ARM_PCT` — when trailing arms (decimal, e.g. 0.5 = +50%)
- `TRAIL_PCT` — drawdown from peak that triggers exit
- `STOP_PCT` — hard stop loss
- `MAX_HOLD_SECS` — time-based exit
- `LLM_EXIT_ENABLED` — toggle LLM advisor on/off
- `MILESTONES_ENABLED` — toggle milestone PnL alerts on/off
- `MILESTONE_PCTS` — comma-separated PnL % thresholds, e.g. `100,200,500,1000`

**NOT editable from Telegram (security boundary):**

- API keys (`JUP_API_KEY`, `HELIUS_API_KEY`, `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `MINIMAX_API_KEY`, `TELEGRAM_BOT_TOKEN`)
- Wallet key (`PRIV_B58`)
- `DRY_RUN` (intentionally requires manual `.env` edit + restart)

---

## LLM exit advisor

When `LLM_EXIT_ENABLED=true`, MoonBags consults MiniMax M2.7 every 30 seconds for each **armed** position (PnL ≥ ARM_PCT).

### What the LLM sees

For each armed position, it gets a compact JSON payload with:

- **Position context:** entry/current price (in SOL), PnL %, peak PnL %, drawdown from peak, current trail %, hold time
- **Momentum:** price + volume + tx count across 5m / 1h / 4h / 24h windows, holders, market cap, liquidity, % from ATH
- **Trade flow (last 30 min):** smart money, bundlers, dev, whales, insiders — buys/sells/net flow in SOL
- **Top 10 holders:** holding %, average PnL, average buy/sell prices, trend (buy or sell)
- **Liquidity pools:** top 3 by USD value
- **Risk profile:** dev current holding %, dev sell status tag, LP burned %, top10 concentration, sniper status, token tags
- **Recent signals:** smart money / KOL / whale movements scoped to this token (last 60 min)
- **Klines:** 60 1m candles + 60 5m candles (closes + USD volumes)

### What the LLM can decide

Three actions only:

| Action | What happens |
|--------|--------------|
| `hold` | Nothing changes — current trail logic continues |
| `tighten_trail` | Lowers trail % (e.g. 55% → 25%) — locks in more profit. Effective on next 3s tick. |
| `exit_now` | Sells the entire position immediately, bypassing the trail |

The LLM **cannot** buy more, partial-sell, loosen the trail, or override the hard stop.

### Telegram notifications

Per-position lifecycle with LLM enabled:

```
🟢 BUY YOLO                              ← buy fires
⚡ ARMED YOLO — trailing active          ← PnL hits +50%
🤖 LLM watching YOLO                     ← LLM picks up the position (once)
🤖 LLM tightened YOLO  55% → 25%         ← only on actual change
🟢 SELL YOLO — llm                       ← exit triggered
   PnL: +0.084 SOL (+420.0%)
   peak: +680.5%  |  held: 8m 12s
   LLM: "smart money flipped to selling, bundlers exit-stamping"
```

Polling cost: ~120 LLM calls per armed position per hour. The Starter plan (1500 / 5h) handles ~6 simultaneous armed positions comfortably.

### Safety net

The hard stop (`STOP_PCT`) is **always active** regardless of LLM state. If MiniMax goes down or returns garbage, the bot falls back to the existing trail logic. The LLM never gets to override the floor.

---

## Milestone alerts

When a position's PnL crosses a threshold you configured, a Telegram message fires with an **inline sell button** — one tap to take profit without opening `/positions`.

**Defaults:** `100, 200, 500, 1000` — meaning +100% (🚀 2x), +200% (🌙 3x), +500% (💎 6x), +1000% (👑 11x).

### How it works

- Every 3-second tick, after PnL is computed, the bot checks whether the current PnL just crossed any threshold in `MILESTONE_PCTS`.
- The first time a position crosses a given threshold, a notification fires. Each threshold fires **at most once per position** (dedupe via `position.milestonesHit[]`, persisted across restarts).
- The inline button uses the same `sell:<mint>` callback as the sell buttons in `/positions`, so tapping it works instantly.

### Sample notification

```
🌙 ALLIN hit +200%  (3.0x)
Now: +214.3%  |  Peak: +241.7%
Unrealized: +0.0426 SOL

[ 🚨 Sell ALLIN ]
```

Tier icons: 🚀 for 2x, 🌙 for 3x, 💎 for 5-9x, 👑 for 10x+.

### Configuration

Both knobs editable live via `/settings` in Telegram:

| Setting | Description |
|---------|-------------|
| `MILESTONES_ENABLED` | Feature toggle (default ON) |
| `MILESTONE_PCTS` | Comma-separated % thresholds, e.g. `100,200,500,1000`. Max 10 values. |

Changes take effect on the next tick — no restart needed.

---

## Web dashboard

A live dashboard runs on `http://localhost:8787/` (configurable via `DASHBOARD_PORT`). React/Vite SPA, polls `/api/state` every 2 seconds.

**Pepe-on-the-Moon theme** — Pepe green primary, Earth visor blue accent, coral for losses, on a true space-black surface with a faint star field and Earth-glow gradient.

**Layout:**

- **Top bar** — 🌙 MOONBAGS logo + LIVE/DRY pill, compact OPEN/REALIZED PNL/UPTIME stats
- **Hero card** — massive 120px Pepe-green realized-PnL number, 8-bar cumulative-PnL sparkline (real, from `state/closed.json`), 4 KPI tiles (WIN RATE, AVG PNL, BEST, WORST)
- **Open positions** as rich cards (one per position):
  - Token icon (real Jupiter image) inside a colored ring (green/blue/coral by PnL)
  - Name + $SYMBOL + ARMED chip when applicable
  - GMGN + JUP external links + copy-mint button
  - **Jupiter enrichment badges**: verification status, organic score, mint/freeze authority safety, top-10 holder concentration warnings, dev token history
  - Big PnL %, drawdown-from-peak progress bar (the "drawdown limit" — fills shrink as we retrace from peak)
  - **Real 1m price chart** — last ~60 minutes of OKX kline data as an SVG line + area, dashed reference line at entry price
  - SELL button (currently a stub — manual sell via Telegram `/positions`)
- **Live feed** — compact mini cards for recent SCG alerts. Each shows token icon, GMGN/JUP links, organic-score chip, and an inline `CLOSED +420%` badge if you've already traded that token (reads from `state/closed.json`).
- **Bottom config strip** — fixed 48px showing BUY / ARM / TRAIL / STOP / LLM / DRY values. The "EDIT IN TELEGRAM /settings" link auto-resolves your bot username via `getMe` and opens `https://t.me/<botname>` in a new tab.

**Localhost-only with no auth** — don't expose it externally. For remote access, tunnel via SSH:

```bash
ssh -L 8787:localhost:8787 youruser@yourserver
```

Then open `http://localhost:8787/` in your local browser.

### Rebuilding the frontend

The dashboard is a React/Vite/Tailwind SPA in `frontend/`. If you edit anything in `frontend/src/`:

```bash
cd frontend
npm run build  # outputs to ../public/
```

The backend serves the built artifacts from `public/` — no backend restart needed for frontend-only changes, just refresh the browser.

---

## State files

The bot writes to `state/` in the project directory:

| File | Purpose |
|------|---------|
| `state/positions.json` | Live position state — restored on restart |
| `state/closed.json` | Append-only log of all closed trades (used by `/pnl`, `/history`). Capped at 500 entries. |
| `state/poller.json` | `paused` flag and blacklist — survives restart |
| `state/stranded.json` | Audit log of in-flight positions reconciled on boot. Worth manual review if anything appears here. |

**Backup `state/` periodically** if you want to preserve PnL history.

---

## Operating day-to-day

### Normal flow

1. Check `/start` in Telegram for current SOL balance + open positions.
2. Receive buy/arm/sell notifications as they happen.
3. If something looks off in a position, tap the Sell button in `/positions`.
4. Run `/pnl` at the end of the day for a summary.

### Tuning settings

Use `/settings` from Telegram. Common adjustments:

- **Markets are crazy bullish:** raise `BUY_SIZE_SOL` to deploy more capital per trade.
- **Bot is missing big runners:** widen `TRAIL_PCT` (e.g. 0.55 → 0.70) so wicks don't shake you out.
- **Too many flat trades:** raise `STOP_PCT` to give positions more room (or lower it for tighter risk).
- **Pausing during macro events:** `/pause`, then `/resume` when ready.

### Emergency: kill all positions

```
/sellall
CONFIRM
```

Sells every open position immediately via Jupiter. Confirms with a summary message.

### Restarting the bot

```bash
pm2 restart moonbags
# or
sudo systemctl restart moonbags
```

State is preserved. Positions in flight at the moment of restart are reconciled from your wallet balance and logged to `state/stranded.json`.

---

## Backtesting

Two scripts ship with the bot for tuning your trading params and researching individual tokens.

### Grid-search backtester — `src/_backtest.ts`

Fetches the **top 100 trending Solana tokens** from OKX, pulls 24 hours of kline data per token, then grid-searches every combination of `ARM_PCT × TRAIL_PCT × STOP_PCT` to find which settings would have produced the best PnL across that universe. The defaults shipped in `.env.example` were derived from this exact script.

**Run with defaults (5m bars, top 15 results):**

```bash
npx tsx src/_backtest.ts
```

**Customize via flags:**

```bash
# Use 1-minute bars instead of 5m (denser data, slower fetch)
npx tsx src/_backtest.ts --bar 1m

# Show top 30 ranked combinations instead of 15
npx tsx src/_backtest.ts --top 30

# Skip tokens with fewer than 80 candles of data (cleaner sample)
npx tsx src/_backtest.ts --min-candles 80

# Combine
npx tsx src/_backtest.ts --bar 5m --top 25 --min-candles 60
```

**What you'll see** — a ranked table like this:

```
ARM   TRAIL  STOP    | TOTAL PnL  | AVG/TRADE  | W / L / H | WIN%
50%   55%    40%     | +12,840%   | +128%      | 42 / 31 / 27 | 58%
50%   60%    40%     | +12,210%   | +122%      | 38 / 35 / 27 | 52%
40%   55%    40%     | +11,990%   | +120%      | 44 / 29 / 27 | 60%
...
```

- **TOTAL PnL** — sum of % returns across all simulated trades
- **AVG/TRADE** — average % per trade
- **W / L / H** — wins / losses / still-holding (trade hit neither stop nor trail by end of data)
- **WIN%** — wins as % of completed trades (excluding holding)

A CSV with the full grid is also written to `backtest_<timestamp>.csv` for further analysis in a spreadsheet.

**Tune your `.env` from this** — the row at the top of the table is the historical optimum across the sampled universe. The current defaults (`ARM=0.5`, `TRAIL=0.55`, `STOP=0.4`) sit near the top consistently. Run periodically to spot regime shifts.

> ⚠️ Past performance ≠ future results, especially in meme coins. The backtest is a sanity check, not a guarantee.

### Ad-hoc on-chain snapshot — `src/_okxTest.ts`

Pulls a full live snapshot of any token (price + 5m/1h/4h/24h momentum, smart-money / bundler / dev trade flow, top-10 holder PnL, liquidity pools, dev hold %, recent signals, 1m + 5m kline). Same data the LLM advisor sees, dumped to your terminal.

```bash
npx tsx src/_okxTest.ts <mint-address>
```

Useful for manually evaluating a token before whitelisting it, or debugging why the LLM made a particular decision.

---

## Troubleshooting

### `[priceFeed] okx prices failed`

The `onchainos` CLI is intermittently rate-limited or having auth issues. The bot **automatically falls back to Jupiter Ultra sell quotes** for affected tokens — no action needed. If it persists for >5 minutes, check:

- Is `onchainos --version` working from the shell?
- Are you on IPv4? `onchainos` does NOT support IPv6. Run `curl -6 -s https://ipv6.icanhazip.com || curl -s https://ipv4.icanhazip.com` — if you get an IPv6 response, disable IPv6 on your network interface.

### `MINIMAX_API_KEY missing — skipping LLM consult`

You set `LLM_EXIT_ENABLED=true` but no API key. Either:
- Add `MINIMAX_API_KEY=...` to `.env` and restart, OR
- Run `/llm` in Telegram to toggle it back off.

### `Buy failed`

Common causes:
- Insufficient SOL in wallet for `BUY_SIZE_SOL` + fees.
- Token has no liquidity yet (alert fired too early).
- Slippage exceeded — the bot retries with the next alert; nothing to do.

### `Sell stuck`

After 10 retries, the bot gives up and sends a `SELL STUCK` alert. Use `/positions` → tap the Sell button to retry manually, or sell directly via your wallet if needed.

### Bot stopped responding to Telegram

```bash
pm2 restart moonbags    # or systemctl restart
```

The polling loop is robust but a network blip can occasionally stall it. Restart resolves.

### Lost trades in `/pnl`

Closed trades are logged to `state/closed.json`. If the file was corrupted or deleted, history is gone. The bot continues to track `realizedPnlSol` in `state/positions.json` (which persists across restarts).

---

## Safety notes

1. **Use a dedicated wallet.** Never put a wallet that holds anything important into `PRIV_B58`. Funds in this wallet are exposed to whatever the bot does.
2. **Start with `DRY_RUN=true`.** Watch logs for at least an hour before going live.
3. **Start with small `BUY_SIZE_SOL`.** 0.02 SOL is a safe starting point — that's roughly $4 per trade at $200/SOL. Scale up only after seeing the bot perform.
4. **Keep `STOP_PCT` set.** This is your floor. The LLM and the trail can both be wrong; the hard stop saves you from total wipeout on a single trade.
5. **Don't expose the dashboard publicly.** It has no authentication. Use SSH tunneling for remote access.
6. **Review `state/stranded.json` after every restart.** Anything appearing there means the bot recovered an in-flight position from your wallet — verify it's correct.
7. **Test `/sellall` once in dry-run.** Make sure you're comfortable with the confirmation flow before relying on it in an emergency.
8. **The LLM can be wrong.** It uses a strong prompt and good data, but meme-coin moves are noisy. Always have the hard stop as a backstop.
9. **Backups.** Periodically save `state/` somewhere safe so you don't lose PnL history.
10. **This is not financial advice.** Meme coins are extremely volatile. You will lose trades. The bot is a tool, not a guarantee.

---

## Project structure

```
src/
├── main.ts              ← entry point: wires everything together
├── config.ts            ← env loading + live settings updates (mutable CONFIG)
├── types.ts             ← shared TypeScript types
├── logger.ts            ← pino logger
├── scgPoller.ts         ← polls SCG Alpha + pause/blacklist state (persisted)
├── positionManager.ts   ← position lifecycle, tickPositions, tickLlmAdvisor
├── jupClient.ts         ← Jupiter Ultra swap execution + wallet balance
├── jupTokensClient.ts   ← Jupiter Tokens API enrichment (verification, organic score, audit)
├── priceFeed.ts         ← OKX prices (primary) + Jupiter sell quote (fallback)
├── okxClient.ts         ← onchainos CLI wrapper for the LLM data layer + dashboard kline
├── llmExitAdvisor.ts    ← MiniMax M2.7 client + tool calling (`enable_thinking`, `extra_body.reasoning_split`)
├── notifier.ts          ← Telegram notifications (with HTML escaping)
├── telegramBot.ts       ← Telegram command handler (long polling, force_reply for edits)
├── server.ts            ← localhost web dashboard backend (`/api/state` JSON, static serve)
├── _setup.ts            ← interactive first-time setup wizard (`npm run setup`)
├── _backtest.ts         ← grid-search backtester
└── _okxTest.ts          ← ad-hoc on-chain snapshot tool

frontend/                ← React/Vite/Tailwind dashboard SPA (build → public/)
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── TopBar.tsx              ← glass header w/ MoonBags logo + stats
│   │   ├── HeroSection.tsx         ← 120px PnL hero + sparkline + KPI tiles
│   │   ├── PositionsTable.tsx      ← rich position cards (NOT a table)
│   │   ├── AlertsFeed.tsx          ← compact alert mini-cards w/ closed-PnL inline
│   │   ├── BottomConfigStrip.tsx   ← fixed config pills + Telegram deep-link
│   │   ├── TokenAvatar.tsx         ← circular icon w/ initial-letter fallback
│   │   ├── TokenInfoBadges.tsx     ← Jupiter verification + organic score + audit pills
│   │   ├── MiniPriceChart.tsx      ← real SVG line chart from 1m OKX kline
│   │   └── ui/                     ← shadcn primitives (badge, button, card, etc.)
│   ├── lib/
│   │   ├── format.ts               ← truncMint, fmtSol, fmtUsd, fmtAge, fmtUptime
│   │   └── sparkline.tsx           ← SparkBars + heroBars helpers
│   ├── types.ts                    ← State, Position, Alert, ClosedTrade, TokenInfo
│   └── index.css                   ← star field + pepe-glow + body backdrop gradients

state/                   ← created at runtime, persisted across restarts
├── positions.json       ← open positions + realizedPnlSol
├── closed.json          ← every closed trade (capped at 500). Source for /pnl + /history
├── poller.json          ← paused flag + blacklist
└── stranded.json        ← audit log of in-flight positions reconciled on boot
```

---

## License

Private. Do not redistribute without permission.
