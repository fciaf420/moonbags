/**
 * Backtest: optimize exit strategy using OKX hot-tokens list.
 *
 * Usage:
 *   npx tsx src/_backtest.ts                         # simple trail grid (default)
 *   npx tsx src/_backtest.ts --strategy hybrid        # trail + scale-out + moonbag grid
 *   npx tsx src/_backtest.ts --bar 5m --top 20
 *   npx tsx src/_backtest.ts --min-candles 80
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";

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
const MIN_CANDLES = parseInt(arg("--min-candles", "60"));   // ~5 hours of 5m data
const STRATEGY    = arg("--strategy", "simple");            // "simple" | "hybrid" | "protective"
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Candle { ts: number; open: number; high: number; low: number; close: number }
interface SimResult { exitPct: number; reason: "trail" | "stop" | "tp" | "holding" | "no_entry" }
interface TokenSample { address: string; symbol: string }
interface GridResult {
  arm: number; trail: number; stop: number;
  scaleoutPct: number; scaleoutMult: number; moonbagPct: number;
  mbTrail: number; mbTimeout: number;
  breakEvenAfter: number; hardTPPct: number;
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
      .map(t => ({ address: t.tokenContractAddress, symbol: t.tokenSymbol }))
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
// Entry = first candle open. Supports partial scale-out and moonbag.
// ---------------------------------------------------------------------------
// NOTE on entry timing:
//   We don't replicate SCG's upstream filter (we don't know exactly what it is),
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
): SimResult {
  const firstCandle = candles[0];
  if (!firstCandle) return { exitPct: 0, reason: "no_entry" };
  const rawEntry = firstCandle.open;
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

  for (const c of candles) {
    if (!moonbagMode) {
      if (c.high > runPeak) runPeak = c.high;
      if (!armed && (c.high / decEntry - 1) >= arm) armed = true;

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
    if (armed) {
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
  moonbagRange?: number[];    // fraction kept after trail (0 = disabled). default [0, 0.10, 0.20]
  mbTrailRange?: number[];    // moonbag's own drawdown trail. default [0.50, 0.60, 0.70]
  mbTimeoutRange?: number[];  // moonbag max hold, minutes. default [30, 60, 120]
  onProgress?: (stage: "fetching" | "simulating", pct: number) => void;
}

export interface RunBacktestResult {
  samplesUsed: number;
  tokensFetched: number;
  allResults: GridResult[];     // full grid, sorted best→worst
  topResults: GridResult[];     // top N slice for convenience
  bar: string;
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
  const armRange   = opts.armRange ?? ARM_RANGE;
  const trailRange = opts.trailRange ?? TRAIL_RANGE;
  const stopRange  = opts.stopRange ?? STOP_RANGE;

  const start = Date.now();

  // 1. Fetch hot tokens
  opts.onProgress?.("fetching", 0);
  const tokens = await fetchHotTokens();

  // 2. Fetch klines in parallel batches
  const samples: Array<{ symbol: string; candles: Candle[] }> = [];
  for (let i = 0; i < tokens.length; i += 5) {
    const batch = tokens.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async t => ({ symbol: t.symbol, candles: await fetchKlines(t.address, bar) })),
    );
    for (const r of results) {
      if (r.candles.length >= minCandles) samples.push(r);
    }
    opts.onProgress?.("fetching", Math.min(100, Math.round(((i + 5) / tokens.length) * 100)));
    if (i + 5 < tokens.length) await new Promise(r => setTimeout(r, 400));
  }

  // 3. Build grid. Simple mode: ARM × TRAIL × STOP. Hybrid mode: additionally
  //    grid over moonbag params (keep a sliver running after trail fires).
  //    Scale-out is intentionally excluded — live bot doesn't support it.
  const mbRange   = opts.moonbagRange  ?? [0, 0.10, 0.20];
  const mbtRange  = opts.mbTrailRange  ?? [0.50, 0.60, 0.70];
  const mbtoRange = opts.mbTimeoutRange ?? [30, 60, 120];
  type Combo = { arm: number; trail: number; stop: number; mbPct: number; mbTrail: number; mbTimeout: number };
  const combos: Combo[] = [];
  for (const arm of armRange) {
    for (const trail of trailRange) {
      for (const stop of stopRange) {
        if (!opts.hybrid) {
          combos.push({ arm, trail, stop, mbPct: 0, mbTrail: 0, mbTimeout: 0 });
        } else {
          for (const mbPct of mbRange) {
            if (mbPct === 0) {
              combos.push({ arm, trail, stop, mbPct: 0, mbTrail: 0, mbTimeout: 0 });
            } else {
              for (const mbTrail of mbtRange) {
                for (const mbTimeout of mbtoRange) {
                  combos.push({ arm, trail, stop, mbPct, mbTrail, mbTimeout });
                }
              }
            }
          }
        }
      }
    }
  }

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
      );
      if (sim.reason === "no_entry") { noEntry++; continue; }
      if (sim.reason === "holding") { holding++; continue; } // exclude from PnL totals
      totalPnlPct += sim.exitPct;
      if (sim.exitPct >= 0) wins++;
      else losses++;
    }
    const decidedTrades = wins + losses;
    results.push({
      arm: combo.arm, trail: combo.trail, stop: combo.stop,
      scaleoutPct: 0, scaleoutMult: 0,
      moonbagPct: combo.mbPct, mbTrail: combo.mbTrail, mbTimeout: combo.mbTimeout,
      breakEvenAfter: 0, hardTPPct: 0,
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
    tokensFetched: tokens.length,
    allResults: results,
    topResults: results.slice(0, topN),
    bar,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Main (CLI entry — prints table + writes CSV)
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`\n📊 memeautobuy backtest  |  bar: ${BAR}  |  min candles: ${MIN_CANDLES}`);
  console.log(`   fee: ${FEE_BPS}bps (${(FEE_BPS/100).toFixed(2)}%)  |  slippage: ${SLIPPAGE_BPS}bps (${(SLIPPAGE_BPS/100).toFixed(2)}%)  |  round-trip haircut: ${((FEE_BPS+SLIPPAGE_BPS)*2/100).toFixed(2)}%\n`);

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
  type Combo = { arm: number; trail: number; stop: number; soPct: number; soMult: number; mbPct: number; mbTrail: number; mbTimeout: number; breakEvenAfter: number; hardTPPct: number };
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
      arm: combo.arm, trail: combo.trail, stop: combo.stop,
      scaleoutPct: combo.soPct, scaleoutMult: combo.soMult, moonbagPct: combo.mbPct,
      mbTrail: combo.mbTrail, mbTimeout: combo.mbTimeout,
      breakEvenAfter: combo.breakEvenAfter, hardTPPct: combo.hardTPPct,
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
