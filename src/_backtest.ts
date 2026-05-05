/**
 * Backtest: optimize exit strategy using OKX hot-tokens list.
 *
 * Usage:
 *   npx tsx src/_backtest.ts                         # all deterministic exit modes (default)
 *   npx tsx src/_backtest.ts --strategy simple        # simple trail grid
 *   npx tsx src/_backtest.ts --strategy hybrid        # trail + scale-out + moonbag grid
 *   npx tsx src/_backtest.ts --bar 5m --top 20
 *   npx tsx src/_backtest.ts --min-candles 80
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import type { SignalAlertsResponse } from "./types.js";
import {
  getMarketSignal,
  getMarketTrenches,
  getMarketTrending,
  isGmgnConfigured,
  type GmgnRow,
} from "./gmgnClient.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const arg = (flag: string, def: string) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? (process.argv[i + 1] ?? def) : def;
};
const BAR         = arg("--bar", "5m");
const TOP_N       = parseInt(arg("--top", "15"));
const TOKEN_LIMIT = parseInt(arg("--tokens", "0"));
const MIN_CANDLES = parseInt(arg("--min-candles", "60"));   // ~5 hours of 5m data
const STRATEGY    = arg("--strategy", "all");               // "all" | "simple" | "hybrid" | "protective"
const SOURCE      = arg("--source", "gmgn");                // "private" | "hot" | "gmgn" | "okx"
const FEE_BPS     = parseInt(arg("--fee-bps", "50"));         // Ultra platform fee per swap (50 bps = 0.5%)
const SLIPPAGE_BPS = parseInt(arg("--slippage-bps", "150"));  // estimated slippage per swap (150 bps = 1.5%)

// Grid — keep tight to avoid huge run times; adjust freely
const ARM_RANGE   = [0.30, 0.40, 0.50, 0.60];
const TRAIL_RANGE = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.65, 0.75, 0.85];
const STOP_RANGE  = [0.30, 0.40, 0.50, 0.60];

// Hybrid-only grids (scale-out + moonbag)
const SCALEOUT_PCT_RANGE  = [0, 0.25, 0.50];   // fraction sold at first target (0 = disabled)
const SCALEOUT_MULT_RANGE = [2, 3, 5];          // multiplier to trigger scale-out
const MOONBAG_PCT_RANGE   = [0, 0.10, 0.20];    // fraction kept after trail (0 = disabled)
const MB_TRAIL_RANGE      = [0.50, 0.60, 0.70]; // moonbag's own trail (drawdown from its peak)
const MB_TIMEOUT_RANGE    = [30, 60, 120];       // moonbag max hold in minutes
const FIXED_TP_RANGE      = [0.50, 0.75, 1.00, 1.50, 2.00, 3.00, 5.00];
const TP_LADDER_PRESETS   = [
  { label: "fast", targets: [{ pnlPct: 0.50, sellPct: 0.50 }, { pnlPct: 1.00, sellPct: 1.00 }] },
  { label: "balanced", targets: [{ pnlPct: 0.50, sellPct: 0.25 }, { pnlPct: 1.00, sellPct: 0.25 }, { pnlPct: 2.00, sellPct: 1.00 }] },
  { label: "runner", targets: [{ pnlPct: 0.50, sellPct: 0.25 }, { pnlPct: 1.00, sellPct: 0.25 }, { pnlPct: 2.00, sellPct: 0.25 }] },
];

// Protective-only grids (break-even protect + hard take-profit)
// For BE: once price crosses the threshold, stop floor moves to entry (0% PnL).
// For TP: sell everything when price reaches the threshold.
// Set to 0 to disable that mechanism. A row with both BE=0 and TP=0 is the baseline.
const BREAK_EVEN_RANGE = [0, 0.50, 0.75, 1.00];            // 50% / 75% / 100% PnL triggers break-even protection
const HARD_TP_RANGE    = [0, 0.50, 1.00, 2.00, 3.00, 5.00]; // 50% / 1x / 2x / 3x / 5x flat take-profit

// Bar interval to ms lookup for timeout simulation
const BAR_MS: Record<string, number> = {
  "1s": 1_000, "1m": 60_000, "5m": 300_000, "15m": 900_000,
  "30m": 1_800_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000,
};
const PRIVATE_SIGNAL_BAR_PRIORITY = ["5m", "15m", "1H"] as const;
const PRIVATE_SIGNAL_MIN_RUNWAY_MS = 24 * 60 * 60 * 1000;
const MIN_CANDLES_BY_BAR: Record<string, number> = {
  "1m": 240,
  "5m": 288,
  "15m": 96,
  "1H": 24,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Candle { ts: number; open: number; high: number; low: number; close: number }
interface SimResult { exitPct: number; reason: "trail" | "stop" | "tp" | "holding" | "no_entry" }
interface TokenSample {
  address: string;
  symbol: string;
  alertTimeSec?: number;
  alertMcap?: number;
  impliedSupply?: number;
  source: "private" | "hot" | "gmgn" | "okx";
}
interface CandleSample {
  symbol: string;
  candles: Candle[];
  bar: string;
  entryValue?: number;
  entrySource: "alert_mcap" | "first_candle";
}
export type BacktestExitMode = "trail" | "fixed_tp" | "tp_ladder";
export type BacktestTpTarget = { pnlPct: number; sellPct: number };
interface GridResult {
  strategyMode: BacktestExitMode;
  arm: number; trail: number; stop: number;
  scaleoutPct: number; scaleoutMult: number; moonbagPct: number;
  mbTrail: number; mbTimeout: number;
  breakEvenAfter: number; hardTPPct: number;
  fixedTargetPct: number;
  ladderLabel: string;
  ladderTargets: BacktestTpTarget[];
  trailRemainder: boolean;
  totalPnlPct: number; avgExitPct: number;
  wins: number; losses: number; holding: number; noEntry: number; trades: number;
  tpHits: number;       // how many trades exited via hard TP
  beSaves: number;      // how many trades exited via break-even stop (saved from loss)
}

type OnchainosResponse<T> = {
  ok?: boolean;
  data?: T;
  error?: string;
};

type CliError = Error & {
  code?: number | string;
  signal?: string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

function onchainosEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.OKX_PASSPHRASE && env.OKX_API_PASSPHRASE) {
    env.OKX_PASSPHRASE = env.OKX_API_PASSPHRASE;
  }
  return env;
}

function describeCliError(err: unknown): string {
  const e = err as CliError;
  const chunks = [
    e.message,
    String(e.stderr ?? "").trim(),
    String(e.stdout ?? "").trim(),
  ].filter(Boolean);
  return chunks.join(" | ").slice(0, 800);
}

async function runOnchainosJson<T>(args: string[], timeout: number): Promise<T> {
  try {
    const { stdout } = await execFileAsync("onchainos", args, {
      timeout,
      env: onchainosEnv(),
    });
    const parsed = JSON.parse(String(stdout)) as OnchainosResponse<T>;
    if (parsed.ok === false) {
      throw new Error(parsed.error ?? "onchainos returned ok=false");
    }
    return parsed.data as T;
  } catch (err) {
    throw new Error(`onchainos ${args.join(" ")} failed: ${describeCliError(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Fetch top 100 hot Solana tokens (sorted by 24h volume). Uses onchainos'
// `token hot-tokens` endpoint — the old `token trending` subcommand was
// removed in onchainos v2.3.0, so we rely exclusively on hot-tokens now.
// ---------------------------------------------------------------------------
async function fetchHotTokens(): Promise<TokenSample[]> {
  type RawToken = { tokenContractAddress: string; tokenSymbol: string };
  const args = [
    "token", "hot-tokens",
    "--chain", "solana",
    "--rank-by", "5",      // volume
    "--time-frame", "4",   // 24h
    "--limit", "100",      // max allowed (default was 20)
  ];

  try {
    const rows = await runOnchainosJson<RawToken[]>(args, 15_000);
    const tokens = (rows ?? [])
      .map(t => ({ address: t.tokenContractAddress, symbol: t.tokenSymbol, source: "hot" as const }))
      .filter(t => t.address && t.symbol);
    if (tokens.length > 0) return tokens;
    throw new Error("hot-tokens returned no tokens");
  } catch (err) {
    throw new Error(
      "Unable to fetch OKX hot-tokens list. Update onchainos with `npm run install:onchainos`, " +
      `then verify \`onchainos token hot-tokens --help\`. Cause: ${(err as Error).message}`,
    );
  }
}

function pickGmgnString(row: GmgnRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function pickGmgnNumber(row: GmgnRow, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = row[key];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

type OkxHotTokenRow = {
  tokenContractAddress?: string;
  tokenSymbol?: string;
  marketCap?: string;
  firstTradeTime?: string;
};

// Fetch OKX hot-tokens across all four time frames (5m, 1h, 4h, 24h) and
// deduplicate by mint. Using only the 5m frame returns tokens born minutes ago
// that have no OHLCV history; the broader sweep surfaces tokens that are still
// hot after 24h+ and therefore have the candle runway the backtest needs.
// Tokens without a firstTradeTime skip the runway check and just need minCandles.
async function fetchOkxSignals(): Promise<TokenSample[]> {
  const TIME_FRAMES = ["1", "2", "3", "4"]; // 5m, 1h, 4h, 24h
  const seen = new Set<string>();
  const out: TokenSample[] = [];

  for (const tf of TIME_FRAMES) {
    const rows = await runOnchainosJson<OkxHotTokenRow[]>([
      "token", "hot-tokens",
      "--chain", "solana",
      "--rank-by", "5",
      "--time-frame", tf,
      "--limit", "100",
    ], 15_000).catch(() => null);
    if (!rows || rows.length === 0) continue;
    for (const row of rows) {
      const mint = row.tokenContractAddress ?? "";
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      const tsMs = Number(row.firstTradeTime);
      const alertTimeSec = Number.isFinite(tsMs) && tsMs > 0
        ? (tsMs > 1e12 ? Math.floor(tsMs / 1000) : Math.floor(tsMs))
        : undefined;
      out.push({
        address: mint,
        symbol: row.tokenSymbol ?? mint.slice(0, 6),
        alertTimeSec,
        alertMcap: Number(row.marketCap) || undefined,
        source: "okx",
      });
    }
  }

  if (out.length === 0) {
    throw new Error(
      "OKX hot-tokens returned no tokens across all time frames. Check onchainos CLI auth and `onchainos token hot-tokens --chain solana --rank-by 5 --time-frame 4 --limit 1`.",
    );
  }
  return out;
}

async function fetchGmgnTokens(): Promise<TokenSample[]> {
  if (!isGmgnConfigured()) {
    throw new Error("GMGN_API_KEY is not set — cannot run GMGN backtest. Add it to .env and restart.");
  }
  const chain = "sol" as const;
  const settled = await Promise.allSettled([
    getMarketSignal(chain, { groups: [{ signal_type: [12] }], limit: 50 }),
    getMarketTrenches(chain, { limit: 50 }),
    getMarketTrending(chain, "5m", { limit: 50 }),
  ]);
  const signalRows = settled[0].status === "fulfilled" ? settled[0].value : [];
  const trenchesRows = settled[1].status === "fulfilled" ? settled[1].value : [];
  const trendingRows = settled[2].status === "fulfilled" ? settled[2].value : [];

  const seen = new Set<string>();
  const tokens: TokenSample[] = [];

  const harvest = (rows: GmgnRow[], withTimestamp: boolean) => {
    for (const row of rows) {
      const address = pickGmgnString(row, ["address", "token_address", "mint", "contract_address"]);
      if (!address || seen.has(address)) continue;
      const symbol = pickGmgnString(row, ["symbol", "name"]) ?? address.slice(0, 6);
      const alertTimeSec = withTimestamp
        ? pickGmgnNumber(row, ["signal_time", "created_at", "timestamp", "open_timestamp", "call_time"])
        : undefined;
      const alertMcap = pickGmgnNumber(row, ["market_cap", "marketCap", "marketCapUsd", "mcap"]);
      seen.add(address);
      tokens.push({
        address,
        symbol,
        alertTimeSec: alertTimeSec && alertTimeSec > 1_600_000_000 && alertTimeSec < 2_000_000_000_000
          ? (alertTimeSec > 1e12 ? Math.floor(alertTimeSec / 1000) : Math.floor(alertTimeSec))
          : undefined,
        alertMcap,
        source: "gmgn",
      });
    }
  };

  harvest(signalRows, true);
  harvest(trenchesRows, false);
  harvest(trendingRows, false);

  if (tokens.length === 0) {
    throw new Error("GMGN returned no tokens across signal/trenches/trending endpoints.");
  }
  return tokens;
}

async function fetchPrivateTokens(): Promise<TokenSample[]> {
  if (!CONFIG.PRIVATE_SIGNAL_API_URL || !CONFIG.PRIVATE_SIGNAL_API_KEY) {
    throw new Error("Private Feed backtest requires PRIVATE_SIGNAL_API_URL and PRIVATE_SIGNAL_API_KEY in .env");
  }
  const res = await fetch(CONFIG.PRIVATE_SIGNAL_API_URL, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${CONFIG.PRIVATE_SIGNAL_API_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Private Feed alerts failed: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as SignalAlertsResponse;
  const alerts = Array.isArray(body?.alerts) ? body.alerts : [];
  const seen = new Set<string>();
  const tokens: TokenSample[] = [];

  for (const alert of alerts) {
    if (!alert.mint || seen.has(alert.mint)) continue;
    seen.add(alert.mint);
    tokens.push({
      address: alert.mint,
      symbol: alert.name || alert.mint.slice(0, 6),
      alertTimeSec: alert.alert_time,
      alertMcap: alert.alert_mcap,
      impliedSupply: estimateSupplyFromAlert(alert),
      source: "private",
    });
  }

  if (tokens.length === 0) throw new Error("Private Feed alerts returned no tokens");
  await savePrivateSignalSnapshot(alerts).catch(() => undefined);
  return tokens;
}

function estimateSupplyFromAlert(alert: SignalAlertsResponse["alerts"][number]): number | undefined {
  const supplies = Object.values(alert.tracked_prices ?? {})
    .map((tracked) => tracked.price > 0 && tracked.mcap > 0 ? tracked.mcap / tracked.price : NaN)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (supplies.length === 0) return undefined;
  return supplies[Math.floor(supplies.length / 2)];
}

async function savePrivateSignalSnapshot(alerts: SignalAlertsResponse["alerts"]): Promise<void> {
  const dir = path.resolve("state", "backtests");
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await writeFile(
    path.join(dir, `private-alerts-${timestamp}.json`),
    JSON.stringify({ capturedAt: new Date().toISOString(), source: "private", alerts }, null, 2),
  );
}

function candlesAfterAlert(candles: Candle[], alertTimeSec?: number): Candle[] {
  if (!alertTimeSec || !Number.isFinite(alertTimeSec)) return candles;
  const alertMs = alertTimeSec * 1000;
  const firstTs = candles[0]?.ts;
  const lastTs = candles[candles.length - 1]?.ts;
  if (!firstTs || !lastTs || alertMs < firstTs || alertMs > lastTs) return [];
  return candles.filter((c) => c.ts >= alertMs);
}

function hasRunway(candles: Candle[], alertTimeSec?: number): boolean {
  if (!alertTimeSec || !Number.isFinite(alertTimeSec)) return true;
  const lastTs = candles[candles.length - 1]?.ts;
  return Boolean(lastTs && lastTs - alertTimeSec * 1000 >= PRIVATE_SIGNAL_MIN_RUNWAY_MS);
}

function minCandlesForBar(bar: string, configuredMin: number, source: "private" | "hot" | "gmgn" | "okx"): number {
  if (source === "private" || source === "gmgn" || source === "okx") return MIN_CANDLES_BY_BAR[bar] ?? configuredMin;
  return configuredMin;
}

async function fetchSampleCandles(token: TokenSample, preferredBar: string, configuredMin: number): Promise<CandleSample | null> {
  const hasAlertTime = Boolean(token.alertTimeSec && Number.isFinite(token.alertTimeSec));
  if (token.source !== "private" && !hasAlertTime) {
    const candles = await fetchKlines(token.address, preferredBar);
    return candles.length >= configuredMin
      ? { symbol: token.symbol, candles, bar: preferredBar, entrySource: "first_candle" }
      : null;
  }

  const bars = Array.from(new Set([preferredBar, ...PRIVATE_SIGNAL_BAR_PRIORITY]));
  const eagerBars = bars.slice(0, 2);
  const eager = await Promise.all(eagerBars.map(async (bar) => ({ bar, candles: candlesAfterAlert(await fetchKlines(token.address, bar), token.alertTimeSec) })));
  for (const sample of eager) {
    if (sample.candles.length >= minCandlesForBar(sample.bar, configuredMin, token.source) && hasRunway(sample.candles, token.alertTimeSec)) {
      return buildCandleSample(token, sample.candles, sample.bar);
    }
  }

  for (const bar of bars.slice(2)) {
    const candles = candlesAfterAlert(await fetchKlines(token.address, bar), token.alertTimeSec);
    if (candles.length >= minCandlesForBar(bar, configuredMin, token.source) && hasRunway(candles, token.alertTimeSec)) {
      return buildCandleSample(token, candles, bar);
    }
  }
  return null;
}

function buildCandleSample(token: TokenSample, candles: Candle[], bar: string): CandleSample {
  if (token.alertMcap && token.alertMcap > 0 && token.impliedSupply && token.impliedSupply > 0) {
    return {
      symbol: token.symbol,
      candles: candles.map((c) => ({
        ts: c.ts,
        open: c.open * token.impliedSupply!,
        high: c.high * token.impliedSupply!,
        low: c.low * token.impliedSupply!,
        close: c.close * token.impliedSupply!,
      })),
      bar,
      entryValue: token.alertMcap,
      entrySource: "alert_mcap",
    };
  }
  return { symbol: token.symbol, candles, bar, entrySource: "first_candle" };
}

// ---------------------------------------------------------------------------
// Fetch OKX klines for one token
// ---------------------------------------------------------------------------
async function fetchKlines(address: string, bar: string = BAR): Promise<Candle[]> {
  try {
    const data = await runOnchainosJson<Array<{ ts: string; o: string; h: string; l: string; c: string }>>([
      "market", "kline",
      "--address", address,
      "--chain", "solana",
      "--bar", bar,
      "--limit", "299",
    ], 10_000);

    if (!data?.length) return [];

    return data
      .map(c => ({
        ts:    Number(c.ts),
        open:  parseFloat(c.o),
        high:  parseFloat(c.h),
        low:   parseFloat(c.l),
        close: parseFloat(c.c),
      }))
      .filter(c => c.open > 0)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Simulate one trade with given params.
// Entry = Private Feed alert market cap when available, otherwise first candle open.
// Supports partial scale-out and moonbag.
// ---------------------------------------------------------------------------
// NOTE on entry timing:
//   We don't replicate Private Feed's upstream filter (we don't know exactly what it is),
//   so we take all hot-tokens and enter each one at the oldest candle in the fetched
//   window. This simulates "bot received some signal and entered; test forward from
//   there." The hot-tokens bias (they already pumped) cuts the other way — if the
//   bot had received an alert 25h ago it would have been at the start of the pump.
//   Rankings are differentiated by the exit math (trigger-price exits) and by
//   excluding mark-to-market holdings from the PnL total.

function simulate(
  candles: Candle[],
  arm: number, trail: number, stop: number,
  scaleoutPct = 0, scaleoutMult = 0, moonbagPct = 0,
  mbTrail = 0.60, mbTimeoutMs = 0,
  breakEvenAfter = 0,   // if > 0, once price crosses (1+breakEvenAfter), stop floor moves to entry
  hardTPPct = 0,        // if > 0, sell everything at the TP level (1+hardTPPct)
  strategyMode: BacktestExitMode = "trail",
  ladderTargets: BacktestTpTarget[] = [],
  trailRemainder = true,
  entryValue?: number,
): SimResult {
  const firstCandle = candles[0];
  if (!firstCandle) return { exitPct: 0, reason: "no_entry" };
  const rawEntry = entryValue && entryValue > 0 ? entryValue : firstCandle.open;
  if (!rawEntry || rawEntry <= 0) return { exitPct: 0, reason: "no_entry" };

  // Apply fee + slippage haircut: each swap costs (FEE_BPS + SLIPPAGE_BPS)/10000
  // Effective entry price = raw * (1 + haircut), every sell price * (1 - haircut)
  const haircut = (FEE_BPS + SLIPPAGE_BPS) / 10_000;
  const entry = rawEntry * (1 + haircut);
  // Decision thresholds use raw mid-market, not haircut-adjusted entry
  const decEntry = rawEntry;
  const adjSell = (p: number) => p * (1 - haircut);

  let runPeak = rawEntry;
  let armed = false;
  let position = 1.0;
  let realizedPnl = 0;
  let scaledOut = false;
  let moonbagMode = false;
  let mbPeak = 0;
  let mbStartTs = 0;
  let breakEvenArmed = false;   // once true, hard stop floor becomes entry (0% PnL)
  const ladderHit = new Set<number>();

  for (const c of candles) {
    if (!moonbagMode) {
      if (c.high > runPeak) runPeak = c.high;
      const trailEligible = strategyMode === "trail" ||
        (strategyMode === "tp_ladder" && trailRemainder && ladderHit.size > 0);
      if (!armed && trailEligible && (c.high / decEntry - 1) >= arm) armed = true;

      // Break-even protect: once price ever crosses the trigger, we never let
      // the position close below entry. Flips on at the FIRST candle whose
      // high breaches the threshold.
      if (breakEvenAfter > 0 && !breakEvenArmed && (c.high / decEntry - 1) >= breakEvenAfter) {
        breakEvenArmed = true;
      }

      // Hard take-profit: flat exit at the TP level. Takes precedence over
      // trail/stop/scaleout — if the TP is hit, we're done.
      if (hardTPPct > 0 && (c.high / decEntry - 1) >= hardTPPct) {
        const tpPrice = decEntry * (1 + hardTPPct);
        realizedPnl += position * (adjSell(tpPrice) / entry - 1);
        return { exitPct: realizedPnl * 100, reason: "tp" };
      }

      if (strategyMode === "tp_ladder" && ladderTargets.length > 0) {
        for (let i = 0; i < ladderTargets.length; i++) {
          const target = ladderTargets[i]!;
          if (ladderHit.has(i) || (c.high / decEntry - 1) < target.pnlPct) continue;
          const tpPrice = decEntry * (1 + target.pnlPct);
          const sellPct = Math.min(position, position * target.sellPct);
          realizedPnl += sellPct * (adjSell(tpPrice) / entry - 1);
          position -= sellPct;
          ladderHit.add(i);
          if (position <= 0.001 || target.sellPct >= 0.999) {
            return { exitPct: realizedPnl * 100, reason: "tp" };
          }
        }
        if (!armed && trailRemainder && ladderHit.size > 0 && (c.high / decEntry - 1) >= arm) {
          armed = true;
        }
      }
    }

    // scale-out: sell a fraction at the multiplier target
    if (!scaledOut && scaleoutPct > 0 && c.high >= decEntry * scaleoutMult) {
      const sellPrice = decEntry * scaleoutMult;
      realizedPnl += scaleoutPct * (adjSell(sellPrice) / entry - 1);
      position -= scaleoutPct;
      scaledOut = true;
    }

    // moonbag phase: its own trail + timeout
    if (moonbagMode) {
      if (c.high > mbPeak) mbPeak = c.high;

      const mbTimedOut = mbTimeoutMs > 0 && (c.ts - mbStartTs) >= mbTimeoutMs;
      const mbTrailed  = mbTrail > 0 && mbPeak > 0 && c.low <= mbPeak * (1 - mbTrail);

      if (mbTimedOut || mbTrailed) {
        realizedPnl += position * (adjSell(c.close) / entry - 1);
        return { exitPct: realizedPnl * 100, reason: "trail" };
      }
      continue;
    }

    // stop loss — live bot sells the moment price crosses entry×(1-stop).
    // If break-even armed, the floor is entry itself (0% PnL).
    const stopFloor = breakEvenArmed ? 0 : -stop;
    const stopPrice = breakEvenArmed ? decEntry : decEntry * (1 + stopFloor);
    if (c.low <= stopPrice) {
      // Exit AT the trigger price, not at c.close. This mirrors the live bot
      // which sells the instant the level is crossed (2s polling).
      realizedPnl += position * (adjSell(stopPrice) / entry - 1);
      return { exitPct: realizedPnl * 100, reason: "stop" };
    }

    // trailing stop — live bot sells the moment drawdown from peak ≥ trail%,
    // i.e. the moment price crosses peak × (1 - trail). Exit AT that level,
    // not at c.close, so different trails produce different exits.
    const canTrail = strategyMode === "trail" ||
      (strategyMode === "tp_ladder" && trailRemainder && ladderHit.size > 0);
    if (canTrail && armed) {
      const trailPrice = runPeak * (1 - trail);
      if (c.low <= trailPrice) {
        if (moonbagPct > 0 && position > moonbagPct) {
          const trailSellPct = position - moonbagPct;
          realizedPnl += trailSellPct * (adjSell(trailPrice) / entry - 1);
          position = moonbagPct;
          moonbagMode = true;
          mbPeak = trailPrice;
          mbStartTs = c.ts;
        } else {
          realizedPnl += position * (adjSell(trailPrice) / entry - 1);
          return { exitPct: realizedPnl * 100, reason: "trail" };
        }
      }
    }
  }

  // end of data — mark-to-market remaining position (apply haircut as if sold)
  const lastClose = candles[candles.length - 1]?.close ?? entry;
  realizedPnl += position * (adjSell(lastClose) / entry - 1);
  return { exitPct: realizedPnl * 100, reason: "holding" };
}

// ---------------------------------------------------------------------------
// Library entry point — usable from the Telegram /backtest command.
// Returns top N sorted results without printing or saving a CSV.
// ---------------------------------------------------------------------------
export interface RunBacktestOptions {
  bar?: string;            // "1m" | "5m" | "15m" | "1H" | "4H" | "1D"   default "1m"
  minCandles?: number;     // skip tokens with fewer candles. default 60
  topN?: number;           // how many top results to return. default 10
  armRange?: number[];
  trailRange?: number[];
  stopRange?: number[];
  // Hybrid mode: additionally grid over moonbag params (partial kept after trail fires).
  // Scale-out is deliberately NOT included — the live bot has no scale-out feature,
  // so grading it would produce unusable adoptable params.
  hybrid?: boolean;
  allStrategies?: boolean;      // compare trail, fixed TP, TP ladder, and a small moonbag grid.
  moonbagRange?: number[];    // fraction kept after trail (0 = disabled). default [0, 0.10, 0.20]
  mbTrailRange?: number[];    // moonbag's own drawdown trail. default [0.50, 0.60, 0.70]
  mbTimeoutRange?: number[];  // moonbag max hold, minutes. default [30, 60, 120]
  onProgress?: (stage: "fetching" | "simulating", pct: number) => void;
  source?: "private" | "hot" | "gmgn" | "okx";
  tokenLimit?: number;
}

export interface RunBacktestResult {
  samplesUsed: number;
  tokensFetched: number;
  allResults: GridResult[];     // full grid, sorted best→worst
  topResults: GridResult[];     // top N slice for convenience
  bar: string;
  source: "private" | "hot" | "gmgn" | "okx";
  resolutionCounts: Record<string, number>;
  entrySourceCounts: Record<string, number>;
  durationMs: number;
}

export async function runBacktest(opts: RunBacktestOptions = {}): Promise<RunBacktestResult> {
  // Default to 5m bars — at OKX's 299-candle cap, 5m = ~25h of forward runway per
  // token. 1m gives tighter exit fidelity but only 5h of runway, which leaves
  // most hot-tokens in "holding" state (not enough time to trigger trail/stop).
  // Trade-off: 5m intra-candle dumps resolve to candle close for price path, but
  // exits still fire AT peak×(1-trail) trigger levels (not at candle close), so
  // different trails are still correctly differentiated.
  const bar = opts.bar ?? "5m";
  const minCandles = opts.minCandles ?? 60;
  const topN = opts.topN ?? 10;
  const source = opts.source ?? "gmgn";
  const armRange   = opts.armRange ?? ARM_RANGE;
  const trailRange = opts.trailRange ?? TRAIL_RANGE;
  const stopRange  = opts.stopRange ?? STOP_RANGE;

  const start = Date.now();

  // 1. Fetch hot tokens
  opts.onProgress?.("fetching", 0);
  const fetchedTokens =
    source === "private"
      ? await fetchPrivateTokens()
      : source === "gmgn"
      ? await fetchGmgnTokens()
      : source === "okx"
        ? await fetchOkxSignals()
        : await fetchHotTokens();
  const tokens = opts.tokenLimit && opts.tokenLimit > 0 ? fetchedTokens.slice(0, opts.tokenLimit) : fetchedTokens;

  // 2. Fetch klines in parallel batches
  const samples: CandleSample[] = [];
  for (let i = 0; i < tokens.length; i += 5) {
    const batch = tokens.slice(i, i + 5);
    const results = await Promise.all(batch.map((t) => fetchSampleCandles(t, bar, minCandles)));
    for (const r of results) {
      if (r) samples.push(r);
    }
    opts.onProgress?.("fetching", Math.min(100, Math.round(((i + 5) / tokens.length) * 100)));
    if (i + 5 < tokens.length) await new Promise(r => setTimeout(r, 400));
  }
  const resolutionCounts = samples.reduce<Record<string, number>>((acc, sample) => {
    acc[sample.bar] = (acc[sample.bar] ?? 0) + 1;
    return acc;
  }, {});
  const entrySourceCounts = samples.reduce<Record<string, number>>((acc, sample) => {
    acc[sample.entrySource] = (acc[sample.entrySource] ?? 0) + 1;
    return acc;
  }, {});
  if (samples.length === 0) {
    return {
      samplesUsed: 0,
      tokensFetched: fetchedTokens.length,
      allResults: [],
      topResults: [],
      bar,
      source,
      resolutionCounts,
      entrySourceCounts,
      durationMs: Date.now() - start,
    };
  }

  // 3. Build grid. Simple mode: ARM × TRAIL × STOP. Hybrid mode additionally
  //    grids over moonbag params. All-strategies mode compares deterministic
  //    exit families that Telegram can adopt: trail, fixed TP, and TP ladder.
  const mbRange   = opts.moonbagRange  ?? [0, 0.10, 0.20];
  const mbtRange  = opts.mbTrailRange  ?? [0.50, 0.60, 0.70];
  const mbtoRange = opts.mbTimeoutRange ?? [30, 60, 120];
  type Combo = {
    strategyMode: BacktestExitMode;
    arm: number; trail: number; stop: number;
    mbPct: number; mbTrail: number; mbTimeout: number;
    fixedTargetPct: number;
    ladderLabel: string;
    ladderTargets: BacktestTpTarget[];
    trailRemainder: boolean;
  };
  const combos: Combo[] = [];
  for (const arm of armRange) {
    for (const trail of trailRange) {
      for (const stop of stopRange) {
        if (opts.allStrategies) {
          combos.push({
            strategyMode: "trail",
            arm, trail, stop,
            mbPct: 0, mbTrail: 0, mbTimeout: 0,
            fixedTargetPct: 0,
            ladderLabel: "",
            ladderTargets: [],
            trailRemainder: true,
          });
          for (const fixedTargetPct of FIXED_TP_RANGE) {
            combos.push({
              strategyMode: "fixed_tp",
              arm: 0, trail: 0, stop,
              mbPct: 0, mbTrail: 0, mbTimeout: 0,
              fixedTargetPct,
              ladderLabel: "",
              ladderTargets: [],
              trailRemainder: false,
            });
          }
          for (const preset of TP_LADDER_PRESETS) {
            combos.push({
              strategyMode: "tp_ladder",
              arm, trail, stop,
              mbPct: 0, mbTrail: 0, mbTimeout: 0,
              fixedTargetPct: 0,
              ladderLabel: preset.label,
              ladderTargets: preset.targets,
              trailRemainder: true,
            });
          }
          combos.push({
            strategyMode: "trail",
            arm, trail, stop,
            mbPct: 0.10, mbTrail: 0.60, mbTimeout: 60,
            fixedTargetPct: 0,
            ladderLabel: "",
            ladderTargets: [],
            trailRemainder: true,
          });
        } else if (!opts.hybrid) {
          combos.push({
            strategyMode: "trail",
            arm, trail, stop,
            mbPct: 0, mbTrail: 0, mbTimeout: 0,
            fixedTargetPct: 0,
            ladderLabel: "",
            ladderTargets: [],
            trailRemainder: true,
          });
        } else {
          for (const mbPct of mbRange) {
            if (mbPct === 0) {
              combos.push({
                strategyMode: "trail",
                arm, trail, stop,
                mbPct: 0, mbTrail: 0, mbTimeout: 0,
                fixedTargetPct: 0,
                ladderLabel: "",
                ladderTargets: [],
                trailRemainder: true,
              });
            } else {
              for (const mbTrail of mbtRange) {
                for (const mbTimeout of mbtoRange) {
                  combos.push({
                    strategyMode: "trail",
                    arm, trail, stop,
                    mbPct, mbTrail, mbTimeout,
                    fixedTargetPct: 0,
                    ladderLabel: "",
                    ladderTargets: [],
                    trailRemainder: true,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  const uniqueCombos = new Map<string, Combo>();
  for (const combo of combos) {
    const key = [
      combo.strategyMode,
      combo.arm, combo.trail, combo.stop,
      combo.mbPct, combo.mbTrail, combo.mbTimeout,
      combo.fixedTargetPct,
      combo.ladderLabel,
      combo.ladderTargets.map((target) => `${target.pnlPct}:${target.sellPct}`).join(","),
      combo.trailRemainder,
    ].join("|");
    uniqueCombos.set(key, combo);
  }
  combos.splice(0, combos.length, ...uniqueCombos.values());

  // 4. Simulate
  //    PnL totals only include DECIDED trades (trail/stop/tp).
  //    "holding" (never-exited) and "no_entry" (signal never fired) are tracked
  //    separately so they can't distort the ranking.
  const results: GridResult[] = [];
  for (let i = 0; i < combos.length; i++) {
    const combo = combos[i]!;
    let totalPnlPct = 0, wins = 0, losses = 0, holding = 0, noEntry = 0;
    for (const s of samples) {
      const sim = simulate(
        s.candles,
        combo.arm, combo.trail, combo.stop,
        0, 0,                                    // no scale-out
        combo.mbPct, combo.mbTrail, combo.mbTimeout * 60_000,
        0, combo.fixedTargetPct,
        combo.strategyMode, combo.ladderTargets, combo.trailRemainder,
        s.entryValue,
      );
      if (sim.reason === "no_entry") { noEntry++; continue; }
      if (sim.reason === "holding") { holding++; continue; } // exclude from PnL totals
      totalPnlPct += sim.exitPct;
      if (sim.exitPct >= 0) wins++;
      else losses++;
    }
    const decidedTrades = wins + losses;
    results.push({
      strategyMode: combo.strategyMode,
      arm: combo.arm, trail: combo.trail, stop: combo.stop,
      scaleoutPct: 0, scaleoutMult: 0,
      moonbagPct: combo.mbPct, mbTrail: combo.mbTrail, mbTimeout: combo.mbTimeout,
      breakEvenAfter: 0, hardTPPct: combo.fixedTargetPct,
      fixedTargetPct: combo.fixedTargetPct,
      ladderLabel: combo.ladderLabel,
      ladderTargets: combo.ladderTargets,
      trailRemainder: combo.trailRemainder,
      totalPnlPct,
      avgExitPct: decidedTrades > 0 ? totalPnlPct / decidedTrades : 0,
      wins, losses, holding, noEntry,
      trades: decidedTrades,
      tpHits: 0, beSaves: 0,
    });
    if (i % 5 === 0) opts.onProgress?.("simulating", Math.round((i / combos.length) * 100));
  }

  results.sort((a, b) => b.totalPnlPct - a.totalPnlPct);

  // Sanity: if the top-5 is flat (all same totalPnlPct), something in the sim
  // has collapsed the grid. Log loudly so regressions can't hide.
  if (results.length >= 5) {
    const top5 = results.slice(0, 5);
    const flat = top5.every((r) => Math.abs(r.totalPnlPct - top5[0]!.totalPnlPct) < 0.01);
    if (flat && top5[0]!.trades > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[backtest] WARN: top-5 rankings are identical (+${top5[0]!.totalPnlPct.toFixed(1)}%). Grid may have collapsed.`);
    }
  }

  return {
    samplesUsed: samples.length,
    tokensFetched: fetchedTokens.length,
    allResults: results,
    topResults: results.slice(0, topN),
    bar,
    source,
    resolutionCounts,
    entrySourceCounts,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Main (CLI entry — prints table + writes CSV)
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`\n📊 memeautobuy backtest  |  bar: ${BAR}  |  min candles: ${MIN_CANDLES}`);
  console.log(`   fee: ${FEE_BPS}bps (${(FEE_BPS/100).toFixed(2)}%)  |  slippage: ${SLIPPAGE_BPS}bps (${(SLIPPAGE_BPS/100).toFixed(2)}%)  |  round-trip haircut: ${((FEE_BPS+SLIPPAGE_BPS)*2/100).toFixed(2)}%\n`);

  if (STRATEGY === "all") {
    const result = await runBacktest({
      bar: BAR,
      topN: TOP_N,
      minCandles: MIN_CANDLES,
      allStrategies: true,
      source: SOURCE === "hot" ? "hot" : SOURCE === "private" ? "private" : "gmgn",
      tokenLimit: TOKEN_LIMIT > 0 ? TOKEN_LIMIT : undefined,
    });
    const resolutionText = Object.entries(result.resolutionCounts).map(([bar, count]) => `${count} ${bar}`).join(" · ") || "none";
    const entryText = Object.entries(result.entrySourceCounts)
      .map(([entrySource, count]) => `${count} ${entrySource}`)
      .join(" · ") || "none";
    console.log(`Source: ${result.source} | usable samples: ${result.samplesUsed}/${result.tokensFetched} | OHLCV: ${resolutionText} | entries: ${entryText}`);
    console.log("LLM Managed is not modeled; deterministic exits only.\n");
    for (const [idx, r] of result.topResults.entries()) {
      const winPct = ((r.wins / (r.wins + r.losses || 1)) * 100).toFixed(0);
      const label = r.strategyMode === "fixed_tp"
        ? `Fixed TP +${(r.fixedTargetPct * 100).toFixed(0)}% / STOP ${(r.stop * 100).toFixed(0)}%`
        : r.strategyMode === "tp_ladder"
          ? `TP Ladder ${r.ladderLabel} / ARM ${(r.arm * 100).toFixed(0)}% / TRAIL ${(r.trail * 100).toFixed(0)}% / STOP ${(r.stop * 100).toFixed(0)}%`
          : `Trail / ARM ${(r.arm * 100).toFixed(0)}% / TRAIL ${(r.trail * 100).toFixed(0)}% / STOP ${(r.stop * 100).toFixed(0)}%` +
            (r.moonbagPct > 0 ? ` / MB ${(r.moonbagPct * 100).toFixed(0)}%` : "");
      console.log(
        `#${idx + 1} ${label}\n` +
        `   total ${r.totalPnlPct >= 0 ? "+" : ""}${r.totalPnlPct.toFixed(1)}% | avg ${r.avgExitPct >= 0 ? "+" : ""}${r.avgExitPct.toFixed(1)}% | ${r.wins}W/${r.losses}L/${r.holding}H | win ${winPct}%`,
      );
    }
    console.log("");
    return;
  }

  // 1. Fetch hot tokens
  process.stdout.write("Fetching hot tokens... ");
  const tokens = await fetchHotTokens();
  console.log(`${tokens.length} tokens`);

  // 2. Fetch klines in batches of 5 (avoid rate limits)
  console.log(`\nFetching ${BAR} klines from OKX (this takes ~${Math.ceil(tokens.length / 5) * 3}s)...\n`);
  const samples: Array<{ symbol: string; candles: Candle[] }> = [];

  for (let i = 0; i < tokens.length; i += 5) {
    const batch = tokens.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async t => ({ symbol: t.symbol, candles: await fetchKlines(t.address) }))
    );
    for (const r of results) {
      if (r.candles.length >= MIN_CANDLES) {
        samples.push(r);
        process.stdout.write(`✓`);
      } else {
        process.stdout.write(`·`);
      }
    }
    // brief pause between batches to be polite
    if (i + 5 < tokens.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n\n${samples.length} / ${tokens.length} tokens have ≥${MIN_CANDLES} candles of data\n`);

  if (samples.length < 5) {
    console.log("Not enough token data to backtest meaningfully.");
    return;
  }

  // 3. Build grid combos
  const barMs = BAR_MS[BAR as keyof typeof BAR_MS] ?? 300_000;
  type Combo = {
    strategyMode?: BacktestExitMode;
    arm: number; trail: number; stop: number; soPct: number; soMult: number; mbPct: number; mbTrail: number; mbTimeout: number;
    breakEvenAfter: number; hardTPPct: number;
    fixedTargetPct?: number;
    ladderLabel?: string;
    ladderTargets?: BacktestTpTarget[];
    trailRemainder?: boolean;
  };
  const combos: Combo[] = [];

  if (STRATEGY === "hybrid") {
    for (const arm of ARM_RANGE)
      for (const trail of TRAIL_RANGE)
        for (const stop of STOP_RANGE)
          for (const soPct of SCALEOUT_PCT_RANGE)
            for (const soMult of (soPct === 0 ? [0] : SCALEOUT_MULT_RANGE))
              for (const mbPct of MOONBAG_PCT_RANGE) {
                if (mbPct === 0) {
                  combos.push({ arm, trail, stop, soPct, soMult, mbPct, mbTrail: 0, mbTimeout: 0, breakEvenAfter: 0, hardTPPct: 0 });
                } else {
                  for (const mbt of MB_TRAIL_RANGE)
                    for (const mbto of MB_TIMEOUT_RANGE)
                      combos.push({ arm, trail, stop, soPct, soMult, mbPct, mbTrail: mbt, mbTimeout: mbto, breakEvenAfter: 0, hardTPPct: 0 });
                }
              }
  } else if (STRATEGY === "protective") {
    // Tight grid focused on answering two questions:
    //   (a) does break-even-protect improve over baseline?
    //   (b) is a flat +50% take-profit better than letting the trail run?
    // Keep arm fixed at 0.5 and stop fixed at 0.4 (user's current config) to
    // isolate the BE/TP impact. Vary trail across [0.35, 0.55] so we can see
    // if tighter trail compounds with BE protect.
    const PROT_ARM   = [0.5];
    const PROT_TRAIL = [0.35, 0.55];
    const PROT_STOP  = [0.4];
    for (const arm of PROT_ARM)
      for (const trail of PROT_TRAIL)
        for (const stop of PROT_STOP)
          for (const be of BREAK_EVEN_RANGE)
            for (const tp of HARD_TP_RANGE)
              combos.push({ arm, trail, stop, soPct: 0, soMult: 0, mbPct: 0, mbTrail: 0, mbTimeout: 0, breakEvenAfter: be, hardTPPct: tp });
  } else {
    for (const arm of ARM_RANGE)
      for (const trail of TRAIL_RANGE)
        for (const stop of STOP_RANGE)
          combos.push({ arm, trail, stop, soPct: 0, soMult: 0, mbPct: 0, mbTrail: 0, mbTimeout: 0, breakEvenAfter: 0, hardTPPct: 0 });
  }

  console.log(`Running grid search: ${combos.length} combos × ${samples.length} tokens (strategy: ${STRATEGY})...\n`);

  const results: GridResult[] = [];

  for (const combo of combos) {
    let totalPnlPct = 0, wins = 0, losses = 0, holding = 0, noEntry = 0, tpHits = 0, beSaves = 0;

    const mbTimeoutMs = combo.mbTimeout * 60_000;

    for (const s of samples) {
      const sim = simulate(
        s.candles,
        combo.arm, combo.trail, combo.stop,
        combo.soPct, combo.soMult, combo.mbPct, combo.mbTrail, mbTimeoutMs,
        combo.breakEvenAfter, combo.hardTPPct,
        combo.strategyMode ?? (combo.hardTPPct > 0 ? "fixed_tp" : "trail"),
        combo.ladderTargets ?? [],
        combo.trailRemainder ?? true,
      );
      if (sim.reason === "no_entry") { noEntry++; continue; }
      if (sim.reason === "holding") { holding++; continue; }
      totalPnlPct += sim.exitPct;
      if (sim.exitPct >= 0) wins++;
      else losses++;
      if (sim.reason === "tp") tpHits++;
      // break-even save: stop fired AND BE was armed AND final PnL is near zero
      if (sim.reason === "stop" && combo.breakEvenAfter > 0 && Math.abs(sim.exitPct) < 10) beSaves++;
    }

    const decidedTrades = wins + losses;
    results.push({
      strategyMode: combo.strategyMode ?? (combo.hardTPPct > 0 ? "fixed_tp" : "trail"),
      arm: combo.arm, trail: combo.trail, stop: combo.stop,
      scaleoutPct: combo.soPct, scaleoutMult: combo.soMult, moonbagPct: combo.mbPct,
      mbTrail: combo.mbTrail, mbTimeout: combo.mbTimeout,
      breakEvenAfter: combo.breakEvenAfter, hardTPPct: combo.hardTPPct,
      fixedTargetPct: combo.fixedTargetPct ?? combo.hardTPPct,
      ladderLabel: combo.ladderLabel ?? "",
      ladderTargets: combo.ladderTargets ?? [],
      trailRemainder: combo.trailRemainder ?? true,
      totalPnlPct,
      avgExitPct: decidedTrades > 0 ? totalPnlPct / decidedTrades : 0,
      wins, losses, holding, noEntry,
      trades: decidedTrades,
      tpHits, beSaves,
    });
  }

  // Sort by total PnL
  results.sort((a, b) => b.totalPnlPct - a.totalPnlPct);

  // 4. Print table
  const isHybrid = STRATEGY === "hybrid";
  const isProtective = STRATEGY === "protective";
  const hdrExtra = isHybrid
    ? "SO%  SO×  MB%  MBT  MBm  "
    : isProtective
      ? "BE@    TP@    "
      : "";
  const dashes = isHybrid ? 98 : isProtective ? 88 : 68;
  console.log(
    "ARM".padEnd(5) + "TRAIL".padEnd(7) + "STOP".padEnd(6) + hdrExtra +
    "| TOTAL PnL".padStart(12) + " | AVG/TRADE".padStart(11) +
    " | W / L / H".padStart(12) + " | WIN%" +
    (isProtective ? "  | TP hits/BE saves" : "")
  );
  console.log("─".repeat(dashes));

  for (const r of results.slice(0, TOP_N)) {
    const winPct = ((r.wins / (r.wins + r.losses || 1)) * 100).toFixed(0);
    const fmtPct = (v: number) => v > 0 ? `+${(v * 100).toFixed(0)}%` : "–";
    const extra = isHybrid
      ? `${((r.scaleoutPct * 100).toFixed(0) + "%").padEnd(5)}` +
        `${(r.scaleoutMult ? r.scaleoutMult + "x" : "–").padEnd(5)}` +
        `${((r.moonbagPct * 100).toFixed(0) + "%").padEnd(5)}` +
        `${(r.mbTrail ? (r.mbTrail * 100).toFixed(0) + "%" : "–").padEnd(5)}` +
        `${(r.mbTimeout ? r.mbTimeout + "m" : "–").padEnd(5)}`
      : isProtective
        ? `${fmtPct(r.breakEvenAfter).padEnd(7)}${fmtPct(r.hardTPPct).padEnd(7)}`
        : "";
    const tail = isProtective
      ? ` | ${String(r.tpHits).padStart(3)} / ${String(r.beSaves).padStart(3)}`
      : "";
    console.log(
      `${((r.arm   * 100).toFixed(0) + "%").padEnd(5)}` +
      `${((r.trail * 100).toFixed(0) + "%").padEnd(7)}` +
      `${((r.stop  * 100).toFixed(0) + "%").padEnd(6)}` + extra +
      `| ${((r.totalPnlPct >= 0 ? "+" : "") + r.totalPnlPct.toFixed(1) + "%").padStart(10)} ` +
      `| ${((r.avgExitPct  >= 0 ? "+" : "") + r.avgExitPct.toFixed(1)  + "%").padStart(10)} ` +
      `| ${String(r.wins).padStart(3)} / ${String(r.losses).padStart(3)} / ${String(r.holding).padStart(3)} ` +
      `| ${winPct}%` + tail
    );
  }

  // Show current settings (simple trail, no scale-out/moonbag)
  const cur = results.find(r => r.arm === 0.5 && r.trail === 0.4 && r.stop === 0.5 && r.scaleoutPct === 0 && r.moonbagPct === 0);
  if (cur) {
    const rank = results.indexOf(cur) + 1;
    console.log(`\n  Current (ARM 50% TRAIL 40% STOP 50%, no SO/MB): rank #${rank} / ${results.length}`);
    console.log(`   Total PnL: ${cur.totalPnlPct >= 0 ? "+" : ""}${cur.totalPnlPct.toFixed(1)}%  avg: ${cur.avgExitPct >= 0 ? "+" : ""}${cur.avgExitPct.toFixed(1)}%`);
  }

  const best = results[0];
  if (best) {
    const bestLabel = isHybrid
      ? `ARM ${(best.arm*100).toFixed(0)}%  TRAIL ${(best.trail*100).toFixed(0)}%  STOP ${(best.stop*100).toFixed(0)}%  SO ${(best.scaleoutPct*100).toFixed(0)}%@${best.scaleoutMult || "–"}x  MB ${(best.moonbagPct*100).toFixed(0)}% trail=${best.mbTrail ? (best.mbTrail*100).toFixed(0)+"%" : "–"} timeout=${best.mbTimeout || "–"}m`
      : `ARM ${(best.arm*100).toFixed(0)}%  TRAIL ${(best.trail*100).toFixed(0)}%  STOP ${(best.stop*100).toFixed(0)}%`;
    console.log(`\n  Best: ${bestLabel}`);
    console.log(`   Total PnL: ${best.totalPnlPct >= 0 ? "+" : ""}${best.totalPnlPct.toFixed(1)}%  avg/trade: ${best.avgExitPct >= 0 ? "+" : ""}${best.avgExitPct.toFixed(1)}%  wins: ${best.wins}/${best.trades}\n`);
  }

  // 5. Export CSV
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const csvFile = path.resolve(`backtest_${STRATEGY}_${timestamp}.csv`);
  const header = "rank,arm_pct,trail_pct,stop_pct,scaleout_pct,scaleout_mult,moonbag_pct,mb_trail_pct,mb_timeout_min,total_pnl_pct,avg_exit_pct,wins,losses,holding,trades,win_pct\n";
  const rows = results.map((r, i) => {
    const winPct = ((r.wins / (r.wins + r.losses || 1)) * 100).toFixed(1);
    return [
      i + 1,
      (r.arm   * 100).toFixed(0),
      (r.trail * 100).toFixed(0),
      (r.stop  * 100).toFixed(0),
      (r.scaleoutPct  * 100).toFixed(0),
      r.scaleoutMult || 0,
      (r.moonbagPct   * 100).toFixed(0),
      (r.mbTrail * 100).toFixed(0),
      r.mbTimeout,
      r.totalPnlPct.toFixed(2),
      r.avgExitPct.toFixed(2),
      r.wins,
      r.losses,
      r.holding,
      r.trades,
      winPct,
    ].join(",");
  }).join("\n");
  await writeFile(csvFile, header + rows);
  console.log(`  CSV saved -> ${csvFile}\n`);
}

// Only run main() when this file is invoked directly as a script (not when
// imported as a library, e.g. by the /backtest Telegram command).
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e); process.exit(1); });
}
