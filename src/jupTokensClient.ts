/**
 * Jupiter Tokens API v2 — search + enrichment.
 *
 * Endpoint: https://lite-api.jup.ag/tokens/v2/search?query=<mint>
 * Returns an array; we take [0].
 *
 * Used to enrich dashboard rows (positions + alerts) with:
 *   - Jupiter verification status
 *   - organic score (0–100, filters bot/wash trading)
 *   - audit flags (mint/freeze disabled, top holder %, dev migrations/mints)
 *   - holders, mcap, liquidity, recent price change
 *
 * Cached per-mint for 60s to avoid hammering Jupiter when the dashboard polls.
 */

import logger from "./logger.js";

const BASE_URL = "https://lite-api.jup.ag/tokens/v2/search";
const TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

export type TokenInfo = {
  mint: string;
  name: string;
  symbol: string;
  verified: boolean;
  organicScore: number;              // 0–100
  organicScoreLabel: "low" | "medium" | "high" | string;
  holderCount: number;
  mcapUsd: number;
  liquidityUsd: number;
  priceUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange24h: number;
  numBuys1h: number;
  numSells1h: number;
  numTraders1h: number;
  buyVolume1h: number;
  sellVolume1h: number;
  buyOrganicVolume1h: number;
  numOrganicBuyers1h: number;
  audit: {
    mintAuthorityDisabled: boolean;
    freezeAuthorityDisabled: boolean;
    topHoldersPercentage: number;
    devMigrations: number;
    devMints: number;
    isSus?: boolean;
  };
  tags: string[];
  launchpad: string;
  icon: string;
  fetchedAt: number;
};

type CacheEntry = { at: number; value: TokenInfo | null };
const cache = new Map<string, CacheEntry>();

type JupRawStats = {
  priceChange?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
};

type JupRawToken = {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
  verification?: string;
  organicScore?: number;
  organicScoreLabel?: string;
  holderCount?: number;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  usdPrice?: number;
  stats5m?: JupRawStats;
  stats1h?: JupRawStats;
  stats24h?: JupRawStats;
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devMigrations?: number;
    devMints?: number;
    isSus?: boolean;
  };
  tags?: string[];
  launchpad?: string;
};

function normalize(raw: JupRawToken): TokenInfo {
  const s5 = raw.stats5m ?? {};
  const s1h = raw.stats1h ?? {};
  const s24h = raw.stats24h ?? {};
  const audit = raw.audit ?? {};
  return {
    mint: raw.id,
    name: raw.name ?? "",
    symbol: raw.symbol ?? "",
    verified: raw.verification === "verified",
    organicScore: Number(raw.organicScore ?? 0),
    organicScoreLabel: raw.organicScoreLabel ?? "low",
    holderCount: Number(raw.holderCount ?? 0),
    mcapUsd: Number(raw.mcap ?? raw.fdv ?? 0),
    liquidityUsd: Number(raw.liquidity ?? 0),
    priceUsd: Number(raw.usdPrice ?? 0),
    priceChange5m: Number(s5.priceChange ?? 0),
    priceChange1h: Number(s1h.priceChange ?? 0),
    priceChange24h: Number(s24h.priceChange ?? 0),
    numBuys1h: Number(s1h.numBuys ?? 0),
    numSells1h: Number(s1h.numSells ?? 0),
    numTraders1h: Number(s1h.numTraders ?? 0),
    buyVolume1h: Number(s1h.buyVolume ?? 0),
    sellVolume1h: Number(s1h.sellVolume ?? 0),
    buyOrganicVolume1h: Number(s1h.buyOrganicVolume ?? 0),
    numOrganicBuyers1h: Number(s1h.numOrganicBuyers ?? 0),
    audit: {
      mintAuthorityDisabled: Boolean(audit.mintAuthorityDisabled),
      freezeAuthorityDisabled: Boolean(audit.freezeAuthorityDisabled),
      topHoldersPercentage: Number(audit.topHoldersPercentage ?? 0),
      devMigrations: Number(audit.devMigrations ?? 0),
      devMints: Number(audit.devMints ?? 0),
      isSus: audit.isSus,
    },
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    launchpad: raw.launchpad ?? "",
    icon: raw.icon ?? "",
    fetchedAt: Date.now(),
  };
}

export async function getTokenInfo(mint: string): Promise<TokenInfo | null> {
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}?query=${encodeURIComponent(mint)}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.debug({ mint, status: res.status }, "[jupTokens] non-OK");
      cache.set(mint, { at: Date.now(), value: null });
      return null;
    }
    const json = (await res.json()) as JupRawToken[];
    const row = Array.isArray(json) ? json.find((t) => t.id === mint) ?? json[0] : null;
    if (!row?.id) {
      cache.set(mint, { at: Date.now(), value: null });
      return null;
    }
    const info = normalize(row);
    cache.set(mint, { at: Date.now(), value: info });
    return info;
  } catch (err) {
    logger.debug({ mint, err: (err as Error).message }, "[jupTokens] fetch failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Parallel batch helper — preserves order.
export async function getTokenInfos(mints: string[]): Promise<Map<string, TokenInfo>> {
  const out = new Map<string, TokenInfo>();
  const unique = Array.from(new Set(mints));
  const results = await Promise.all(unique.map((m) => getTokenInfo(m).catch(() => null)));
  for (let i = 0; i < unique.length; i++) {
    const info = results[i];
    if (info) out.set(unique[i]!, info);
  }
  return out;
}
