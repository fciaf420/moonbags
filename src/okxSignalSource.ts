import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "./config.js";
import logger from "./logger.js";
import { isBlacklisted, isPaused, recordAlertEvent } from "./privateSignalPoller.js";
import { checkSignalMintCooldown, markSignalMintAccepted } from "./sourceDedupe.js";
import { getRuntimeSettings, type SourceMode } from "./settingsStore.js";
import type { SignalAlert } from "./types.js";

const execFileAsync = promisify(execFile);

const CHAIN = "solana";
const CHAIN_INDEX = "501";
const CHANNEL = "dex-market-new-signal-openapi";
const CLI_TIMEOUT_MS = 20_000;
const POLL_MS = 3_000;
const EVENT_LIMIT = 50;
const RECENT_REJECTION_CAP = 20;

export type OkxSignalCandidate = {
  sourceKey: string;
  mint: string;
  name: string;
  symbol?: string;
  logo?: string;
  timestamp: number;
  amountUsd: number;
  priceUsd: number;
  marketCapUsd: number;
  holders: number;
  top10HolderPercent: number;
  triggerWalletCount: number;
  walletType: number;
  soldRatioPercent: number;
  raw: unknown;
};

export type OkxSignalStatus = {
  enabled: boolean;
  mode: SourceMode;
  liveFilter: {
    minHolders: number;
    walletTypes: number[];
  };
  running: boolean;
  seeded: boolean;
  sessionId?: string;
  lastPollAt?: number;
  lastEventAt?: number;
  lastError?: string;
  candidatesSeen: number;
  candidatesFiltered: number;
  candidatesAccepted: number;
  lastRejectionReason?: string;
  recentRejections: Array<{ at: number; mint?: string; name?: string; reason: string }>;
  lastCandidate?: OkxSignalCandidate;
};

type StartOptions = {
  onAcceptedCandidate?: (alert: SignalAlert) => void | Promise<void>;
};

type SignalListRow = {
  amountUsd?: string;
  chainIndex?: string;
  cursor?: string;
  price?: string;
  soldRatioPercent?: string;
  timestamp?: string;
  token?: {
    holders?: string;
    logo?: string;
    marketCapUsd?: string;
    name?: string;
    symbol?: string;
    tokenAddress?: string;
    top10HolderPercent?: string;
  };
  triggerWalletAddress?: string;
  triggerWalletCount?: string;
  walletType?: string;
};

let running = false;
let seeded = false;
let sessionId: string | undefined;
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;
let starting = false;
let stopping = false;
let lastPollAt: number | undefined;
let lastEventAt: number | undefined;
let lastError: string | undefined;
let onAcceptedCandidate: StartOptions["onAcceptedCandidate"];

const seen = new Set<string>();
const seenOrder: string[] = [];
const SEEN_CAP = 10_000;

let candidatesSeen = 0;
let candidatesFiltered = 0;
let candidatesAccepted = 0;
let lastCandidate: OkxSignalCandidate | undefined;
const recentRejections: OkxSignalStatus["recentRejections"] = [];

function currentMode(): SourceMode {
  return getRuntimeSettings().signals.sourceMode;
}

function isModeEnabled(mode = currentMode()): boolean {
  const okx = getRuntimeSettings().signals.okx;
  return okx.enabled && (mode === "okx_watch" || mode === "hybrid" || mode === "okx_only");
}

function isLiveMode(mode = currentMode()): boolean {
  return mode === "hybrid" || mode === "okx_only";
}

function walletTypeLabel(type: number): string {
  if (type === 1) return "Smart Money";
  if (type === 2) return "KOL";
  if (type === 3) return "Whale";
  return `type ${type}`;
}

function candidateFilterRejection(candidate: OkxSignalCandidate): string | null {
  const runtime = getRuntimeSettings();
  const filter = runtime.signals.okx.entryFilter;
  if (candidate.holders < filter.minHolders) {
    return `OKX filter: holders ${candidate.holders.toLocaleString("en-US")} < ${filter.minHolders.toLocaleString("en-US")}`;
  }
  if (!filter.walletTypes.includes(candidate.walletType)) {
    const allowed = filter.walletTypes.map(walletTypeLabel).join("/");
    return `OKX filter: wallet type ${walletTypeLabel(candidate.walletType)} not ${allowed}`;
  }
  if (filter.minAmountUsd > 0 && candidate.amountUsd < filter.minAmountUsd) {
    return `OKX filter: amountUsd $${Math.round(candidate.amountUsd).toLocaleString("en-US")} < $${Math.round(filter.minAmountUsd).toLocaleString("en-US")}`;
  }
  const mcap = candidate.marketCapUsd;
  if (runtime.alertFilter.mcapMin > 0 && mcap > 0 && mcap < runtime.alertFilter.mcapMin) {
    return `mcap ${Math.round(mcap).toLocaleString("en-US")} < ${Math.round(runtime.alertFilter.mcapMin).toLocaleString("en-US")}`;
  }
  if (runtime.alertFilter.mcapMax > 0 && mcap > runtime.alertFilter.mcapMax) {
    return `mcap ${Math.round(mcap).toLocaleString("en-US")} > ${Math.round(runtime.alertFilter.mcapMax).toLocaleString("en-US")}`;
  }
  return null;
}

function remember(key: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  seenOrder.push(key);
  while (seenOrder.length > SEEN_CAP) {
    const evicted = seenOrder.shift();
    if (evicted) seen.delete(evicted);
  }
}

function onchainosEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.OKX_PASSPHRASE && env.OKX_API_PASSPHRASE) {
    env.OKX_PASSPHRASE = env.OKX_API_PASSPHRASE;
  }
  return env;
}

async function runCli<T>(args: string[]): Promise<T | null> {
  const { stdout } = await execFileAsync("onchainos", args, {
    timeout: CLI_TIMEOUT_MS,
    env: onchainosEnv(),
    maxBuffer: 8 * 1024 * 1024,
  });
  const parsed = JSON.parse(String(stdout || "{}")) as { ok?: boolean; data?: T; error?: unknown; msg?: unknown };
  if (parsed.ok === false) {
    throw new Error(String(parsed.error ?? parsed.msg ?? "onchainos response not-ok"));
  }
  return parsed.data ?? null;
}

function extractSessionId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of ["id", "sessionId", "session_id"]) {
    const found = rec[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  for (const child of Object.values(rec)) {
    const nested = extractSessionId(child);
    if (nested) return nested;
  }
  return undefined;
}

function eventRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  for (const key of ["events", "items", "messages", "data", "result"]) {
    const value = rec[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeCandidate(raw: unknown): OkxSignalCandidate | null {
  const row = raw && typeof raw === "object" ? raw as SignalListRow & Record<string, unknown> : {};
  const token = (row.token && typeof row.token === "object" ? row.token : {}) as SignalListRow["token"] & Record<string, unknown>;
  const mint =
    text(token?.tokenAddress) ||
    text(row.tokenAddress) ||
    text(row.contractAddress) ||
    text(row.address);
  if (!mint) return null;

  const timestampRaw = row.timestamp ?? row.time ?? row.ts;
  const timestampNum = num(timestampRaw);
  const timestamp = timestampNum > 0
    ? (timestampNum < 1_000_000_000_000 ? timestampNum * 1000 : timestampNum)
    : Date.now();
  const name = text(token?.name) || text(row.name) || text(token?.symbol) || mint.slice(0, 8);
  const sourceKey = `okx:${mint}:${timestamp}`;

  return {
    sourceKey,
    mint,
    name,
    symbol: text(token?.symbol) || undefined,
    logo: text(token?.logo) || undefined,
    timestamp,
    amountUsd: num(row.amountUsd),
    priceUsd: num(row.price),
    marketCapUsd: num(token?.marketCapUsd ?? row.marketCapUsd),
    holders: num(token?.holders ?? row.holders),
    top10HolderPercent: num(token?.top10HolderPercent ?? row.top10HolderPercent),
    triggerWalletCount: Math.round(num(row.triggerWalletCount)),
    walletType: Math.round(num(row.walletType)),
    soldRatioPercent: num(row.soldRatioPercent),
    raw,
  };
}

function reject(candidate: OkxSignalCandidate | null, reason: string): void {
  candidatesFiltered++;
  const row = {
    at: Date.now(),
    mint: candidate?.mint,
    name: candidate?.name,
    reason,
  };
  recentRejections.push(row);
  while (recentRejections.length > RECENT_REJECTION_CAP) recentRejections.shift();
  if (candidate) {
    recordAlertEvent({
      at: Date.now(),
      mint: candidate.mint,
      name: candidate.name,
      score: 0,
      age_mins: Math.max(0, Math.floor((Date.now() - candidate.timestamp) / 60_000)),
      liquidity: 0,
      action: "filtered",
      reason: `OKX: ${reason}`,
    });
  }
}

function candidateToAlert(candidate: OkxSignalCandidate): SignalAlert {
  const ageMins = Math.max(0, Math.floor((Date.now() - candidate.timestamp) / 60_000));
  const score = Math.max(0, Math.min(100,
    50 + candidate.triggerWalletCount * 5 + Math.min(candidate.amountUsd / 1000, 25) - Math.min(candidate.soldRatioPercent / 2, 30),
  ));
  return {
    mint: candidate.mint,
    name: candidate.symbol ? `${candidate.name} (${candidate.symbol})` : candidate.name,
    source: "okx",
    sourceMeta: {
      walletType: candidate.walletType,
      triggerWalletCount: candidate.triggerWalletCount,
      amountUsd: candidate.amountUsd,
      soldRatioPercent: candidate.soldRatioPercent,
      sourceKey: candidate.sourceKey,
    },
    logo: candidate.logo,
    score,
    alert_time: candidate.timestamp,
    alert_mcap: candidate.marketCapUsd,
    current_mcap: candidate.marketCapUsd,
    return_pct: 0,
    max_return_pct: 0,
    max_mcap: candidate.marketCapUsd,
    age_mins: ageMins,
    holders: candidate.holders,
    bs_ratio: 0,
    bot_degen_pct: 0,
    holder_growth_pct: 0,
    liquidity: 0,
    bundler_pct: 0,
    top10_pct: candidate.top10HolderPercent,
    kol_count: candidate.walletType === 2 ? candidate.triggerWalletCount : 0,
    signal_count: candidate.triggerWalletCount,
    degen_call_count: 0,
    rug_ratio: 0,
    twitter_followers: 0,
    liq_trend: "unknown",
    completed: false,
  };
}

async function seedFromSignalList(): Promise<void> {
  if (seeded) return;
  const limit = getRuntimeSettings().signals.okx.seedLimit;
  if (limit <= 0) {
    seeded = true;
    return;
  }
  let cursor: string | undefined;
  let loaded = 0;
  try {
    while (loaded < limit) {
      const pageLimit = Math.min(100, limit - loaded);
      const args = ["signal", "list", "--chain", CHAIN, "--limit", String(pageLimit)];
      if (cursor) args.push("--cursor", cursor);
      const rows = await runCli<SignalListRow[]>(args);
      if (!rows || rows.length === 0) break;
      for (const row of rows) {
        const candidate = normalizeCandidate(row);
        if (candidate) remember(candidate.sourceKey);
      }
      loaded += rows.length;
      cursor = rows[rows.length - 1]?.cursor;
      if (!cursor || rows.length < pageLimit) break;
    }
    seeded = true;
    logger.info({ loaded }, "[okx-source] seeded historical signal dedupe");
  } catch (err) {
    lastError = (err as Error).message;
    logger.warn({ err: lastError }, "[okx-source] seed failed");
  }
}

async function startSession(): Promise<void> {
  if (sessionId || starting || stopping || !isModeEnabled()) return;
  starting = true;
  try {
    const data = await runCli<unknown>([
      "ws", "start",
      "--chain", CHAIN,
      "--channel", CHANNEL,
      "--chain-index", CHAIN_INDEX,
      "--idle-timeout", "30m",
    ]);
    sessionId = extractSessionId(data);
    if (!sessionId) throw new Error("onchainos ws start did not return a session id");
    lastError = undefined;
    logger.info({ sessionId }, "[okx-source] WSS session started");
  } catch (err) {
    lastError = (err as Error).message;
    logger.warn({ err: lastError }, "[okx-source] WSS start failed");
  } finally {
    starting = false;
  }
}

async function handleCandidate(candidate: OkxSignalCandidate): Promise<void> {
  const mode = currentMode();
  candidatesSeen++;
  lastCandidate = candidate;

  if (seen.has(candidate.sourceKey)) {
    reject(candidate, "duplicate signal");
    return;
  }
  remember(candidate.sourceKey);

  if (mode === "okx_watch") {
    reject(candidate, "watch mode");
    return;
  }
  if (!isLiveMode(mode)) {
    reject(candidate, "OKX source disabled");
    return;
  }
  if (isPaused()) {
    reject(candidate, "bot paused");
    return;
  }
  if (isBlacklisted(candidate.mint)) {
    reject(candidate, "blacklisted");
    return;
  }
  const filterReason = candidateFilterRejection(candidate);
  if (filterReason) {
    reject(candidate, filterReason);
    return;
  }
  const cooldown = checkSignalMintCooldown(candidate.mint, getRuntimeSettings().signals.okx.mintCooldownMins);
  if (!cooldown.ok) {
    reject(candidate, cooldown.reason);
    return;
  }

  const alert = candidateToAlert(candidate);
  markSignalMintAccepted(candidate.mint, "okx");
  candidatesAccepted++;
  recordAlertEvent({
    at: Date.now(),
    mint: alert.mint,
    name: alert.name,
    score: alert.score,
    age_mins: alert.age_mins,
    liquidity: alert.liquidity,
    action: "fired",
  });
  logger.info(
    { mint: candidate.mint, name: candidate.name, walletType: candidate.walletType, wallets: candidate.triggerWalletCount, amountUsd: candidate.amountUsd },
    "[okx-source] firing OKX signal",
  );
  await Promise.resolve(onAcceptedCandidate?.(alert));
}

async function pollOnce(): Promise<void> {
  if (!running || polling || !isModeEnabled()) return;
  polling = true;
  try {
    if (!sessionId) await startSession();
    if (!sessionId) return;

    const data = await runCli<unknown>([
      "ws", "poll",
      "--chain", CHAIN,
      "--id", sessionId,
      "--channel", CHANNEL,
      "--limit", String(EVENT_LIMIT),
    ]);
    lastPollAt = Date.now();
    for (const row of eventRows(data)) {
      const candidate = normalizeCandidate(row);
      if (!candidate) {
        reject(null, "malformed OKX signal");
        continue;
      }
      lastEventAt = Date.now();
      await handleCandidate(candidate);
    }
  } catch (err) {
    lastError = (err as Error).message;
    logger.warn({ err: lastError }, "[okx-source] poll failed");
    sessionId = undefined;
  } finally {
    polling = false;
    schedulePoll();
  }
}

function schedulePoll(): void {
  if (!running) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    void pollOnce();
  }, POLL_MS);
  pollTimer.unref?.();
}

export function startOkxSignalSource(options: StartOptions = {}): void {
  onAcceptedCandidate = options.onAcceptedCandidate;
  if (running) return;
  running = true;
  void refreshOkxSignalSource();
}

export async function refreshOkxSignalSource(): Promise<void> {
  if (!running) return;
  const enabled = isModeEnabled();
  if (!enabled) {
    if (sessionId) await stopSession();
    schedulePoll();
    return;
  }
  await seedFromSignalList();
  await startSession();
  schedulePoll();
}

async function stopSession(): Promise<void> {
  if (!sessionId || stopping) return;
  const id = sessionId;
  sessionId = undefined;
  stopping = true;
  try {
    await runCli<unknown>(["ws", "stop", "--chain", CHAIN, "--id", id]);
    logger.info({ sessionId: id }, "[okx-source] WSS session stopped");
  } catch (err) {
    lastError = (err as Error).message;
    logger.warn({ err: lastError, sessionId: id }, "[okx-source] WSS stop failed");
  } finally {
    stopping = false;
  }
}

export async function stopOkxSignalSource(): Promise<void> {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  await stopSession();
}

export function getOkxSignalStatus(): OkxSignalStatus {
  const mode = currentMode();
  const filter = getRuntimeSettings().signals.okx.entryFilter;
  return {
    enabled: isModeEnabled(mode),
    mode,
    liveFilter: {
      minHolders: filter.minHolders,
      walletTypes: [...filter.walletTypes],
    },
    running,
    seeded,
    sessionId,
    lastPollAt,
    lastEventAt,
    lastError,
    candidatesSeen,
    candidatesFiltered,
    candidatesAccepted,
    lastRejectionReason: recentRejections[recentRejections.length - 1]?.reason,
    recentRejections: [...recentRejections],
    lastCandidate,
  };
}
