import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "./config.js";
import logger from "./logger.js";
import { getRuntimeSettings } from "./settingsStore.js";

const execFileAsync = promisify(execFile);

const CHAIN = "solana";
const SOLANA_CHAIN_INDEX = 501;
const CLI_TIMEOUT_MS = 12_000;
const EVENT_LIMIT = 50;
const STALE_SESSION_MS = 90_000;
const MAX_RECENT_EVENTS = 120;
const DEFAULT_CHANNELS = ["price-info", "trades", "dex-token-candle1m"];

export type OkxWsOverlay = {
  mint: string;
  sessionId?: string;
  active: boolean;
  latestPriceInfo?: unknown;
  recentTrades: unknown[];
  recentCandles1m: unknown[];
  lastEventAt?: number;
  lastPollAt?: number;
  errorCount: number;
  lastError?: string;
};

export type OkxWsStatus = {
  enabled: boolean;
  running: boolean;
  fallback: boolean;
  watchedMints: number;
  activeSessions: number;
  lastEventAt?: number;
  lastPollAt?: number;
  lastError?: string;
  disabledReason?: string;
  sessions: Array<{
    mint: string;
    sessionId?: string;
    active: boolean;
    lastEventAt?: number;
    lastPollAt?: number;
    errorCount: number;
    lastError?: string;
  }>;
};

type ServiceOptions = {
  onMintEvent?: (mint: string) => void | Promise<void>;
};

type WatchState = {
  mint: string;
  sessionId?: string;
  starting?: boolean;
  stopping?: boolean;
  latestPriceInfo?: unknown;
  recentTrades: unknown[];
  recentCandles1m: unknown[];
  lastEventAt?: number;
  lastPollAt?: number;
  lastTriggerAt?: number;
  errorCount: number;
  lastError?: string;
  backoffUntil?: number;
};

type NormalizedEvent = {
  channel?: string;
  at: number;
  payload: unknown;
};

const watches = new Map<string, WatchState>();

let running = false;
let fallback = false;
let disabledReason: string | undefined;
let lastError: string | undefined;
let lastEventAt: number | undefined;
let lastPollAt: number | undefined;
let pollTimer: NodeJS.Timeout | null = null;
let onMintEvent: ServiceOptions["onMintEvent"];
let polling = false;

function configured(): { enabled: boolean; pollMs: number; triggerTickMs: number; channels: string[] } {
  const wss = getRuntimeSettings().marketData.wss;
  const channels = wss.channels.length > 0 ? wss.channels : DEFAULT_CHANNELS;
  return {
    enabled: Boolean(CONFIG.OKX_WSS_ENABLED && wss.enabled),
    pollMs: Math.max(500, wss.pollMs || 1000),
    triggerTickMs: Math.max(250, wss.triggerTickMs || 1000),
    channels,
  };
}

function onchainosEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.OKX_PASSPHRASE && env.OKX_API_PASSPHRASE) {
    env.OKX_PASSPHRASE = env.OKX_API_PASSPHRASE;
  }
  return env;
}

async function runWsCli<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await execFileAsync("onchainos", args, {
      timeout: CLI_TIMEOUT_MS,
      env: onchainosEnv(),
    });
    const parsed = JSON.parse(String(stdout || "{}")) as { ok?: boolean; data?: T; error?: unknown; msg?: unknown };
    if (parsed.ok === false) {
      throw new Error(String(parsed.error ?? parsed.msg ?? "onchainos ws response not-ok"));
    }
    return parsed.data ?? (parsed as T);
  } catch (err) {
    const e = err as Error & { code?: string | number; stdout?: unknown; stderr?: unknown };
    const detail = [
      e.message,
      e.stderr ? String(e.stderr).slice(0, 240) : "",
      e.stdout ? String(e.stdout).slice(0, 240) : "",
    ].filter(Boolean).join(" | ");
    if (e.code === "ENOENT") {
      fallback = true;
      disabledReason = "onchainos CLI not found";
    }
    throw new Error(detail || String(err));
  }
}

function extractSessionId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of ["id", "sessionId", "session_id", "wsSessionId"]) {
    const found = rec[key];
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  for (const child of Object.values(rec)) {
    const nested = extractSessionId(child);
    if (nested) return nested;
  }
  return undefined;
}

function normalizeEvents(raw: unknown, fallbackChannel?: string): NormalizedEvent[] {
  const source = unwrapEventArray(raw);
  const now = Date.now();
  return source.map((payload) => {
    const rec = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const channel =
      typeof rec.channel === "string" ? rec.channel :
      typeof rec.arg === "object" && rec.arg && typeof (rec.arg as Record<string, unknown>).channel === "string"
        ? String((rec.arg as Record<string, unknown>).channel)
        : fallbackChannel;
    const ts = Number(rec.ts ?? rec.time ?? rec.tradeTime ?? rec.createdAt ?? rec.updatedAt);
    return {
      channel,
      at: Number.isFinite(ts) && ts > 0 ? (ts < 1_000_000_000_000 ? ts * 1000 : ts) : now,
      payload,
    };
  });
}

function unwrapEventArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  for (const key of ["events", "items", "messages", "data", "result"]) {
    const value = rec[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function appendLimited(target: unknown[], items: unknown[]): void {
  target.push(...items);
  if (target.length > MAX_RECENT_EVENTS) {
    target.splice(0, target.length - MAX_RECENT_EVENTS);
  }
}

function isTradeChannel(channel?: string): boolean {
  return channel === "trades" || channel?.includes("trade") === true;
}

function isCandleChannel(channel?: string): boolean {
  return channel?.includes("candle") === true || channel?.includes("kline") === true;
}

function isPriceInfoChannel(channel?: string): boolean {
  return channel === "price-info" || channel?.includes("price") === true;
}

async function startSession(state: WatchState): Promise<void> {
  const cfg = configured();
  if (!running || !cfg.enabled || state.sessionId || state.starting || state.stopping) return;
  if (state.backoffUntil && Date.now() < state.backoffUntil) return;

  state.starting = true;
  try {
    const args = ["ws", "start", "--chain", CHAIN];
    for (const channel of cfg.channels) args.push("--channel", channel);
    args.push("--token-pair", `${SOLANA_CHAIN_INDEX}:${state.mint}`);

    const data = await runWsCli<unknown>(args);
    const sessionId = extractSessionId(data);
    if (!sessionId) throw new Error("onchainos ws start did not return a session id");

    state.sessionId = sessionId;
    state.lastError = undefined;
    state.errorCount = 0;
    fallback = false;
    disabledReason = undefined;
    logger.info({ mint: state.mint, sessionId, channels: cfg.channels }, "[okx-wss] session started");
  } catch (err) {
    const msg = (err as Error).message;
    state.errorCount++;
    state.lastError = msg;
    state.backoffUntil = Date.now() + Math.min(60_000, 2_000 * state.errorCount);
    lastError = msg;
    logger.warn({ mint: state.mint, err: msg }, "[okx-wss] session start failed");
  } finally {
    state.starting = false;
  }
}

async function pollSession(state: WatchState): Promise<void> {
  if (!state.sessionId) {
    await startSession(state);
    return;
  }

  const cfg = configured();
  let sawEvents = false;
  try {
    for (const channel of cfg.channels) {
      const data = await runWsCli<unknown>([
        "ws", "poll",
        "--chain", CHAIN,
        "--id", state.sessionId,
        "--channel", channel,
        "--limit", String(EVENT_LIMIT),
      ]);
      state.lastPollAt = Date.now();
      lastPollAt = state.lastPollAt;
      const events = normalizeEvents(data, channel);
      if (events.length === 0) continue;
      sawEvents = true;

      for (const event of events) {
        const eventChannel = event.channel ?? channel;
        if (isPriceInfoChannel(eventChannel)) state.latestPriceInfo = event.payload;
        else if (isCandleChannel(eventChannel)) appendLimited(state.recentCandles1m, [event.payload]);
        else if (isTradeChannel(eventChannel)) appendLimited(state.recentTrades, [event.payload]);
        else appendLimited(state.recentTrades, [event.payload]);
        state.lastEventAt = Math.max(state.lastEventAt ?? 0, event.at);
        lastEventAt = Math.max(lastEventAt ?? 0, event.at);
      }
    }
    state.errorCount = 0;
    state.lastError = undefined;
    if (sawEvents) maybeTriggerTick(state);
  } catch (err) {
    const msg = (err as Error).message;
    state.errorCount++;
    state.lastError = msg;
    lastError = msg;
    logger.warn({ mint: state.mint, sessionId: state.sessionId, err: msg }, "[okx-wss] poll failed");
    if (state.errorCount >= 3) {
      state.sessionId = undefined;
      state.backoffUntil = Date.now() + Math.min(60_000, 2_000 * state.errorCount);
    }
  }
}

function maybeTriggerTick(state: WatchState): void {
  const cb = onMintEvent;
  if (!cb) return;
  const { triggerTickMs } = configured();
  if (state.lastTriggerAt && Date.now() - state.lastTriggerAt < triggerTickMs) return;
  state.lastTriggerAt = Date.now();
  Promise.resolve(cb(state.mint)).catch((err) => {
    logger.warn({ mint: state.mint, err: String(err) }, "[okx-wss] onMintEvent failed");
  });
}

async function pollAll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const cfg = configured();
    if (!cfg.enabled) return;
    await Promise.all(Array.from(watches.values()).map(async (state) => {
      if (state.sessionId && state.lastPollAt && Date.now() - state.lastPollAt > STALE_SESSION_MS) {
        const staleSessionId = state.sessionId;
        logger.warn({ mint: state.mint, sessionId: staleSessionId }, "[okx-wss] session stale, restarting");
        state.sessionId = undefined;
        runWsCli<unknown>(["ws", "stop", "--chain", CHAIN, "--id", staleSessionId]).catch((err) => {
          logger.warn({ mint: state.mint, sessionId: staleSessionId, err: (err as Error).message }, "[okx-wss] stale stop failed");
        });
      }
      await pollSession(state);
    }));
  } finally {
    polling = false;
    schedulePoll();
  }
}

function schedulePoll(): void {
  if (!running) return;
  if (pollTimer) clearTimeout(pollTimer);
  const { pollMs } = configured();
  pollTimer = setTimeout(() => {
    void pollAll();
  }, pollMs);
  pollTimer.unref?.();
}

export function startOkxWsService(options: ServiceOptions = {}): void {
  onMintEvent = options.onMintEvent;
  if (running) return;
  running = true;
  const cfg = configured();
  if (!cfg.enabled) {
    disabledReason = "disabled by OKX_WSS_ENABLED/settings";
    logger.info("[okx-wss] disabled");
  } else {
    logger.info({ pollMs: cfg.pollMs, channels: cfg.channels }, "[okx-wss] service started");
  }
  schedulePoll();
}

export async function watchOkxWsMint(mint: string): Promise<void> {
  const cleanMint = mint.trim();
  if (!cleanMint) return;
  let state = watches.get(cleanMint);
  if (!state) {
    state = {
      mint: cleanMint,
      recentTrades: [],
      recentCandles1m: [],
      errorCount: 0,
    };
    watches.set(cleanMint, state);
  }
  await startSession(state);
}

export async function unwatchOkxWsMint(mint: string): Promise<void> {
  const state = watches.get(mint);
  if (!state) return;
  watches.delete(mint);
  if (!state.sessionId || state.stopping) return;
  state.stopping = true;
  try {
    await runWsCli<unknown>(["ws", "stop", "--chain", CHAIN, "--id", state.sessionId]);
    logger.info({ mint, sessionId: state.sessionId }, "[okx-wss] session stopped");
  } catch (err) {
    lastError = (err as Error).message;
    logger.warn({ mint, sessionId: state.sessionId, err: lastError }, "[okx-wss] stop failed");
  }
}

export function getOkxWsOverlay(mint: string): OkxWsOverlay | null {
  const state = watches.get(mint);
  if (!state) return null;
  return {
    mint: state.mint,
    sessionId: state.sessionId,
    active: Boolean(state.sessionId),
    latestPriceInfo: state.latestPriceInfo,
    recentTrades: [...state.recentTrades],
    recentCandles1m: [...state.recentCandles1m],
    lastEventAt: state.lastEventAt,
    lastPollAt: state.lastPollAt,
    errorCount: state.errorCount,
    lastError: state.lastError,
  };
}

export function getOkxWsStatus(): OkxWsStatus {
  const cfg = configured();
  const sessions = Array.from(watches.values()).map((state) => ({
    mint: state.mint,
    sessionId: state.sessionId,
    active: Boolean(state.sessionId),
    lastEventAt: state.lastEventAt,
    lastPollAt: state.lastPollAt,
    errorCount: state.errorCount,
    lastError: state.lastError,
  }));
  return {
    enabled: cfg.enabled,
    running,
    fallback,
    watchedMints: watches.size,
    activeSessions: sessions.filter((session) => session.active).length,
    lastEventAt,
    lastPollAt,
    lastError,
    disabledReason: cfg.enabled ? disabledReason : "disabled by OKX_WSS_ENABLED/settings",
    sessions,
  };
}

export async function stopOkxWsService(): Promise<void> {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  const active = Array.from(watches.values()).filter((state) => state.sessionId);
  await Promise.allSettled(active.map((state) => unwatchOkxWsMint(state.mint)));
}
