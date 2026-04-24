import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import logger from "./logger.js";
import type { ScgAlert } from "./types.js";
import { checkSignalMintCooldown, markSignalMintAccepted } from "./sourceDedupe.js";
import { getRuntimeSettings } from "./settingsStore.js";
import { isBlacklisted, isPaused, recordAlertEvent } from "./scgPoller.js";
import {
  getMarketSignal,
  getMarketTrenches,
  getMarketTrending,
  getMaybeBool,
  getMaybeNumber,
  getMaybeString,
  isGmgnConfigured,
  getTokenInfo,
  getTokenPool,
  getTokenSecurity,
  type GmgnChain,
  type GmgnRow,
  type GmgnTrendingInterval,
  type GmgnTrenchesType,
} from "./gmgnClient.js";

type GmgnSourceKind = "trending" | "trenches" | "signal" | "watchlist";
type GmgnMode = "watch" | "watch_only" | "scan_only" | "scanner" | "live" | "active" | "buy";

type GmgnSettings = {
  enabled: boolean;
  pollMs: number;
  mode: GmgnMode;
  sourceMode: string;
  chains: GmgnChain[];
  trending: {
    enabled: boolean;
    interval: GmgnTrendingInterval;
    limit: number;
    orderBy: string;
    direction: "asc" | "desc";
    filters: string[];
    platforms: string[];
  };
  trenches: {
    enabled: boolean;
    limit: number;
    types: GmgnTrenchesType[];
    launchpadPlatforms: string[];
    filterPreset: string;
    minSmartDegenCount: number;
    sortBy: string;
  };
  signal: {
    enabled: boolean;
    limit: number;
    groups: Array<{ signal_type: number[] }>;
    side?: "buy" | "sell";
  };
  watchlist: {
    enabled: boolean;
    refreshLimit: number;
    maxEntries: number;
  };
  watchlistTtlMins: number;
  filters: {
    minMarketCapUsd: number;
    maxMarketCapUsd: number;
    minLiquidityUsd: number;
    minHolders: number;
    minTokenAgeMins: number;
    maxTokenAgeMins: number;
    minSmartMoneyCount: number;
    minKolCount: number;
    maxRugRatio: number;
    maxTop10Pct: number;
    requireNoHoneypot: boolean;
    requireRenounced: boolean;
    requirePool: boolean;
    maxBundlerPct: number;
    maxBotPct: number;
    maxCreatorBalancePct: number;
    requireNotWashTrading: boolean;
  };
  trigger: {
    minScans: number;
    minHolderGrowthPct: number;
    maxHolderGrowthPct: number;
    maxLiquidityDropPct: number;
    minBuySellRatio: number;
    minSmartOrKolCount: number;
  };
  mintCooldownMins: number;
  liveScoreMin: number;
  watchScoreMin: number;
  maxCandidatesPerPoll: number;
  includePoolInfo: boolean;
};

type GmgnWatchStatus = "watch" | "accepted" | "filtered" | "dedup";

export type GmgnSignalCandidate = {
  chain: GmgnChain;
  source: GmgnSourceKind;
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
  holders: number;
  smartMoneyCount: number;
  kolCount: number;
  sniperCount: number;
  bundlerPct: number;
  ratTraderPct: number;
  creatorBalancePct: number;
  top10Pct: number;
  rugRatio: number;
  hotLevel: number;
  change1m: number;
  change5m: number;
  change1h: number;
  isHoneypot: boolean;
  isWashTrading: boolean;
  renouncedMint: boolean;
  renouncedFreeze: boolean;
  isOnCurve: boolean;
  sourceMeta: Record<string, unknown>;
  raw: GmgnRow;
  alert: ScgAlert;
};

type GmgnWatchEntry = {
  mint: string;
  chain: GmgnChain;
  source: GmgnSourceKind;
  sourceKey: string;
  firstSeenAt?: number;
  firstHolders?: number;
  firstLiquidityUsd?: number;
  name: string;
  symbol?: string;
  logo?: string;
  timestamp: number;
  lastSeenAt: number;
  status: GmgnWatchStatus;
  reason?: string;
  score: number;
  marketCapUsd: number;
  liquidityUsd: number;
  holders: number;
  top10Pct: number;
  rugRatio: number;
  sourceMeta: Record<string, unknown>;
};

type GmgnSnapshot = {
  at: number;
  mode: string;
  chain: GmgnChain;
  source: string;
  count: number;
  rows: Array<Pick<GmgnWatchEntry, "mint" | "name" | "symbol" | "source" | "status" | "reason" | "score" | "marketCapUsd" | "liquidityUsd" | "holders" | "top10Pct" | "rugRatio">>;
};

type StartOptions = {
  onAcceptedCandidate?: (alert: ScgAlert) => void | Promise<void>;
};

type GmgnStatus = {
  enabled: boolean;
  configured: boolean;
  mode: GmgnMode;
  sourceMode: string;
  running: boolean;
  seeded: boolean;
  chains: GmgnChain[];
  trending: { enabled: boolean; interval: GmgnTrendingInterval; limit: number };
  trenches: { enabled: boolean; limit: number; types: GmgnTrenchesType[] };
  signal: { enabled: boolean; limit: number };
  watchlist: { enabled: boolean; refreshLimit: number; size: number };
  lastPollAt?: number;
  lastEventAt?: number;
  lastError?: string;
  baseline: GmgnSettings["filters"];
  trigger: GmgnSettings["trigger"];
  candidatesSeen: number;
  candidatesFiltered: number;
  candidatesAccepted: number;
  recentRejections: Array<{ at: number; mint?: string; name?: string; source?: GmgnSourceKind; reason: string }>;
  lastRejectionReason?: string;
  lastCandidate?: GmgnSignalCandidate;
  lastAcceptedCandidate?: GmgnSignalCandidate;
};

const STATE_DIR = path.resolve("state");
const GMGN_STATE_DIR = path.join(STATE_DIR, "gmgn");
const WATCHLIST_FILE = path.join(GMGN_STATE_DIR, "watchlist.json");
const SNAPSHOTS_FILE = path.join(GMGN_STATE_DIR, "snapshots.json");
const POLL_MS = 30_000;
const SEEN_CAP = 10_000;
const WATCHLIST_CAP = 500;
const SNAPSHOT_CAP = 5_000;
const RECENT_REJECTION_CAP = 20;

const DEFAULT_SETTINGS: GmgnSettings = {
  enabled: true,
  pollMs: 30_000,
  mode: "watch",
  sourceMode: "scg_only",
  chains: ["sol"],
  trending: {
    // [TRENDING-ENABLED 2026-04-22] /v1/market/rank returns full token
    // profiles (holder_count, smart_degen_count, renowned_count), so
    // trending seeds pass the baseline filter without requiring upfront
    // enrichment. Deep-dive via /v1/token/info + /v1/token/security is
    // invoked just before emit to reconfirm the filters.
    enabled: true,
    interval: "1h",
    limit: 10,
    orderBy: "volume",
    direction: "desc",
    filters: ["not_risk", "not_honeypot"],
    platforms: [],
  },
  trenches: {
    // Gated off 2026-04-22 — kept intact for future re-enable.
    enabled: false,
    limit: 10,
    types: ["new_creation", "near_completion", "completed"],
    launchpadPlatforms: ["Pump.fun", "pump_mayhem", "letsbonk"],
    filterPreset: "safe",
    minSmartDegenCount: 1,
    sortBy: "smart_degen_count",
  },
  signal: {
    // Gated off 2026-04-22 — /v1/market/token_signal rows miss
    // holder_count + smart_degen_count, so signal seeds always failed
    // the baseline filter. Re-enable after the deep-dive pipeline is
    // proven on trending seeds.
    enabled: false,
    limit: 10,
    groups: [{ signal_type: [12] }],
  },
  watchlist: {
    enabled: true,
    refreshLimit: 4,
    maxEntries: 150,
  },
  watchlistTtlMins: 180,
  filters: {
    minMarketCapUsd: 0,
    maxMarketCapUsd: 0,
    minLiquidityUsd: 10_000,
    minHolders: 150,
    minTokenAgeMins: 5,
    maxTokenAgeMins: 240,
    minSmartMoneyCount: 0,
    minKolCount: 0,
    maxRugRatio: 0.35,
    maxTop10Pct: 45,
    requireNoHoneypot: true,
    requireRenounced: false,
    requirePool: false,
    maxBundlerPct: 50,
    maxBotPct: 50,
    maxCreatorBalancePct: 20,
    requireNotWashTrading: true,
  },
  trigger: {
    minScans: 10,
    minHolderGrowthPct: 5,
    maxHolderGrowthPct: 50,
    maxLiquidityDropPct: 30,
    minBuySellRatio: 1.15,
    minSmartOrKolCount: 0,
  },
  mintCooldownMins: 90,
  liveScoreMin: 60,
  watchScoreMin: 35,
  maxCandidatesPerPoll: 4,
  includePoolInfo: false,
};

const seenSourceKeys = new Set<string>();
const seenSourceOrder: string[] = [];
const watchlist = new Map<string, GmgnWatchEntry>();
const snapshots: GmgnSnapshot[] = [];
const recentRejections: GmgnStatus["recentRejections"] = [];

let running = false;
let seeded = false;
let loaded = false;
let polling = false;
let starting = false;
let stopping = false;
let pollTimer: NodeJS.Timeout | null = null;
let lastPollAt: number | undefined;
let lastEventAt: number | undefined;
let lastError: string | undefined;
let candidatesSeen = 0;
let candidatesFiltered = 0;
let candidatesAccepted = 0;
let lastCandidate: GmgnSignalCandidate | undefined;
let lastAcceptedCandidate: GmgnSignalCandidate | undefined;
let onAcceptedCandidate: StartOptions["onAcceptedCandidate"];

function cloneRawRow(raw: unknown): GmgnRow {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as GmgnRow;
  return {};
}

function isMode(value: unknown): value is GmgnMode {
  return value === "watch" || value === "watch_only" || value === "scan_only" || value === "scanner" || value === "live" || value === "active" || value === "buy";
}

function currentSettings(): GmgnSettings {
  const runtime = getRuntimeSettings() as unknown as { signals?: { gmgn?: unknown } };
  const raw = runtime.signals?.gmgn;
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_SETTINGS);

  const rec = raw as Record<string, unknown>;
  const sourceMode =
    runtime.signals &&
    typeof (runtime.signals as Record<string, unknown>).sourceMode === "string"
      ? String((runtime.signals as Record<string, unknown>).sourceMode)
      : DEFAULT_SETTINGS.sourceMode;
  const isGmgnLiveSourceMode = sourceMode === "gmgn_live" || sourceMode === "gmgn_only" || sourceMode === "hybrid";
  const modeFromSource: GmgnMode = isGmgnLiveSourceMode ? "live" : "watch";
  const trending = (rec.trending && typeof rec.trending === "object" ? rec.trending : {}) as Record<string, unknown>;
  const trenches = (rec.trenches && typeof rec.trenches === "object" ? rec.trenches : {}) as Record<string, unknown>;
  const signal = (rec.signal && typeof rec.signal === "object" ? rec.signal : {}) as Record<string, unknown>;
  const watchlistCfg = (rec.watchlist && typeof rec.watchlist === "object" ? rec.watchlist : {}) as Record<string, unknown>;
  const filters = (rec.filters && typeof rec.filters === "object" ? rec.filters : {}) as Record<string, unknown>;
  const baseline = (rec.baseline && typeof rec.baseline === "object" ? rec.baseline : {}) as Record<string, unknown>;
  const trigger = (rec.trigger && typeof rec.trigger === "object" ? rec.trigger : {}) as Record<string, unknown>;
  const finite = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const finitePct = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? maybeRatioPct(parsed) : fallback;
  };

  const chains: GmgnChain[] = ["sol"];
  void rec.chains;

  const trendingInterval = trending.interval === "1m" || trending.interval === "5m" || trending.interval === "1h" || trending.interval === "6h" || trending.interval === "24h"
    ? trending.interval
    : DEFAULT_SETTINGS.trending.interval;
  const storedMode = isMode(rec.mode) ? rec.mode : modeFromSource;
  const mode: GmgnMode = isGmgnLiveSourceMode ? storedMode : "watch";
  const signalGroups = Array.isArray(signal.groups)
    ? signal.groups.map((group) => {
        const recGroup = group as Record<string, unknown>;
        const values = Array.isArray(recGroup.signal_type)
          ? recGroup.signal_type.map((item) => Math.round(Number(item))).filter((n) => Number.isFinite(n) && n > 0)
          : [];
        return values.length > 0 ? { signal_type: Array.from(new Set(values)) } : null;
      }).filter((item): item is { signal_type: number[] } => item != null)
    : DEFAULT_SETTINGS.signal.groups;

  return {
    enabled: typeof rec.enabled === "boolean" ? rec.enabled : DEFAULT_SETTINGS.enabled,
    pollMs: Math.max(15_000, Math.min(600_000, Math.round(Number(rec.pollMs ?? DEFAULT_SETTINGS.pollMs)) || DEFAULT_SETTINGS.pollMs)),
    mode,
    sourceMode,
    chains: chains.length > 0 ? chains : DEFAULT_SETTINGS.chains,
    trending: {
      enabled: trending.enabled === undefined ? DEFAULT_SETTINGS.trending.enabled : Boolean(trending.enabled),
      interval: trendingInterval,
      limit: Math.max(1, Math.min(100, Math.round(Number(trending.limit ?? DEFAULT_SETTINGS.trending.limit)) || DEFAULT_SETTINGS.trending.limit)),
      orderBy: typeof trending.orderBy === "string" && trending.orderBy.trim() ? trending.orderBy.trim() : DEFAULT_SETTINGS.trending.orderBy,
      direction: trending.direction === "asc" ? "asc" : "desc",
      filters: Array.isArray(trending.filters)
        ? trending.filters.map((item) => getMaybeString(item)).filter((item): item is string => Boolean(item))
        : DEFAULT_SETTINGS.trending.filters,
      platforms: Array.isArray(trending.platforms)
        ? trending.platforms.map((item) => getMaybeString(item)).filter((item): item is string => Boolean(item))
        : DEFAULT_SETTINGS.trending.platforms,
    },
    trenches: {
      enabled: trenches.enabled === undefined ? DEFAULT_SETTINGS.trenches.enabled : Boolean(trenches.enabled),
      limit: Math.max(1, Math.min(100, Math.round(Number(trenches.limit ?? DEFAULT_SETTINGS.trenches.limit)) || DEFAULT_SETTINGS.trenches.limit)),
      types: Array.isArray(trenches.types)
        ? trenches.types.map((type) => (type === "new_creation" || type === "near_completion" || type === "completed" ? type : null)).filter((item): item is GmgnTrenchesType => item != null)
        : DEFAULT_SETTINGS.trenches.types,
      launchpadPlatforms: Array.isArray(trenches.launchpadPlatforms)
        ? trenches.launchpadPlatforms.map((item) => getMaybeString(item)).filter((item): item is string => Boolean(item))
        : DEFAULT_SETTINGS.trenches.launchpadPlatforms,
      filterPreset: typeof trenches.filterPreset === "string" && trenches.filterPreset.trim() ? trenches.filterPreset.trim() : DEFAULT_SETTINGS.trenches.filterPreset,
      minSmartDegenCount: Math.max(0, Math.round(Number(trenches.minSmartDegenCount ?? DEFAULT_SETTINGS.trenches.minSmartDegenCount)) || DEFAULT_SETTINGS.trenches.minSmartDegenCount),
      sortBy: typeof trenches.sortBy === "string" && trenches.sortBy.trim() ? trenches.sortBy.trim() : DEFAULT_SETTINGS.trenches.sortBy,
    },
    signal: {
      enabled: signal.enabled === undefined ? DEFAULT_SETTINGS.signal.enabled : Boolean(signal.enabled),
      limit: Math.max(1, Math.min(100, Math.round(Number(signal.limit ?? DEFAULT_SETTINGS.signal.limit)) || DEFAULT_SETTINGS.signal.limit)),
      groups: signalGroups.length > 0 ? signalGroups : DEFAULT_SETTINGS.signal.groups,
      side: signal.side === "buy" || signal.side === "sell" ? signal.side : undefined,
    },
    watchlist: {
      enabled: watchlistCfg.enabled === undefined ? DEFAULT_SETTINGS.watchlist.enabled : Boolean(watchlistCfg.enabled),
      refreshLimit: Math.max(1, Math.min(20, Math.round(Number(watchlistCfg.refreshLimit ?? DEFAULT_SETTINGS.watchlist.refreshLimit)) || DEFAULT_SETTINGS.watchlist.refreshLimit)),
      maxEntries: Math.max(20, Math.min(1000, Math.round(Number(rec.maxWatchMints ?? watchlistCfg.maxEntries ?? DEFAULT_SETTINGS.watchlist.maxEntries)) || DEFAULT_SETTINGS.watchlist.maxEntries)),
    },
    watchlistTtlMins: Math.max(5, Math.min(1440 * 7, Math.round(finite(rec.watchlistTtlMins, DEFAULT_SETTINGS.watchlistTtlMins)))),
    filters: {
      minMarketCapUsd: Math.max(0, finite(baseline.minMcapUsd ?? filters.minMarketCapUsd, DEFAULT_SETTINGS.filters.minMarketCapUsd)),
      maxMarketCapUsd: Math.max(0, finite(baseline.maxMcapUsd ?? filters.maxMarketCapUsd, DEFAULT_SETTINGS.filters.maxMarketCapUsd)),
      minLiquidityUsd: Math.max(0, finite(baseline.minLiquidityUsd ?? filters.minLiquidityUsd, DEFAULT_SETTINGS.filters.minLiquidityUsd)),
      minHolders: Math.max(0, Math.round(finite(baseline.minHolders ?? filters.minHolders, DEFAULT_SETTINGS.filters.minHolders))),
      minTokenAgeMins: Math.max(0, Math.round(finite(filters.minTokenAgeMins, DEFAULT_SETTINGS.filters.minTokenAgeMins))),
      maxTokenAgeMins: Math.max(0, Math.round(finite(filters.maxTokenAgeMins, DEFAULT_SETTINGS.filters.maxTokenAgeMins))),
      minSmartMoneyCount: Math.max(0, Math.round(finite(filters.minSmartMoneyCount, DEFAULT_SETTINGS.filters.minSmartMoneyCount))),
      minKolCount: Math.max(0, Math.round(finite(filters.minKolCount, DEFAULT_SETTINGS.filters.minKolCount))),
      maxRugRatio: finite(baseline.maxRugRatio ?? filters.maxRugRatio, DEFAULT_SETTINGS.filters.maxRugRatio),
      maxTop10Pct: finitePct(baseline.maxTop10HolderRate ?? filters.maxTop10Pct, DEFAULT_SETTINGS.filters.maxTop10Pct),
      requireNoHoneypot: filters.requireNoHoneypot === undefined ? DEFAULT_SETTINGS.filters.requireNoHoneypot : Boolean(filters.requireNoHoneypot),
      requireRenounced: filters.requireRenounced === undefined ? DEFAULT_SETTINGS.filters.requireRenounced : Boolean(filters.requireRenounced),
      requirePool: filters.requirePool === undefined ? DEFAULT_SETTINGS.filters.requirePool : Boolean(filters.requirePool),
      maxBundlerPct: finitePct(baseline.maxBundlerRate ?? filters.maxBundlerPct, DEFAULT_SETTINGS.filters.maxBundlerPct),
      maxBotPct: finitePct(baseline.maxBotRate ?? filters.maxBotPct, DEFAULT_SETTINGS.filters.maxBotPct),
      maxCreatorBalancePct: finitePct(baseline.maxCreatorBalanceRate ?? filters.maxCreatorBalancePct, DEFAULT_SETTINGS.filters.maxCreatorBalancePct),
      requireNotWashTrading:
        baseline.requireNotWashTrading === undefined
          ? DEFAULT_SETTINGS.filters.requireNotWashTrading
          : Boolean(baseline.requireNotWashTrading),
    },
    trigger: {
      minScans: Math.max(1, Math.min(20, Math.round(finite(trigger.minScans, DEFAULT_SETTINGS.trigger.minScans)))),
      minHolderGrowthPct: Math.max(0, finite(trigger.minHolderGrowthPct, DEFAULT_SETTINGS.trigger.minHolderGrowthPct)),
      maxHolderGrowthPct: Math.max(0, finite(trigger.maxHolderGrowthPct, DEFAULT_SETTINGS.trigger.maxHolderGrowthPct)),
      maxLiquidityDropPct: Math.max(0, Math.min(100, finite(trigger.maxLiquidityDropPct, DEFAULT_SETTINGS.trigger.maxLiquidityDropPct))),
      minBuySellRatio: Math.max(0, finite(trigger.minBuySellRatio, DEFAULT_SETTINGS.trigger.minBuySellRatio)),
      minSmartOrKolCount: Math.max(0, Math.round(finite(trigger.minSmartOrKolCount, DEFAULT_SETTINGS.trigger.minSmartOrKolCount))),
    },
    mintCooldownMins: Math.max(0, Number(rec.mintCooldownMins ?? DEFAULT_SETTINGS.mintCooldownMins) || DEFAULT_SETTINGS.mintCooldownMins),
    liveScoreMin: Math.max(0, Math.min(100, Number(rec.liveScoreMin ?? DEFAULT_SETTINGS.liveScoreMin) || DEFAULT_SETTINGS.liveScoreMin)),
    watchScoreMin: Math.max(0, Math.min(100, Number(rec.watchScoreMin ?? DEFAULT_SETTINGS.watchScoreMin) || DEFAULT_SETTINGS.watchScoreMin)),
    maxCandidatesPerPoll: Math.max(1, Math.min(20, Math.round(Number(rec.maxCandidatesPerPoll ?? DEFAULT_SETTINGS.maxCandidatesPerPoll)) || DEFAULT_SETTINGS.maxCandidatesPerPoll)),
    includePoolInfo: rec.includePoolInfo === undefined ? DEFAULT_SETTINGS.includePoolInfo : Boolean(rec.includePoolInfo),
  };
}

function parseNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeMint(value: unknown): string {
  return getMaybeString(value) ?? "";
}

function normalizeTimestamp(value: unknown): number {
  const n = parseNumber(value);
  if (n <= 0) return Date.now();
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

function isLiveMode(mode: GmgnMode): boolean {
  return mode === "live" || mode === "active" || mode === "buy" || mode === "scanner";
}

function watchModeReason(mode: GmgnMode): string {
  return isLiveMode(mode) ? "live scan disabled" : "watch mode";
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

function getStringField(row: GmgnRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    const str = getMaybeString(value);
    if (str) return str;
  }
  return undefined;
}

function getMintFromRow(row: GmgnRow): string {
  return (
    getStringField(row, ["address", "token_address", "tokenAddress", "mint", "contractAddress", "token", "ca"]) ??
    getStringField(row, ["token"]) ??
    ""
  );
}

function getChainFromRow(row: GmgnRow, fallback: GmgnChain): GmgnChain {
  const raw = getStringField(row, ["chain"]);
  if (raw === "sol" || raw === "bsc" || raw === "base" || raw === "eth") return raw;
  return fallback;
}

function maybeRatioPct(value: unknown): number {
  const n = parseNumber(value);
  if (n <= 1 && n >= 0) return n * 100;
  return n;
}

function scoreFromData(candidate: Partial<GmgnSignalCandidate>): number {
  let score = 24;
  score += Math.min(20, Math.max(0, candidate.hotLevel ?? 0) * 2);
  score += Math.min(20, Math.max(0, candidate.smartMoneyCount ?? 0) * 6);
  score += Math.min(12, Math.max(0, candidate.kolCount ?? 0) * 4);
  score += Math.min(10, Math.max(-10, (candidate.change1h ?? 0) / 2));
  score += Math.min(6, Math.max(-6, (candidate.change5m ?? 0) / 2));
  score += candidate.isOnCurve ? 2 : 0;
  score += candidate.renouncedMint && candidate.renouncedFreeze ? 5 : 0;
  score -= Math.min(18, Math.max(0, candidate.top10Pct ?? 0) / 4);
  score -= Math.min(20, Math.max(0, candidate.rugRatio ?? 0) * 100);
  score -= candidate.isHoneypot ? 50 : 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function liqTrendFor(candidate: Partial<GmgnSignalCandidate>): ScgAlert["liq_trend"] {
  const change = Math.max(candidate.change1h ?? 0, candidate.change5m ?? 0, candidate.change1m ?? 0);
  if (change > 0) return "rising";
  if (change < 0) return "falling";
  return "unknown";
}

function buildAlert(candidate: GmgnSignalCandidate): ScgAlert {
  const ageMins = Math.max(0, Math.floor((Date.now() - candidate.timestamp) / 60_000));
  return {
    mint: candidate.mint,
    name: candidate.symbol ? `${candidate.name} (${candidate.symbol})` : candidate.name,
    source: "gmgn",
    sourceMeta: {
      ...candidate.sourceMeta,
      smartMoneyCount: candidate.smartMoneyCount,
      kolCount: candidate.kolCount,
      sniperCount: candidate.sniperCount,
      bundlerPct: candidate.bundlerPct,
      ratTraderPct: candidate.ratTraderPct,
      creatorBalancePct: candidate.creatorBalancePct,
      hotLevel: candidate.hotLevel,
      change1m: candidate.change1m,
      change5m: candidate.change5m,
      change1h: candidate.change1h,
      isHoneypot: candidate.isHoneypot,
      isWashTrading: candidate.isWashTrading,
      renouncedMint: candidate.renouncedMint,
      renouncedFreeze: candidate.renouncedFreeze,
      isOnCurve: candidate.isOnCurve,
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
    bs_ratio: 0,
    bot_degen_pct: candidate.bundlerPct,
    holder_growth_pct: 0,
    liquidity: candidate.liquidityUsd,
    bundler_pct: candidate.bundlerPct,
    top10_pct: candidate.top10Pct,
    kol_count: candidate.kolCount,
    signal_count: candidate.smartMoneyCount + candidate.kolCount + candidate.sniperCount,
    degen_call_count: candidate.smartMoneyCount,
    rug_ratio: candidate.rugRatio,
    twitter_followers: 0,
    liq_trend: liqTrendFor(candidate),
    completed: false,
  };
}

function maybeReject(candidate: Partial<GmgnSignalCandidate>, _reason: string): string | null {
  const filters = currentSettings().filters;
  const runtime = getRuntimeSettings();
  const mcap = candidate.marketCapUsd ?? 0;
  if (mcap > 0 && filters.minMarketCapUsd > 0 && mcap < filters.minMarketCapUsd) {
    return `market cap ${Math.round(mcap).toLocaleString("en-US")} < ${Math.round(filters.minMarketCapUsd).toLocaleString("en-US")}`;
  }
  if (filters.maxMarketCapUsd > 0 && mcap > filters.maxMarketCapUsd) {
    return `market cap ${Math.round(mcap).toLocaleString("en-US")} > ${Math.round(filters.maxMarketCapUsd).toLocaleString("en-US")}`;
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
  if (candidate.timestamp && candidate.timestamp > 0) {
    const ageMins = Math.max(0, Math.floor((Date.now() - candidate.timestamp) / 60_000));
    if (filters.minTokenAgeMins > 0 && ageMins < filters.minTokenAgeMins) {
      return `token age ${ageMins}min < ${filters.minTokenAgeMins}min`;
    }
    if (filters.maxTokenAgeMins > 0 && ageMins > filters.maxTokenAgeMins) {
      return `token age ${ageMins}min > ${filters.maxTokenAgeMins}min (too old)`;
    }
  }
  if ((candidate.smartMoneyCount ?? 0) < filters.minSmartMoneyCount) {
    return `smart money ${Math.round(candidate.smartMoneyCount ?? 0)} < ${filters.minSmartMoneyCount}`;
  }
  if ((candidate.kolCount ?? 0) < filters.minKolCount) {
    return `KOL count ${Math.round(candidate.kolCount ?? 0)} < ${filters.minKolCount}`;
  }
  // [GMGN-FIELD-MISSING] rug_ratio is not exposed by any GMGN open-API
  // endpoint. Leaving the check active would be a no-op (always 0); disabling
  // so users aren't misled into thinking the filter runs.
  // if ((candidate.rugRatio ?? 0) > filters.maxRugRatio) {
  //   return `rug ratio ${(candidate.rugRatio ?? 0).toFixed(2)} > ${filters.maxRugRatio}`;
  // }
  if ((candidate.top10Pct ?? 0) > filters.maxTop10Pct) {
    return `top10 ${Math.round(candidate.top10Pct ?? 0)}% > ${filters.maxTop10Pct}%`;
  }
  if ((candidate.bundlerPct ?? 0) > filters.maxBundlerPct) {
    return `bundler ${(candidate.bundlerPct ?? 0).toFixed(0)}% > ${filters.maxBundlerPct}%`;
  }
  if ((candidate.ratTraderPct ?? 0) > filters.maxBotPct) {
    return `bot ${(candidate.ratTraderPct ?? 0).toFixed(0)}% > ${filters.maxBotPct}%`;
  }
  if ((candidate.creatorBalancePct ?? 0) > filters.maxCreatorBalancePct) {
    return `creator ${(candidate.creatorBalancePct ?? 0).toFixed(0)}% > ${filters.maxCreatorBalancePct}%`;
  }
  // [GMGN-FIELD-MISSING] is_wash_trading is not exposed. Proxy via
  // top_rat_trader_percentage (ratTraderPct) and top_bot_degen_percentage
  // which already gate through maxBotPct above.
  // if (filters.requireNotWashTrading && candidate.isWashTrading) {
  //   return "wash trading flagged";
  // }
  if (filters.requireNoHoneypot && candidate.isHoneypot) {
    return "honeypot flagged";
  }
  if (filters.requireRenounced && !(candidate.renouncedMint && candidate.renouncedFreeze)) {
    return "mint/freeze authority not renounced";
  }
  if (filters.requirePool && (candidate.liquidityUsd ?? 0) <= 0) {
    return "pool data unavailable";
  }
  return null;
}

function gmgnBuySellRatio(candidate: Partial<GmgnSignalCandidate>): number | undefined {
  const meta = candidate.sourceMeta ?? {};
  const buy =
    getMaybeNumber(meta.buy_count) ??
    getMaybeNumber(meta.buyCount) ??
    getMaybeNumber(meta.buys) ??
    getMaybeNumber(meta.buy_tx_count) ??
    getMaybeNumber(candidate.raw?.buy_count) ??
    getMaybeNumber(candidate.raw?.buys);
  const sell =
    getMaybeNumber(meta.sell_count) ??
    getMaybeNumber(meta.sellCount) ??
    getMaybeNumber(meta.sells) ??
    getMaybeNumber(meta.sell_tx_count) ??
    getMaybeNumber(candidate.raw?.sell_count) ??
    getMaybeNumber(candidate.raw?.sells);
  if (buy === undefined || sell === undefined) return undefined;
  return buy / Math.max(1, sell);
}

function gmgnSnapshotCount(mint: string): number {
  return snapshots.reduce((count, snapshot) => {
    return count + (snapshot.rows.some((row) => row.mint === mint) ? 1 : 0);
  }, 0);
}

function maybeRejectTrigger(candidate: GmgnSignalCandidate, settings: GmgnSettings): string | null {
  const trigger = settings.trigger;
  const existing = watchlist.get(candidate.mint);
  const scans = Math.max(existing ? 1 : 0, gmgnSnapshotCount(candidate.mint));
  if (scans < trigger.minScans) {
    return `scans ${scans} < ${trigger.minScans}`;
  }

  const firstHolders = existing?.firstHolders ?? candidate.holders;
  const holderGrowthPct = firstHolders > 0 ? ((candidate.holders - firstHolders) / firstHolders) * 100 : 0;
  if (holderGrowthPct < trigger.minHolderGrowthPct) {
    return `holder growth ${holderGrowthPct.toFixed(1)}% < ${trigger.minHolderGrowthPct}%`;
  }
  if (trigger.maxHolderGrowthPct > 0 && holderGrowthPct > trigger.maxHolderGrowthPct) {
    return `holder growth ${holderGrowthPct.toFixed(1)}% > ${trigger.maxHolderGrowthPct}% (bot inflation)`;
  }

  const firstLiquidity = existing?.firstLiquidityUsd ?? candidate.liquidityUsd;
  const liquidityDropPct = firstLiquidity > 0 ? Math.max(0, ((firstLiquidity - candidate.liquidityUsd) / firstLiquidity) * 100) : 0;
  if (liquidityDropPct > trigger.maxLiquidityDropPct) {
    return `liquidity drop ${liquidityDropPct.toFixed(0)}% > ${trigger.maxLiquidityDropPct}%`;
  }

  const smartOrKol = candidate.smartMoneyCount + candidate.kolCount;
  if (smartOrKol < trigger.minSmartOrKolCount) {
    return `smart/KOL ${smartOrKol} < ${trigger.minSmartOrKolCount}`;
  }

  const ratio = gmgnBuySellRatio(candidate);
  if (ratio !== undefined && ratio < trigger.minBuySellRatio) {
    return `buy/sell ${ratio.toFixed(2)} < ${trigger.minBuySellRatio}`;
  }

  candidate.sourceMeta = {
    ...candidate.sourceMeta,
    scans,
    holderGrowthPct,
    liquidityDropPct,
    buySellRatio: ratio,
  };
  candidate.alert.sourceMeta = candidate.sourceMeta;
  candidate.alert.holder_growth_pct = holderGrowthPct;
  candidate.alert.bs_ratio = ratio ?? 0;
  return null;
}

function reject(candidate: Partial<GmgnSignalCandidate> | null, source: GmgnSourceKind, reason: string): void {
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
      reason: `GMGN/${source}: ${reason}`,
    });
  }
}

function dedup(candidate: Partial<GmgnSignalCandidate>, source: GmgnSourceKind, reason: string): void {
  recordAlertEvent({
    at: Date.now(),
    mint: candidate.mint ?? "",
    name: candidate.name ?? "",
    score: candidate.score ?? 0,
    age_mins: Math.max(0, Math.floor((Date.now() - (candidate.timestamp ?? Date.now())) / 60_000)),
    liquidity: Math.max(0, candidate.liquidityUsd ?? 0),
    action: "dedup",
    reason: `GMGN/${source}: ${reason}`,
  });
}

function upsertWatchEntry(
  candidate: GmgnSignalCandidate,
  status: GmgnWatchStatus,
  reason?: string,
  opts: { enriched?: boolean } = {},
): void {
  const existing = watchlist.get(candidate.mint);
  const enriched = opts.enriched ?? true;
  const entry: GmgnWatchEntry = {
    mint: candidate.mint,
    chain: candidate.chain,
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
  while (watchlist.size > currentSettings().watchlist.maxEntries) {
    const oldest = [...watchlist.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
    if (!oldest) break;
    watchlist.delete(oldest.mint);
  }
}

function appendSnapshot(candidateRows: GmgnWatchEntry[], chain: GmgnChain, source: string): void {
  snapshots.push({
    at: Date.now(),
    mode: currentSettings().mode,
    chain,
    source,
    count: candidateRows.length,
    rows: candidateRows.map((row) => ({
      mint: row.mint,
      name: row.name,
      symbol: row.symbol,
      source: row.source,
      status: row.status,
      reason: row.reason,
      score: row.score,
      marketCapUsd: row.marketCapUsd,
      liquidityUsd: row.liquidityUsd,
      holders: row.holders,
      top10Pct: row.top10Pct,
      rugRatio: row.rugRatio,
    })),
  });
  while (snapshots.length > SNAPSHOT_CAP) snapshots.shift();
}

function purgeStaleWatchlist(settings = currentSettings()): void {
  const cutoff = Date.now() - settings.watchlistTtlMins * 60_000;
  for (const [mint, entry] of watchlist.entries()) {
    if (entry.lastSeenAt < cutoff) watchlist.delete(mint);
  }
}

function serializeState(): { watchlist: GmgnWatchEntry[]; snapshots: GmgnSnapshot[] } {
  return {
    watchlist: [...watchlist.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    snapshots: [...snapshots],
  };
}

function hydrateWatchEntry(raw: unknown): GmgnWatchEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const mint = getMaybeString(rec.mint);
  const chain = rec.chain === "sol" || rec.chain === "bsc" || rec.chain === "base" || rec.chain === "eth" ? rec.chain : null;
  if (!mint || !chain) return null;
  return {
    mint,
    chain,
    source: rec.source === "trending" || rec.source === "trenches" || rec.source === "signal" || rec.source === "watchlist" ? rec.source : "watchlist",
    sourceKey: getMaybeString(rec.sourceKey) ?? `watchlist:${chain}:${mint}`,
    name: getMaybeString(rec.name) ?? mint.slice(0, 8),
    symbol: getMaybeString(rec.symbol),
    logo: getMaybeString(rec.logo),
    timestamp: Number(rec.timestamp ?? Date.now()) || Date.now(),
    lastSeenAt: Number(rec.lastSeenAt ?? Date.now()) || Date.now(),
    firstHolders: Number(rec.firstHolders ?? rec.holders ?? 0) || 0,
    firstLiquidityUsd: Number(rec.firstLiquidityUsd ?? rec.liquidityUsd ?? 0) || 0,
    status: rec.status === "accepted" || rec.status === "filtered" || rec.status === "dedup" ? rec.status : "watch",
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
          if (entry) {
            watchlist.set(entry.mint, entry);
          }
        }
      }
    }

    const snapshotRaw = await readFile(SNAPSHOTS_FILE, "utf8").catch(() => "");
    if (snapshotRaw) {
      const parsed = JSON.parse(snapshotRaw) as unknown;
      const rows = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.snapshots;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && typeof row === "object") {
            snapshots.push(row as GmgnSnapshot);
          }
        }
      }
    }

    while (snapshots.length > SNAPSHOT_CAP) snapshots.shift();
    purgeStaleWatchlist();
    while (watchlist.size > currentSettings().watchlist.maxEntries) {
      const oldest = [...watchlist.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (!oldest) break;
      watchlist.delete(oldest.mint);
    }
    logger.info({ watchlist: watchlist.size, snapshots: snapshots.length }, "[gmgn-source] state restored");
  } catch (err) {
    logger.warn({ err: String(err) }, "[gmgn-source] state load failed");
  }
}

let persistTimer: NodeJS.Timeout | null = null;
function persistState(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await mkdir(GMGN_STATE_DIR, { recursive: true });
      purgeStaleWatchlist();
      const state = serializeState();
      await writeFile(WATCHLIST_FILE, JSON.stringify({ watchlist: state.watchlist }, null, 2));
      await writeFile(SNAPSHOTS_FILE, JSON.stringify({ snapshots: state.snapshots }, null, 2));
    } catch (err) {
      logger.error({ err: String(err) }, "[gmgn-source] persist failed");
    }
  }, 200);
  persistTimer.unref?.();
}

function exactSeedKey(candidate: { source: GmgnSourceKind; chain: GmgnChain; mint: string; sourceKey: string }): string {
  return `${candidate.source}:${candidate.chain}:${candidate.mint}:${candidate.sourceKey}`;
}

function extractRowsFromSource(raw: unknown): GmgnRow[] {
  if (Array.isArray(raw)) return raw.filter((row): row is GmgnRow => Boolean(row) && typeof row === "object");
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  for (const key of ["list", "items", "rows", "signals", "records", "tokens", "trends", "data", "pump", "result", "results"]) {
    const child = rec[key];
    if (Array.isArray(child)) {
      return child.filter((row): row is GmgnRow => Boolean(row) && typeof row === "object");
    }
    if (child && typeof child === "object") {
      const nested = extractRowsFromSource(child);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

function baseSeedFromRow(source: GmgnSourceKind, chain: GmgnChain, row: GmgnRow): GmgnSignalCandidate | null {
  const mint = normalizeMint(getStringField(row, ["address", "token_address", "tokenAddress", "mint", "contractAddress", "token", "ca"]));
  if (!mint) return null;

  const name = getStringField(row, ["name", "symbol", "token_name"]) ?? mint.slice(0, 8);
  const symbol = getStringField(row, ["symbol"]);
  const logo = getStringField(row, ["logo", "image", "icon"]);
  const timestamp =
    normalizeTimestamp(
      getStringField(row, ["trigger_at", "timestamp", "time", "ts", "creation_timestamp", "created_at", "createdAt", "open_timestamp"]) ??
        Date.now(),
    );

  const marketCapUsd = parseNumber(
    getStringField(row, ["market_cap", "marketCap", "marketCapUsd", "marketcap", "mcap", "liquidity_market_cap"]) ??
      row.market_cap ??
      row.marketCap ??
      0,
  );
  const priceUsd = parseNumber(getStringField(row, ["price", "priceUsd"]) ?? row.price ?? 0);
  const liquidityUsd = parseNumber(getStringField(row, ["liquidity", "liquidityUsd"]) ?? row.liquidity ?? 0);
  const holders = Math.round(parseNumber(getStringField(row, ["holder_count", "holders", "holderCount"]) ?? row.holder_count ?? 0));
  const smartMoneyCountRaw = Math.round(parseNumber(getStringField(row, ["smart_degen_count", "smartMoneyCount"]) ?? row.smart_degen_count ?? 0));
  // A row returned from /v1/market/token_signal IS a smart-money buy by
  // definition, so ensure smartMoneyCount is at least 1 even when the
  // upstream row omits the count field. Left in place for when the
  // "signal" source is re-enabled.
  const smartMoneyCount = source === "signal" ? Math.max(1, smartMoneyCountRaw) : smartMoneyCountRaw;
  const kolCount = Math.round(parseNumber(getStringField(row, ["renowned_count", "kol_count", "kolCount"]) ?? row.renowned_count ?? 0));
  const sniperCount = Math.round(parseNumber(getStringField(row, ["sniper_count", "sniperCount"]) ?? row.sniper_count ?? 0));
  const bundlerPct = maybeRatioPct(getStringField(row, ["bundler_rate", "bundler_pct", "bundlerPct", "bundler_percent"]) ?? row.bundler_rate ?? 0);
  const ratTraderPct = maybeRatioPct(getStringField(row, ["rat_trader_amount_rate", "ratTraderPct", "rat_trader_rate"]) ?? row.rat_trader_amount_rate ?? 0);
  const creatorBalancePct = maybeRatioPct(
    getStringField(row, ["creator_balance_rate", "creatorBalanceRate", "dev_balance_rate", "devHoldRate"]) ??
      row.creator_balance_rate ??
      row.dev_balance_rate ??
      0,
  );
  const top10Pct = maybeRatioPct(getStringField(row, ["top10_holder_rate", "top10Pct", "top_10_holder_rate"]) ?? row.top10_holder_rate ?? 0);
  const rugRatio = parseNumber(getStringField(row, ["rug_ratio", "rugRatio"]) ?? row.rug_ratio ?? 0);
  const hotLevel = parseNumber(getStringField(row, ["hot_level", "hotLevel"]) ?? row.hot_level ?? 0);
  const change1m = parseNumber(getStringField(row, ["change1m", "price_change_1m", "price_change_percent1m", "priceChange1m"]) ?? row.change1m ?? 0);
  const change5m = parseNumber(getStringField(row, ["change5m", "price_change_5m", "price_change_percent5m", "priceChange5m"]) ?? row.change5m ?? 0);
  const change1h = parseNumber(getStringField(row, ["change1h", "price_change_1h", "price_change_percent1h", "priceChange1h"]) ?? row.change1h ?? 0);
  const isHoneypot = getMaybeBool(row.is_honeypot) ?? false;
  const isWashTrading = getMaybeBool(row.is_wash_trading ?? row.wash_trading ?? row.isWashTrading) ?? false;
  const renouncedMint = getMaybeBool(row.renounced_mint) ?? false;
  const renouncedFreeze = getMaybeBool(row.renounced_freeze_account) ?? false;
  const isOnCurve = getMaybeBool(row.is_on_curve) ?? false;
  const sourceKey = exactSeedKey({ source, chain, mint, sourceKey: getMaybeString(row.id) ?? `${timestamp}` });

  const candidate: GmgnSignalCandidate = {
    chain,
    source,
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
    holders,
    smartMoneyCount,
    kolCount,
    sniperCount,
    bundlerPct,
    ratTraderPct,
    creatorBalancePct,
    top10Pct,
    rugRatio,
    hotLevel,
    change1m,
    change5m,
    change1h,
    isHoneypot,
    isWashTrading,
    renouncedMint,
    renouncedFreeze,
    isOnCurve,
    sourceMeta: {
      source,
      chain,
      rawId: getMaybeString(row.id),
    },
    raw: row,
    alert: {} as ScgAlert,
  };
  candidate.score = scoreFromData(candidate);
  candidate.alert = buildAlert(candidate);
  candidate.alert.score = candidate.score;
  return candidate;
}

async function enrichSeed(seed: GmgnSignalCandidate): Promise<GmgnSignalCandidate> {
  const [info, security, pool] = await Promise.allSettled([
    getTokenInfo(seed.chain, seed.mint),
    getTokenSecurity(seed.chain, seed.mint),
    currentSettings().includePoolInfo ? getTokenPool(seed.chain, seed.mint) : Promise.resolve(null),
  ]);

  const infoObj = info.status === "fulfilled" ? info.value : null;
  const securityObj = security.status === "fulfilled" ? security.value : null;
  const poolObj = pool.status === "fulfilled" ? pool.value : null;

  const next = { ...seed };
  if (infoObj) {
    next.name = getMaybeString(infoObj.name) ?? getMaybeString(infoObj.symbol) ?? next.name;
    next.symbol = getMaybeString(infoObj.symbol) ?? next.symbol;
    next.logo = getMaybeString(infoObj.logo) ?? next.logo;
    next.priceUsd = parseNumber(infoObj.price ?? next.priceUsd);
    next.marketCapUsd = parseNumber(infoObj.marketCap ?? infoObj.market_cap ?? next.marketCapUsd);
    next.liquidityUsd = parseNumber(infoObj.liquidity ?? next.liquidityUsd);
    next.holders = Math.round(parseNumber(infoObj.holder_count ?? next.holders));

    // GMGN nests wallet counts under info.wallet_tags_stat.*
    const tags = (infoObj.wallet_tags_stat ?? {}) as Record<string, unknown>;
    next.smartMoneyCount = Math.max(next.smartMoneyCount, Math.round(parseNumber(tags.smart_wallets)));
    next.kolCount = Math.max(next.kolCount, Math.round(parseNumber(tags.renowned_wallets)));
    next.sniperCount = Math.max(next.sniperCount, Math.round(parseNumber(tags.sniper_wallets)));

    // GMGN nests rates under info.stat.*
    const stat = (infoObj.stat ?? {}) as Record<string, unknown>;
    next.top10Pct = Math.max(next.top10Pct, maybeRatioPct(parseNumber(stat.top_10_holder_rate) || next.top10Pct));
    next.bundlerPct = Math.max(next.bundlerPct, maybeRatioPct(parseNumber(stat.top_bundler_trader_percentage ?? stat.bot_degen_rate)));
    next.ratTraderPct = Math.max(next.ratTraderPct, maybeRatioPct(parseNumber(stat.top_rat_trader_percentage)));
    next.creatorBalancePct = Math.max(
      next.creatorBalancePct,
      maybeRatioPct(parseNumber(stat.creator_hold_rate ?? stat.dev_team_hold_rate)),
    );

    next.sourceMeta = {
      ...next.sourceMeta,
      info,
      link: infoObj.link,
      stat: infoObj.stat,
      dev: infoObj.dev,
      wallet_tags_stat: infoObj.wallet_tags_stat,
    };
  }
  if (securityObj) {
    next.isHoneypot = getMaybeBool(securityObj.is_honeypot) ?? next.isHoneypot;
    next.renouncedMint = getMaybeBool(securityObj.renounced_mint) ?? getMaybeBool(securityObj.mint_renounced) ?? next.renouncedMint;
    next.renouncedFreeze =
      getMaybeBool(securityObj.renounced_freeze_account) ?? getMaybeBool(securityObj.freeze_renounced) ?? next.renouncedFreeze;
    // top_10_holder_rate also appears on the security endpoint — use whichever is larger.
    next.top10Pct = Math.max(next.top10Pct, maybeRatioPct(parseNumber(securityObj.top_10_holder_rate ?? securityObj.top10_holder_rate)));
    // NOTE: GMGN's open API does not expose `rug_ratio`, `is_wash_trading`, or a
    // direct `creator_balance_rate` on the security endpoint. `rugRatio` and
    // `isWashTrading` filters below are effectively always-pass and are
    // retained only so the shared ScgAlert type stays populated.
    next.sourceMeta = {
      ...next.sourceMeta,
      security: securityObj,
    };
  }
  if (poolObj) {
    next.sourceMeta = {
      ...next.sourceMeta,
      pool: poolObj,
    };
    next.liquidityUsd = Math.max(next.liquidityUsd, parseNumber(poolObj.liquidity ?? poolObj.liquidityUsd));
  }

  next.score = scoreFromData(next);
  next.alert = buildAlert(next);
  next.alert.score = next.score;
  next.alert.sourceMeta = next.sourceMeta;
  next.alert.logo = next.logo;
  next.alert.current_mcap = next.marketCapUsd;
  next.alert.alert_mcap = next.marketCapUsd;
  next.alert.liquidity = next.liquidityUsd;
  next.alert.holders = next.holders;
  next.alert.top10_pct = next.top10Pct;
  next.alert.bundler_pct = next.bundlerPct;
  next.alert.rug_ratio = next.rugRatio;
  next.alert.signal_count = next.smartMoneyCount + next.kolCount + next.sniperCount;
  next.alert.kol_count = next.kolCount;
  next.alert.degen_call_count = next.smartMoneyCount;
  next.alert.bot_degen_pct = next.bundlerPct;
  next.alert.liq_trend = liqTrendFor(next);
  return next;
}

function sourceSeedScore(source: GmgnSourceKind, candidate: GmgnSignalCandidate): number {
  const bias = source === "trenches" ? 8 : source === "signal" ? 6 : source === "watchlist" ? 4 : 0;
  return Math.max(0, Math.min(100, candidate.score + bias));
}

function sortAndLimitSeeds(seeds: GmgnSignalCandidate[], max: number): GmgnSignalCandidate[] {
  return [...seeds].sort((a, b) => sourceSeedScore(b.source, b) - sourceSeedScore(a.source, a)).slice(0, max);
}

function shouldProcessSeed(seed: GmgnSignalCandidate): boolean {
  const existing = watchlist.get(seed.mint);
  if (existing && existing.sourceKey === seed.sourceKey) return false;
  return true;
}

async function fetchSeeds(settings: GmgnSettings): Promise<GmgnSignalCandidate[]> {
  const seeds: GmgnSignalCandidate[] = [];

  for (const chain of settings.chains) {
    if (settings.trending.enabled) {
      try {
        const rows = await getMarketTrending(chain, settings.trending.interval, {
          limit: settings.trending.limit,
          orderBy: settings.trending.orderBy,
          direction: settings.trending.direction,
          filters: settings.trending.filters,
          platforms: settings.trending.platforms,
        });
        for (const row of rows) {
          const seed = baseSeedFromRow("trending", chain, row);
          if (seed) seeds.push(seed);
        }
      } catch (err) {
        lastError = (err as Error).message;
        logger.warn({ err: lastError, chain }, "[gmgn-source] trending fetch failed");
      }
    }

    if (settings.trenches.enabled && (chain === "sol" || chain === "bsc" || chain === "base")) {
      try {
        const rows = await getMarketTrenches(chain, {
          limit: settings.trenches.limit,
          types: settings.trenches.types,
          launchpadPlatforms: settings.trenches.launchpadPlatforms,
          filterPreset: settings.trenches.filterPreset,
          minSmartDegenCount: settings.trenches.minSmartDegenCount,
          sortBy: settings.trenches.sortBy,
        });
        for (const row of rows) {
          const seed = baseSeedFromRow("trenches", chain, row);
          if (seed) seeds.push(seed);
        }
      } catch (err) {
        lastError = (err as Error).message;
        logger.warn({ err: lastError, chain }, "[gmgn-source] trenches fetch failed");
      }
    }

    if (settings.signal.enabled && (chain === "sol" || chain === "bsc")) {
      try {
        const rows = await getMarketSignal(chain, {
          groups: settings.signal.groups,
          limit: settings.signal.limit,
          side: settings.signal.side,
        });
        for (const row of rows) {
          const seed = baseSeedFromRow("signal", chain, row);
          if (seed) seeds.push(seed);
        }
      } catch (err) {
        lastError = (err as Error).message;
        logger.warn({ err: lastError, chain }, "[gmgn-source] signal fetch failed");
      }
    }
  }

  const watchEntries = settings.watchlist.enabled
    ? [...watchlist.values()]
        .filter((entry) => entry.lastSeenAt >= Date.now() - settings.watchlistTtlMins * 60_000)
        .sort((a, b) => b.lastSeenAt - a.lastSeenAt || b.score - a.score)
        .slice(0, settings.watchlist.refreshLimit)
        .map((entry) => {
          const meta = entry.sourceMeta as Record<string, unknown>;
          const raw = meta.raw;
          const candidate: GmgnSignalCandidate = {
            chain: entry.chain,
            source: "watchlist",
            sourceKey: `watchlist:${entry.chain}:${entry.mint}:${entry.lastSeenAt}`,
            mint: entry.mint,
            name: entry.name,
            symbol: entry.symbol,
            logo: entry.logo,
            timestamp: entry.timestamp,
            score: entry.score,
            priceUsd: 0,
            marketCapUsd: entry.marketCapUsd,
            liquidityUsd: entry.liquidityUsd,
            holders: entry.holders,
            smartMoneyCount: Math.max(0, Math.round(Number(meta.smartMoneyCount ?? 0)) || 0),
            kolCount: Math.max(0, Math.round(Number(meta.kolCount ?? 0)) || 0),
            sniperCount: Math.max(0, Math.round(Number(meta.sniperCount ?? 0)) || 0),
            bundlerPct: Math.max(0, Number(meta.bundlerPct ?? 0) || 0),
            ratTraderPct: Math.max(0, Number(meta.ratTraderPct ?? 0) || 0),
            creatorBalancePct: Math.max(0, Number(meta.creatorBalancePct ?? 0) || 0),
            top10Pct: entry.top10Pct,
            rugRatio: entry.rugRatio,
            hotLevel: Math.max(0, Number(meta.hotLevel ?? 0) || 0),
            change1m: Math.max(0, Number(meta.change1m ?? 0) || 0),
            change5m: Math.max(0, Number(meta.change5m ?? 0) || 0),
            change1h: Math.max(0, Number(meta.change1h ?? 0) || 0),
            isHoneypot: Boolean(meta.isHoneypot ?? false),
            isWashTrading: Boolean(meta.isWashTrading ?? false),
            renouncedMint: Boolean(meta.renouncedMint ?? false),
            renouncedFreeze: Boolean(meta.renouncedFreeze ?? false),
            isOnCurve: Boolean(meta.isOnCurve ?? false),
            sourceMeta: { ...meta, source: "watchlist" },
            raw: cloneRawRow(raw),
            alert: {} as ScgAlert,
          };
          return candidate;
        })
    : [];

  const combined = [...seeds, ...watchEntries];
  const scored = combined
    .map((seed) => {
      seed.score = scoreFromData(seed);
      seed.alert = buildAlert(seed);
      seed.alert.score = seed.score;
      return seed;
    })
    .filter(shouldProcessSeed);

  return sortAndLimitSeeds(scored, settings.maxCandidatesPerPoll);
}

type DeepDiveResult =
  | { ok: true; candidate: GmgnSignalCandidate }
  | { ok: false; reason: string };

// Deep-dive enrichment: called just before a candidate would emit, after
// baseline + trigger have already passed on the seed-level data. Pulls
// /v1/token/info + /v1/token/security in parallel and fills ONLY missing
// fields on the candidate (does not override richer seed data). Callers
// should re-check baseline filters on the returned candidate.
//
// Also applies the Jupiter datapi audit gate (fees + organicScoreLabel) before
// emit. GMGN-specific: when Jup has no data for a token (not indexed — common
// for new/small tokens), we pass through and rely on GMGN-native signals.
// When Jup DOES have data, fees + scoreLabel are enforced as configured.
//
// Returns { ok:false, reason } if the Jup gate rejects on indexed tokens.
async function deepDiveCandidate(seed: GmgnSignalCandidate): Promise<DeepDiveResult> {
  let info: Record<string, unknown> | null = null;
  let security: Record<string, unknown> | null = null;

  // Only fetch info/security for sparse sources (signal, trenches).
  // Trending and watchlist seeds arrive pre-enriched from /v1/market/rank —
  // the deep-dive calls add nothing and only burn rate-limit quota.
  const needsEnrichment = seed.source === "signal" || seed.source === "trenches";
  if (needsEnrichment) {
    try {
      const [infoRes, securityRes] = await Promise.all([
        getTokenInfo(seed.chain, seed.mint),
        getTokenSecurity(seed.chain, seed.mint),
      ]);
      info = (infoRes ?? null) as Record<string, unknown> | null;
      security = (securityRes ?? null) as Record<string, unknown> | null;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, mint: seed.mint, source: seed.source },
        "[gmgn-source] deep-dive enrichment failed — proceeding on seed data",
      );
    }
  }

  const next: GmgnSignalCandidate = { ...seed, sourceMeta: { ...seed.sourceMeta } };
  const stat = (info && typeof info.stat === "object" && info.stat ? (info.stat as Record<string, unknown>) : {}) as Record<string, unknown>;

  // holder_count → holders (only if seed had 0/missing)
  if (!next.holders || next.holders <= 0) {
    const holderCount = info ? parseNumber(info.holder_count) : 0;
    if (holderCount > 0) next.holders = Math.round(holderCount);
  }

  // liquidity → liquidityUsd (only if missing)
  if (!next.liquidityUsd || next.liquidityUsd <= 0) {
    const liq = info ? parseNumber(info.liquidity) : 0;
    if (liq > 0) next.liquidityUsd = liq;
  }

  // rug_ratio → rugRatio (only if missing or 0)
  if (!next.rugRatio || next.rugRatio <= 0) {
    const rug = security
      ? parseNumber(security.rug_ratio)
      : 0;
    if (rug > 0) next.rugRatio = rug;
  }

  // top_10_holder_rate → top10Pct (only if missing)
  if (!next.top10Pct || next.top10Pct <= 0) {
    const t10 = parseNumber(
      (security && (security.top_10_holder_rate ?? security.top10_holder_rate)) ??
        stat.top_10_holder_rate ??
        0,
    );
    if (t10 > 0) next.top10Pct = maybeRatioPct(t10);
  }

  // bundler_rate → bundlerPct (only if missing)
  if (!next.bundlerPct || next.bundlerPct <= 0) {
    const b = parseNumber(
      (info && info.bundler_rate) ??
        stat.top_bundler_trader_percentage ??
        stat.bot_degen_rate ??
        0,
    );
    if (b > 0) next.bundlerPct = maybeRatioPct(b);
  }

  // is_wash_trading → isWashTrading (only if not set)
  if (!next.isWashTrading) {
    const wash =
      (info && getMaybeBool(info.is_wash_trading)) ??
      (security && getMaybeBool(security.is_wash_trading)) ??
      null;
    if (wash != null) next.isWashTrading = wash;
  }

  next.sourceMeta = {
    ...next.sourceMeta,
    deepDive: { info: info ?? null, security: security ?? null },
  };

  // Refresh score + alert so /sources-status and downstream consumers
  // see the enriched numbers.
  next.score = scoreFromData(next);
  next.alert = buildAlert(next);
  next.alert.score = next.score;
  next.alert.sourceMeta = next.sourceMeta;

  return { ok: true, candidate: next };
}

async function processSeed(seed: GmgnSignalCandidate, settings: GmgnSettings): Promise<void> {
  settings = currentSettings();
  if (!settings.enabled) {
    upsertWatchEntry(seed, "watch", "GMGN disabled");
    return;
  }
  const mode = settings.mode;
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

  const filterReason = maybeReject(seed, "live");
  if (filterReason) {
    reject(seed, seed.source, filterReason);
    upsertWatchEntry(seed, "filtered", filterReason);
    return;
  }

  const watchOnly = !isLiveMode(mode);
  if (watchOnly) {
    if (watchlist.has(seed.mint)) {
      dedup(seed, seed.source, watchModeReason(mode));
      upsertWatchEntry(seed, "dedup", watchModeReason(mode));
      return;
    }
    reject(seed, seed.source, watchModeReason(mode));
    upsertWatchEntry(seed, "watch", watchModeReason(mode));
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

  // Deep-dive: pull /v1/token/info + /v1/token/security once we know the
  // candidate would otherwise fire. This backfills any fields missing
  // from the seed (holders, liquidity, rug_ratio, top10, bundler,
  // is_wash_trading) and gives us a last chance to reject bad tokens.
  const deepDive = await deepDiveCandidate(seed);
  if (!deepDive.ok) {
    const reason = `deep-dive: ${deepDive.reason}`;
    reject(seed, seed.source, reason);
    upsertWatchEntry(seed, "filtered", reason);
    return;
  }
  const enriched = deepDive.candidate;
  // Reuse lastCandidate so /sources-status reflects the enriched numbers.
  lastCandidate = enriched;
  const deepDiveReason = maybeReject(enriched, "deep-dive");
  if (deepDiveReason) {
    const reason = `deep-dive: ${deepDiveReason}`;
    reject(enriched, enriched.source, reason);
    upsertWatchEntry(enriched, "filtered", reason);
    return;
  }

  candidatesAccepted++;
  const alert = enriched.alert;
  markSignalMintAccepted(enriched.mint, "gmgn");
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
    { mint: enriched.mint, name: enriched.name, score: enriched.score, source: enriched.source, chain: enriched.chain },
    "[gmgn-source] firing GMGN candidate",
  );
  await Promise.resolve(onAcceptedCandidate?.(alert));
}

async function persistAndMaybeSeed(candidates: GmgnSignalCandidate[], settings: GmgnSettings, source: string): Promise<boolean> {
  const wasSeeded = seeded;
  appendSnapshot(
    candidates.map((candidate) => ({
      mint: candidate.mint,
      chain: candidate.chain,
      source: candidate.source,
      sourceKey: candidate.sourceKey,
      name: candidate.name,
      symbol: candidate.symbol,
      logo: candidate.logo,
      timestamp: candidate.timestamp,
      lastSeenAt: Date.now(),
      status: watchlist.get(candidate.mint)?.status ?? "watch",
      reason: watchlist.get(candidate.mint)?.reason,
      score: candidate.score,
      marketCapUsd: candidate.marketCapUsd,
      liquidityUsd: candidate.liquidityUsd,
      holders: candidate.holders,
      top10Pct: candidate.top10Pct,
      rugRatio: candidate.rugRatio,
      sourceMeta: candidate.sourceMeta,
    })),
    settings.chains[0] ?? "sol",
    source,
  );
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
    logger.info({ source, candidates: candidates.length }, "[gmgn-source] seeded from first poll");
  }
  return !wasSeeded;
}

async function runCycle(): Promise<void> {
  if (!running || polling || stopping) return;
  polling = true;
  try {
    const settings = currentSettings();
    if (!settings.enabled) {
      persistState();
      return;
    }
    if (!isGmgnConfigured()) {
      lastError = "missing GMGN_API_KEY";
      persistState();
      return;
    }

    await loadState();
    const seeds = await fetchSeeds(settings);
    const firstPoll = await persistAndMaybeSeed(seeds, settings, "scanner");
    if (firstPoll) return;

    // shouldProcessSeed was already applied inside fetchSeeds. Do NOT
    // re-check in this loop — persistAndMaybeSeed above just upserted
    // each seed's sourceKey into the watchlist, which would make
    // shouldProcessSeed return false for every seed and silently skip
    // all processing.
    for (const seed of seeds) {
      try {
        // Trending seeds from /v1/market/rank include a full profile
        // (holder_count, smart_degen_count, renowned_count, liquidity,
        // etc.), so baseline can run directly against the seed. The
        // deep-dive enrichment happens inside processSeed just before
        // emit — this keeps API usage to ~2 calls per accepted
        // candidate rather than per seed.
        await processSeed(seed, settings);
      } catch (err) {
        lastError = (err as Error).message;
        logger.warn({ err: lastError, mint: seed.mint, source: seed.source }, "[gmgn-source] candidate processing failed");
        upsertWatchEntry(seed, "filtered", lastError);
      }
    }

    lastPollAt = Date.now();
    persistState();
  } catch (err) {
    lastError = (err as Error).message;
    logger.warn({ err: lastError }, "[gmgn-source] cycle failed");
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

export function startGmgnSignalSource(options: StartOptions = {}): void {
  onAcceptedCandidate = options.onAcceptedCandidate;
  if (running) return;
  running = true;
  void runCycle();
}

export async function refreshGmgnSignalSource(): Promise<void> {
  if (!running) return;
  await runCycle();
}

export async function stopGmgnSignalSource(): Promise<void> {
  running = false;
  seeded = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

export function getGmgnSignalStatus(): GmgnStatus {
  const settings = currentSettings();
  return {
    enabled: settings.enabled,
    configured: isGmgnConfigured(),
    mode: settings.mode,
    sourceMode: settings.sourceMode,
    running,
    seeded,
    chains: [...settings.chains],
    trending: { enabled: settings.trending.enabled, interval: settings.trending.interval, limit: settings.trending.limit },
    trenches: { enabled: settings.trenches.enabled, limit: settings.trenches.limit, types: [...settings.trenches.types] },
    signal: { enabled: settings.signal.enabled, limit: settings.signal.limit },
    watchlist: { enabled: settings.watchlist.enabled, refreshLimit: settings.watchlist.refreshLimit, size: watchlist.size },
    lastPollAt,
    lastEventAt,
    lastError,
    baseline: settings.filters,
    trigger: settings.trigger,
    candidatesSeen,
    candidatesFiltered,
    candidatesAccepted,
    recentRejections: [...recentRejections],
    lastRejectionReason: recentRejections[recentRejections.length - 1]?.reason,
    lastCandidate,
    lastAcceptedCandidate,
  };
}
