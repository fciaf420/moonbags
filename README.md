# MoonBags

> Solana meme-token auto-trading bot with LLM-powered exit decisions.

MoonBags is the **execution and management layer** for Solana meme-token signals. It consumes real-time discovery streams from **OKX smart-money signals** and/or **GMGN's curated trenches + KOL call feeds**, buys via Jupiter Ultra, then manages exits with either a configurable trail/stop or — optionally — a MiniMax M2.7 LLM that reads live on-chain data (smart money flow, dev holdings, holder PnL, kline trends) every 30 seconds to decide when to sell.

Telegram `/sources` lets you pick between `okx_watch` / `okx_only` / `gmgn_watch` / `gmgn_live` / `gmgn_only` or `hybrid` at runtime, no restart. SCG Alpha is supported as a legacy source in the codebase but disabled by default. Whatever source creates the entry, MoonBags still sizes it, executes through Jupiter, watches it, and exits it with the same universal exit settings.

You operate the bot through a Telegram bot (`/start`, `/positions`, `/settings`, `/sellall`, etc.) or a local web dashboard.

---

## ⚠️ Disclaimers

**Not financial advice.** This software is released for educational and research purposes. Using it to trade real money is your decision and your risk alone. Meme coins are extremely volatile — **you will have losing trades, and you can lose your entire wallet balance**. Nothing in this repo, the dashboard, the Telegram bot, or the LLM advisor's output constitutes investment, legal, tax, or any other kind of professional advice. Do your own research.

**Critical upstream dependencies — OKX and GMGN.** The active signal layers are OKX OnchainOS smart-money signals and GMGN OpenAPI's trenches/signal endpoints. SCG Alpha ([@scg_alpha on X](https://x.com/scg_alpha)) integration remains in the codebase but is disabled by default; re-enabling it requires uncommenting the `[SCG-DISABLED]`-tagged call sites. **I do not own, operate, or control OKX, GMGN, SCG Alpha, Jupiter, Helius, MiniMax, or Telegram**. If any provider changes API shape, rate-limits you, changes pricing, or shuts down, the affected intake or execution path can stop working until the code or provider is updated. You're also subject to each provider's terms of service.

Other third-party services the bot depends on (any of which can break the bot if they change): **Jupiter Ultra** (swap execution + fees), **Helius RPC** (Solana reads), **OKX onchainos CLI** (on-chain data enrichment), **MiniMax** (LLM advisor, optional), **Telegram Bot API** (control + notifications).

Use at your own risk.

---

## Table of contents

1. [Where the trades come from — the discovery layer](#where-the-trades-come-from--the-discovery-layer)
2. [What it does](#what-it-does)
3. [Architecture at a glance](#architecture-at-a-glance)
4. [Prerequisites](#prerequisites)
5. [Quick start — one-command onboarding](#quick-start--one-command-onboarding)
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

MoonBags supports two active discovery sources. Pick one or run both via `/sources`:

**OKX OnchainOS (fast-twitch).** Real-time websocket stream of buys by OKX-labeled Smart Money and KOL wallets. Fires ~3 seconds after the wallet's buy lands on-chain. You're front-running the rest of the market by seconds. Default filters (after a 156-signal data analysis): `minHolders ≥ 100`, `walletTypes ∈ {SmartMoney, KOL}`, `minAmountUsd ≥ 500`, combined with a `/mcapfilter 25000` runtime floor.

**GMGN OpenAPI (curated discovery).** Polls three endpoints every 60s:
- `/v1/trenches` — Pump.fun / pump_mayhem / letsbonk launches with smart-degen activity, safety preset on
- `/v1/market/token_signal` — smart-money + KOL call signals (`signal_type=12`)
- `/v1/market/rank` (trending) — **disabled by default**; buying post-pump momentum is the wrong lens for early entries

Both sources share the same safety floor, cross-source mint cooldown, blacklist, and Jupiter execution path. You can run them alongside each other (`hybrid` mode).

**SCG Alpha (legacy, disabled).** The repo still contains the SCG poller behind `[SCG-DISABLED]` comment tags. Users who want SCG back can uncomment the call in `src/main.ts` and re-add `scg_only` to the source-mode array in `src/telegramBot.ts`.

If you want to swap in your own discovery source, the signal-source interface is at `src/okxSignalSource.ts` and `src/gmgnSignalSource.ts` — every downstream layer (dedup, position manager, exit engine, Jupiter, Telegram) is signal-source agnostic.

---

## What it does

1. **Receives** live signals from OKX (websocket, ~3s after smart-wallet buys land) and/or GMGN (60s poll across trenches + smart-money calls).
   - Mode selected via `/sources`: `okx_only`, `gmgn_live`, `gmgn_only`, `hybrid`, or any of the watch-only variants.
   - SCG Alpha polling is present in the codebase but disabled by default.
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
        │   UPSTREAM — discovery sources           │
        │   (NOT part of this repo, NOT mine)      │
        ├──────────────────────────────────────────┤
        │                                          │
        │   ┌──────────────┐     ┌──────────────┐  │
        │   │     OKX      │     │     GMGN     │  │
        │   │  OnchainOS   │     │   OpenAPI    │  │
        │   │  (WSS, ~3s)  │     │ (60s poll)   │  │
        │   │              │     │              │  │
        │   │ smart-money  │     │ trenches +   │  │
        │   │ + KOL buys   │     │ KOL signals  │  │
        │   └──────┬───────┘     └──────┬───────┘  │
        │          │                    │          │
        └──────────┼────────────────────┼──────────┘
                   │                    │
                   └────────┬───────────┘
                            ▼
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
                       |   |  exit advisor  |    choose LLM Managed)
                       |   +----------------+
                       ▼
                  +----------------+
                  |    Telegram    |   ← you control + receive alerts here
                  |  bot + alerts  |
                  +----------------+
```

---

## Prerequisites

- **macOS, Linux, or Windows via WSL2 Ubuntu** (native Windows shell is not supported)
- **Node.js 20+** ([install via nvm](https://github.com/nvm-sh/nvm))
- **A funded Solana wallet** (for live trading) — needs SOL for both trades and gas
- **Accounts for:** Helius, Jupiter, SCG Alpha, Telegram, OKX (free), and optionally MiniMax (paid)

---

## Quick start — one-command onboarding

If someone handed you this repo and said "get MoonBags running", start here. The installer is meant to be the friendly path: it installs dependencies, installs OKX OnchainOS, runs the setup wizard, and finishes with a health check.

From a fresh machine:

```bash
curl -fsSL https://raw.githubusercontent.com/fciaf420/moonbags/main/install.sh | bash
```

If you already cloned the repo and are inside it:

```bash
MOONBAGS_DIR="$PWD" bash install.sh
```

If your checkout does not include `install.sh` yet, run the same steps manually:

```bash
npm install
npm run install:onchainos
npm run setup
npm run doctor
```

What the installer covers:

| Step | What happens |
|------|--------------|
| Install app packages | Runs `npm install` in the project. |
| Install OKX OnchainOS | Runs `npm run install:onchainos`, which calls OKX's official installer. |
| Set up credentials | Runs the interactive setup wizard and writes `.env` after confirmation. |
| Check the install | Runs `npm run doctor` so you can fix missing keys, PATH issues, or service problems before trading. |

After the installer finishes, open Telegram and send these to your bot:

```text
/doctor
/setup_status
/start
```

- `/doctor` checks the bot from Telegram: wallet, RPC, Jupiter, OKX OnchainOS, Telegram, and common runtime problems.
- `/setup_status` shows what is complete and what still needs attention.
- `/start` confirms the bot is online and shows the main dashboard.

Keep `DRY_RUN=true` until `/doctor` and `/setup_status` are clean and you are comfortable with the alerts.

### Start the bot

For a first dry run:

```bash
npm run start
```

For a long-running install, use `pm2`:

```bash
npm install -g pm2
pm2 start "npm run start" --name moonbags
pm2 logs moonbags
pm2 save
```

Useful restart commands:

```bash
pm2 restart moonbags
pm2 restart moonbags --update-env   # use after changing .env
pm2 logs moonbags
```

Once `pm2` is running, Telegram `/update` becomes the self-healing update path: it checks `origin/main`, shows incoming commits, refuses unsafe local changes, runs `npm install` when package files changed, and restarts `moonbags` with `pm2`.

### What the setup wizard asks for

The wizard walks through every credential, validates the services it can check live, auto-detects your Telegram `chat_id`, and can generate a fresh Solana keypair for you.

| Step | What it does |
|------|--------------|
| 1 | Checks that the `onchainos` CLI is on `$PATH` |
| 2 | OKX OnchainOS credentials, plus optional GMGN OpenAPI key for GMGN Watch/Live source modes |
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
# Open the dashboard
open http://localhost:8787/

# Control from Telegram:
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

This is a **compiled Rust binary** (npm package) that wraps OKX's on-chain data API. It's used by the price feed, the LLM advisor, backtests, and optional WebSocket acceleration for open-position monitoring.

```bash
npm run install:onchainos
```

That command runs OKX's official installer:

```bash
curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh
```

The installer places the `onchainos` binary on your user PATH, commonly under `~/.local/bin`. If `which onchainos` still returns nothing, open a new terminal or add that directory to your shell PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Then restart the bot so it picks up the PATH:

```bash
pm2 restart moonbags --update-env
```

Verify it works:

```bash
which onchainos
onchainos --version
onchainos token trending --help
onchainos market price --address So11111111111111111111111111111111111111112 --chain solana
```

Use `onchainos 2.1.0` or newer. If `/backtest` fails with `unrecognized subcommand 'trending'`, rerun the installer to update the CLI and restart the bot:

```bash
npm run install:onchainos
```

Optional: set `OKX_WSS_ENABLED=true` to let MoonBags open OKX WebSocket sessions for tokens you already hold. WSS does not create entries or execute sells; it only refreshes market data faster and wakes the normal Jupiter-confirmed exit checks sooner.

Then create OnchainOS API credentials at [web3.okx.com/onchain-os/dev-portal](https://web3.okx.com/onchain-os/dev-portal). Use a read-only key and save the passphrase you set during creation.

Set in `.env`:

```env
OKX_API_KEY=your-okx-api-key
OKX_SECRET_KEY=your-okx-secret-key
OKX_PASSPHRASE=your-okx-passphrase
```

The `onchainos` CLI expects `OKX_PASSPHRASE`. The bot also accepts the older local alias `OKX_API_PASSPHRASE` and passes it through as `OKX_PASSPHRASE` when spawning the CLI. It's IPv4-only.

### GMGN OpenAPI (optional source)

GMGN can be used as an additional signal source from Telegram `/sources`. Create an API key at [gmgn.ai/ai](https://gmgn.ai/ai), then add it to `.env`:

```env
GMGN_API_KEY=your-gmgn-api-key
```

GMGN source modes do not use GMGN for execution. MoonBags uses GMGN market/signal data for discovery and still routes buys/sells through Jupiter.

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
3. Set the API key in `.env`:
   ```
   MINIMAX_API_KEY=your-token-plan-key
   ```

**Using a different LLM provider (e.g. OpenRouter):** Set `LLM_API_KEY`, `LLM_ENDPOINT`, and `LLM_MODEL` instead. Any OpenAI-compatible provider works:
```
LLM_API_KEY=sk-or-v1-...
LLM_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
LLM_MODEL=anthropic/claude-3.5-sonnet
```
`MINIMAX_API_KEY` is still accepted for backwards compatibility if you don't set `LLM_API_KEY`.

Then choose **LLM Managed** from Telegram `/settings` → **Exit Strategy**.

---

## Environment variables reference

Create `.env` in the project root with these values:

Keep secrets here. Trading exit settings are edited in Telegram and persisted separately in `state/settings.json`, so you don't have to keep retyping the live risk knobs into the env file.

```env
# === REQUIRED ===
JUP_API_KEY=jup_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HELIUS_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
OKX_API_KEY=your-okx-api-key
OKX_SECRET_KEY=your-okx-secret-key
OKX_PASSPHRASE=your-okx-passphrase
GMGN_API_KEY=your-gmgn-api-key
PRIV_B58=base58-encoded-solana-keypair-secret

# === RPC ===
RPC_URL=https://beta.helius-rpc.com?api-key=${HELIUS_API_KEY}

# === TRADING BASICS ===
# Exit strategy, TP ladder, trail, stop, moonbag, and milestones are edited
# in Telegram and saved to state/settings.json.
BUY_SIZE_SOL=0.02              # SOL per trade
MAX_CONCURRENT_POSITIONS=10    # max open positions

# === ALERT FILTERS (0 = disabled) ===
MAX_ALERT_AGE_MINS=0
MIN_LIQUIDITY_USD=0
MIN_SCORE=0
MAX_RUG_RATIO=0
MAX_BUNDLER_PCT=0
MAX_TOP10_PCT=0
REQUIRE_RISING_LIQ=false
MIN_ALERT_MCAP=0              # only buy alerts at or above this mcap ($). Also editable via /mcapfilter or /stats
MAX_ALERT_MCAP=0              # only buy alerts at or below this mcap ($). Also editable via /mcapfilter or /stats

# === POLLING ===
SCG_POLL_MS=3000               # how often to poll SCG for new alerts
PRICE_POLL_MS=3000             # how often to update prices for open positions
LLM_POLL_MS=30000              # how often the LLM advisor checks armed positions
OKX_WSS_ENABLED=false          # optional WSS acceleration for open positions only

# === EXECUTION ===
SLIPPAGE_BPS=2500              # fallback slippage for non-Ultra quotes
DRY_RUN=true                   # FALSE to enable real trades

# === DASHBOARD ===
DASHBOARD_PORT=8787            # localhost-only web dashboard

# === TELEGRAM ===
TELEGRAM_BOT_TOKEN=8775xxxxxxx:AAGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=518183629

# === LLM EXIT ADVISOR ===
# Option A — MiniMax (default)
MINIMAX_API_KEY=               # MiniMax Token Plan key
# Option B — any OpenAI-compatible provider (e.g. OpenRouter)
# LLM_API_KEY=sk-or-v1-...
# LLM_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
# LLM_MODEL=anthropic/claude-3.5-sonnet
```

On first boot, MoonBags creates `state/settings.json` from the env defaults. Telegram `/settings` then becomes the source of truth for live trading behavior:

```json
{
  "exit": {
    "profitStrategy": {
      "type": "trail",
      "fixedTargetPct": 1,
      "ladderTargets": [
        { "pnlPct": 0.5, "sellPct": 0.25 },
        { "pnlPct": 1, "sellPct": 0.25 },
        { "pnlPct": 2, "sellPct": 0.25 }
      ],
      "trailRemainder": true
    },
    "trail": { "armPct": 0.5, "trailPct": 0.55 },
    "risk": { "stopPct": 0.4, "maxHoldSecs": 99999999999999999 },
    "runner": { "keepPct": 0, "trailPct": 0.6, "timeoutSecs": 7200 },
    "llm": { "enabled": false }
  }
}
```

**Security note:** `.env` should never be committed. Add it to `.gitignore` (already present in this repo).

---

## Running the bot

### Dev mode (recommended for first run)

```bash
DRY_RUN=true npm run start
```

In dry-run, the bot fetches alerts and prices but **does not submit any swap transactions**. Watch the logs to verify everything is wired correctly.

### Live trading

1. Set `DRY_RUN=false` in `.env`.
2. Make sure your wallet has enough SOL (at least 10× your `BUY_SIZE_SOL` plus ~0.01 SOL for fees).
3. Run:
   ```bash
   npm run start
   ```

### Production (long-running)

Use a process manager so the bot survives crashes:

**Option A — `pm2`:**
```bash
npm install -g pm2
pm2 start "npm run start" --name moonbags
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
ExecStart=/usr/bin/env npm run start
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
| `/settings` | Interactive menu with Buy, Exit Strategy, Risk Controls, TP targets, milestones, and LLM controls. Trading changes save to `state/settings.json` and apply on next tick — **no restart**. |
| `/pnl` | Today's PnL + all-time stats, win/loss count, win rate, best + worst trade. Reads `state/closed.json`. |
| `/stats` | Signal metadata analysis — win rate + avg PnL by mcap tier, Pearson correlations between signal fields and trade outcomes. Includes an inline "Adopt" button to activate the best-performing mcap range as an entry filter in one tap. Stats grow as new trades close (forward testing only). |
| `/mcapfilter [min] [max\|off]` | Set or clear the mcap entry filter manually. `/mcapfilter 50000 200000` = $50k–$200k range. `/mcapfilter 50000` = $50k floor, no ceiling. `/mcapfilter off` = clear. Persists in `state/settings.json`. |
| `/history [N]` | Last N closed trades (default 10, max 50) — name, PnL, exit reason, hold duration. |
| `/llm` | One-tap toggle for the LLM exit advisor. Warns if `LLM_API_KEY` (or `MINIMAX_API_KEY`) is empty. |
| `/share` | Encode your current settings as a shareable `MB1:...` string. Forward the message to anyone — they paste it into `/import` to adopt your settings in one tap. |
| `/import MB1:...` | Import settings shared by another user. Shows a diff and asks for confirmation before applying. |
| `/sources` | Choose entry source mode: SCG only, OKX Watch/Live/only, or GMGN Watch/Live/only. |
| `/wss` | OKX WSS status and enable/disable buttons for open-position market-data acceleration. |
| `/pause` | Stop taking new SCG/OKX/GMGN entry alerts. Open positions keep running. **Persists across restart.** |
| `/resume` | Resume taking new alerts. |
| `/sellall` | Emergency liquidation. Lists every open position, requires typing **`CONFIRM`** (exact, case-sensitive) within 60s. Any other reply cancels. |
| `/skip <mint>` | Blacklist a token (ignore future SCG/OKX/GMGN alerts for it). `/skip` alone lists current. `/skip clear` resets. **Persists across restart.** |
| `/mint <mint>` | On-demand on-chain snapshot for any token: price + 5m/1h/4h/24h % changes, smart money / bundler / dev flow, top-10 holder PnL, dev hold %, LP burn, GMGN link. |
| `/wallet` | Full wallet address + SOL balance + Solscan link. |
| `/backtest [source] [hybrid]` | Run the exit-strategy backtester. Source: `gmgn` (default) pulls fresh calls from GMGN signals/trenches/trending; `scg` is retained but disabled. Add `hybrid` to switch the grid to trail + scale-out + moonbag. Examples: `/backtest`, `/backtest hybrid`, `/backtest gmgn hybrid`. Tap a row to adopt the exit strategy live. |
| `/backtest_hybrid` | Alias for `/backtest hybrid` — same source default, hybrid exit grid. |
| `/doctor` | Run a health check from Telegram. Use this when the bot starts, after changing `.env`, or when something feels off. Mirrors `npm run doctor`. |
| `/ping` | Live connectivity check for SCG polling, Telegram delivery, source-mode status, and optional OKX WSS runtime state. |
| `/setup_status` | Show a plain-English setup checklist: credentials, wallet, Telegram, OKX OnchainOS, and remaining fixes. |
| `/update` | Check `origin/main`, show incoming commits, then pull + restart through `pm2` after confirmation. Requires `git` and a `pm2` process named `moonbags`. |

### Notification behaviour

Sent to your Telegram chat as events happen. Dedupe is built in so you don't get spammed:

- `🟢 BUY` — every buy (mcap, spent, tx link)
- `⚡ ARMED` — when a position hits the configured trail arm threshold and trailing activates
- `🤖 LLM watching` — fires **once per position** when the LLM advisor first picks it up
- `🤖 LLM tightened 55% → 25%` / `🤖 LLM loosened 25% → 55%` — only when the LLM actually changes the trail (≥1% delta), direction-aware copy
- `🚀 / 🌙 / 💎 / 👑 <TOKEN> hit +100%` — **milestone alerts** with an inline sell button when a position crosses each configured PnL % (fires once per threshold). Tap the button to close in one tap.
- `🟢 SELL` — every close, with reason + PnL. Includes the LLM's reasoning when it triggered the exit.
- `❌ BUY FAILED` — when a swap couldn't land
- `🚨 SELL STUCK` — after 10 sell retries failed (needs manual action)

### Signal source modes

`/sources` controls what can create entry signals:

- **SCG only** — default. Only SCG Alpha alerts can buy.
- **OKX Watch** — SCG still buys; OKX discovery signals are tracked and shown but never bought.
- **Hybrid Live** — SCG alerts and live OKX discovery signals can both buy.
- **OKX only** — SCG keeps polling for health/status, but only OKX discovery signals can buy.
- **GMGN Watch** — SCG still buys; GMGN scanner candidates are filtered, tracked, and shown but never bought.
- **GMGN Live** — SCG alerts and GMGN scanner candidates can both buy after the baseline + tracking trigger passes.
- **GMGN only** — SCG keeps polling for health/status, but only GMGN scanner candidates can buy.

OKX discovery uses `dex-market-new-signal-openapi`, the OnchainOS smart-money/KOL/whale signal feed. Historical `onchainos signal list` rows are used only to seed dedupe on startup, so old rows are not bought. Live OKX signals are treated as entry triggers in Hybrid/OKX-only modes only when they pass the OKX live-buy filter in `state/settings.json`: Smart Money/KOL wallet type and at least 500 holders by default. Pause, blacklist, duplicate/mint cooldown, max-position, and Jupiter execution safety still apply.

The OKX live-buy filter is intentionally separate from exit settings. OKX entries still use your current active exit strategy unless you change it in `/settings`.

GMGN uses a scanner/watchlist flow. Each scan pulls GMGN trending, Trenches, and signal data, applies a fast baseline filter, then tracks surviving mints across multiple scans. Defaults live in `state/settings.json`: holders at least 200, liquidity at least $10k, top-10 holders at most 50%, rug/bundler/bot rates capped, creator hold capped, wash trading rejected, then at least two scans with holder growth, stable liquidity, buy pressure, and smart/KOL confirmation. GMGN Watch is the safest first rollout because it records forward snapshots before allowing live buys.

**Settings you can edit live via `/settings`:**

- `BUY_SIZE_SOL` — SOL per trade
- `MAX_CONCURRENT_POSITIONS` — max open positions
- **Exit Strategy** — Trail, Fixed TP, TP Ladder, or LLM Managed
- **TP targets** — typed as `50:25,100:25,200:25` for +50% sell 25%, +100% sell 25%, etc.
- **Risk Controls** — trail arm, trail drawdown, hard stop, and max hold
- **Runner / Moonbag** — keep a remainder after profit-taking and trail it separately
- **Milestones** — notification thresholds with inline sell buttons
- **LLM Managed** — let MiniMax manage profit exits when configured

**NOT editable from Telegram (security boundary):**

- API keys (`JUP_API_KEY`, `HELIUS_API_KEY`, `OKX_API_KEY`, `OKX_SECRET_KEY`, `OKX_PASSPHRASE`, `MINIMAX_API_KEY`, `TELEGRAM_BOT_TOKEN`)
- Wallet key (`PRIV_B58`)
- `DRY_RUN` (intentionally requires manual `.env` edit + restart)

---

## LLM exit advisor

When you choose **LLM Managed** in Telegram, MoonBags consults MiniMax M2.7 every 30 seconds for each **armed** position.

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
- **Deterministic evidence facts:**
  - *Bearish (reactive):* `bundlerDistribution`, `smartMoneySelling`, `topHolderCapitulation`, `volumeCliff`, `roundTripRisk`
  - *Proactive (sell-into-strength):* `priceAcceleration` (parabolic 1m candle), `volumeBlowoff` (5m volume ≥ 3× hourly avg), `txRatioBurst` (5m tx count ≥ 2× hourly avg), `pctFromAthSpike` (price within 5% of ATH on a +100% winner)
- **Memory:** recent same-position decisions, global closed-trade track record, and similar historical cases when the same evidence facts appeared

### What the LLM can decide

Four actions:

| Action | What happens |
|--------|--------------|
| `hold` | Nothing changes — current trail logic continues |
| `set_trail` | Changes trail % up or down within the configured ceiling. Effective on next 3s tick. |
| `partial_exit` | Sells 10-75% of the current position and leaves the remainder open. |
| `exit_now` | Sells the entire position immediately, bypassing the trail |

The LLM **cannot** buy more or override the hard stop. Aggressive actions are hard-gated: `partial_exit` and `exit_now` are blocked unless the deterministic evidence object allows them, and trail tightening is blocked unless at least two evidence facts are active. Every non-hold reason must cite exact fact keys.

The gate has two unlock paths:
- **Bearish path:** 2+ reactive facts (existing behaviour)
- **Proactive path:** 2+ proactive facts OR 1 proactive + 1 bearish — enables selling into strength at blow-off tops without waiting for on-chain confirmation of the reversal

Each consult writes an audit record to `state/llm_audits/<mint>.json` with the exact prompt payload, evidence facts, similar-case memory, raw tool arguments, parsed decision, and gate result.

### Telegram notifications

Per-position lifecycle with LLM enabled:

```
🟢 BUY YOLO                              ← buy fires
⚡ ARMED YOLO — trailing active          ← PnL hits +50%
🤖 LLM watching YOLO                     ← LLM picks up the position (once)
🤖 LLM tightened YOLO  55% → 25%         ← only on actual change
💰 LLM partial YOLO sold 30%             ← only when evidence gate allows
🟢 SELL YOLO — llm                       ← exit triggered
   PnL: +0.084 SOL (+420.0%)
   peak: +680.5%  |  held: 8m 12s
   LLM: "smart money flipped to selling, bundlers exit-stamping"
```

Polling cost: ~120 LLM calls per armed position per hour. The Starter plan (1500 / 5h) handles ~6 simultaneous armed positions comfortably.

### Safety net

The configured hard stop is **always active** regardless of LLM state. If MiniMax goes down or returns garbage, the bot falls back to the existing trail logic. The LLM never gets to override the floor.

---

## Milestone alerts

When a position's PnL crosses a threshold you configured, a Telegram message fires with an **inline sell button** — one tap to take profit without opening `/positions`.

**Defaults:** `100, 200, 500, 1000` — meaning +100% (🚀 2x), +200% (🌙 3x), +500% (💎 6x), +1000% (👑 11x).

### How it works

- Every 3-second tick, after PnL is computed, the bot checks whether the current PnL just crossed any configured milestone threshold.
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

Editable live via `/settings` in Telegram:

| Setting | Description |
|---------|-------------|
| Enabled | Feature toggle (default ON) |
| Thresholds | Comma-separated % thresholds, e.g. `100,200,500,1000`. Max 10 values. |

Changes take effect on the next tick — no restart needed.

---

## Web dashboard

A live dashboard runs on `http://localhost:8787/` (configurable via `DASHBOARD_PORT`). React/Vite SPA, polls `/api/state` every 2 seconds.

**Signal stats page** — `http://localhost:8787/stats` — auto-refreshing table of win rate by mcap tier, distribution stats (mean/median/stdev), and Pearson correlations. Same data as the Telegram `/stats` command.

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
- **Bottom config strip** — fixed 48px showing BUY, the structured exit block, moonbag controls, LLM, and DRY values. The "EDIT IN TELEGRAM /settings" link auto-resolves your bot username via `getMe` and opens `https://t.me/<botname>` in a new tab.

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
| `state/settings.json` | Live trading exit/settings state edited in Telegram; secrets still live in `.env`. |
| `state/poller.json` | `paused` flag and blacklist — survives restart |
| `state/stranded.json` | Audit log of in-flight positions reconciled on boot. Worth manual review if anything appears here. |

**Backup `state/` periodically** if you want to preserve PnL history.

---

## Operating day-to-day

### Normal flow

1. Send `/doctor` after every install, update, or `.env` change.
2. Send `/setup_status` if `/doctor` reports anything missing.
3. Check `/start` for current SOL balance + open positions.
4. Receive buy/arm/sell notifications as they happen.
5. If something looks off in a position, tap the Sell button in `/positions`.
6. Run `/pnl` at the end of the day for a summary.

### Tuning settings

Use `/settings` from Telegram. Common adjustments:

- **Markets are crazy bullish:** raise `BUY_SIZE_SOL` to deploy more capital per trade.
- **Bot is missing big runners:** widen the Trail setting (e.g. 55% → 70%) so wicks don't shake you out.
- **Too many flat trades:** loosen the Stop setting to give positions more room, or tighten it for lower risk.
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
pm2 restart moonbags --update-env   # after .env or PATH changes
# or
sudo systemctl restart moonbags
```

State is preserved. Positions in flight at the moment of restart are reconciled from your wallet balance and logged to `state/stranded.json`.

### Self-healing updates from Telegram

If the bot is running under `pm2`, `/update` can pull the latest `origin/main`, refresh packages when needed, and restart the bot for you:

```bash
npm install -g pm2
pm2 start "npm run start" --name moonbags
pm2 save
```

Then send `/update` in Telegram. The bot checks for `git`, refuses to update when the working tree has local edits or local-only commits, shows incoming commits, warns when positions are open, and requires a confirm tap before running `git pull --ff-only origin main`. If `package.json` or `package-lock.json` changed, it runs `npm install` before `pm2 restart moonbags --update-env`.

After the restart, send `/doctor` and `/setup_status` to confirm the bot came back healthy.

---

## Backtesting

Two scripts ship with the bot for tuning your trading params and researching individual tokens.

### SCG alert backtester — `src/_backtest.ts`

Fetches the current SCG Alpha alert window, saves a snapshot to `state/backtests/`, then uses each alert's `alert_time` plus `alert_mcap` as the simulated entry when SCG provides enough data to derive supply. If `alert_mcap` cannot be anchored, it falls back to the first usable post-signal candle. It pulls OHLCV after that signal and requires roughly 24 hours of post-signal runway before a token is eligible for the recommendation. The backtester compares deterministic exit modes that Telegram can adopt live:

- **Trail** — arm, trailing drawdown, hard stop.
- **Fixed TP** — sell the whole position at a fixed take-profit percent.
- **TP Ladder** — sell partial chunks at multiple take-profit targets, then trail the remainder.

LLM Managed mode is intentionally not modeled because the LLM reads live holder, smart-money, dev, and momentum context that is not present in OHLCV candles.

**Run with defaults (5m bars, top 15 results):**

```bash
npx tsx src/_backtest.ts
```

**Customize via flags:**

```bash
# Use hot-token mode as a market sanity check instead of the SCG alert window
npx tsx src/_backtest.ts --source hot

# Show top 30 ranked combinations instead of 15
npx tsx src/_backtest.ts --top 30

# Smoke-test the first 25 SCG alerts while developing
npx tsx src/_backtest.ts --tokens 25

# Combine
npx tsx src/_backtest.ts --bar 5m --top 25 --source scg
```

**What you'll see** — a ranked table like this:

```
#1 TP Ladder balanced / ARM 50% / TRAIL 55% / STOP 40%
   total +12,840% | avg +128% | 42W/31L/27H | win 58%
#2 Fixed TP +100% / STOP 40%
   total +12,210% | avg +122% | 38W/35L/27H | win 52%
```

- **TOTAL PnL** — sum of % returns across all simulated trades
- **AVG/TRADE** — average % per trade
- **W / L / H** — wins / losses / still-holding (trade hit neither stop nor trail by end of data)
- **WIN%** — wins as % of completed trades (excluding holding)
- **entries** — how many samples used SCG `alert_mcap` versus the first usable candle as the entry basis

Telegram `/backtest` shows the same recommendation in chat and includes adopt buttons. Adopting saves to `state/settings.json`, switches the exit strategy if needed, and applies on the next position tick without a restart.

The current SCG endpoint does not expose pagination or arbitrary historical ranges; Chrome DevTools shows the Vault calling only `GET https://api.scgalpha.com/api/alerts`, and `limit`, `offset`, `page`, `before`, and `since` probes return the same window. Local snapshots in `state/backtests/` are how MoonBags builds a replayable history going forward.

> ⚠️ Past performance ≠ future results, especially in meme coins. The backtest is a sanity check, not a guarantee.

### Ad-hoc on-chain snapshot — `src/_okxTest.ts`

Pulls a full live snapshot of any token (price + 5m/1h/4h/24h momentum, smart-money / bundler / dev trade flow, top-10 holder PnL, liquidity pools, dev hold %, recent signals, 1m + 5m kline). Same data the LLM advisor sees, dumped to your terminal.

```bash
npx tsx src/_okxTest.ts <mint-address>
```

Useful for manually evaluating a token before whitelisting it, or debugging why the LLM made a particular decision.

---

## Troubleshooting

See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for the practical recovery guide.

Fast checks:

```bash
npm run doctor
pm2 restart moonbags --update-env
pm2 logs moonbags
```

Telegram checks:

```text
/doctor
/setup_status
```

Common fixes:

- OnchainOS missing: `npm run install:onchainos`, then reopen terminal or add `~/.local/bin` to PATH.
- Bot running under old env: `pm2 restart moonbags --update-env`.
- Telegram quiet: send `/doctor`, then `/setup_status`, then check `pm2 logs moonbags`.
- No entry signals: send `/ping`. If it says the poller is alive but recent decisions are filtered, check `MAX_ALERT_AGE_MINS`, `MIN_LIQUIDITY_USD`, `MIN_SCORE`, and the other alert filters in `.env`. `0` disables each numeric filter. Also check `/mcapfilter` — if an mcap range is active, alerts outside it are silently dropped.
- WSS off: this is normal unless you set `OKX_WSS_ENABLED=true`. WSS is only an acceleration layer for positions you already hold; Jupiter still confirms every exit.
- Need latest version: send `/update` in Telegram after `pm2` is set up.

---

## Safety notes

1. **Use a dedicated wallet.** Never put a wallet that holds anything important into `PRIV_B58`. Funds in this wallet are exposed to whatever the bot does.
2. **Start with `DRY_RUN=true`.** Watch logs for at least an hour before going live.
3. **Start with small `BUY_SIZE_SOL`.** 0.02 SOL is a safe starting point — that's roughly $4 per trade at $200/SOL. Scale up only after seeing the bot perform.
4. **Keep a stop loss set.** This is your floor. The LLM and the trail can both be wrong; the hard stop saves you from total wipeout on a single trade.
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
├── okxSignalSource.ts   ← optional OKX discovery source for `/sources`
├── gmgnClient.ts        ← GMGN OpenAPI client for optional GMGN source modes
├── gmgnSignalSource.ts  ← GMGN scanner/watchlist source for `/sources`
├── llmExitAdvisor.ts    ← MiniMax M2.7 client + tool calling (`enable_thinking`, `extra_body.reasoning_split`)
├── notifier.ts          ← Telegram notifications (with HTML escaping)
├── telegramBot.ts       ← Telegram command handler (long polling, force_reply for edits)
├── server.ts            ← localhost web dashboard backend (`/api/state` JSON, `/api/stats` signal stats, `/stats` HTML page, static serve)
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
