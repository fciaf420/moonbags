import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Position, ScgAlert } from "./types.js";
import { CONFIG, SOL_MINT } from "./config.js";
import logger from "./logger.js";
import { buyTokenWithSol, sellTokenForSol, getWalletTokenBalance, unwrapResidualWsol } from "./jupClient.js";
import { getBatchPricesParallel, getPriceViaSellQuote } from "./priceFeed.js";
import { notifyBuy, notifyBuyFail, notifySell, notifySellFail, notifyArmed, notifyMoonbagStart, notifyLlmActive, notifyLlmTighten, notifyLlmPartial, notifyTakeProfitPartial, notifyMilestone } from "./notifier.js";
import { consultLlm, type LlmContext } from "./llmExitAdvisor.js";
import { getPositionSnapshot } from "./okxClient.js";
import { getRuntimeSettings, type TpTarget } from "./settingsStore.js";
import {
  appendLlmTradeRecord,
  computeVerdict,
  getDecisions,
  clearMint as clearLlmMemory,
  type LlmTradeRecord,
} from "./llmMemory.js";

const positions = new Map<string, Position>();
const BOOT_AT = Date.now();
let realizedPnlSol = 0;

type CloseReason = "trail" | "stop" | "timeout" | "take_profit" | "manual" | "moonbag_trail" | "moonbag_timeout" | "llm";

const STATE_DIR = path.resolve("state");
const STATE_FILE = path.join(STATE_DIR, "positions.json");
const CLOSED_LOG = path.join(STATE_DIR, "closed.json");
const STRANDED_LOG = path.join(STATE_DIR, "stranded.json");
let persistTimer: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Closed-trade log — appended on every sell so /pnl and /history can read it
// back later (in-memory positions are wiped ~60s after close).
// ---------------------------------------------------------------------------
export type ClosedTrade = {
  mint: string;
  name: string;
  closedAt: number;
  openedAt: number;
  holdSecs: number;
  entrySol: number;
  exitSol: number;
  pnlSol: number;
  pnlPct: number;
  peakPnlPct: number;
  reason: string;
  partialCount?: number;
  partialEntrySol?: number;
  partialExitSol?: number;
  remainingEntrySol?: number;
  remainingExitSol?: number;
  llmReason?: string;
  exitSig?: string;
};

// Serializes writes to closed.json — without this, concurrent closes can
// race the read-modify-write and lose trade rows.
let closedLogChain: Promise<void> = Promise.resolve();

async function appendClosedTrade(t: ClosedTrade): Promise<void> {
  closedLogChain = closedLogChain.then(async () => {
    try {
      await mkdir(STATE_DIR, { recursive: true });
      let all: ClosedTrade[] = [];
      try {
        const raw = await readFile(CLOSED_LOG, "utf8");
        all = JSON.parse(raw) as ClosedTrade[];
      } catch { /* first write */ }
      all.push(t);
      // keep only most recent 500 trades
      if (all.length > 500) all = all.slice(-500);
      await writeFile(CLOSED_LOG, JSON.stringify(all, null, 2));
    } catch (err) {
      logger.error({ err: String(err) }, "[closed-log] append failed");
    }
  });
  return closedLogChain;
}

export async function getClosedTrades(limit = 100): Promise<ClosedTrade[]> {
  try {
    const raw = await readFile(CLOSED_LOG, "utf8");
    const all = JSON.parse(raw) as ClosedTrade[];
    return all.slice(-limit).reverse();
  } catch {
    return [];
  }
}

function serializePos(p: Position): Record<string, unknown> {
  return {
    ...p,
    tokensHeld: p.tokensHeld.toString(),
    originalTokensHeld: p.originalTokensHeld?.toString(),
  };
}

function deserializePos(raw: Record<string, unknown>): Position {
  return {
    ...raw,
    tokensHeld: BigInt(String(raw.tokensHeld ?? "0")),
    originalTokensHeld: raw.originalTokensHeld ? BigInt(String(raw.originalTokensHeld)) : undefined,
  } as Position;
}

function getPartialExitAccounting(position: Position, remainingEntrySol: number): {
  count: number;
  entrySol: number;
  exitSol: number;
  pnlSol: number;
} {
  const partials = position.partialExits ?? [];
  if (partials.length === 0) return { count: 0, entrySol: 0, exitSol: 0, pnlSol: 0 };

  const exitSol = partials.reduce((sum, p) => sum + p.exitSol, 0);
  const storedEntrySol = partials.reduce((sum, p) => sum + (p.entrySol ?? 0), 0);
  const hasStoredBasis = partials.every((p) => typeof p.entrySol === "number" && Number.isFinite(p.entrySol));

  if (hasStoredBasis) {
    const pnlSol = partials.reduce((sum, p) => sum + (p.pnlSol ?? p.exitSol - (p.entrySol ?? 0)), 0);
    return { count: partials.length, entrySol: storedEntrySol, exitSol, pnlSol };
  }

  // Back-compat for positions that were already partially sold before we
  // started persisting tranche basis. Each sellPct is a fraction of the
  // then-current remaining position, so reconstruct the original basis from
  // the final remaining basis and walk the partials forward.
  const remainingFraction = partials.reduce((product, p) => product * (1 - p.sellPct), 1);
  if (remainingFraction <= 0 || !Number.isFinite(remainingFraction)) {
    return { count: partials.length, entrySol: storedEntrySol, exitSol, pnlSol: exitSol - storedEntrySol };
  }

  let entryBefore = remainingEntrySol / remainingFraction;
  let entrySol = 0;
  for (const partial of partials) {
    const allocatedEntry = entryBefore * partial.sellPct;
    entrySol += allocatedEntry;
    entryBefore -= allocatedEntry;
  }
  return { count: partials.length, entrySol, exitSol, pnlSol: exitSol - entrySol };
}

function markDirty(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await mkdir(STATE_DIR, { recursive: true });
      const payload = {
        savedAt: Date.now(),
        realizedPnlSol,
        positions: Array.from(positions.values()).map(serializePos),
      };
      await writeFile(STATE_FILE, JSON.stringify(payload, null, 2));
    } catch (err) {
      logger.error({ err: String(err) }, "[state] persist failed");
    }
  }, 500);
  persistTimer.unref?.();
}

async function flushPersist(): Promise<void> {
  // Cancel any pending debounce
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    await mkdir(STATE_DIR, { recursive: true });
    const payload = {
      savedAt: Date.now(),
      realizedPnlSol,
      positions: Array.from(positions.values()).map(serializePos),
    };
    await writeFile(STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    logger.error({ err: String(err) }, "[state] flush persist failed");
  }
}

async function recordStranded(record: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    let all: Record<string, unknown>[] = [];
    try {
      const raw = await readFile(STRANDED_LOG, "utf8");
      all = JSON.parse(raw) as Record<string, unknown>[];
    } catch { /* first write */ }
    all.push({ recordedAt: Date.now(), ...record });
    await writeFile(STRANDED_LOG, JSON.stringify(all, null, 2));
  } catch (err) {
    logger.error({ err: String(err) }, "[stranded-log] write failed");
  }
}

export async function loadPersistedPositions(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const payload = JSON.parse(raw) as { realizedPnlSol?: number; positions?: Record<string, unknown>[] };
    realizedPnlSol = payload.realizedPnlSol ?? 0;
    const loaded = payload.positions ?? [];
    let restored = 0;
    let dropped = 0;
    for (const r of loaded) {
      const pos = deserializePos(r);
      if (pos.status === "open") {
        positions.set(pos.mint, pos);
        restored++;
      } else if (pos.status === "opening" || pos.status === "closing") {
        // Try to reconcile: if the wallet has tokens, the trade likely landed
        // on-chain. Adopt as "open" so the bot can manage it. Record the recovery
        // to state/stranded.json for manual review either way.
        const previousStatus = pos.status;
        const walletBalance = await getWalletTokenBalance(pos.mint).catch(() => null);
        if (walletBalance && walletBalance > 0n) {
          pos.status = "open";
          pos.tokensHeld = walletBalance;
          positions.set(pos.mint, pos);
          restored++;
          await recordStranded({
            mint: pos.mint,
            name: pos.name,
            previousStatus: `${previousStatus} (recovered)`,
            walletBalance: walletBalance.toString(),
            action: "adopted as open",
          });
          logger.warn({ mint: pos.mint, balance: walletBalance.toString() }, "[state] recovered in-flight position from wallet balance");
        } else {
          await recordStranded({
            mint: pos.mint,
            name: pos.name,
            previousStatus,
            walletBalance: walletBalance == null ? "unknown" : "0",
            action: "dropped",
          });
          logger.warn({ mint: pos.mint, status: previousStatus }, "[state] dropped in-flight position (no wallet balance)");
          dropped++;
        }
      }
    }
    logger.info({ restored, dropped, realizedPnlSol }, "[state] positions restored");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      logger.info("[state] no prior state file, starting fresh");
    } else {
      logger.error({ err: String(err) }, "[state] load failed");
    }
  }
}

export function getPositions(): Position[] {
  return Array.from(positions.values());
}

export function adoptPosition(p: Position): void {
  positions.set(p.mint, p);
  markDirty();
}

export async function forceClosePosition(mint: string): Promise<{ ok: boolean; reason: string }> {
  const p = positions.get(mint);
  if (!p) return { ok: false, reason: "not found" };
  if (p.status === "closed" || p.status === "failed") {
    return { ok: false, reason: `already ${p.status}` };
  }
  if (p.status === "closing") {
    return { ok: false, reason: "sell already in flight" };
  }
  void closePosition(mint, "manual" as const);
  return { ok: true, reason: "sell initiated" };
}

export function getStats(): {
  bootAt: number;
  realizedPnlSol: number;
  openCount: number;
  maxConcurrent: number;
  dryRun: boolean;
} {
  let openCount = 0;
  for (const p of positions.values()) {
    if (p.status === "opening" || p.status === "open" || p.status === "closing") openCount++;
  }
  return {
    bootAt: BOOT_AT,
    realizedPnlSol,
    openCount,
    maxConcurrent: CONFIG.MAX_CONCURRENT_POSITIONS,
    dryRun: CONFIG.DRY_RUN,
  };
}

export async function openPosition(alert: ScgAlert): Promise<Position | null> {
  if (positions.size >= CONFIG.MAX_CONCURRENT_POSITIONS) {
    logger.info({ mint: alert.mint }, "capacity full, skipping");
    return null;
  }

  const existing = positions.get(alert.mint);
  if (existing) {
    return existing;
  }

  const placeholder: Position = {
    mint: alert.mint,
    name: alert.name,
    status: "opening",
    entrySolSpent: 0,
    tokensHeld: 0n,
    tokenDecimals: 0,
    entryPricePerTokenSol: 0,
    currentPricePerTokenSol: 0,
    peakPricePerTokenSol: 0,
    armed: false,
    openedAt: Date.now(),
    lastTickAt: Date.now(),
  };
  positions.set(alert.mint, placeholder);
  markDirty();

  const solLamports = BigInt(Math.floor(CONFIG.BUY_SIZE_SOL * 1_000_000_000));

  const buyResult = await buyTokenWithSol(alert.mint, solLamports);
  if (!buyResult) {
    placeholder.status = "failed";
    placeholder.exitReason = "error";
    markDirty();
    logger.error({ mint: alert.mint, name: alert.name }, "buyTokenWithSol failed");
    void notifyBuyFail({ name: alert.name, mint: alert.mint, attempts: 1 });
    scheduleCleanup(alert.mint);
    return null;
  }

  const { signature, tokensReceivedRaw, tokenDecimals } = buyResult;

  let entryPricePerTokenSol: number;
  const quote = await getPriceViaSellQuote(alert.mint, tokensReceivedRaw).catch(() => null);
  if (quote && tokensReceivedRaw > 0n) {
    entryPricePerTokenSol = Number(quote.solReceivedLamports) / 1e9 / (Number(tokensReceivedRaw) / Math.pow(10, tokenDecimals));
  } else if (tokensReceivedRaw > 0n) {
    entryPricePerTokenSol = (Number(solLamports) / 1e9) / (Number(tokensReceivedRaw) / Math.pow(10, tokenDecimals));
  } else {
    entryPricePerTokenSol = 0;
  }

  const position: Position = {
    mint: alert.mint,
    name: alert.name,
    status: "open",
    entrySig: signature,
    entrySolSpent: Number(solLamports) / 1e9,
    tokensHeld: tokensReceivedRaw,
    tokenDecimals,
    entryPricePerTokenSol,
    currentPricePerTokenSol: entryPricePerTokenSol,
    peakPricePerTokenSol: entryPricePerTokenSol,
    armed: false,
    openedAt: Date.now(),
    lastTickAt: Date.now(),
  };
  positions.set(alert.mint, position);
  await flushPersist();

  logger.info(
    {
      mint: alert.mint,
      name: alert.name,
      entrySig: signature,
      entrySolSpent: position.entrySolSpent,
      tokens: position.tokensHeld.toString(),
      entryPrice: entryPricePerTokenSol,
    },
    "position opened",
  );

  void notifyBuy({
    name: alert.name,
    mint: alert.mint,
    solSpent: position.entrySolSpent,
    entryMcap: alert.alert_mcap,
    entryPrice: entryPricePerTokenSol,
    signature,
  });

  return position;
}

export async function tickPositions(): Promise<void> {
  const openPositions = Array.from(positions.values()).filter((p) => p.status === "open");
  if (openPositions.length === 0) return;

  const mints = openPositions.map((p) => p.mint);
  const batchMints = Array.from(new Set([...mints, SOL_MINT]));

  const priceMap = await getBatchPricesParallel(batchMints).catch(() => new Map<string, number>());
  const solUsdPrice = priceMap.get(SOL_MINT);

  await Promise.all(
    openPositions.map((position) =>
      tickOne(position, priceMap, solUsdPrice).catch((err) => {
        logger.error({ err: String(err), mint: position.mint }, "tick failed");
      }),
    ),
  );
}

async function tickOne(
  position: Position,
  priceMap: Map<string, number>,
  solUsdPrice: number | undefined,
): Promise<void> {
  let currentPriceSol: number | null = null;

  const tokenUsdPrice = priceMap.get(position.mint);
  if (tokenUsdPrice && solUsdPrice && solUsdPrice > 0) {
    currentPriceSol = tokenUsdPrice / solUsdPrice;
  } else {
    // fallback: on-chain sell quote — slower but always accurate
    const quote = await getPriceViaSellQuote(position.mint, position.tokensHeld).catch(() => null);
    if (quote) {
      currentPriceSol = (quote.solPerTokenRaw * Math.pow(10, position.tokenDecimals)) / 1e9;
    }
  }

  if (currentPriceSol === null || !Number.isFinite(currentPriceSol) || currentPriceSol <= 0) {
    logger.warn({ mint: position.mint }, "price unavailable, skipping tick");
    position.lastTickAt = Date.now();
    return;
  }

  position.currentPricePerTokenSol = currentPriceSol;
  const settings = getRuntimeSettings();
  const { profitStrategy, risk, trail, runner } = settings.exit;

  // Moonbag mode: track moonbag peak separately
  if (position.moonbagMode) {
    if (currentPriceSol > (position.moonbagPeakPriceSol ?? 0)) {
      position.moonbagPeakPriceSol = currentPriceSol;
    }
    const mbPeak = position.moonbagPeakPriceSol ?? currentPriceSol;
    const mbDrawdown = 1 - currentPriceSol / mbPeak;
    const mbElapsed = (Date.now() - (position.moonbagStartedAt ?? Date.now())) / 1000;

    let mbReason: "moonbag_trail" | "moonbag_timeout" | null = null;
    if (runner.timeoutSecs > 0 && mbElapsed >= runner.timeoutSecs) {
      mbReason = "moonbag_timeout";
    } else if (runner.trailPct > 0 && mbDrawdown >= runner.trailPct) {
      mbReason = "moonbag_trail";
    }

    if (mbReason) {
      if (position.lastSellAttemptAt && Date.now() - position.lastSellAttemptAt < SELL_RETRY_COOLDOWN_MS) {
        position.lastTickAt = Date.now();
        return;
      }
      await closePosition(position.mint, mbReason);
    }
    position.lastTickAt = Date.now();
    return;
  }

  if (currentPriceSol > position.peakPricePerTokenSol) {
    position.peakPricePerTokenSol = currentPriceSol;
  }

  const entry = position.entryPricePerTokenSol;
  if (entry <= 0) {
    position.lastTickAt = Date.now();
    return;
  }

  const pnlPct = currentPriceSol / entry - 1;
  const drawdownFromPeakPct = 1 - currentPriceSol / position.peakPricePerTokenSol;
  const trailEligible =
    profitStrategy.type === "trail" ||
    profitStrategy.type === "llm_managed" ||
    (profitStrategy.type === "tp_ladder" && profitStrategy.trailRemainder && (position.tpTargetsHit?.length ?? 0) > 0);

  if (!position.armed && trailEligible && pnlPct >= trail.armPct) {
    position.armed = true;
    markDirty();
    logger.info({ mint: position.mint, pnlPct }, "armed trailing");
    void notifyArmed({ name: position.name, mint: position.mint, pnlPct });
  }

  // Milestone alerts — fire a Telegram notification (with inline sell button)
  // the first time a position crosses each configured PnL threshold on its
  // way UP. Dedupe via position.milestonesHit so each fires at most once.
  if (settings.milestones.enabled && pnlPct > 0 && settings.milestones.pcts.length > 0) {
    const pnlPctWhole = pnlPct * 100;
    const peakPnlPct = (position.peakPricePerTokenSol / entry - 1) * 100;
    const hit = position.milestonesHit ?? [];
    let dirty = false;
    for (const milestone of settings.milestones.pcts) {
      if (pnlPctWhole >= milestone && !hit.includes(milestone)) {
        hit.push(milestone);
        dirty = true;
        const currentSolValue = position.entrySolSpent * (currentPriceSol / entry);
        const unrealizedSol = currentSolValue - position.entrySolSpent;
        void notifyMilestone({
          name: position.name,
          mint: position.mint,
          milestonePct: milestone,
          currentPnlPct: pnlPctWhole,
          peakPnlPct,
          entrySol: position.entrySolSpent,
          unrealizedSol,
        });
        logger.info({ mint: position.mint, milestone, pnlPct: pnlPctWhole }, "milestone hit");
      }
    }
    if (dirty) {
      position.milestonesHit = hit;
      markDirty();
    }
  }

  // Effective trail: LLM may override CONFIG.TRAIL_PCT via dynamicTrailPct
  const effectiveTrailPct = position.dynamicTrailPct ?? trail.trailPct;

  let reason: "trail" | "stop" | "timeout" | "take_profit" | null = null;
  const elapsedSecs = (Date.now() - position.openedAt) / 1000;
  if (risk.maxHoldSecs > 0 && elapsedSecs >= risk.maxHoldSecs) {
    reason = "timeout";
  } else if (pnlPct <= -risk.stopPct) {
    reason = "stop";
  } else if (profitStrategy.type === "fixed_tp" && pnlPct >= profitStrategy.fixedTargetPct) {
    reason = "take_profit";
  } else if (profitStrategy.type === "tp_ladder") {
    const target = findTriggeredTpTarget(position, profitStrategy.ladderTargets, pnlPct);
    if (target) {
      if (target.target.sellPct >= 0.999) {
        reason = "take_profit";
      } else {
        await partialSellForTakeProfit(position, target.index, target.target, pnlPct);
        position.lastTickAt = Date.now();
        return;
      }
    }
  }

  if (!reason && trailEligible && position.armed && drawdownFromPeakPct >= effectiveTrailPct) {
    reason = "trail";
  }

  if (reason && position.lastSellAttemptAt && Date.now() - position.lastSellAttemptAt < SELL_RETRY_COOLDOWN_MS) {
    position.lastTickAt = Date.now();
    return;
  }

  if (reason) {
    const confirmQuote = await getPriceViaSellQuote(position.mint, position.tokensHeld).catch(() => null);
    if (confirmQuote) {
      const confirmedPrice = (confirmQuote.solPerTokenRaw * Math.pow(10, position.tokenDecimals)) / 1e9;
      if (Number.isFinite(confirmedPrice) && confirmedPrice > 0) {
        position.currentPricePerTokenSol = confirmedPrice;
        const confirmedPnl = confirmedPrice / entry - 1;
        const confirmedDrawdown = 1 - confirmedPrice / position.peakPricePerTokenSol;

        let stillTriggered = false;
        if (reason === "timeout") {
          stillTriggered = risk.maxHoldSecs > 0 && (Date.now() - position.openedAt) / 1000 >= risk.maxHoldSecs;
        } else if (reason === "stop") {
          stillTriggered = confirmedPnl <= -risk.stopPct;
        } else if (reason === "take_profit") {
          if (profitStrategy.type === "fixed_tp") {
            stillTriggered = confirmedPnl >= profitStrategy.fixedTargetPct;
          } else if (profitStrategy.type === "tp_ladder") {
            stillTriggered = Boolean(findTriggeredTpTarget(position, profitStrategy.ladderTargets, confirmedPnl));
          }
        } else if (reason === "trail") {
          stillTriggered = position.armed && confirmedDrawdown >= effectiveTrailPct;
        }

        if (stillTriggered) {
          // Skip moonbag when LLM is active — LLM owns post-arm exit decisions.
          if ((reason === "trail" || reason === "take_profit") && runner.keepPct > 0 && !CONFIG.LLM_EXIT_ENABLED) {
            await partialSellAndMoonbag(position, reason);
          } else {
            await closePosition(position.mint, reason);
          }
        } else {
          logger.info({ mint: position.mint, reason, confirmedPrice }, "exit dismissed after re-quote");
        }
      } else {
        if ((reason === "trail" || reason === "take_profit") && runner.keepPct > 0 && !CONFIG.LLM_EXIT_ENABLED) {
          await partialSellAndMoonbag(position, reason);
        } else {
          await closePosition(position.mint, reason);
        }
      }
    } else {
      if ((reason === "trail" || reason === "take_profit") && runner.keepPct > 0 && !CONFIG.LLM_EXIT_ENABLED) {
        await partialSellAndMoonbag(position, reason);
      } else {
        await closePosition(position.mint, reason);
      }
    }
  }

  position.lastTickAt = Date.now();
}

const MAX_SELL_RETRIES = 10;
const SELL_RETRY_COOLDOWN_MS = 60_000;

function findTriggeredTpTarget(
  position: Position,
  targets: TpTarget[],
  pnlPct: number,
): { index: number; target: TpTarget } | null {
  const hit = position.tpTargetsHit ?? [];
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    if (!target || hit.includes(index)) continue;
    if (pnlPct >= target.pnlPct) return { index, target };
  }
  return null;
}

async function partialSellForTakeProfit(
  position: Position,
  targetIndex: number,
  target: TpTarget,
  currentPnlPctDecimal: number,
): Promise<void> {
  if (position.status !== "open") {
    logger.debug({ mint: position.mint, currentStatus: position.status }, "[tp] skipped - not in 'open' state");
    return;
  }
  if (position.lastSellAttemptAt && Date.now() - position.lastSellAttemptAt < SELL_RETRY_COOLDOWN_MS) {
    logger.debug({ mint: position.mint, targetIndex }, "[tp] within sell cooldown, skipping");
    return;
  }

  const mint = position.mint;
  position.status = "closing";
  position.lastSellAttemptAt = Date.now();
  markDirty();

  const walletBalance = await getWalletTokenBalance(mint);
  if (walletBalance === 0n) {
    position.status = "closed";
    position.exitReason = "manual";
    markDirty();
    scheduleCleanup(mint);
    return;
  }

  const totalTokens = walletBalance ?? position.tokensHeld;
  const sellTokens = BigInt(Math.floor(Number(totalTokens) * target.sellPct));
  const remainingTokens = totalTokens - sellTokens;

  if (sellTokens <= 0n || remainingTokens <= 0n) {
    position.status = "open";
    markDirty();
    await closePosition(mint, "take_profit");
    return;
  }

  const sellResult = await sellTokenForSol(mint, sellTokens);
  if (!sellResult) {
    position.status = "open";
    markDirty();
    logger.warn({ mint, targetIndex, sellPct: target.sellPct }, "[tp] partial sell failed, will retry");
    return;
  }

  const exitSol = Number(sellResult.solReceivedLamports) / 1e9;
  const entrySolBefore = position.entrySolSpent;
  const allocatedEntry = entrySolBefore * target.sellPct;
  const remainingEntry = entrySolBefore * (1 - target.sellPct);
  realizedPnlSol += exitSol - allocatedEntry;

  position.originalTokensHeld = position.originalTokensHeld ?? totalTokens;
  position.tokensHeld = remainingTokens;
  position.entrySolSpent = remainingEntry;
  position.status = "open";
  position.sellFailureCount = 0;
  position.lastSellAttemptAt = undefined;
  position.tpTargetsHit = Array.from(new Set([...(position.tpTargetsHit ?? []), targetIndex])).sort((a, b) => a - b);
  position.partialExits = position.partialExits ?? [];
  position.partialExits.push({
    at: Date.now(),
    sellPct: target.sellPct,
    entrySol: allocatedEntry,
    exitSol,
    pnlSol: exitSol - allocatedEntry,
    priceSol: position.currentPricePerTokenSol,
    reason: `take_profit:${Math.round(target.pnlPct * 100)}%`,
    sig: sellResult.signature,
  });
  await flushPersist();

  const partialPnlPct = allocatedEntry > 0 ? (exitSol / allocatedEntry - 1) * 100 : 0;
  logger.info(
    { mint, targetIndex, targetPnlPct: target.pnlPct, sellPct: target.sellPct, exitSol, partialPnlPct, remainingTokens: remainingTokens.toString() },
    "[tp] partial take-profit executed",
  );
  void notifyTakeProfitPartial({
    name: position.name,
    mint,
    targetPnlPct: target.pnlPct,
    sellPct: target.sellPct,
    exitSol,
    partialPnlSol: exitSol - allocatedEntry,
    partialPnlPct,
    currentPnlPct: currentPnlPctDecimal * 100,
    signature: sellResult.signature ?? "",
  });
  unwrapResidualWsol().catch((err) => logger.warn({ err: String(err) }, "[wsol] post-tp-partial unwrap failed"));
}

async function partialSellAndMoonbag(position: Position, reason: "trail" | "take_profit"): Promise<void> {
  if (position.status !== "open") {
    logger.debug({ mint: position.mint, currentStatus: position.status }, "[partial-sell] skipped — not in 'open' state");
    return;
  }
  const runner = getRuntimeSettings().exit.runner;
  const mint = position.mint;
  position.status = "closing";
  position.lastSellAttemptAt = Date.now();
  markDirty();

  const walletBalance = await getWalletTokenBalance(mint);
  if (walletBalance === 0n) {
    position.status = "closed";
    position.exitReason = "manual";
    markDirty();
    scheduleCleanup(mint);
    return;
  }
  const totalTokens = walletBalance ?? position.tokensHeld;
  const moonbagTokens = BigInt(Math.floor(Number(totalTokens) * runner.keepPct));
  const sellTokens = totalTokens - moonbagTokens;

  if (sellTokens <= 0n) {
    position.status = "open";
    markDirty();
    return;
  }

  const sellResult = await sellTokenForSol(mint, sellTokens);
  if (!sellResult) {
    position.status = "open";
    markDirty();
    logger.warn({ mint, reason }, "partial sell for moonbag failed, will retry");
    return;
  }

  const exitSol = Number(sellResult.solReceivedLamports) / 1e9;
  const entrySol = position.entrySolSpent;
  const sellFraction = 1 - runner.keepPct;
  const allocatedEntry = entrySol * sellFraction;
  const moonbagEntry = entrySol * runner.keepPct;
  const pnlSolPct = allocatedEntry > 0 ? (exitSol / allocatedEntry - 1) * 100 : 0;
  realizedPnlSol += exitSol - allocatedEntry;

  position.originalTokensHeld = position.originalTokensHeld ?? totalTokens;
  position.tokensHeld = moonbagTokens;
  position.entrySolSpent = moonbagEntry; // reduce entry basis so moonbag close has correct PnL
  position.partialExits = position.partialExits ?? [];
  position.partialExits.push({
    at: Date.now(),
    sellPct: sellFraction,
    entrySol: allocatedEntry,
    exitSol,
    pnlSol: exitSol - allocatedEntry,
    priceSol: position.currentPricePerTokenSol,
    reason,
    sig: sellResult.signature,
  });
  position.moonbagMode = true;
  position.moonbagPeakPriceSol = position.currentPricePerTokenSol;
  position.moonbagStartedAt = Date.now();
  position.status = "open";
  position.exitSig = sellResult.signature;
  position.sellFailureCount = 0;
  position.lastSellAttemptAt = undefined;
  await flushPersist();

  const peakPnlPct = position.entryPricePerTokenSol > 0
    ? (position.peakPricePerTokenSol / position.entryPricePerTokenSol - 1) * 100
    : 0;

  logger.info(
    { mint, reason, exitSol, pnlSolPct, moonbagTokens: moonbagTokens.toString(), moonbagPct: runner.keepPct },
    "partial sell done, moonbag active",
  );

  void notifySell({
    name: position.name, mint, reason,
    entrySol: allocatedEntry, exitSol, pnlSolPct, peakPnlPct,
    holdSecs: Math.floor((Date.now() - position.openedAt) / 1000),
    signature: sellResult.signature ?? "",
  });

  void notifyMoonbagStart({
    name: position.name, mint,
    moonbagPct: runner.keepPct,
    mbTrailPct: runner.trailPct,
    mbTimeoutMins: runner.timeoutSecs / 60,
  });

  unwrapResidualWsol().catch((err) => logger.warn({ err: String(err) }, "[wsol] post-partial-sell unwrap failed"));
}

/**
 * LLM-managed partial exit — sell a fraction of the CURRENT tokensHeld and
 * keep the rest of the position running with its existing trail/stop/LLM
 * coverage. This is how we capture long-runner upside: lock profit in
 * chunks while staying exposed for more.
 *
 * Key differences from partialSellAndMoonbag (which is for the non-LLM
 * moonbag flow):
 *   - Position never flips into "moonbag mode" — the remainder keeps being
 *     consulted by the LLM each tick.
 *   - Called by the LLM advisor, not by the static trail path.
 *   - Entry basis is reduced proportionally so future PnL math on the
 *     remaining piece is correct (e.g. 50% partial sell cuts entrySolSpent
 *     in half — remaining piece's PnL is measured vs the residual entry).
 */
async function partialSellPosition(
  position: Position,
  sellPct: number,
  reason: string,
): Promise<void> {
  if (position.status !== "open") {
    logger.debug({ mint: position.mint, currentStatus: position.status }, "[partial-exit] skipped — not in 'open' state");
    return;
  }
  const mint = position.mint;

  // Cooldown gate — don't fire partials during a sell-retry backoff window.
  if (position.lastSellAttemptAt && Date.now() - position.lastSellAttemptAt < SELL_RETRY_COOLDOWN_MS) {
    logger.debug({ mint, sellPct }, "[partial-exit] within sell cooldown, skipping");
    return;
  }

  position.status = "closing";
  position.lastSellAttemptAt = Date.now();
  markDirty();

  const walletBalance = await getWalletTokenBalance(mint);
  if (walletBalance === 0n) {
    // Position tokens no longer present — treat as fully closed (manual sell).
    position.status = "closed";
    position.exitReason = "manual";
    markDirty();
    scheduleCleanup(mint);
    return;
  }
  const totalTokens = walletBalance ?? position.tokensHeld;
  const sellTokens = BigInt(Math.floor(Number(totalTokens) * sellPct));
  const remainingTokens = totalTokens - sellTokens;

  // Guards: avoid edge cases that would leave a useless dust position
  if (sellTokens <= 0n || remainingTokens < totalTokens / 10n) {
    logger.warn({ mint, totalTokens: totalTokens.toString(), sellTokens: sellTokens.toString(), remainingTokens: remainingTokens.toString() }, "[partial-exit] degenerate sell size, escalating to exit_now");
    position.status = "open";
    markDirty();
    await closePosition(mint, "llm");
    return;
  }

  const sellResult = await sellTokenForSol(mint, sellTokens);
  if (!sellResult) {
    position.status = "open";
    markDirty();
    logger.warn({ mint, sellPct }, "[partial-exit] sell failed, will retry on next LLM consult after cooldown");
    return;
  }

  const exitSol = Number(sellResult.solReceivedLamports) / 1e9;
  const entrySolBefore = position.entrySolSpent;
  const allocatedEntry = entrySolBefore * sellPct;
  const remainingEntry = entrySolBefore * (1 - sellPct);
  realizedPnlSol += exitSol - allocatedEntry;

  // Capture original tokensHeld the FIRST time a partial fires, so we can
  // compute a true "full-round-trip" PnL later.
  position.originalTokensHeld = position.originalTokensHeld ?? totalTokens;

  // Update position state: reduced size, reduced basis, back to open.
  position.tokensHeld = remainingTokens;
  position.entrySolSpent = remainingEntry;
  position.status = "open";
  position.sellFailureCount = 0;
  position.lastSellAttemptAt = undefined;
  position.lastLlmReason = reason;

  // Log the partial in the position history so subsequent consults know.
  position.partialExits = position.partialExits ?? [];
  position.partialExits.push({
    at: Date.now(),
    sellPct,
    entrySol: allocatedEntry,
    exitSol,
    pnlSol: exitSol - allocatedEntry,
    priceSol: position.currentPricePerTokenSol,
    reason,
    sig: sellResult.signature,
  });
  markDirty();

  const partialPnlPct = allocatedEntry > 0 ? (exitSol / allocatedEntry - 1) * 100 : 0;
  const currentPnlPct = position.entryPricePerTokenSol > 0
    ? (position.currentPricePerTokenSol / position.entryPricePerTokenSol - 1) * 100
    : 0;

  logger.info(
    { mint, sellPct, exitSol, partialPnlPct, currentPnlPct, remainingTokens: remainingTokens.toString(), priorPartials: position.partialExits.length - 1 },
    "[llm] partial_exit executed",
  );
  void notifyLlmPartial({
    name: position.name,
    mint,
    sellPct,
    exitSol,
    partialPnlSol: exitSol - allocatedEntry,
    partialPnlPct,
    currentPnlPct,
    reason,
    signature: sellResult.signature ?? "",
  });
  unwrapResidualWsol().catch((err) => logger.warn({ err: String(err) }, "[wsol] post-partial-exit unwrap failed"));
}

async function closePosition(mint: string, reason: CloseReason): Promise<void> {
  const position = positions.get(mint);
  if (!position) return;

  // Re-entry guard: if the position is already in-flight or closed, do nothing.
  // This prevents tickPositions and tickLlmAdvisor from concurrently issuing
  // duplicate sells, double-counting realizedPnlSol, etc.
  if (position.status !== "open") {
    logger.debug({ mint, currentStatus: position.status, attemptedReason: reason }, "[close] skipped — not in 'open' state");
    return;
  }

  position.status = "closing";
  position.lastSellAttemptAt = Date.now();
  markDirty();

  const walletBalance = await getWalletTokenBalance(mint);
  if (walletBalance === 0n) {
    position.status = "closed";
    position.exitReason = "manual";
    markDirty();
    logger.info({ mint, reason }, "position tokens no longer in wallet (manually sold), marking closed");
    scheduleCleanup(mint);
    return;
  }
  if (walletBalance !== null && walletBalance !== position.tokensHeld) {
    logger.warn(
      { mint, expected: position.tokensHeld.toString(), actual: walletBalance.toString() },
      "wallet balance differs from tracked tokensHeld, using actual balance",
    );
    position.tokensHeld = walletBalance;
    markDirty();
  }

  const sellAmount = walletBalance ?? position.tokensHeld;
  const sellResult = await sellTokenForSol(mint, sellAmount);
  if (!sellResult) {
    const count = (position.sellFailureCount ?? 0) + 1;
    position.sellFailureCount = count;
    if (count >= MAX_SELL_RETRIES) {
      position.status = "failed";
      position.exitReason = "error";
      markDirty();
      logger.error(
        { mint, reason, tokens: position.tokensHeld.toString(), attempts: count },
        "sellTokenForSol failed permanently after max retries",
      );
      void notifySellFail({ name: position.name, mint, reason, attempts: count });
      scheduleCleanup(mint);
      return;
    }
    position.status = "open";
    markDirty();
    logger.warn(
      { mint, reason, attempt: count, maxAttempts: MAX_SELL_RETRIES, cooldownSec: SELL_RETRY_COOLDOWN_MS / 1000 },
      "sellTokenForSol failed, will retry on next tick after cooldown",
    );
    return;
  }

  const exitSol = Number(sellResult.solReceivedLamports) / 1e9;
  const entrySol = position.entrySolSpent;
  const pnlSolPct = entrySol > 0 ? (exitSol / entrySol - 1) * 100 : 0;
  realizedPnlSol += exitSol - entrySol;

  const partials = getPartialExitAccounting(position, entrySol);
  const cumulativeEntrySol = entrySol + partials.entrySol;
  const cumulativeExitSol = exitSol + partials.exitSol;
  const cumulativePnlSol = cumulativeExitSol - cumulativeEntrySol;
  const cumulativePnlSolPct = cumulativeEntrySol > 0 ? (cumulativeExitSol / cumulativeEntrySol - 1) * 100 : 0;

  position.status = "closed";
  position.exitSig = sellResult.signature;
  position.exitReason = reason;
  await flushPersist();

  const peakPnlPctLog = position.entryPricePerTokenSol > 0
    ? (position.peakPricePerTokenSol / position.entryPricePerTokenSol - 1) * 100
    : 0;
  const holdSecsLog = Math.floor((Date.now() - position.openedAt) / 1000);

  logger.info(
    { mint, reason, entrySol, exitSol, pnlSolPct, partialCount: partials.count, cumulativeEntrySol, cumulativeExitSol, cumulativePnlSolPct },
    "position closed",
  );
  void appendClosedTrade({
    mint, name: position.name,
    closedAt: Date.now(), openedAt: position.openedAt, holdSecs: holdSecsLog,
    entrySol: cumulativeEntrySol,
    exitSol: cumulativeExitSol,
    pnlSol: cumulativePnlSol,
    pnlPct: cumulativePnlSolPct,
    peakPnlPct: peakPnlPctLog,
    partialCount: partials.count || undefined,
    partialEntrySol: partials.count ? partials.entrySol : undefined,
    partialExitSol: partials.count ? partials.exitSol : undefined,
    remainingEntrySol: partials.count ? entrySol : undefined,
    remainingExitSol: partials.count ? exitSol : undefined,
    reason, llmReason: reason === "llm" ? position.lastLlmReason : undefined,
    exitSig: sellResult.signature,
  });

  // L3 shadow logger: persist decision timeline + post-mortem verdict so
  // future PRs can inject a "recent track record" block back into the prompt.
  if (CONFIG.LLM_EXIT_ENABLED) {
    const decisions = getDecisions(mint);
    if (decisions.length > 0) {
      const base: Omit<LlmTradeRecord, "verdict"> = {
        mint,
        name: position.name,
        openedAt: position.openedAt,
        closedAt: Date.now(),
        holdSecs: holdSecsLog,
        entryPnlPct: 0,
        // Store PnL as a decimal (0.574 for +57.4%) — this is the scale the
        // verdict heuristic reasons about, not the whole-percent log value.
        exitPnlPct: cumulativeEntrySol > 0 ? cumulativeExitSol / cumulativeEntrySol - 1 : 0,
        peakPnlPct: position.entryPricePerTokenSol > 0
          ? position.peakPricePerTokenSol / position.entryPricePerTokenSol - 1
          : 0,
        exitReason: reason,
        decisions,
      };
      const verdict = computeVerdict(base);
      void appendLlmTradeRecord({ ...base, verdict });
    }
    clearLlmMemory(mint);
  }
  void notifySell({
    name: position.name,
    mint,
    reason,
    entrySol: cumulativeEntrySol,
    exitSol: cumulativeExitSol,
    pnlSolPct: cumulativePnlSolPct,
    peakPnlPct: peakPnlPctLog,
    holdSecs: holdSecsLog,
    signature: sellResult.signature ?? "",
    llmReason: reason === "llm" ? position.lastLlmReason : undefined,
  });
  unwrapResidualWsol().catch((err) => logger.warn({ err: String(err) }, "[wsol] post-sell unwrap failed"));
  scheduleCleanup(mint);
}

function scheduleCleanup(mint: string): void {
  setTimeout(() => {
    const p = positions.get(mint);
    if (p && (p.status === "closed" || p.status === "failed")) {
      positions.delete(mint);
    }
  }, 60_000).unref?.();
}

// ---------------------------------------------------------------------------
// LLM exit advisor — runs on its own interval (LLM_POLL_MS).
//
// Gating:
//   - only fires when CONFIG.LLM_EXIT_ENABLED === true
//   - only consults positions that are status="open" AND armed
//     (pre-arm positions are protected by hard STOP_PCT only — same as today)
//   - per-position throttle of LLM_POLL_MS so multiple ticks within the
//     window won't double-call the LLM for the same position
// ---------------------------------------------------------------------------
export async function tickLlmAdvisor(): Promise<void> {
  if (!CONFIG.LLM_EXIT_ENABLED) return;

  const llmPollMs = CONFIG.LLM_POLL_MS;
  const candidates = Array.from(positions.values()).filter((p) =>
    p.status === "open" &&
    p.armed &&
    !p.moonbagMode &&    // moonbag is disabled when LLM is on, but defensive
    (!p.lastLlmCheckAt || Date.now() - p.lastLlmCheckAt >= llmPollMs),
  );

  if (candidates.length === 0) return;

  await Promise.all(candidates.map((p) => consultOnePosition(p).catch((err) => {
    logger.error({ err: String(err), mint: p.mint }, "[llm] advisor tick failed");
  })));
}

async function consultOnePosition(position: Position): Promise<void> {
  position.lastLlmCheckAt = Date.now();

  const entry = position.entryPricePerTokenSol;
  const current = position.currentPricePerTokenSol;
  const peak = position.peakPricePerTokenSol;
  if (entry <= 0 || current <= 0 || peak <= 0) return;

  // One-time "LLM watching" notification when LLM first picks up an armed position.
  if (!position.llmActiveNotified) {
    position.llmActiveNotified = true;
    markDirty();
    void notifyLlmActive({
      name: position.name,
      mint: position.mint,
      trailPct: position.dynamicTrailPct ?? CONFIG.TRAIL_PCT,
      pnlPct: current / entry - 1,
    });
  }

  const ctx: LlmContext = {
    name: position.name,
    mint: position.mint,
    entryPriceUsd: entry,                        // priced in SOL — fine, model treats as relative
    currentPriceUsd: current,
    pnlPct: current / entry - 1,
    peakPnlPct: peak / entry - 1,
    drawdownFromPeakPct: 1 - current / peak,
    currentTrailPct: position.dynamicTrailPct ?? CONFIG.TRAIL_PCT,
    ceilingTrailPct: CONFIG.TRAIL_PCT,           // user-configured default is the max trail allowed
    holdSecs: Math.floor((Date.now() - position.openedAt) / 1000),
  };

  const snapshot = await getPositionSnapshot(position.mint, 30).catch((err) => {
    logger.warn({ err: String(err), mint: position.mint }, "[llm] snapshot fetch failed");
    return null;
  });
  if (!snapshot) return;

  const decision = await consultLlm(ctx, snapshot);
  if (!decision) return;   // null = fall back to existing trail logic for this poll

  if (decision.action === "hold") {
    logger.debug({ mint: position.mint, reason: decision.reason }, "[llm] hold");
    return;
  }

  if (decision.action === "set_trail" && decision.newTrailPct != null) {
    const oldTrail = position.dynamicTrailPct ?? CONFIG.TRAIL_PCT;
    // Dedupe: only act + notify if this is a meaningful change (either direction)
    if (Math.abs(decision.newTrailPct - oldTrail) < 0.01) {
      logger.debug({ mint: position.mint, oldTrail, newTrail: decision.newTrailPct }, "[llm] set_trail no-op");
      return;
    }
    const direction = decision.newTrailPct < oldTrail ? "tightened" : "loosened";
    position.dynamicTrailPct = decision.newTrailPct;
    position.lastLlmReason = decision.reason;
    markDirty();
    logger.info(
      { mint: position.mint, oldTrail, newTrail: decision.newTrailPct, direction, reason: decision.reason },
      "[llm] trail changed",
    );
    // TODO: notifier.ts currently says "tightened" explicitly. Reuse for now;
    // revisit when notifier gets a generic "trail changed" variant that handles
    // both tighten and loosen copy.
    void notifyLlmTighten({
      name: position.name,
      mint: position.mint,
      oldTrailPct: oldTrail,
      newTrailPct: decision.newTrailPct,
      reason: decision.reason,
    });
    return;
  }

  if (decision.action === "exit_now") {
    logger.info({ mint: position.mint, reason: decision.reason }, "[llm] exit triggered");
    position.lastLlmReason = decision.reason;
    markDirty();
    await closePosition(position.mint, "llm");
    return;
  }

  if (decision.action === "partial_exit" && decision.sellPct != null) {
    // Safety caps — defensive beyond the validator in llmExitAdvisor.
    if (decision.sellPct < 0.10 || decision.sellPct > 0.75) {
      logger.warn({ mint: position.mint, sellPct: decision.sellPct }, "[llm] partial_exit sellPct out of band, ignoring");
      return;
    }
    // Don't allow too many partial exits per position (sanity cap).
    const priorPartials = position.partialExits?.length ?? 0;
    if (priorPartials >= 5) {
      logger.warn({ mint: position.mint, priorPartials }, "[llm] partial_exit cap reached (5), ignoring");
      return;
    }
    await partialSellPosition(position, decision.sellPct, decision.reason);
  }
}
