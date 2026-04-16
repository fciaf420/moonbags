/**
 * LLM memory for the exit advisor.
 *
 * Tiered memory:
 *   - L2 (in-memory): ring buffer of recent PositionSnapshots + recent LLM
 *     decisions per mint. computeTrends() turns the snapshot ring into a
 *     compact trend-vector block that the user prompt embeds.
 *   - L3 (persisted):   state/llm_decisions.json — a shadow log written on
 *     every position close, capturing the full decision timeline + a
 *     post-mortem verdict. Not read back into prompts YET (shadow mode).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { PositionSnapshot } from "./okxClient.js";

// ---------------------------------------------------------------------------
// L2 — in-memory ring buffers
// ---------------------------------------------------------------------------
const SNAPSHOT_DEPTH = 10;
const DECISION_DEPTH = 10;

type SnapshotRecord = { at: number; snap: PositionSnapshot };

export type DecisionRecord = {
  at: number;
  action: "hold" | "exit_now" | "set_trail" | "tighten_trail";   // legacy "tighten_trail" tolerated
  newTrailPct?: number;
  oldTrailPct: number;
  reason: string;
  pnlPct: number;        // decimal at time of decision (e.g. 0.574)
  peakPnlPct: number;    // decimal
};

const snapshotLog = new Map<string, SnapshotRecord[]>();
const decisionLog = new Map<string, DecisionRecord[]>();

export function recordSnapshot(mint: string, snap: PositionSnapshot): void {
  const arr = snapshotLog.get(mint) ?? [];
  arr.push({ at: Date.now(), snap });
  if (arr.length > SNAPSHOT_DEPTH) arr.splice(0, arr.length - SNAPSHOT_DEPTH);
  snapshotLog.set(mint, arr);
}

export function recordDecision(mint: string, dec: DecisionRecord): void {
  const arr = decisionLog.get(mint) ?? [];
  arr.push(dec);
  if (arr.length > DECISION_DEPTH) arr.splice(0, arr.length - DECISION_DEPTH);
  decisionLog.set(mint, arr);
}

export function getSnapshots(mint: string): SnapshotRecord[] {
  return snapshotLog.get(mint) ?? [];
}

export function getDecisions(mint: string): DecisionRecord[] {
  return decisionLog.get(mint) ?? [];
}

export function clearMint(mint: string): void {
  snapshotLog.delete(mint);
  decisionLog.delete(mint);
}

// ---------------------------------------------------------------------------
// Trend vectors — last ~5 samples of each key signal, oldest → newest
// ---------------------------------------------------------------------------
export type TrendVectors = {
  samples: number;
  ageSecs: number[];
  price: number[];
  volume5m: number[];
  priceChange5m: number[];
  holders: number[];
  smartMoneyNetFlow: number[];
  bundlersNetFlow: number[];
  devNetFlow: number[];
  whalesNetFlow: number[];
  topHoldersAvgPnl: number[];
  liquidityTotal: number[];
};

const TREND_SAMPLES = 5;

function liquiditySum(snap: PositionSnapshot): number {
  return snap.liquidity.reduce((s, p) => s + p.liquidityUsd, 0);
}

export function computeTrends(mint: string): TrendVectors | null {
  const arr = snapshotLog.get(mint);
  if (!arr || arr.length < 2) return null;

  // oldest → newest, keep last TREND_SAMPLES
  const slice = arr.slice(-TREND_SAMPLES);
  const now = Date.now();

  const price: number[] = [];
  const volume5m: number[] = [];
  const priceChange5m: number[] = [];
  const holders: number[] = [];
  const smartMoneyNetFlow: number[] = [];
  const bundlersNetFlow: number[] = [];
  const devNetFlow: number[] = [];
  const whalesNetFlow: number[] = [];
  const topHoldersAvgPnl: number[] = [];
  const liquidityTotal: number[] = [];
  const ageSecs: number[] = [];

  for (const rec of slice) {
    const s = rec.snap;
    ageSecs.push(Math.floor((now - rec.at) / 1000));
    price.push(s.momentum?.priceUsd ?? 0);
    volume5m.push(s.momentum?.volume5m ?? 0);
    priceChange5m.push(s.momentum?.priceChange5m ?? 0);
    holders.push(s.momentum?.holders ?? 0);
    smartMoneyNetFlow.push(s.smartMoney.netFlowSol);
    bundlersNetFlow.push(s.bundlers.netFlowSol);
    devNetFlow.push(s.dev.netFlowSol);
    whalesNetFlow.push(s.whales.netFlowSol);
    topHoldersAvgPnl.push(s.topHolders?.averagePnlUsd ?? 0);
    liquidityTotal.push(liquiditySum(s));
  }

  return {
    samples: slice.length,
    ageSecs,
    price,
    volume5m,
    priceChange5m,
    holders,
    smartMoneyNetFlow,
    bundlersNetFlow,
    devNetFlow,
    whalesNetFlow,
    topHoldersAvgPnl,
    liquidityTotal,
  };
}

// ---------------------------------------------------------------------------
// L3 — persistent decision log (shadow-mode; not read back into prompts)
// ---------------------------------------------------------------------------
const STATE_DIR = path.resolve("state");
const DECISIONS_FILE = path.join(STATE_DIR, "llm_decisions.json");
const MAX_RECORDS = 500;

export type LlmTradeRecord = {
  mint: string;
  name: string;
  openedAt: number;
  closedAt: number;
  holdSecs: number;
  entryPnlPct: number;
  exitPnlPct: number;
  peakPnlPct: number;
  exitReason: string;
  decisions: DecisionRecord[];
  verdict:
    | "correct_exit"
    | "premature_exit"
    | "correct_tighten"
    | "premature_tighten"
    | "held_well"
    | "stuck_loser"
    | "mixed";
};

export function computeVerdict(
  rec: Omit<LlmTradeRecord, "verdict">,
): LlmTradeRecord["verdict"] {
  const hadTighten = rec.decisions.some(
    (d) =>
      (d.action === "set_trail" || d.action === "tighten_trail") &&
      d.newTrailPct != null &&
      d.newTrailPct < d.oldTrailPct,
  );
  const hadExit = rec.exitReason === "llm";
  const allHolds = rec.decisions.length > 0 && rec.decisions.every((d) => d.action === "hold");
  const exitPct = rec.exitPnlPct;
  const peakPct = rec.peakPnlPct;
  const capturedRatio = peakPct > 0 ? exitPct / peakPct : 1;

  if (hadExit) {
    return capturedRatio > 0.7 ? "correct_exit" : "premature_exit";
  }
  if (hadTighten) {
    return capturedRatio > 0.5 ? "correct_tighten" : "premature_tighten";
  }
  if (allHolds) {
    return exitPct > 0.5 ? "held_well" : "stuck_loser";
  }
  return "mixed";
}

// Serialize writes to llm_decisions.json — concurrent closes must not race
// the read-modify-write.
let chain: Promise<void> = Promise.resolve();

export async function appendLlmTradeRecord(rec: LlmTradeRecord): Promise<void> {
  chain = chain.then(async () => {
    try {
      await mkdir(STATE_DIR, { recursive: true });
      let all: LlmTradeRecord[] = [];
      try {
        const raw = await readFile(DECISIONS_FILE, "utf8");
        all = JSON.parse(raw) as LlmTradeRecord[];
      } catch {
        /* first write */
      }
      all.push(rec);
      if (all.length > MAX_RECORDS) all = all.slice(-MAX_RECORDS);
      await writeFile(DECISIONS_FILE, JSON.stringify(all, null, 2));
    } catch (err) {
      // Don't crash position close on logging error
      // eslint-disable-next-line no-console
      console.error("[llm-decisions] append failed:", String(err));
    }
  });
  return chain;
}

export async function readLlmTradeRecords(limit = 100): Promise<LlmTradeRecord[]> {
  try {
    const raw = await readFile(DECISIONS_FILE, "utf8");
    const all = JSON.parse(raw) as LlmTradeRecord[];
    return all.slice(-limit).reverse();
  } catch {
    return [];
  }
}
