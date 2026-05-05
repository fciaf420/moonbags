/**
 * OKX discovery signal source.
 *
 * private-feed-style pipeline modeled on src/gmgnSignalSource.ts:
 *   1. Seed: `onchainos token hot-tokens --chain solana --rank-by 5 --time-frame 1 --limit 100`
 *      (volume-ranked 5m window, top 100). Polled every 30s.
 *   2. Track: survivors land in a watchlist. A candidate must be seen across
 *      N scans, grow holders, keep liquidity stable, and maintain a healthy
 *      buy/sell ratio before we will consider firing.
 *   3. Deep-dive: just before emit, pull `onchainos token advanced-info` to
 *      backfill top10HoldPercent, bundleHoldingPercent, sniperHoldingPercent,
 *      devHoldingPercent on a per-token basis. Best-effort merge from
 *      `onchainos memepump token-bundle-info` when cheap.
 *   4. Alert: emit a normalized SignalAlert via `onAcceptedCandidate` so
 *      positionManager picks it up the same way it handles Private Feed/OKX/GMGN alerts.
 *
 * See gmgnSignalSource.ts for the architectural blueprint.
 */

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import logger from "./logger.js";
import type { SignalAlert } from "./types.js";
import { checkSignalMintCooldown, markSignalMintAccepted } from "./sourceDedupe.js";
import { getRuntimeSettings } from "./settingsStore.js";
import { fetchJupAudit, passesJupGate } from "./jupGate.js";
import { isBlacklisted, isPaused, recordAlertEvent } from "./privateSignalPoller.js";
import {
  getMaybeBool,
  getMaybeNumber,
  getMaybeString,
} from "./gmgnClient.js";

type OkxDiscoverySourceKind = "hot_tokens" | "watchlist";

export type OkxRow = Record<string, unknown>;

type OkxDiscoverySettings = {
  enabled: boolean;
  pollMs: number;
  mintCooldownMins: number;
  watchlistTtlMins: number;
  maxWatchMints: number;
  maxCandidatesPerPoll: number;
  seedLimit: number;
  timeFrame: string;
  rankBy: string;
  includeBundleInfo: boolean;
  baseline: {
    minHolders: number;
    minLiquidityUsd: number;
    minMcapUsd: number;
    maxMcapUsd: number;
    maxTop10HolderRate: number;
    maxRugRatio: number;
    maxBundlerRate: number;
    maxBotRate: number;
    maxCreatorBalanceRate: number;
    requireNotWashTrading: boolean;
  };
  trigger: {
    minScans: number;
    minHolderGrowthPct: number;
    maxLiquidityDropPct: number;
    minBuySellRatio: number;
  };
};

type OkxWatchStatus = "watch" | "accepted" | "filtered" | "dedup";

export type OkxDiscoveryCandidate = {
  source: OkxDiscoverySourceKind;
  sourceKey: string;
  mint: string;
  name: string;
  symbol?: string;
  logo?: string;
  timestamp: number;
  score: number;
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volumeUsd: number;
  inflowUsd: number;
  holders: number;
  uniqueTraders: number;
  txsBuy: number;
  txsSell: number;
  txsTotal: number;
  changePct: number;
  bundlerPct: number;
  sniperPct: number;
  creatorBalancePct: number;
  top10Pct: number;
  rugRatio: number;
  isWashTrading: boolean;
  sourceMeta: Record<string, unknown>;
  raw: OkxRow;
  alert: SignalAlert;
};

type OkxWatchEntry = {
  mint: string;
  source: OkxDiscoverySourceKind;
  sourceKey: string;
  firstSeenAt?: number;
  firstHolders?: number;
  firstLiquidityUsd?: number;
  name: string;
  symbol?: string;
  logo?: string;
  timestamp: number;
  lastSeenAt: number;
  status: OkxWatchStatus;
  reason?: string;
  score: number;
  marketCapUsd: number;
  liquidityUsd: number;
  holders: number;
  top10Pct: number;
  rugRatio: number;
  sourceMeta: Record<string, unknown>;
};

type OkxSnapshot = {
  at: number;
  source: string;
  count: number;
  rows: Array<
    Pick<
      OkxWatchEntry,
      "mint" | "name" | "symbol" | "source" | "status" | "reason" | "score" | "marketCapUsd" | "liquidityUsd" | "holders" | "top10Pct" | "rugRatio"
    >
  >;
};

type StartOptions = {
  onAcceptedCandidate?: (alert: SignalAlert) => void | Promise<void>;
};

type OkxDiscoveryStatus = {
  enabled: boolean;
  configured: boolean;
  running: boolean;
  seeded: boolean;
  sourceMode: string;
  pollMs: number;
  watchlist: { size: number };
  lastPollAt?: number;
  lastEventAt?: number;
  lastRefreshAt?: number;
  lastError?: string;
  baseline: OkxDiscoverySettings["baseline"];
  trigger: OkxDiscoverySettings["trigger"];
  candidatesSeen: number;
  candidatesFiltered: number;
  candidatesAccepted: number;
  recentRejections: Array<{ at: number; mint?: string; name?: string; source?: OkxDiscoverySourceKind; reason: string }>;
  lastRejectionReason?: string;
  lastCandidate?: OkxDiscoveryCandidate;
  lastAcceptedCandidate?: OkxDiscoveryCandidate;
  watchedMints: number;
};

const STATE_DIR = path.resolve("state");
const OKX_STATE_DIR = path.join(STATE_DIR, "okx-discovery");
const WATCHLIST_FILE = path.join(OKX_STATE_DIR, "watchlist.json");
const SNAPSHOTS_FILE = path.join(OKX_STATE_DIR, "snapshots.json");
const POLL_MS = 30_000;
const SEEN_CAP = 10_000;
const SNAPSHOT_CAP = 5_000;
const RECENT_REJECTION_CAP = 20;
const CLI_TIMEOUT_MS = 15_000;

const execFileAsync = promisify(execFile);

const DEFAULT_SETTINGS: OkxDiscoverySettings = {
  enabled: true,
  pollMs: 30_000,
  mintCooldownMins: 60,
  watchlistTtlMins: 180,
  maxWatchMints: 120,
  maxCandidatesPerPoll: 6,
  seedLimit: 100,
  timeFrame: "1",
  rankBy: "5",
  includeBundleInfo: false,
  baseline: {
    minHolders: 200,
    minLiquidityUsd: 10_000,
    minMcapUsd: 0,
    maxMcapUsd: 0,
    maxTop10HolderRate: 0.5,
    maxRugRatio: 0.3,
    maxBundlerRate: 0.5,
    maxBotRate: 0.5,
    maxCreatorBalanceRate: 0.2,
    requireNotWashTrading: true,
  },
  trigger: {
    minScans: 2,
    minHolderGrowthPct: 5,
    maxLiquidityDropPct: 30,
    minBuySellRatio: 1.15,
  },
};

const seenSourceKeys = new Set<string>();
const seenSourceOrder: string[] = [];
const watchlist = new Map<string, OkxWatchEntry>();
const snapshots: OkxSnapshot[] = [];
const recentRejections: OkxDiscoveryStatus["recentRejections"] = [];

let running = false;
let seeded = false;
let loaded = false;
let polling = false;
let pollTimer: NodeJS.Timeout | null = null;
let lastPollAt: number | undefined;
let lastEventAt: number | undefined;
let lastRefreshAt: number | undefined;
let lastError: string | undefined;
let candidatesSeen = 0;
let candidatesFiltered = 0;
let candidatesAccepted = 0;
let lastCandidate: OkxDiscoveryCandidate | undefined;
let lastAcceptedCandidate: OkxDiscoveryCandidate | undefined;
let onAcceptedCandidate: StartOptions["onAcceptedCandidate"];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function parseNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function maybeRatioPct(value: unknown): number {
  // OKX returns percentages already multiplied ("22.582" = 22.582%). Only
  // convert when the value looks like a 0..1 ratio.
  const n = parseNumber(value);
  if (n > 0 && n <= 1) return n * 100;
  return n;
}

function currentSettings(): OkxDiscoverySettings {
  const runtime = getRuntimeSettings() as unknown as {
    signals?: { sourceMode?: string; okx?: { discovery?: unknown } };
  };
  const raw = runtime.signals?.okx?.discovery;
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_SETTINGS);

  const rec = raw as Record<string, unknown>;
  const baseline = (rec.baseline && typeof rec.baseline === "object" ? rec.baseline : {}) as Record<string, unknown>;
  const trigger = (rec.trigger && typeof rec.trigger === "object" ? rec.trigger : {}) as Record<string, unknown>;
  const finite = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : DEFAULT_SETTINGS.enabled,
    pollMs: Math.max(15_000, Math.min(600_000, Math.round(finite(rec.pollMs, DEFAULT_SETTINGS.pollMs)))),
    mintCooldownMins: Math.max(0, finite(rec.mintCooldownMins, DEFAULT_SETTINGS.mintCooldownMins)),
    watchlistTtlMins: Math.max(5, Math.min(1440 * 7, Math.round(finite(rec.watchlistTtlMins, DEFAULT_SETTINGS.watchlistTtlMins)))),
    maxWatchMints: Math.max(20, Math.min(1000, Math.round(finite(rec.maxWatchMints, DEFAULT_SETTINGS.maxWatchMints)))),
    maxCandidatesPerPoll: Math.max(1, Math.min(20, Math.round(finite(rec.maxCandidatesPerPoll, DEFAULT_SETTINGS.maxCandidatesPerPoll)))),
    seedLimit: Math.max(10, Math.min(100, Math.round(finite(rec.seedLimit, DEFAULT_SETTINGS.seedLimit)))),
    timeFrame: typeof rec.timeFrame === "string" && rec.timeFrame.trim() ? rec.timeFrame.trim() : DEFAULT_SETTINGS.timeFrame,
    rankBy: typeof rec.rankBy === "string" && rec.rankBy.trim() ? rec.rankBy.trim() : DEFAULT_SETTINGS.rankBy,
    includeBundleInfo: typeof rec.includeBundleInfo === "boolean" ? rec.includeBundleInfo : DEFAULT_SETTINGS.includeBundleInfo,
    baseline: {
      minHolders: Math.max(0, Math.round(finite(baseline.minHolders, DEFAULT_SETTINGS.baseline.minHolders))),
      minLiquidityUsd: Math.max(0, finite(baseline.minLiquidityUsd, DEFAULT_SETTINGS.baseline.minLiquidityUsd)),
      minMcapUsd: Math.max(0, finite(baseline.minMcapUsd, DEFAULT_SETTINGS.baseline.minMcapUsd)),
      maxMcapUsd: Math.max(0, finite(baseline.maxMcapUsd, DEFAULT_SETTINGS.baseline.maxMcapUsd)),
      maxTop10HolderRate: finite(baseline.maxTop10HolderRate, DEFAULT_SETTINGS.baseline.maxTop10HolderRate),
      maxRugRatio: finite(baseline.maxRugRatio, DEFAULT_SETTINGS.baseline.maxRugRatio),
      maxBundlerRate: finite(baseline.maxBundlerRate, DEFAULT_SETTINGS.baseline.maxBundlerRate),
      maxBotRate: finite(baseline.maxBotRate, DEFAULT_SETTINGS.baseline.maxBotRate),
      maxCreatorBalanceRate: finite(baseline.maxCreatorBalanceRate, DEFAULT_SETTINGS.baseline.maxCreatorBalanceRate),
      requireNotWashTrading:
        baseline.requireNotWashTrading === undefined
          ? DEFAULT_SETTINGS.baseline.requireNotWashTrading
          : Boolean(baseline.requireNotWashTrading),
    },
    trigger: {
      minScans: Math.max(1, Math.min(20, Math.round(finite(trigger.minScans, DEFAULT_SETTINGS.trigger.minScans)))),
      minHolderGrowthPct: Math.max(0, finite(trigger.minHolderGrowthPct, DEFAULT_SETTINGS.trigger.minHolderGrowthPct)),
      maxLiquidityDropPct: Math.max(0, Math.min(100, finite(trigger.maxLiquidityDropPct, DEFAULT_SETTINGS.trigger.maxLiquidityDropPct))),
      minBuySellRatio: Math.max(0, finite(trigger.minBuySellRatio, DEFAULT_SETTINGS.trigger.minBuySellRatio)),
    },
  };
}

// ---------------------------------------------------------------------------
// CLI runner (mirrors okxClient.ts)
// ---------------------------------------------------------------------------
function onchainosEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.OKX_PASSPHRASE && env.OKX_API_PASSPHRASE) {
    env.OKX_PASSPHRASE = env.OKX_API_PASSPHRASE;
  }
  return env;
}

async function runCli<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync("onchainos", args, {
      timeout: CLI_TIMEOUT_MS,
      env: onchainosEnv(),
    });
    const json = JSON.parse(stdout) as { ok: boolean; data?: T };
    if (!json.ok) {
      logger.warn({ args: args.join(" ") }, "[okx-discovery] response not-ok");
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    const e = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string };
    logger.warn(
      {
        err: e.message,
        code: e.code,
        stdout: String(e.stdout ?? "").slice(0, 400),
        stderr: String(e.stderr ?? "").slice(0, 400),
        args: args.join(" "),
      },
      "[okx-discovery] cli failed",
    );
    return null;
  }
}

function isOkxConfigured(): boolean {
  const env = onchainosEnv();
  return Boolean(env.OKX_API_KEY && env.OKX_SECRET_KEY && env.OKX_PASSPHRASE);
}

// ---------------------------------------------------------------------------
// Row → candidate
// ---------------------------------------------------------------------------
function getStringField(row: OkxRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    const str = getMaybeString(value);
    if (str) return str;
  }
  return undefined;
}

function rememberSourceKey(key: string): void {
  if (seenSourceKeys.has(key)) return;
  seenSourceKeys.add(key);
  seenSourceOrder.push(key);
  while (seenSourceOrder.length > SEEN_CAP) {
    const evicted = seenSourceOrder.shift();
    if (evicted) seenSourceKeys.delete(evicted);
  }
}

function exactSeedKey(candidate: { source: OkxDiscoverySourceKind; mint: string; sourceKey: string }): string {
  return `${candidate.source}:${candidate.mint}:${candidate.sourceKey}`;
}

function scoreFromData(candidate: Partial<OkxDiscoveryCandidate>): number {
  let score = 24;
  const vol = candidate.volumeUsd ?? 0;
  score += Math.min(25, Math.log10(Math.max(1, vol)) * 4);
  const inflow = candidate.inflowUsd ?? 0;
  if (inflow > 0) score += Math.min(10, Math.log10(Math.max(1, inflow)) * 3);
  score += Math.min(15, Math.max(0, candidate.holders ?? 0) / 20);
  score += Math.min(10, Math.max(0, candidate.uniqueTraders ?? 0) / 5);
  const change = candidate.changePct ?? 0;
  score += Math.min(10, Math.max(-10, change / 10));
  score -= Math.min(15, Math.max(0, candidate.top10Pct ?? 0) / 5);
  score -= Math.min(20, Math.max(0, candidate.bundlerPct ?? 0) / 3);
  score -= candidate.isWashTrading ? 20 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function liqTrendFor(candidate: Partial<OkxDiscoveryCandidate>): SignalAlert["liq_trend"] {
  const change = candidate.changePct ?? 0;
  if (change > 0) return "rising";
  if (change < 0) return "falling";
  return "unknown";
}

function buildAlert(candidate: OkxDiscoveryCandidate): SignalAlert {
  const ageMins = Math.max(0, Math.floor((Date.now() - candidate.timestamp) / 60_000));
  const bsRatio = candidate.txsSell > 0 ? candidate.txsBuy / candidate.txsSell : candidate.txsBuy > 0 ? 2 : 0;
  return {
    mint: candidate.mint,
    name: candidate.symbol ? `${candidate.name} (${candidate.symbol})` : candidate.name,
    source: "okx",
    sourceMeta: {
      ...candidate.sourceMeta,
      discovery: true,
      volumeUsd: candidate.volumeUsd,
      inflowUsd: candidate.inflowUsd,
      uniqueTraders: candidate.uniqueTraders,
      txsBuy: candidate.txsBuy,
      txsSell: candidate.txsSell,
      txsTotal: candidate.txsTotal,
      changePct: candidate.changePct,
      bundlerPct: candidate.bundlerPct,
      sniperPct: candidate.sniperPct,
      creatorBalancePct: candidate.creatorBalancePct,
      isWashTrading: candidate.isWashTrading,
      raw: candidate.raw,
    },
    logo: candidate.logo,
    score: candidate.score,
    alert_time: candidate.timestamp,
    alert_mcap: candidate.marketCapUsd,
    current_mcap: candidate.marketCapUsd,
    return_pct: 0,
    max_return_pct: 0,
    max_mcap: candidate.marketCapUsd,
    age_mins: ageMins,
    holders: candidate.holders,
    bs_ratio: bsRatio,
    bot_degen_pct: candidate.bundlerPct,
    holder_growth_pct: 0,
    liquidity: candidate.liquidityUsd,
    bundler_pct: candidate.bundlerPct,
    top10_pct: candidate.top10Pct,
    kol_count: 0,
    signal_count: candidate.uniqueTraders,
    degen_call_count: 0,
    rug_ratio: candidate.rugRatio,
    twitter_followers: 0,
    liq_trend: liqTrendFor(candidate),
    completed: false,
  };
}

function baseSeedFromRow(row: OkxRow): OkxDiscoveryCandidate | null {
  const mint =
    getStringField(row, ["tokenContractAddress", "address", "tokenAddress", "mint", "contractAddress", "token"]) ?? "";
  if (!mint) return null;

  const symbol = getStringField(row, ["tokenSymbol", "symbol"]);
  const name = getStringField(row, ["tokenName", "name"]) ?? symbol ?? mint.slice(0, 8);
  const logo = getStringField(row, ["tokenLogoUrl", "logo", "image", "icon"]);
  const ts = parseNumber(
    getStringField(row, ["firstTradeTime", "createTime", "timestamp", "ts"]) ?? row.firstTradeTime ?? 0,
  );
  const timestamp = ts > 0 ? (ts < 1_000_000_000_000 ? ts * 1000 : ts) : Date.now();

  const marketCapUsd = parseNumber(row.marketCap ?? row.market_cap ?? 0);
  const priceUsd = parseNumber(row.price ?? 0);
  const liquidityUsd = parseNumber(row.liquidity ?? 0);
  const volumeUsd = parseNumber(row.volume ?? 0);
  const inflowUsd = parseNumber(row.inflowUsd ?? 0);
  const holders = Math.round(parseNumber(row.holders ?? 0));
  const uniqueTraders = Math.round(parseNumber(row.uniqueTraders ?? 0));
  const txsBuy = Math.round(parseNumber(row.txsBuy ?? 0));
  const txsSell = Math.round(parseNumber(row.txsSell ?? 0));
  const txsTotal = Math.round(parseNumber(row.txs ?? txsBuy + txsSell));
  const changePct = parseNumber(row.change ?? 0);

  // OKX hot-tokens percentages arrive as "0..100" strings in most rows but
  // can occasionally be fractional; maybeRatioPct handles both.
  const top10Pct = maybeRatioPct(row.top10HoldPercent ?? row.top10_holder_rate ?? 0);
  const bundlerPct = maybeRatioPct(row.bundleHoldPercent ?? row.bundler_rate ?? 0);
  const creatorBalancePct = maybeRatioPct(row.devHoldPercent ?? row.creator_balance_rate ?? 0);
  // hot-tokens rows don't expose rug_ratio / is_wash_trading directly — the
  // deep-dive `advanced-info` endpoint fills these just before emit.
  const rugRatio = 0;
  const isWashTrading = false;

  const sourceKey = exactSeedKey({
    source: "hot_tokens",
    mint,
    sourceKey:
      getStringField(row, ["cursor", "id"]) ??
      `${timestamp}:${Math.round(volumeUsd)}`,
  });

  const candidate: OkxDiscoveryCandidate = {
    source: "hot_tokens",
    sourceKey,
    mint,
    name,
    symbol,
    logo,
    timestamp,
    score: 0,
    priceUsd,
    marketCapUsd,
    liquidityUsd,
    volumeUsd,
    inflowUsd,
    holders,
    uniqueTraders,
    txsBuy,
    txsSell,
    txsTotal,
    changePct,
    bundlerPct,
    sniperPct: 0,
    creatorBalancePct,
    top10Pct,
    rugRatio,
    isWashTrading,
    sourceMeta: {
      source: "hot_tokens",
      rankBy: getStringField(row, ["rankBy"]) ?? undefined,
    },
    raw: row,
    alert: {} as SignalAlert,
  };
  candidate.score = scoreFromData(candidate);
  candidate.alert = buildAlert(candidate);
  candidate.alert.score = candidate.score;
  return candidate;
}

// ---------------------------------------------------------------------------
// Baseline + trigger filters
// ---------------------------------------------------------------------------
function maybeReject(candidate: Partial<OkxDiscoveryCandidate>): string | null {
  const settings = currentSettings();
  const filters = settings.baseline;
  const runtime = getRuntimeSettings();
  const mcap = candidate.marketCapUsd ?? 0;

  if (mcap > 0 && filters.minMcapUsd > 0 && mcap < filters.minMcapUsd) {
    return `mcap ${Math.round(mcap).toLocaleString("en-US")} < ${Math.round(filters.minMcapUsd).toLocaleString("en-US")}`;
  }
  if (filters.maxMcapUsd > 0 && mcap > filters.maxMcapUsd) {
    return `mcap ${Math.round(mcap).toLocaleString("en-US")} > ${Math.round(filters.maxMcapUsd).toLocaleString("en-US")}`;
  }
  if (runtime.alertFilter.mcapMin > 0 && mcap > 0 && mcap < runtime.alertFilter.mcapMin) {
    return `mcap ${Math.round(mcap).toLocaleString("en-US")} < ${Math.round(runtime.alertFilter.mcapMin).toLocaleString("en-US")}`;
  }
  if (runtime.alertFilter.mcapMax > 0 && mcap > runtime.alertFilter.mcapMax) {
    return `mcap ${Math.round(mcap).toLocaleString("en-US")} > ${Math.round(runtime.alertFilter.mcapMax).toLocaleString("en-US")}`;
  }

  if ((candidate.liquidityUsd ?? 0) < filters.minLiquidityUsd) {
    return `liquidity ${Math.round(candidate.liquidityUsd ?? 0).toLocaleString("en-US")} < ${Math.round(filters.minLiquidityUsd).toLocaleString("en-US")}`;
  }
  if ((candidate.holders ?? 0) < filters.minHolders) {
    return `holders ${Math.round(candidate.holders ?? 0).toLocaleString("en-US")} < ${Math.round(filters.minHolders).toLocaleString("en-US")}`;
  }

  const top10 = candidate.top10Pct ?? 0;
  const maxTop10Pct = filters.maxTop10HolderRate <= 1 ? filters.maxTop10HolderRate * 100 : filters.maxTop10HolderRate;
  if (top10 > maxTop10Pct) {
    return `top10 ${top10.toFixed(1)}% > ${maxTop10Pct.toFixed(0)}%`;
  }

  const bundler = candidate.bundlerPct ?? 0;
  const maxBundlerPct = filters.maxBundlerRate <= 1 ? filters.maxBundlerRate * 100 : filters.maxBundlerRate;
  if (bundler > maxBundlerPct) {
    return `bundler ${bundler.toFixed(1)}% > ${maxBundlerPct.toFixed(0)}%`;
  }

  const sniper = candidate.sniperPct ?? 0;
  const maxBotPct = filters.maxBotRate <= 1 ? filters.maxBotRate * 100 : filters.maxBotRate;
  if (sniper > maxBotPct) {
    return `sniper ${sniper.toFixed(1)}% > ${maxBotPct.toFixed(0)}%`;
  }

  const creator = candidate.creatorBalancePct ?? 0;
  const maxCreatorPct =
    filters.maxCreatorBalanceRate <= 1 ? filters.maxCreatorBalanceRate * 100 : filters.maxCreatorBalanceRate;
  if (creator > maxCreatorPct) {
    return `creator ${creator.toFixed(1)}% > ${maxCreatorPct.toFixed(0)}%`;
  }

  if ((candidate.rugRatio ?? 0) > filters.maxRugRatio) {
    return `rug ratio ${(candidate.rugRatio ?? 0).toFixed(2)} > ${filters.maxRugRatio}`;
  }

  if (filters.requireNotWashTrading && candidate.isWashTrading) {
    return "wash trading flagged";
  }

  return null;
}

function snapshotCount(mint: string): number {
  return snapshots.reduce((count, snapshot) => {
    return count + (snapshot.rows.some((row) => row.mint === mint) ? 1 : 0);
  }, 0);
}

function buySellRatio(candidate: OkxDiscoveryCandidate): number | undefined {
  if (candidate.txsSell > 0) return candidate.txsBuy / candidate.txsSell;
  if (candidate.txsBuy > 0) return Number.POSITIVE_INFINITY;
  return undefined;
}

function maybeRejectTrigger(candidate: OkxDiscoveryCandidate, settings: OkxDiscoverySettings): string | null {
  const trigger = settings.trigger;
  const existing = watchlist.get(candidate.mint);
  const scans = Math.max(existing ? 1 : 0, snapshotCount(candidate.mint));
  if (scans < trigger.minScans) {
    return `scans ${scans} < ${trigger.minScans}`;
  }

  const firstHolders = existing?.firstHolders ?? candidate.holders;
  const holderGrowthPct = firstHolders > 0 ? ((candidate.holders - firstHolders) / firstHolders) * 100 : 0;
  if (holderGrowthPct < trigger.minHolderGrowthPct) {
    return `holder growth ${holderGrowthPct.toFixed(1)}% < ${trigger.minHolderGrowthPct}%`;
  }

  const firstLiquidity = existing?.firstLiquidityUsd ?? candidate.liquidityUsd;
  const liquidityDropPct =
    firstLiquidity > 0 ? Math.max(0, ((firstLiquidity - candidate.liquidityUsd) / firstLiquidity) * 100) : 0;
  if (liquidityDropPct > trigger.maxLiquidityDropPct) {
    return `liquidity drop ${liquidityDropPct.toFixed(0)}% > ${trigger.maxLiquidityDropPct}%`;
  }

  const ratio = buySellRatio(candidate);
  if (ratio !== undefined && ratio !== Number.POSITIVE_INFINITY && ratio < trigger.minBuySellRatio) {
    return `buy/sell ${ratio.toFixed(2)} < ${trigger.minBuySellRatio}`;
  }

  candidate.sourceMeta = {
    ...candidate.sourceMeta,
    scans,
    holderGrowthPct,
    liquidityDropPct,
    buySellRatio: ratio === Number.POSITIVE_INFINITY ? null : ratio,
  };
  candidate.alert.sourceMeta = candidate.sourceMeta;
  candidate.alert.holder_growth_pct = holderGrowthPct;
  if (ratio !== undefined && ratio !== Number.POSITIVE_INFINITY) {
    candidate.alert.bs_ratio = ratio;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Watchlist / snapshot persistence
// ---------------------------------------------------------------------------
function reject(candidate: Partial<OkxDiscoveryCandidate> | null, source: OkxDiscoverySourceKind, reason: string): void {
  candidatesFiltered++;
  const row = {
    at: Date.now(),
    mint: candidate?.mint,
    name: candidate?.name,
    source,
    reason,
  };
  recentRejections.push(row);
  while (recentRejections.length > RECENT_REJECTION_CAP) recentRejections.shift();
  if (candidate) {
    recordAlertEvent({
      at: Date.now(),
      mint: candidate.mint ?? "",
      name: candidate.name ?? "",
      score: candidate.score ?? 0,
      age_mins: Math.max(0, Math.floor((Date.now() - (candidate.timestamp ?? Date.now())) / 60_000)),
      liquidity: Math.max(0, candidate.liquidityUsd ?? 0),
      action: "filtered",
      reason: `OKX/${source}: ${reason}`,
    });
  }
}

function dedup(candidate: Partial<OkxDiscoveryCandidate>, source: OkxDiscoverySourceKind, reason: string): void {
  recordAlertEvent({
    at: Date.now(),
    mint: candidate.mint ?? "",
    name: candidate.name ?? "",
    score: candidate.score ?? 0,
    age_mins: Math.max(0, Math.floor((Date.now() - (candidate.timestamp ?? Date.now())) / 60_000)),
    liquidity: Math.max(0, candidate.liquidityUsd ?? 0),
    action: "dedup",
    reason: `OKX/${source}: ${reason}`,
  });
}

function upsertWatchEntry(
  candidate: OkxDiscoveryCandidate,
  status: OkxWatchStatus,
  reason?: string,
  opts: { enriched?: boolean } = {},
): void {
  const existing = watchlist.get(candidate.mint);
  const enriched = opts.enriched ?? true;
  const entry: OkxWatchEntry = {
    mint: candidate.mint,
    source: candidate.source,
    sourceKey: candidate.sourceKey,
    firstSeenAt: existing?.firstSeenAt ?? Date.now(),
    firstHolders: existing?.firstHolders ?? (enriched ? candidate.holders : undefined),
    firstLiquidityUsd: existing?.firstLiquidityUsd ?? (enriched ? candidate.liquidityUsd : undefined),
    name: candidate.name,
    symbol: candidate.symbol,
    logo: candidate.logo,
    timestamp: candidate.timestamp,
    lastSeenAt: Date.now(),
    status,
    reason,
    score: candidate.score,
    marketCapUsd: candidate.marketCapUsd,
    liquidityUsd: candidate.liquidityUsd,
    holders: candidate.holders,
    top10Pct: candidate.top10Pct,
    rugRatio: candidate.rugRatio,
    sourceMeta: candidate.sourceMeta,
  };
  if (existing) {
    watchlist.set(candidate.mint, { ...existing, ...entry, firstSeenAt: existing.firstSeenAt ?? Date.now() });
  } else {
    watchlist.set(candidate.mint, entry);
  }
  while (watchlist.size > currentSettings().maxWatchMints) {
    const oldest = [...watchlist.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!oldest) break;
    watchlist.delete(oldest.mint);
  }
}

function appendSnapshot(rows: OkxDiscoveryCandidate[], source: string): void {
  snapshots.push({
    at: Date.now(),
    source,
    count: rows.length,
    rows: rows.map((candidate) => {
      const existing = watchlist.get(candidate.mint);
      return {
        mint: candidate.mint,
        name: candidate.name,
        symbol: candidate.symbol,
        source: candidate.source,
        status: existing?.status ?? "watch",
        reason: existing?.reason,
        score: candidate.score,
        marketCapUsd: candidate.marketCapUsd,
        liquidityUsd: candidate.liquidityUsd,
        holders: candidate.holders,
        top10Pct: candidate.top10Pct,
        rugRatio: candidate.rugRatio,
      };
    }),
  });
  while (snapshots.length > SNAPSHOT_CAP) snapshots.shift();
}

function purgeStaleWatchlist(settings = currentSettings()): void {
  const cutoff = Date.now() - settings.watchlistTtlMins * 60_000;
  for (const [mint, entry] of watchlist.entries()) {
    if (entry.lastSeenAt < cutoff) watchlist.delete(mint);
  }
}

function serializeState(): { watchlist: OkxWatchEntry[]; snapshots: OkxSnapshot[] } {
  return {
    watchlist: [...watchlist.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    snapshots: [...snapshots],
  };
}

function hydrateWatchEntry(raw: unknown): OkxWatchEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const mint = getMaybeString(rec.mint);
  if (!mint) return null;
  return {
    mint,
    source: rec.source === "hot_tokens" || rec.source === "watchlist" ? rec.source : "watchlist",
    sourceKey: getMaybeString(rec.sourceKey) ?? `watchlist:${mint}`,
    name: getMaybeString(rec.name) ?? mint.slice(0, 8),
    symbol: getMaybeString(rec.symbol),
    logo: getMaybeString(rec.logo),
    timestamp: Number(rec.timestamp ?? Date.now()) || Date.now(),
    lastSeenAt: Number(rec.lastSeenAt ?? Date.now()) || Date.now(),
    firstSeenAt: Number(rec.firstSeenAt ?? rec.lastSeenAt ?? Date.now()) || Date.now(),
    firstHolders: Number(rec.firstHolders ?? rec.holders ?? 0) || 0,
    firstLiquidityUsd: Number(rec.firstLiquidityUsd ?? rec.liquidityUsd ?? 0) || 0,
    status:
      rec.status === "accepted" || rec.status === "filtered" || rec.status === "dedup" ? rec.status : "watch",
    reason: getMaybeString(rec.reason),
    score: Number(rec.score ?? 0) || 0,
    marketCapUsd: Number(rec.marketCapUsd ?? 0) || 0,
    liquidityUsd: Number(rec.liquidityUsd ?? 0) || 0,
    holders: Number(rec.holders ?? 0) || 0,
    top10Pct: Number(rec.top10Pct ?? 0) || 0,
    rugRatio: Number(rec.rugRatio ?? 0) || 0,
    sourceMeta: (rec.sourceMeta && typeof rec.sourceMeta === "object" ? rec.sourceMeta : {}) as Record<string, unknown>,
  };
}

async function loadState(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await readFile(WATCHLIST_FILE, "utf8").catch(() => "");
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      const rows = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.watchlist;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const entry = hydrateWatchEntry(row);
          if (entry) watchlist.set(entry.mint, entry);
        }
      }
    }

    const snapshotRaw = await readFile(SNAPSHOTS_FILE, "utf8").catch(() => "");
    if (snapshotRaw) {
      const parsed = JSON.parse(snapshotRaw) as unknown;
      const rows = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.snapshots;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && typeof row === "object") snapshots.push(row as OkxSnapshot);
        }
      }
    }

    while (snapshots.length > SNAPSHOT_CAP) snapshots.shift();
    purgeStaleWatchlist();
    while (watchlist.size > currentSettings().maxWatchMints) {
      const oldest = [...watchlist.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (!oldest) break;
      watchlist.delete(oldest.mint);
    }
    logger.info(
      { watchlist: watchlist.size, snapshots: snapshots.length },
      "[okx-discovery] state restored",
    );
  } catch (err) {
    logger.warn({ err: String(err) }, "[okx-discovery] state load failed");
  }
}

let persistTimer: NodeJS.Timeout | null = null;
function persistState(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await mkdir(OKX_STATE_DIR, { recursive: true });
      purgeStaleWatchlist();
      const state = serializeState();
      await writeFile(WATCHLIST_FILE, JSON.stringify({ watchlist: state.watchlist }, null, 2));
      await writeFile(SNAPSHOTS_FILE, JSON.stringify({ snapshots: state.snapshots }, null, 2));
    } catch (err) {
      logger.error({ err: String(err) }, "[okx-discovery] persist failed");
    }
  }, 200);
  persistTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Seed fetch + dedupe
// ---------------------------------------------------------------------------
function extractRows(raw: unknown): OkxRow[] {
  if (Array.isArray(raw)) return raw.filter((row): row is OkxRow => Boolean(row) && typeof row === "object");
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  for (const key of ["list", "items", "rows", "data", "tokens", "records"]) {
    const child = rec[key];
    if (Array.isArray(child)) {
      return child.filter((row): row is OkxRow => Boolean(row) && typeof row === "object");
    }
  }
  return [];
}

function shouldProcessSeed(seed: OkxDiscoveryCandidate): boolean {
  const existing = watchlist.get(seed.mint);
  if (existing && existing.sourceKey === seed.sourceKey) return false;
  return true;
}

function sortAndLimitSeeds(seeds: OkxDiscoveryCandidate[], max: number): OkxDiscoveryCandidate[] {
  return [...seeds].sort((a, b) => b.score - a.score).slice(0, max);
}

async function fetchSeeds(settings: OkxDiscoverySettings): Promise<OkxDiscoveryCandidate[]> {
  const raw = await runCli<unknown>([
    "token",
    "hot-tokens",
    "--chain",
    "solana",
    "--rank-by",
    settings.rankBy,
    "--time-frame",
    settings.timeFrame,
    "--limit",
    String(settings.seedLimit),
  ]);
  if (!raw) return [];

  const rows = extractRows(raw);
  const seeds: OkxDiscoveryCandidate[] = [];
  for (const row of rows) {
    const seed = baseSeedFromRow(row);
    if (!seed) continue;
    seeds.push(seed);
    rememberSourceKey(seed.sourceKey);
  }

  // Filter-dedupe ONLY inside fetchSeeds — processSeed no longer re-applies
  // shouldProcessSeed (the GMGN double-dedupe bug we just fixed).
  const deduped = seeds.filter(shouldProcessSeed);
  return sortAndLimitSeeds(deduped, settings.maxCandidatesPerPoll);
}

// ---------------------------------------------------------------------------
// Deep dive (just before emit)
// ---------------------------------------------------------------------------
type OkxDeepDiveResult =
  | { ok: true; candidate: OkxDiscoveryCandidate }
  | { ok: false; reason: string };

async function deepDiveCandidate(seed: OkxDiscoveryCandidate): Promise<OkxDeepDiveResult> {
  const settings = currentSettings();
  let advanced: Record<string, unknown> | null = null;
  let bundle: Record<string, unknown> | null = null;
  try {
    advanced = await runCli<Record<string, unknown>>([
      "token",
      "advanced-info",
      "--chain",
      "solana",
      "--address",
      seed.mint,
    ]);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, mint: seed.mint },
      "[okx-discovery] deep-dive (advanced-info) threw — dropping candidate",
    );
    return { ok: false, reason: "request failed" };
  }

  if (!advanced) {
    // Request returned no data / not-ok — safer to drop than to fire with
    // seed-only numbers that might have been masked by deep-dive checks.
    return { ok: false, reason: "request failed" };
  }

  if (settings.includeBundleInfo) {
    try {
      bundle = await runCli<Record<string, unknown>>([
        "memepump",
        "token-bundle-info",
        "--address",
        seed.mint,
      ]);
    } catch (err) {
      // Bundle info is optional — keep going.
      logger.debug(
        { err: (err as Error).message, mint: seed.mint },
        "[okx-discovery] deep-dive (bundle-info) failed — skipping bundle merge",
      );
    }
  }

  const next: OkxDiscoveryCandidate = { ...seed, sourceMeta: { ...seed.sourceMeta } };

  // advanced-info fields: top10HoldPercent, bundleHoldingPercent,
  // sniperHoldingPercent, devHoldingPercent, snipersTotal, riskControlLevel
  const top10 = maybeRatioPct(advanced.top10HoldPercent ?? advanced.top_10_holder_rate ?? 0);
  if (top10 > 0) next.top10Pct = Math.max(next.top10Pct, top10);

  const bundler = maybeRatioPct(advanced.bundleHoldingPercent ?? advanced.bundler_rate ?? 0);
  if (bundler > 0) next.bundlerPct = Math.max(next.bundlerPct, bundler);

  const sniper = maybeRatioPct(advanced.sniperHoldingPercent ?? 0);
  if (sniper > 0) next.sniperPct = Math.max(next.sniperPct, sniper);

  const creator = maybeRatioPct(advanced.devHoldingPercent ?? advanced.creator_balance_rate ?? 0);
  if (creator > 0) next.creatorBalancePct = Math.max(next.creatorBalancePct, creator);

  // rug_ratio / is_wash_trading are not directly exposed by advanced-info;
  // we use the fields that ARE exposed to fail-safe. Keep the filter slots
  // populated so the SignalAlert shape stays consistent downstream.
  const rug = getMaybeNumber(advanced.rug_ratio);
  if (rug !== undefined && rug > next.rugRatio) next.rugRatio = rug;

  const wash =
    getMaybeBool(advanced.is_wash_trading) ??
    (typeof advanced.riskControlLevel === "string" && advanced.riskControlLevel === "3" ? true : null);
  if (wash != null) next.isWashTrading = wash;

  if (bundle) {
    const bundlerFromBundle = maybeRatioPct(bundle.bundlerAthPercent ?? 0);
    if (bundlerFromBundle > 0) next.bundlerPct = Math.max(next.bundlerPct, bundlerFromBundle);
    next.sourceMeta = { ...next.sourceMeta, bundleInfo: bundle };
  }

  next.sourceMeta = {
    ...next.sourceMeta,
    deepDive: {
      advanced,
      bundle: bundle ?? null,
    },
  };

  next.score = scoreFromData(next);
  next.alert = buildAlert(next);
  next.alert.score = next.score;
  next.alert.sourceMeta = next.sourceMeta;

  // Global Jup audit gate — applied AFTER enrichment so all sources share
  // the same fees + organicScoreLabel floor. Transient Jup failures pass.
  const jupCfg = getRuntimeSettings().jupGate;
  const audit = await fetchJupAudit(seed.mint);
  const gate = passesJupGate(audit, jupCfg);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }
  if (audit) {
    next.sourceMeta = {
      ...next.sourceMeta,
      jupAudit: audit,
    };
    next.alert.sourceMeta = next.sourceMeta;
  }

  return { ok: true, candidate: next };
}

// ---------------------------------------------------------------------------
// Seed processing + runCycle
// ---------------------------------------------------------------------------
async function processSeed(seed: OkxDiscoveryCandidate, settings: OkxDiscoverySettings): Promise<void> {
  settings = currentSettings();
  if (!settings.enabled) {
    upsertWatchEntry(seed, "watch", "OKX discovery disabled");
    return;
  }

  lastCandidate = seed;
  lastEventAt = Date.now();
  candidatesSeen++;

  if (isPaused()) {
    reject(seed, seed.source, "bot paused");
    upsertWatchEntry(seed, "filtered", "bot paused");
    return;
  }
  if (isBlacklisted(seed.mint)) {
    reject(seed, seed.source, "blacklisted");
    upsertWatchEntry(seed, "filtered", "blacklisted");
    return;
  }

  const filterReason = maybeReject(seed);
  if (filterReason) {
    reject(seed, seed.source, filterReason);
    upsertWatchEntry(seed, "filtered", filterReason);
    return;
  }

  const triggerReason = maybeRejectTrigger(seed, settings);
  if (triggerReason) {
    reject(seed, seed.source, triggerReason);
    upsertWatchEntry(seed, "watch", triggerReason);
    return;
  }

  const cooldown = checkSignalMintCooldown(seed.mint, settings.mintCooldownMins);
  if (!cooldown.ok) {
    reject(seed, seed.source, cooldown.reason);
    upsertWatchEntry(seed, "filtered", cooldown.reason);
    return;
  }

  const deepDive = await deepDiveCandidate(seed);
  if (!deepDive.ok) {
    const reason = `deep-dive: ${deepDive.reason}`;
    reject(seed, seed.source, reason);
    upsertWatchEntry(seed, "filtered", reason);
    return;
  }
  const enriched = deepDive.candidate;
  lastCandidate = enriched;

  const deepDiveReason = maybeReject(enriched);
  if (deepDiveReason) {
    const reason = `deep-dive: ${deepDiveReason}`;
    reject(enriched, enriched.source, reason);
    upsertWatchEntry(enriched, "filtered", reason);
    return;
  }

  candidatesAccepted++;
  const alert = enriched.alert;
  markSignalMintAccepted(enriched.mint, "okx_discovery");
  recordAlertEvent({
    at: Date.now(),
    mint: alert.mint,
    name: alert.name,
    score: alert.score,
    age_mins: alert.age_mins,
    liquidity: alert.liquidity,
    action: "fired",
  });
  upsertWatchEntry(enriched, "accepted");
  lastAcceptedCandidate = enriched;
  logger.info(
    { mint: enriched.mint, name: enriched.name, score: enriched.score, source: enriched.source },
    "[okx-discovery] firing OKX candidate",
  );
  await Promise.resolve(onAcceptedCandidate?.(alert));
}

async function persistAndMaybeSeed(candidates: OkxDiscoveryCandidate[]): Promise<boolean> {
  const wasSeeded = seeded;
  appendSnapshot(candidates, "hot_tokens");
  for (const candidate of candidates) {
    upsertWatchEntry(
      candidate,
      watchlist.get(candidate.mint)?.status ?? "watch",
      watchlist.get(candidate.mint)?.reason,
      { enriched: false },
    );
  }
  persistState();
  if (!seeded) {
    seeded = true;
    logger.info({ candidates: candidates.length }, "[okx-discovery] seeded from first poll");
  }
  return !wasSeeded;
}

async function runCycle(): Promise<void> {
  if (!running || polling) return;
  polling = true;
  try {
    const settings = currentSettings();
    if (!settings.enabled) {
      persistState();
      return;
    }
    if (!isOkxConfigured()) {
      lastError = "missing OKX_API_KEY/OKX_SECRET_KEY/OKX_PASSPHRASE";
      persistState();
      return;
    }

    await loadState();
    const seeds = await fetchSeeds(settings);
    lastRefreshAt = Date.now();
    const firstPoll = await persistAndMaybeSeed(seeds);
    if (firstPoll) return;

    // shouldProcessSeed was already applied inside fetchSeeds. Do NOT
    // re-check in this loop — persistAndMaybeSeed above just upserted each
    // seed's sourceKey into the watchlist, which would make shouldProcessSeed
    // return false for every seed and silently skip all processing.
    for (const seed of seeds) {
      try {
        await processSeed(seed, settings);
      } catch (err) {
        lastError = (err as Error).message;
        logger.warn(
          { err: lastError, mint: seed.mint, source: seed.source },
          "[okx-discovery] candidate processing failed",
        );
        upsertWatchEntry(seed, "filtered", lastError);
      }
    }

    lastPollAt = Date.now();
    persistState();
  } catch (err) {
    lastError = (err as Error).message;
    logger.warn({ err: lastError }, "[okx-discovery] cycle failed");
  } finally {
    polling = false;
    if (running) {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        void runCycle();
      }, currentSettings().pollMs || POLL_MS);
      pollTimer.unref?.();
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function startOkxDiscoverySource(options: StartOptions = {}): void {
  onAcceptedCandidate = options.onAcceptedCandidate;
  if (running) return;
  running = true;
  void runCycle();
}

export async function refreshOkxDiscoverySource(): Promise<void> {
  if (!running) return;
  await runCycle();
}

export async function stopOkxDiscoverySource(): Promise<void> {
  running = false;
  seeded = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

export function getOkxDiscoveryStatus(): OkxDiscoveryStatus {
  const settings = currentSettings();
  const runtime = getRuntimeSettings() as unknown as { signals?: { sourceMode?: string } };
  return {
    enabled: settings.enabled,
    configured: isOkxConfigured(),
    running,
    seeded,
    sourceMode: runtime.signals?.sourceMode ?? "",
    pollMs: settings.pollMs,
    watchlist: { size: watchlist.size },
    lastPollAt,
    lastEventAt,
    lastRefreshAt,
    lastError,
    baseline: settings.baseline,
    trigger: settings.trigger,
    candidatesSeen,
    candidatesFiltered,
    candidatesAccepted,
    recentRejections: [...recentRejections],
    lastRejectionReason: recentRejections[recentRejections.length - 1]?.reason,
    lastCandidate,
    lastAcceptedCandidate,
    watchedMints: watchlist.size,
  };
}
