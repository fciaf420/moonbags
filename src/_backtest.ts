/**
 * Backtest: optimize exit strategy using OKX trending tokens.
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
  return i !== -1 ? process.argv[i + 1] : def;
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
interface SimResult { exitPct: number; reason: "trail" | "stop" | "tp" | "holding" }
interface TokenSample { address: string; symbol: string }
interface GridResult {
  arm: number; trail: number; stop: number;
  scaleoutPct: number; scaleoutMult: number; moonbagPct: number;
  mbTrail: number; mbTimeout: number;
  breakEvenAfter: number; hardTPPct: number;
  totalPnlPct: number; avgExitPct: number;
  wins: number; losses: number; holding: number; trades: number;
  tpHits: number;       // how many trades exited via hard TP
  beSaves: number;      // how many trades exited via break-even stop (saved from loss)
}

// ---------------------------------------------------------------------------
// Fetch top 100 trending Solana tokens (sorted by 24h volume)
// ---------------------------------------------------------------------------
async function fetchTrendingTokens(): Promise<TokenSample[]> {
  const { stdout } = await execFileAsync("onchainos", [
    "token", "trending",
    "--chain", "solana",
    "--sort-by", "5",      // volume
    "--time-frame", "4",   // 24h
  ], { timeout: 15_000 });

  const j = JSON.parse(stdout) as { data?: Array<{ tokenContractAddress: string; tokenSymbol: string }> };
  return (j.data ?? []).map(t => ({ address: t.tokenContractAddress, symbol: t.tokenSymbol }));
}

// ---------------------------------------------------------------------------
// Fetch OKX klines for one token
// ---------------------------------------------------------------------------
async function fetchKlines(address: string, bar: string = BAR): Promise<Candle[]> {
  try {
    const { stdout } = await execFileAsync("onchainos", [
      "market", "kline",
      "--address", address,
      "--chain", "solana",
      "--bar", bar,
      "--limit", "299",
    ], { timeout: 10_000 });

    const j = JSON.parse(stdout) as {
      ok: boolean;
      data?: Array<{ ts: string; o: string; h: string; l: string; c: string }>;
    };

    if (!j.ok || !j.data?.length) return [];

    return j.data
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
function simulate(
  candles: Candle[],
  arm: number, trail: number, stop: number,
  scaleoutPct = 0, scaleoutMult = 0, moonbagPct = 0,
  mbTrail = 0.60, mbTimeoutMs = 0,
  breakEvenAfter = 0,   // if > 0, once price crosses (1+breakEvenAfter), stop floor moves to entry
  hardTPPct = 0,        // if > 0, sell everything at the TP level (1+hardTPPct)
): SimResult {
  const rawEntry = candles[0].open;
  if (!rawEntry || rawEntry <= 0) return { exitPct: 0, reason: "holding" };

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

    // stop loss — if break-even armed, the floor becomes entry (0% PnL)
    // instead of -stop; otherwise regular hard stop.
    const stopFloor = breakEvenArmed ? 0 : -stop;
    if ((c.low / decEntry - 1) <= stopFloor) {
      // On break-even stop, model the exit at the entry price (haircut-adjusted)
      // so the PnL is a clean ~-haircut%, not wherever the candle closed.
      const exitPrice = breakEvenArmed ? decEntry : c.close;
      realizedPnl += position * (adjSell(exitPrice) / entry - 1);
      return { exitPct: realizedPnl * 100, reason: "stop" };
    }

    // trailing stop — only when armed
    if (armed && c.low <= runPeak * (1 - trail)) {
      if (moonbagPct > 0 && position > moonbagPct) {
        const trailSellPct = position - moonbagPct;
        realizedPnl += trailSellPct * (adjSell(c.close) / entry - 1);
        position = moonbagPct;
        moonbagMode = true;
        mbPeak = c.close;
        mbStartTs = c.ts;
      } else {
        realizedPnl += position * (adjSell(c.close) / entry - 1);
        return { exitPct: realizedPnl * 100, reason: "trail" };
      }
    }
  }

  // end of data — mark-to-market remaining position (apply haircut as if sold)
  const lastClose = candles[candles.length - 1].close;
  realizedPnl += position * (adjSell(lastClose) / entry - 1);
  return { exitPct: realizedPnl * 100, reason: "holding" };
}

// ---------------------------------------------------------------------------
// Library entry point — usable from the Telegram /backtest command.
// Returns top N sorted results without printing or saving a CSV.
// ---------------------------------------------------------------------------
export interface RunBacktestOptions {
  bar?: string;            // "1m" | "5m" | "15m" | "1H" | "4H" | "1D"   default "5m"
  minCandles?: number;     // skip tokens with fewer candles. default 60
  topN?: number;           // how many top results to return. default 10
  armRange?: number[];
  trailRange?: number[];
  stopRange?: number[];
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
  const bar = opts.bar ?? "5m";
  const minCandles = opts.minCandles ?? 60;
  const topN = opts.topN ?? 10;
  const armRange   = opts.armRange ?? ARM_RANGE;
  const trailRange = opts.trailRange ?? TRAIL_RANGE;
  const stopRange  = opts.stopRange ?? STOP_RANGE;

  const start = Date.now();

  // 1. Fetch trending tokens
  opts.onProgress?.("fetching", 0);
  const tokens = await fetchTrendingTokens();

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

  // 3. Build simple-strategy grid (ARM × TRAIL × STOP, no moonbag / no scaleout)
  const combos: Array<{ arm: number; trail: number; stop: number }> = [];
  for (const arm of armRange)
    for (const trail of trailRange)
      for (const stop of stopRange)
        combos.push({ arm, trail, stop });

  // 4. Simulate
  const results: GridResult[] = [];
  for (let i = 0; i < combos.length; i++) {
    const combo = combos[i]!;
    let totalPnlPct = 0, wins = 0, losses = 0, holding = 0;
    for (const s of samples) {
      const sim = simulate(s.candles, combo.arm, combo.trail, combo.stop);
      totalPnlPct += sim.exitPct;
      if (sim.reason === "holding") holding++;
      else if (sim.exitPct >= 0) wins++;
      else losses++;
    }
    results.push({
      arm: combo.arm, trail: combo.trail, stop: combo.stop,
      scaleoutPct: 0, scaleoutMult: 0, moonbagPct: 0, mbTrail: 0, mbTimeout: 0,
      breakEvenAfter: 0, hardTPPct: 0,
      totalPnlPct,
      avgExitPct: samples.length > 0 ? totalPnlPct / samples.length : 0,
      wins, losses, holding,
      trades: samples.length,
      tpHits: 0, beSaves: 0,
    });
    if (i % 5 === 0) opts.onProgress?.("simulating", Math.round((i / combos.length) * 100));
  }

  results.sort((a, b) => b.totalPnlPct - a.totalPnlPct);

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

  // 1. Fetch trending tokens
  process.stdout.write("Fetching trending tokens... ");
  const tokens = await fetchTrendingTokens();
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
  const barMs = BAR_MS[BAR] ?? 300_000;
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
    let totalPnlPct = 0, wins = 0, losses = 0, holding = 0, tpHits = 0, beSaves = 0;

    const mbTimeoutMs = combo.mbTimeout * 60_000;

    for (const s of samples) {
      const sim = simulate(
        s.candles,
        combo.arm, combo.trail, combo.stop,
        combo.soPct, combo.soMult, combo.mbPct, combo.mbTrail, mbTimeoutMs,
        combo.breakEvenAfter, combo.hardTPPct,
      );
      totalPnlPct += sim.exitPct;
      if (sim.reason === "holding") holding++;
      else if (sim.exitPct >= 0) wins++;
      else losses++;
      if (sim.reason === "tp") tpHits++;
      // break-even save: stop fired AND BE was armed AND final PnL is near zero
      if (sim.reason === "stop" && combo.breakEvenAfter > 0 && Math.abs(sim.exitPct) < 10) beSaves++;
    }

    results.push({
      arm: combo.arm, trail: combo.trail, stop: combo.stop,
      scaleoutPct: combo.soPct, scaleoutMult: combo.soMult, moonbagPct: combo.mbPct,
      mbTrail: combo.mbTrail, mbTimeout: combo.mbTimeout,
      breakEvenAfter: combo.breakEvenAfter, hardTPPct: combo.hardTPPct,
      totalPnlPct,
      avgExitPct: totalPnlPct / samples.length,
      wins, losses, holding,
      trades: samples.length,
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
  const bestLabel = isHybrid
    ? `ARM ${(best.arm*100).toFixed(0)}%  TRAIL ${(best.trail*100).toFixed(0)}%  STOP ${(best.stop*100).toFixed(0)}%  SO ${(best.scaleoutPct*100).toFixed(0)}%@${best.scaleoutMult || "–"}x  MB ${(best.moonbagPct*100).toFixed(0)}% trail=${best.mbTrail ? (best.mbTrail*100).toFixed(0)+"%" : "–"} timeout=${best.mbTimeout || "–"}m`
    : `ARM ${(best.arm*100).toFixed(0)}%  TRAIL ${(best.trail*100).toFixed(0)}%  STOP ${(best.stop*100).toFixed(0)}%`;
  console.log(`\n  Best: ${bestLabel}`);
  console.log(`   Total PnL: ${best.totalPnlPct >= 0 ? "+" : ""}${best.totalPnlPct.toFixed(1)}%  avg/trade: ${best.avgExitPct >= 0 ? "+" : ""}${best.avgExitPct.toFixed(1)}%  wins: ${best.wins}/${best.trades}\n`);

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
