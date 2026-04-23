/**
 * Global Jupiter datapi audit gate.
 *
 * Endpoint: https://datapi.jup.ag/v1/assets/search?query=<mint>
 * We extract two per-token quality signals:
 *   - fees               (number; higher = more organic volume)
 *   - organicScoreLabel  ("low" | "medium" | "high" | null)
 *
 * Additionally we hit the Jupiter tokens API to get organic volume ratios:
 *   - organicVolumePct   (buyOrganicVolume1h / buyVolume1h × 100)
 *   - organicBuyersPct   (numOrganicBuyers1h / numTraders1h × 100)
 *
 * These ratios are the strongest signal for bundled-nuke rugs: tokens with
 * <5% organic volume and <2% organic buyers are almost entirely bot-coordinated.
 *
 * Backtest on recent live universes showed:
 *   GMGN trending:  fees ≥ 1 AND score ∈ {medium, high} nearly DOUBLES win rate.
 *   OKX hot-tokens: filter adds no edge, but user accepted fewer fires for
 *                   cross-source consistency.
 *
 * Rules:
 *   - On transient Jup failure (network error or 4xx) we DEFAULT TO PASS — Jup
 *     is not load-bearing here and we don't want outages to block entries.
 *   - 5s timeout, no retries.
 *   - 5-minute in-memory TTL cache per mint to avoid hammering Jup during
 *     burst polls when multiple sources deep-dive the same token.
 */

import logger from "./logger.js";
import { getTokenInfo } from "./jupTokensClient.js";

const BASE_URL = "https://datapi.jup.ag/v1/assets/search";
const TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export type JupAudit = {
  fees: number;
  organicScoreLabel: string;
  organicVolumePct: number | null;  // buyOrganicVolume1h / buyVolume1h × 100
  organicBuyersPct: number | null;  // numOrganicBuyers1h / numTraders1h × 100
};

export type JupGateConfig = {
  enabled: boolean;
  minFees: number;
  allowedScoreLabels: string[];
  minOrganicVolumePct: number;   // 0 = disabled; e.g. 5 = require ≥5% organic buy volume
  minOrganicBuyersPct: number;   // 0 = disabled; e.g. 2 = require ≥2% organic buyers
};

type CacheEntry = { at: number; value: JupAudit | null };
const cache = new Map<string, CacheEntry>();

function pickFirstRow(json: unknown, mint: string): Record<string, unknown> | null {
  if (!json || typeof json !== "object") return null;
  const maybeList = Array.isArray(json)
    ? json
    : Array.isArray((json as Record<string, unknown>).data)
      ? ((json as Record<string, unknown>).data as unknown[])
      : null;
  if (!maybeList) return null;
  const match = maybeList.find(
    (row) =>
      row &&
      typeof row === "object" &&
      ((row as Record<string, unknown>).id === mint || (row as Record<string, unknown>).mint === mint),
  );
  const first = (match ?? maybeList[0]) as Record<string, unknown> | undefined;
  return first && typeof first === "object" ? first : null;
}

export async function fetchJupAudit(mint: string): Promise<JupAudit | null> {
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  // Fetch datapi (fees + score) and tokens API (organic ratios) in parallel.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const [datapiRes, tokenInfo] = await Promise.all([
      fetch(`${BASE_URL}?query=${encodeURIComponent(mint)}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      }),
      getTokenInfo(mint).catch(() => null),
    ]);

    if (!datapiRes.ok) {
      logger.warn({ mint, status: datapiRes.status }, "[jup-gate] non-OK response");
      cache.set(mint, { at: Date.now(), value: null });
      return null;
    }
    const json = (await datapiRes.json()) as unknown;
    const row = pickFirstRow(json, mint);
    if (!row) {
      cache.set(mint, { at: Date.now(), value: null });
      return null;
    }

    const feesRaw = row.fees;
    const labelRaw = row.organicScoreLabel;
    const fees = typeof feesRaw === "number" ? feesRaw : Number(feesRaw ?? 0);
    const organicScoreLabel =
      typeof labelRaw === "string" && labelRaw.trim() ? labelRaw.trim().toLowerCase() : "";

    // Compute organic ratios from tokens API stats (null if data unavailable).
    let organicVolumePct: number | null = null;
    let organicBuyersPct: number | null = null;
    if (tokenInfo) {
      if (tokenInfo.buyVolume1h > 0) {
        organicVolumePct = (tokenInfo.buyOrganicVolume1h / tokenInfo.buyVolume1h) * 100;
      }
      if (tokenInfo.numTraders1h > 0) {
        organicBuyersPct = (tokenInfo.numOrganicBuyers1h / tokenInfo.numTraders1h) * 100;
      }
    }

    const audit: JupAudit = {
      fees: Number.isFinite(fees) ? fees : 0,
      organicScoreLabel,
      organicVolumePct,
      organicBuyersPct,
    };
    cache.set(mint, { at: Date.now(), value: audit });
    return audit;
  } catch (err) {
    logger.warn({ mint, err: (err as Error).message }, "[jup-gate] fetch failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type JupGateResult = { ok: true } | { ok: false; reason: string };

export function passesJupGate(audit: JupAudit | null, cfg: JupGateConfig): JupGateResult {
  if (!cfg.enabled) return { ok: true };
  // Transient Jup failures (network error, 4xx, parse failure) → pass.
  // Jup isn't load-bearing; don't block entries when Jup is down.
  if (audit == null) return { ok: true };

  if (audit.fees < cfg.minFees) {
    return {
      ok: false,
      reason: `jup-gate: fees ${audit.fees.toFixed(2)} < ${cfg.minFees}`,
    };
  }

  const allow = cfg.allowedScoreLabels ?? [];
  if (allow.length > 0) {
    const normalized = audit.organicScoreLabel.toLowerCase();
    const allowLower = allow.map((s) => s.toLowerCase());
    if (!normalized || !allowLower.includes(normalized)) {
      return {
        ok: false,
        reason: `jup-gate: score "${audit.organicScoreLabel || "unknown"}" not in ${allow.join("|")}`,
      };
    }
  }

  // Organic volume ratio — only enforce when data is available and threshold > 0.
  if (cfg.minOrganicVolumePct > 0 && audit.organicVolumePct !== null) {
    if (audit.organicVolumePct < cfg.minOrganicVolumePct) {
      return {
        ok: false,
        reason: `jup-gate: organic vol ${audit.organicVolumePct.toFixed(1)}% < ${cfg.minOrganicVolumePct}%`,
      };
    }
  }

  // Organic buyers ratio — only enforce when data is available and threshold > 0.
  if (cfg.minOrganicBuyersPct > 0 && audit.organicBuyersPct !== null) {
    if (audit.organicBuyersPct < cfg.minOrganicBuyersPct) {
      return {
        ok: false,
        reason: `jup-gate: organic buyers ${audit.organicBuyersPct.toFixed(1)}% < ${cfg.minOrganicBuyersPct}%`,
      };
    }
  }

  return { ok: true };
}

export function formatJupGate(cfg: JupGateConfig): string {
  if (!cfg.enabled) return "disabled";
  const labels = cfg.allowedScoreLabels.length > 0 ? cfg.allowedScoreLabels.join("|") : "any";
  const parts = [`fees ≥ ${cfg.minFees}`, `score ∈ ${labels}`];
  if (cfg.minOrganicVolumePct > 0) parts.push(`orgVol ≥ ${cfg.minOrganicVolumePct}%`);
  if (cfg.minOrganicBuyersPct > 0) parts.push(`orgBuyers ≥ ${cfg.minOrganicBuyersPct}%`);
  return parts.join(" · ");
}
