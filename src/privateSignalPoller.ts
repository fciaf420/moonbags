import { CONFIG } from "./config.js";
import logger from "./logger.js";
import type { SignalAlert, SignalAlertsResponse } from "./types.js";
import { getRuntimeSettings } from "./settingsStore.js";
import { checkSignalMintCooldown, markSignalMintAccepted } from "./sourceDedupe.js";
import { readPrivateSignalAlerts } from "./privateSignalDb.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type AlertHandler = (alert: SignalAlert) => void | Promise<void>;

export type AlertEvent = {
  at: number;
  mint: string;
  name: string;
  score: number;
  age_mins: number;
  liquidity: number;
  action: "fired" | "filtered" | "dedup";
  reason?: string;
};

const DEDUP_CAP = 5000;
const RECENT_CAP = 200;

export function alertKey(a: Pick<SignalAlert, "mint" | "alert_time">): string {
  return `${a.mint}:${a.alert_time}`;
}

// ---------------------------------------------------------------------------
// Poller health — updated from inside startPrivateSignalPoller's tick() so /ping can
// report whether the upstream is reachable and whether the poller is actually
// processing what it receives. Readable via getPollerHealth() / hasSeenAlert().
// ---------------------------------------------------------------------------
let pollerStartedAt = 0;
let lastTickStartedAt = 0;
let lastTickOkAt = 0;
let lastTickError: string | null = null;
let lastHttpStatus: number | null = null;
let lastAlertCount = 0;
let seenRef: Set<string> | null = null;

export type PollerHealth = {
  startedAt: number;
  lastTickStartedAt: number;
  lastTickOkAt: number;
  lastTickError: string | null;
  lastHttpStatus: number | null;
  lastAlertCount: number;
  seenSize: number;
};

export function getPollerHealth(): PollerHealth {
  return {
    startedAt: pollerStartedAt,
    lastTickStartedAt,
    lastTickOkAt,
    lastTickError,
    lastHttpStatus,
    lastAlertCount,
    seenSize: seenRef?.size ?? 0,
  };
}

export function hasSeenAlert(key: string): boolean {
  return seenRef?.has(key) ?? false;
}

const recentEvents: AlertEvent[] = [];

export function recordAlertEvent(e: AlertEvent): void {
  recentEvents.push(e);
  while (recentEvents.length > RECENT_CAP) recentEvents.shift();
}

function recordEvent(e: AlertEvent): void {
  recordAlertEvent(e);
}

export function getRecentAlertEvents(): AlertEvent[] {
  return [...recentEvents];
}

// ---------------------------------------------------------------------------
// Runtime controls — pause/resume + blacklist (used by Telegram /pause /skip)
// ---------------------------------------------------------------------------
let paused = false;
const blacklist = new Set<string>();

const STATE_DIR = path.resolve("state");
const POLLER_STATE_FILE = path.join(STATE_DIR, "poller.json");

type PollerState = { paused: boolean; blacklist: string[] };

let persistTimer: NodeJS.Timeout | null = null;
function persistPollerState(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await mkdir(STATE_DIR, { recursive: true });
      const state: PollerState = { paused, blacklist: [...blacklist] };
      await writeFile(POLLER_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      logger.error({ err: String(err) }, "[privateSignalPoller] persist state failed");
    }
  }, 200);
  persistTimer.unref?.();
}

/**
 * Restore paused flag and blacklist from disk. Should be awaited at boot
 * (called from main.ts) before the poller starts firing alerts so that
 * a restart doesn't silently un-pause the bot.
 */
export async function loadPollerState(): Promise<void> {
  try {
    const raw = await readFile(POLLER_STATE_FILE, "utf8");
    const state = JSON.parse(raw) as PollerState;
    paused = Boolean(state.paused);
    blacklist.clear();
    for (const m of state.blacklist ?? []) blacklist.add(m);
    logger.info({ paused, blacklistCount: blacklist.size }, "[privateSignalPoller] state restored");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      logger.info("[privateSignalPoller] no prior state — starting fresh (not paused, empty blacklist)");
    } else {
      logger.warn({ err: String(err) }, "[privateSignalPoller] state load failed");
    }
  }
}

export function isPaused(): boolean { return paused; }
export function setPaused(v: boolean): void { paused = v; persistPollerState(); }
export function getBlacklist(): string[] { return [...blacklist]; }
export function addToBlacklist(mint: string): void { blacklist.add(mint); persistPollerState(); }
export function removeFromBlacklist(mint: string): void { blacklist.delete(mint); persistPollerState(); }
export function isBlacklisted(mint: string): boolean { return blacklist.has(mint); }

export function startPrivateSignalPoller(onNew: AlertHandler): () => void {
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  let isRunning = false;
  let seeded = false;
  let missingKeyWarned = false;

  pollerStartedAt = Date.now();
  seenRef = seen;

  function remember(key: string): void {
    if (seen.has(key)) return;
    seen.add(key);
    seenOrder.push(key);
    while (seenOrder.length > DEDUP_CAP) {
      const evict = seenOrder.shift();
      if (evict !== undefined) seen.delete(evict);
    }
  }

  function num(value: unknown, fallback = 0): number {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function str(value: unknown, fallback = ""): string {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  }

  function optionalStr(value: unknown): string | undefined {
    const out = str(value);
    return out ? out : undefined;
  }

  function normalizeAlert(raw: unknown): SignalAlert | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const mint = str(rec.mint);
    if (!mint) return null;
    const alertMcap = num(rec.alert_mcap ?? rec.market_cap ?? rec.mcap);
    const currentMcap = num(rec.current_mcap, alertMcap);
    const maxMcap = num(rec.max_mcap, Math.max(alertMcap, currentMcap));
    const score = num(rec.score);
    return {
      mint,
      name: str(rec.name, mint.slice(0, 8)),
      source: "private",
      sourceMeta: {
        is_safe: rec.is_safe,
        is_smart: rec.is_smart,
        scan_raw_at_alert: rec.scan_raw_at_alert,
        raw: rec,
      },
      logo: optionalStr(rec.logo),
      score,
      alert_time: num(rec.alert_time, Math.floor(Date.now() / 1000)),
      alert_mcap: alertMcap,
      current_mcap: currentMcap,
      return_pct: num(rec.return_pct),
      max_return_pct: num(rec.max_return_pct),
      max_mcap: maxMcap,
      age_mins: num(rec.age_mins),
      holders: num(rec.holders),
      bs_ratio: num(rec.bs_ratio),
      bot_degen_pct: num(rec.bot_degen_pct),
      holder_growth_pct: num(rec.holder_growth_pct),
      liquidity: num(rec.liquidity),
      bundler_pct: num(rec.bundler_pct),
      top10_pct: num(rec.top10_pct),
      kol_count: num(rec.kol_count),
      signal_count: num(rec.signal_count, num(rec.kol_count)),
      degen_call_count: num(rec.degen_call_count),
      rug_ratio: num(rec.rug_ratio),
      twitter_handle: optionalStr(rec.twitter_handle),
      twitter_followers: num(rec.twitter_followers),
      liq_trend: str(rec.liq_trend, "unknown"),
      tracked_prices: rec.tracked_prices && typeof rec.tracked_prices === "object"
        ? rec.tracked_prices as SignalAlert["tracked_prices"]
        : undefined,
      completed: rec.completed === true,
    };
  }

  async function fetchAlerts(): Promise<{ alerts: SignalAlert[]; httpStatus: number | null }> {
    if (CONFIG.PRIVATE_SIGNAL_SOURCE === "postgres") {
      const rows = await readPrivateSignalAlerts(250);
      return {
        alerts: rows.map(normalizeAlert).filter((alert): alert is SignalAlert => alert != null),
        httpStatus: null,
      };
    }
    if (!CONFIG.PRIVATE_SIGNAL_API_URL || !CONFIG.PRIVATE_SIGNAL_API_KEY) {
      throw new Error("missing PRIVATE_SIGNAL_API_URL or PRIVATE_SIGNAL_API_KEY");
    }
    const res = await fetch(CONFIG.PRIVATE_SIGNAL_API_URL, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${CONFIG.PRIVATE_SIGNAL_API_KEY}`,
      },
    });
    if (!res.ok) {
      lastHttpStatus = res.status;
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as SignalAlertsResponse;
    return {
      alerts: (Array.isArray(body?.alerts) ? body.alerts : [])
        .map(normalizeAlert)
        .filter((alert): alert is SignalAlert => alert != null),
      httpStatus: res.status,
    };
  }

  async function tick(): Promise<void> {
    if (isRunning) {
      logger.debug("[privateSignalPoller] previous tick still running, skipping");
      return;
    }
    isRunning = true;
    lastTickStartedAt = Date.now();
    try {
      if (CONFIG.PRIVATE_SIGNAL_SOURCE === "off") {
        lastHttpStatus = null;
        lastAlertCount = 0;
        lastTickError = "Private Feed source disabled";
        if (!missingKeyWarned) {
          logger.warn("[privateSignalPoller] Private Feed source disabled");
          missingKeyWarned = true;
        }
        return;
      }
      missingKeyWarned = false;
      logger.debug("[privateSignalPoller] polling");
      const { alerts, httpStatus } = await fetchAlerts();
      lastHttpStatus = httpStatus;
      lastAlertCount = alerts.length;
      lastTickError = null;
      lastTickOkAt = Date.now();

      if (!seeded) {
        for (const a of alerts) remember(alertKey(a));
        seeded = true;
        logger.debug({ count: alerts.length }, "[privateSignalPoller] seeded dedup set on first poll");
        return;
      }

      const fresh: SignalAlert[] = [];
      for (const a of alerts) {
        const k = alertKey(a);
        if (seen.has(k)) continue;
        remember(k);
        const settings = getRuntimeSettings();
        if (settings.signals.sourceMode === "okx_only" || settings.signals.sourceMode === "gmgn_only") {
          recordEvent({
            at: Date.now(),
            mint: a.mint, name: a.name, score: a.score,
            age_mins: a.age_mins, liquidity: a.liquidity,
            action: "filtered", reason: "Private Feed source disabled",
          });
          continue;
        }
        if (paused) {
          recordEvent({
            at: Date.now(),
            mint: a.mint, name: a.name, score: a.score,
            age_mins: a.age_mins, liquidity: a.liquidity,
            action: "filtered", reason: "bot paused",
          });
          continue;
        }
        if (blacklist.has(a.mint)) {
          recordEvent({
            at: Date.now(),
            mint: a.mint, name: a.name, score: a.score,
            age_mins: a.age_mins, liquidity: a.liquidity,
            action: "filtered", reason: "blacklisted",
          });
          continue;
        }
        // Private Feed is pre-filtered upstream — auto-accept any alert that
        // passes pause/blacklist/sourceMode. We do still honor mint cooldown
        // to prevent re-buying the same token if the relay re-emits it under
        // a new alert_time.
        const cooldown = checkSignalMintCooldown(a.mint, settings.signals.okx.mintCooldownMins);
        if (!cooldown.ok) {
          recordEvent({
            at: Date.now(),
            mint: a.mint,
            name: a.name,
            score: a.score,
            age_mins: a.age_mins,
            liquidity: a.liquidity,
            action: "filtered",
            reason: cooldown.reason,
          });
          continue;
        }
        markSignalMintAccepted(a.mint, "private");
        recordEvent({
          at: Date.now(),
          mint: a.mint,
          name: a.name,
          score: a.score,
          age_mins: a.age_mins,
          liquidity: a.liquidity,
          action: "fired",
        });
        fresh.push(a);
      }

      if (fresh.length === 0) return;

      await Promise.all(
        fresh.map((a) => {
          logger.info(
            { mint: a.mint, name: a.name, score: a.score, age_mins: a.age_mins, liquidity: a.liquidity },
            "[privateSignalPoller] firing alert",
          );
          return Promise.resolve()
            .then(() => onNew(a))
            .catch((err) => {
              logger.error({ err, mint: a.mint }, "[privateSignalPoller] handler error");
            });
        }),
      );
    } catch (err) {
      lastTickError = (err as Error)?.message ?? String(err);
      logger.error({ err }, "[privateSignalPoller] poll failed");
    } finally {
      isRunning = false;
    }
  }

  const interval = setInterval(() => {
    void tick();
  }, CONFIG.PRIVATE_SIGNAL_POLL_MS);

  void tick();

  return () => {
    clearInterval(interval);
    logger.info("poller stopped");
  };
}
