/**
 * OKX filter analysis — hot-tokens edition.
 *
 * Pulls the same universe the live discovery source polls, fetches forward
 * OHLCV, computes peak/final/drawdown PnL per candidate, then sweeps each
 * baseline filter knob so you can see which thresholds separate winners
 * from losers.
 *
 * Run: npx tsx src/_okxFilterAnalysis.ts [--frames 1,2,3,4]
 *
 *   --frames  Comma-separated OKX time-frames to pull and dedupe:
 *             1 = 5m (live default)   2 = 1h   3 = 4h   4 = 24h
 *             Default "1,2,3,4" — gives ~200-400 unique tokens.
 *
 * Output:
 *   - state/okx-filter-analysis-<ts>.csv (full per-candidate table)
 *   - stdout: summary + threshold sweeps
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJupAudit } from "./jupGate.js";

const execFileAsync = promisify(execFile);

type Candle = { ts: number; open: number; high: number; low: number; close: number };

type HotTokenRow = {
  tokenContractAddress?: string;
  tokenSymbol?: string;
  price?: string | number;
  marketCap?: string | number;
  liquidity?: string | number;
  volume?: string | number;
  inflowUsd?: string | number;
  holders?: string | number;
  uniqueTraders?: string | number;
  txs?: string | number;
  txsBuy?: string | number;
  txsSell?: string | number;
  change?: string | number;           // price change % for this time-frame
  top10HoldPercent?: string | number;
  bundleHoldPercent?: string | number;
  devHoldPercent?: string | number;
  mentionsCount?: string | number;
  vibeScore?: string | number;
  riskLevelControl?: string | number;
  firstTradeTime?: string | number;   // ms
};

type Candidate = {
  mint: string;
  symbol: string;
  tfLabel: string;             // which time-frame first surfaced it
  // Hot-tokens row fields
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volumeUsd: number;
  inflowUsd: number;
  holders: number;
  uniqueTraders: number;
  txs: number;
  txsBuy: number;
  txsSell: number;
  buySellRatio: number;
  priceChangePct: number;
  top10Pct: number;
  bundleHoldPct: number;
  devHoldPct: number;
  mentionsCount: number;
  vibeScore: number;
  riskLevel: number;
  tokenAgeHours: number;
  // Jup-gate audit fields (fetched before klines; transient failures default to 0/"")
  fees: number;
  organicScoreLabel: string;
  organicVolumePct: number | null;
  organicBuyersPct: number | null;
  // Forward-PnL fields (computed later)
  hasOhlcv: boolean;
  candleCount: number;
  entryPrice: number;
  maxPnLPct: number;
  finalPnLPct: number;
  minPnLPct: number;
  timeToPeakMins: number;
};

const TF_LABELS: Record<string, string> = { "1": "5m", "2": "1h", "3": "4h", "4": "24h" };

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ratioToPct(v: unknown): number {
  const n = num(v);
  if (n === 0) return 0;
  return Math.abs(n) <= 1 ? n * 100 : n;
}

async function runOnchainos<T>(args: string[], timeoutMs = 20_000): Promise<T | null> {
  const env = { ...process.env };
  if (!env.OKX_PASSPHRASE && env.OKX_API_PASSPHRASE) env.OKX_PASSPHRASE = env.OKX_API_PASSPHRASE;
  try {
    const { stdout } = await execFileAsync("onchainos", args, { timeout: timeoutMs, env, maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(String(stdout || "{}")) as { ok?: boolean; data?: T; error?: unknown };
    if (parsed.ok === false) return null;
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

async function harvestHotTokens(timeFrames: string[]): Promise<Candidate[]> {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const tf of timeFrames) {
    const label = TF_LABELS[tf] ?? tf;
    const rows = await runOnchainos<HotTokenRow[]>([
      "token", "hot-tokens",
      "--chain", "solana",
      "--rank-by", "5",
      "--time-frame", tf,
      "--limit", "100",
    ]);
    if (!rows || rows.length === 0) continue;
    for (const row of rows) {
      const mint = String(row.tokenContractAddress ?? "").trim();
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);
      const firstTradeMs = num(row.firstTradeTime);
      const tokenAgeHours = firstTradeMs > 0 ? (Date.now() - firstTradeMs) / 3_600_000 : 0;
      const txsBuy = num(row.txsBuy);
      const txsSell = num(row.txsSell);
      out.push({
        mint,
        symbol: String(row.tokenSymbol ?? mint.slice(0, 6)),
        tfLabel: label,
        priceUsd: num(row.price),
        marketCapUsd: num(row.marketCap),
        liquidityUsd: num(row.liquidity),
        volumeUsd: num(row.volume),
        inflowUsd: num(row.inflowUsd),
        holders: Math.round(num(row.holders)),
        uniqueTraders: Math.round(num(row.uniqueTraders)),
        txs: Math.round(num(row.txs)),
        txsBuy: Math.round(txsBuy),
        txsSell: Math.round(txsSell),
        buySellRatio: txsSell > 0 ? txsBuy / txsSell : 0,
        priceChangePct: num(row.change),
        top10Pct: ratioToPct(row.top10HoldPercent),
        bundleHoldPct: ratioToPct(row.bundleHoldPercent),
        devHoldPct: ratioToPct(row.devHoldPercent),
        mentionsCount: Math.round(num(row.mentionsCount)),
        vibeScore: num(row.vibeScore),
        riskLevel: Math.round(num(row.riskLevelControl)),
        tokenAgeHours,
        fees: 0,
        organicScoreLabel: "",
        organicVolumePct: null,
        organicBuyersPct: null,
        hasOhlcv: false,
        candleCount: 0,
        entryPrice: 0,
        maxPnLPct: 0,
        finalPnLPct: 0,
        minPnLPct: 0,
        timeToPeakMins: 0,
      });
    }
  }
  return out;
}

async function fetchKlines(address: string): Promise<Candle[]> {
  const data = await runOnchainos<Array<{ ts: string; o: string; h: string; l: string; c: string }>>([
    "market", "kline",
    "--address", address,
    "--chain", "solana",
    "--bar", "5m",
    "--limit", "299",
  ], 12_000);
  if (!data?.length) return [];
  return data
    .map((c) => ({ ts: Number(c.ts), open: parseFloat(c.o), high: parseFloat(c.h), low: parseFloat(c.l), close: parseFloat(c.c) }))
    .filter((c) => c.open > 0)
    .sort((a, b) => a.ts - b.ts);
}

// Entry = oldest candle in the window (simulates "bot discovered this token,
// entered on its earliest available candle, what happened forward").
function computeForwardPnL(c: Candidate, candles: Candle[]): void {
  c.candleCount = candles.length;
  c.hasOhlcv = candles.length >= 12;
  if (!c.hasOhlcv) return;
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  const entry = first.close;
  c.entryPrice = entry;
  let max = entry, min = entry, peakIdx = 0;
  for (let i = 1; i < candles.length; i++) {
    const k = candles[i]!;
    if (k.high > max) { max = k.high; peakIdx = i; }
    if (k.low < min) min = k.low;
  }
  c.maxPnLPct = ((max / entry) - 1) * 100;
  c.minPnLPct = ((min / entry) - 1) * 100;
  c.finalPnLPct = ((last.close / entry) - 1) * 100;
  const peak = candles[peakIdx]!;
  c.timeToPeakMins = (peak.ts - first.ts) / 60_000;
}

const WINNER_PCT = 50;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length % 2) return s[m] ?? 0;
  return ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

export type SweepSummary = {
  n: number;
  winPct: number;
  medianMaxPnl: number;
  medianFinalPnl: number;
  medianMinPnl: number;
};

export type SweepRow = SweepSummary & { threshold: number; kept: number; dropped: number };

export type SweepResult = {
  field: string;
  label: string;
  dir: "min" | "max";
  baseline: SweepSummary;
  rows: SweepRow[];
};

export type TimeFrameSummary = SweepSummary & { tfLabel: string };

// Categorical sweep: each option describes a required label set. "any" keeps
// everything, "medium|high" keeps tokens labeled medium or high, "high"
// keeps only high-scored tokens. Adopt maps the winning option back to
// jupGate.allowedScoreLabels.
export type CategoricalSweepOption = SweepSummary & {
  id: string;
  label: string;
  allowedLabels: string[];
  kept: number;
  dropped: number;
};

export type CategoricalSweepResult = {
  field: string;
  label: string;
  options: CategoricalSweepOption[];
};

export type OkxFilterAnalysisResult = {
  totalTokens: number;
  withOhlcv: number;
  byTimeFrame: TimeFrameSummary[];
  sweeps: SweepResult[];
  sweepsCategorical: CategoricalSweepResult[];
  csvPath: string;
};

function summarizeGroup(g: Candidate[]): SweepSummary {
  if (g.length === 0) return { n: 0, winPct: 0, medianMaxPnl: 0, medianFinalPnl: 0, medianMinPnl: 0 };
  const wins = g.filter((c) => c.maxPnLPct >= WINNER_PCT).length;
  return {
    n: g.length,
    winPct: (wins / g.length) * 100,
    medianMaxPnl: median(g.map((c) => c.maxPnLPct)),
    medianFinalPnl: median(g.map((c) => c.finalPnLPct)),
    medianMinPnl: median(g.map((c) => c.minPnLPct)),
  };
}

function summarize(label: string, g: Candidate[]): string {
  const s = summarizeGroup(g);
  if (s.n === 0) return `  ${label.padEnd(44)} n=0`;
  return `  ${label.padEnd(44)} n=${String(s.n).padStart(3)}  win@${WINNER_PCT}%=${s.winPct.toFixed(0).padStart(3)}%  medMax=${s.medianMaxPnl >= 0 ? "+" : ""}${s.medianMaxPnl.toFixed(0)}%  medFinal=${s.medianFinalPnl >= 0 ? "+" : ""}${s.medianFinalPnl.toFixed(0)}%  medMin=${s.medianMinPnl.toFixed(0)}%`;
}

function computeSweep(
  label: string,
  cs: Candidate[],
  field: keyof Candidate,
  thresholds: number[],
  dir: "min" | "max",
): SweepResult {
  const baseline = summarizeGroup(cs);
  const rows: SweepRow[] = thresholds.map((t) => {
    const kept = cs.filter((c) => {
      const v = c[field] as number;
      return dir === "min" ? v >= t : v <= t;
    });
    const dropped = cs.length - kept.length;
    const s = summarizeGroup(kept);
    return { threshold: t, kept: kept.length, dropped, ...s };
  });
  return { field: String(field), label, dir, baseline, rows };
}

function sweep(label: string, cs: Candidate[], field: keyof Candidate, thresholds: number[], dir: "min" | "max"): void {
  console.log(`\n--- ${label} (keep when ${dir === "min" ? ">=" : "<="} threshold) ---`);
  console.log(`  ${"baseline (no filter)".padEnd(44)} ${summarize("", cs).slice(2)}`);
  for (const t of thresholds) {
    const kept = cs.filter((c) => {
      const v = c[field] as number;
      return dir === "min" ? v >= t : v <= t;
    });
    const dropped = cs.length - kept.length;
    console.log(summarize(`${String(field)} ${dir === "min" ? ">=" : "<="} ${t} (drops ${dropped})`, kept));
  }
}

const OKX_SWEEP_SPECS: Array<{ label: string; field: keyof Candidate; thresholds: number[]; dir: "min" | "max" }> = [
  { label: "holders (baseline minHolders)", field: "holders", thresholds: [0, 100, 200, 500, 1_000, 2_500, 5_000], dir: "min" },
  { label: "liquidityUsd (baseline minLiquidityUsd)", field: "liquidityUsd", thresholds: [0, 5_000, 10_000, 25_000, 50_000, 100_000], dir: "min" },
  { label: "marketCapUsd — lower bound", field: "marketCapUsd", thresholds: [0, 10_000, 25_000, 50_000, 100_000, 250_000], dir: "min" },
  { label: "marketCapUsd — upper bound", field: "marketCapUsd", thresholds: [5_000_000, 1_000_000, 500_000, 250_000, 100_000], dir: "max" },
  { label: "top10Pct (baseline maxTop10HolderRate, 0-100)", field: "top10Pct", thresholds: [100, 50, 40, 30, 25, 20], dir: "max" },
  { label: "bundleHoldPct (baseline maxBundlerRate)", field: "bundleHoldPct", thresholds: [100, 50, 30, 20, 10, 5], dir: "max" },
  { label: "devHoldPct (baseline maxCreatorBalanceRate)", field: "devHoldPct", thresholds: [100, 30, 20, 15, 10, 5], dir: "max" },
  { label: "uniqueTraders", field: "uniqueTraders", thresholds: [0, 25, 50, 100, 250, 500], dir: "min" },
  { label: "buySellRatio (trigger minBuySellRatio)", field: "buySellRatio", thresholds: [0, 1, 1.15, 1.5, 2, 3], dir: "min" },
  { label: "volumeUsd (hot-tokens window)", field: "volumeUsd", thresholds: [0, 10_000, 50_000, 250_000, 1_000_000], dir: "min" },
  { label: "priceChangePct (already pumping?)", field: "priceChangePct", thresholds: [0, 5, 10, 25, 50], dir: "min" },
  { label: "tokenAgeHours (filter out fresh rugs)", field: "tokenAgeHours", thresholds: [0, 1, 6, 24, 72, 168], dir: "min" },
  { label: "fees (jupGate.minFees)", field: "fees", thresholds: [0, 0.1, 0.5, 1, 2, 5, 10, 25, 50], dir: "min" },
  { label: "organicVolumePct (jupGate.minOrganicVolumePct)", field: "organicVolumePct", thresholds: [0, 1, 2, 5, 10, 15, 20, 30], dir: "min" },
  { label: "organicBuyersPct (jupGate.minOrganicBuyersPct)", field: "organicBuyersPct", thresholds: [0, 1, 2, 3, 5, 7, 10], dir: "min" },
];

// Categorical sweep over Jup organicScoreLabel. Represented as a set of
// allowed-label options so adopt can pick the highest-winrate set.
const JUP_LABEL_OPTIONS: Array<{ id: string; label: string; allowedLabels: string[] }> = [
  { id: "any", label: "any label (no filter)", allowedLabels: [] },
  { id: "medium_high", label: "medium or high", allowedLabels: ["medium", "high"] },
  { id: "high", label: "high only", allowedLabels: ["high"] },
];

function computeCategoricalSweep(cs: Candidate[]): CategoricalSweepResult {
  const options: CategoricalSweepOption[] = JUP_LABEL_OPTIONS.map((opt) => {
    const allowLower = opt.allowedLabels.map((l) => l.toLowerCase());
    const kept = cs.filter((c) => {
      if (allowLower.length === 0) return true;
      const normalized = c.organicScoreLabel.toLowerCase();
      return normalized.length > 0 && allowLower.includes(normalized);
    });
    const dropped = cs.length - kept.length;
    const s = summarizeGroup(kept);
    return { id: opt.id, label: opt.label, allowedLabels: opt.allowedLabels, kept: kept.length, dropped, ...s };
  });
  return { field: "organicScoreLabel", label: "organicScoreLabel (jupGate.allowedScoreLabels)", options };
}

export async function runOkxFilterAnalysis(opts?: {
  timeFrames?: string[];
  onProgress?: (stage: string, pct: number) => void;
}): Promise<OkxFilterAnalysisResult> {
  const timeFrames = opts?.timeFrames && opts.timeFrames.length > 0 ? opts.timeFrames : ["1", "2", "3", "4"];
  const onProgress = opts?.onProgress;

  onProgress?.("harvesting hot-tokens", 0);
  const cs = await harvestHotTokens(timeFrames);
  onProgress?.(`harvested ${cs.length} unique tokens`, 10);

  if (cs.length === 0) {
    return {
      totalTokens: 0,
      withOhlcv: 0,
      byTimeFrame: [],
      sweeps: [],
      sweepsCategorical: [],
      csvPath: "",
    };
  }

  let withOhlcv = 0;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    // Fetch Jup audit first (fees + organicScoreLabel). Uses the 5-min cache
    // in jupGate.ts. On any failure keep defaults (0 / "") so sweeps still run.
    try {
      const audit = await fetchJupAudit(c.mint);
      if (audit) {
        c.fees = audit.fees;
        c.organicScoreLabel = audit.organicScoreLabel;
        c.organicVolumePct = audit.organicVolumePct;
        c.organicBuyersPct = audit.organicBuyersPct;
      }
    } catch {
      // swallow - keep defaults
    }
    const candles = await fetchKlines(c.mint);
    computeForwardPnL(c, candles);
    if (c.hasOhlcv) withOhlcv++;
    if (i % 5 === 0 || i === cs.length - 1) {
      const pct = 10 + Math.round(((i + 1) / cs.length) * 80);
      onProgress?.(`OHLCV ${i + 1}/${cs.length} (hasData=${withOhlcv})`, pct);
    }
  }

  const csvPath = await writeCsv(cs);
  onProgress?.("computing sweeps", 95);

  const usable = cs.filter((c) => c.hasOhlcv);

  const byTimeFrame: TimeFrameSummary[] = timeFrames.map((tf) => {
    const label = TF_LABELS[tf] ?? tf;
    const group = usable.filter((c) => c.tfLabel === label);
    return { tfLabel: label, ...summarizeGroup(group) };
  });

  const sweeps: SweepResult[] = OKX_SWEEP_SPECS.map((spec) =>
    computeSweep(spec.label, usable, spec.field, spec.thresholds, spec.dir),
  );

  const sweepsCategorical: CategoricalSweepResult[] = [computeCategoricalSweep(usable)];

  onProgress?.("done", 100);

  return {
    totalTokens: cs.length,
    withOhlcv,
    byTimeFrame,
    sweeps,
    sweepsCategorical,
    csvPath,
  };
}

async function writeCsv(cs: Candidate[]): Promise<string> {
  const dir = path.resolve("state");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(dir, `okx-filter-analysis-${ts}.csv`);
  const header: Array<keyof Candidate> = [
    "mint", "symbol", "tfLabel",
    "priceUsd", "marketCapUsd", "liquidityUsd", "volumeUsd", "inflowUsd",
    "holders", "uniqueTraders", "txs", "txsBuy", "txsSell", "buySellRatio",
    "priceChangePct", "top10Pct", "bundleHoldPct", "devHoldPct",
    "mentionsCount", "vibeScore", "riskLevel", "tokenAgeHours",
    "fees", "organicScoreLabel",
    "hasOhlcv", "candleCount", "entryPrice", "maxPnLPct", "finalPnLPct", "minPnLPct", "timeToPeakMins",
  ];
  const rows = cs.map((c) => header.map((h) => {
    const v = c[h];
    if (typeof v === "boolean") return v ? "1" : "0";
    if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
    return String(v ?? "");
  }).join(","));
  await writeFile(file, [header.join(","), ...rows].join("\n") + "\n");
  return file;
}

async function main(): Promise<void> {
  const framesArg = process.argv.indexOf("--frames");
  const framesRaw = framesArg !== -1 ? String(process.argv[framesArg + 1] ?? "") : "";
  const timeFrames = framesRaw
    ? framesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["1", "2", "3", "4"];

  console.log(`Step 1: harvesting OKX hot-tokens (time-frames: ${timeFrames.map((tf) => `${TF_LABELS[tf] ?? tf}`).join(", ")})...`);
  const t0 = Date.now();
  const cs = await harvestHotTokens(timeFrames);
  console.log(`  → ${cs.length} unique tokens in ${Date.now() - t0}ms`);

  if (cs.length === 0) {
    console.log("No OKX hot-tokens returned. Check onchainos auth / subscription.");
    return;
  }

  console.log(`\nStep 2: fetching forward OHLCV + Jup audit for each...`);
  let withOhlcv = 0;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i]!;
    try {
      const audit = await fetchJupAudit(c.mint);
      if (audit) {
        c.fees = audit.fees;
        c.organicScoreLabel = audit.organicScoreLabel;
        c.organicVolumePct = audit.organicVolumePct;
        c.organicBuyersPct = audit.organicBuyersPct;
      }
    } catch {
      // ignore
    }
    const candles = await fetchKlines(c.mint);
    computeForwardPnL(c, candles);
    if (c.hasOhlcv) withOhlcv++;
    process.stdout.write(`  ohlcv ${i + 1}/${cs.length}  hasData=${withOhlcv}\r`);
  }
  console.log(`  → ${withOhlcv}/${cs.length} have ≥1h of forward candles                  `);

  const csvFile = await writeCsv(cs);
  console.log(`\nCSV: ${csvFile}`);

  const usable = cs.filter((c) => c.hasOhlcv);
  if (usable.length === 0) {
    console.log("\nNo usable forward OHLCV.");
    return;
  }

  console.log(`\n========================================================================`);
  console.log(`SUMMARY — ${usable.length} OKX hot-tokens with forward OHLCV (winner = maxPnL >= ${WINNER_PCT}%)`);
  console.log(`========================================================================`);
  console.log(summarize("ALL", usable));

  console.log(`\nBy time-frame discovered in:`);
  for (const tf of timeFrames) {
    const label = TF_LABELS[tf] ?? tf;
    console.log(summarize(`tf=${label}`, usable.filter((c) => c.tfLabel === label)));
  }

  // Sweeps correspond directly to knobs in signals.okx.discovery.baseline
  sweep("holders (baseline minHolders)", usable, "holders",
    [0, 100, 200, 500, 1_000, 2_500, 5_000], "min");
  sweep("liquidityUsd (baseline minLiquidityUsd)", usable, "liquidityUsd",
    [0, 5_000, 10_000, 25_000, 50_000, 100_000], "min");
  sweep("marketCapUsd — lower bound", usable, "marketCapUsd",
    [0, 10_000, 25_000, 50_000, 100_000, 250_000], "min");
  sweep("marketCapUsd — upper bound", usable, "marketCapUsd",
    [5_000_000, 1_000_000, 500_000, 250_000, 100_000], "max");
  sweep("top10Pct (baseline maxTop10HolderRate, 0-100)", usable, "top10Pct",
    [100, 50, 40, 30, 25, 20], "max");
  sweep("bundleHoldPct (baseline maxBundlerRate)", usable, "bundleHoldPct",
    [100, 50, 30, 20, 10, 5], "max");
  sweep("devHoldPct (baseline maxCreatorBalanceRate)", usable, "devHoldPct",
    [100, 30, 20, 15, 10, 5], "max");
  sweep("uniqueTraders", usable, "uniqueTraders",
    [0, 25, 50, 100, 250, 500], "min");
  sweep("buySellRatio (trigger minBuySellRatio)", usable, "buySellRatio",
    [0, 1, 1.15, 1.5, 2, 3], "min");
  sweep("volumeUsd (hot-tokens window)", usable, "volumeUsd",
    [0, 10_000, 50_000, 250_000, 1_000_000], "min");
  sweep("priceChangePct (already pumping?)", usable, "priceChangePct",
    [0, 5, 10, 25, 50], "min");
  sweep("tokenAgeHours (filter out fresh rugs)", usable, "tokenAgeHours",
    [0, 1, 6, 24, 72, 168], "min");
}

// Only run main() when executed directly, not when imported as a library.
const isMainModule = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return entry.endsWith("_okxFilterAnalysis.ts") || entry.endsWith("_okxFilterAnalysis.js");
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error("FATAL", err);
    process.exit(1);
  });
}
