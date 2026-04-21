/**
 * OKX/onchainos data layer for the LLM exit advisor.
 *
 * Each function wraps one `onchainos` CLI subcommand and returns a clean,
 * normalized shape. All calls are cached with per-endpoint TTLs to avoid
 * hammering the CLI when multiple positions share queries.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "./logger.js";

const execFileAsync = promisify(execFile);

const CHAIN = "solana";
const CLI_TIMEOUT_MS = 12_000;
const CLI_MAX_CONCURRENCY = 3;

let activeCliCalls = 0;
const cliQueue: Array<() => void> = [];

async function withCliSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeCliCalls >= CLI_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => cliQueue.push(resolve));
  }
  activeCliCalls++;
  try {
    return await fn();
  } finally {
    activeCliCalls--;
    cliQueue.shift()?.();
  }
}

// ---------------------------------------------------------------------------
// Tiny TTL cache
// ---------------------------------------------------------------------------
type CacheEntry<T> = { at: number; value: T };
const cache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string, ttlMs: number): T | undefined {
  const e = cache.get(key) as CacheEntry<T> | undefined;
  if (!e) return undefined;
  if (Date.now() - e.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return e.value;
}

function cacheSet<T>(key: string, value: T): void {
  cache.set(key, { at: Date.now(), value });
}

// ---------------------------------------------------------------------------
// Low-level CLI runner
// ---------------------------------------------------------------------------
async function runCli<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await withCliSlot(() =>
      execFileAsync("onchainos", args, {
        timeout: CLI_TIMEOUT_MS,
        env: onchainosEnv(),
      }),
    );
    const json = JSON.parse(stdout) as { ok: boolean; data?: T };
    if (!json.ok) {
      logger.warn({ args: args.join(" ") }, "[okx] response not-ok");
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    logger.warn({ ...describeCliError(err), args: args.join(" ") }, "[okx] cli failed");
    return null;
  }
}

function onchainosEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The onchainos CLI expects OKX_PASSPHRASE. Keep the older
  // OKX_API_PASSPHRASE name working for existing local .env files.
  if (!env.OKX_PASSPHRASE && env.OKX_API_PASSPHRASE) {
    env.OKX_PASSPHRASE = env.OKX_API_PASSPHRASE;
  }
  return env;
}

function describeCliError(err: unknown): Record<string, unknown> {
  const e = err as Error & {
    code?: number | string;
    signal?: string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };
  const stdout = String(e.stdout ?? "");
  const stderr = String(e.stderr ?? "");
  let okxError: unknown;
  try {
    const parsed = JSON.parse(stdout) as { error?: unknown; msg?: unknown; code?: unknown };
    okxError = parsed.error ?? parsed.msg ?? parsed.code;
  } catch {
    okxError = undefined;
  }
  return {
    err: e.message,
    code: e.code,
    signal: e.signal,
    okxError,
    stdout: stdout.slice(0, 500),
    stderr: stderr.slice(0, 500),
  };
}

// ---------------------------------------------------------------------------
// Public types — each is the normalized result of one tool
// ---------------------------------------------------------------------------
export type PriceMomentum = {
  priceUsd: number;
  marketCapUsd: number;
  liquidityUsd: number;
  holders: number;
  athUsd: number;       // session high
  atlUsd: number;       // session low
  pctFromAth: number;   // -50 means we're 50% below ATH
  // Multi-window momentum
  priceChange5m: number;
  priceChange1h: number;
  priceChange4h: number;
  priceChange24h: number;
  volume5m: number;
  volume1h: number;
  volume4h: number;
  volume24h: number;
  txs5m: number;
  txs1h: number;
  txs4h: number;
  txs24h: number;
};

export type TradeRecord = {
  type: "buy" | "sell";
  priceUsd: number;
  volumeSol: number;     // trade size in SOL
  timestamp: number;     // ms
  walletAddress: string;
};

export type TradeWindow = {
  windowMins: number;
  trades: TradeRecord[];
  buys: number;
  sells: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  netFlowSol: number;     // buys - sells in SOL (positive = accumulating)
  uniqueWallets: number;
  uniqueBuyers: number;
  uniqueSellers: number;
};

export type TopHoldersSnapshot = {
  rangeFilter: 1 | 2 | 3;            // top 10, 50, 100
  holdingPercent: number;             // total % held by this group
  averageBuyPriceUsd: number;
  averageSellPriceUsd: number;
  averagePnlUsd: number;
  averageBuyPricePercent: number;     // avg cost as % vs current
  averageSellPricePercent: number;    // avg sell price as % vs current
  trendType: string[];                // ["buy"], ["sell"], etc
  averageHoldingPeriodSecs: number;
};

export type LiquidityPool = {
  pool: string;
  protocolName: string;
  poolAddress: string;
  liquidityUsd: number;
  feePercent: string;
};

export type TokenRisk = {
  tokenTags: string[];                  // devHoldingStatusSellAll, smartMoneyBuy, etc
  riskControlLevel: number;
  bundleHoldingPercent: number;
  top10HoldPercent: number;
  sniperHoldingPercent: number;
  suspiciousHoldingPercent: number;
  lpBurnedPercent: number;
  devHoldingPercent: number;
  devCreateTokenCount: number;
  devLaunchedTokenCount: number;
  devRugPullTokenCount: number;         // <- huge red flag
  snipersTotal: number;
  snipersClearAddressCount: number;     // snipers that already exited
  totalFeeUsd: number;
  createdAt: number;                    // ms
};

export type SignalRecord = {
  walletType: number;                   // 1=Smart Money, 2=KOL, 3=Whale
  triggerWalletCount: number;
  amountUsd: number;
  priceUsd: number;
  soldRatioPercent: number;             // % of position they sold
  timestamp: number;
  marketCapUsd: number;
};

export type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;     // dollar volume in this candle (most useful for LLM)
  confirmed: boolean;    // false = candle still forming
};

// ---------------------------------------------------------------------------
// Tool 1 — full momentum snapshot in one call
// ---------------------------------------------------------------------------
export async function getPriceMomentum(mint: string): Promise<PriceMomentum | null> {
  const key = `momentum:${mint}`;
  const hit = cacheGet<PriceMomentum>(key, 5_000);
  if (hit) return hit;

  type Raw = {
    price: string; marketCap: string; liquidity: string; holders: string;
    maxPrice: string; minPrice: string;
    priceChange5M: string; priceChange1H: string; priceChange4H: string; priceChange24H: string;
    volume5M: string; volume1H: string; volume4H: string; volume24H: string;
    txs5M: string; txs1H: string; txs4H: string; txs24H: string;
  };

  const data = await runCli<Raw[]>(["token", "price-info", "--address", mint, "--chain", CHAIN]);
  const row = data?.[0];
  if (!row) return null;

  const priceUsd = parseFloat(row.price);
  const athUsd = parseFloat(row.maxPrice);

  const out: PriceMomentum = {
    priceUsd,
    marketCapUsd: parseFloat(row.marketCap),
    liquidityUsd: parseFloat(row.liquidity),
    holders: parseInt(row.holders),
    athUsd,
    atlUsd: parseFloat(row.minPrice),
    pctFromAth: athUsd > 0 ? ((priceUsd / athUsd) - 1) * 100 : 0,
    priceChange5m: parseFloat(row.priceChange5M),
    priceChange1h: parseFloat(row.priceChange1H),
    priceChange4h: parseFloat(row.priceChange4H),
    priceChange24h: parseFloat(row.priceChange24H),
    volume5m: parseFloat(row.volume5M),
    volume1h: parseFloat(row.volume1H),
    volume4h: parseFloat(row.volume4H),
    volume24h: parseFloat(row.volume24H),
    txs5m: parseInt(row.txs5M),
    txs1h: parseInt(row.txs1H),
    txs4h: parseInt(row.txs4H),
    txs24h: parseInt(row.txs24H),
  };
  cacheSet(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tool 2 — trades by trader-tag, filtered to a recent time window
// ---------------------------------------------------------------------------
async function getTradesByTag(
  mint: string,
  tagFilter: number,
  withinMins: number,
  limit = 200,
): Promise<TradeWindow> {
  const key = `trades:${mint}:${tagFilter}:${limit}`;
  let raw = cacheGet<unknown[]>(key, 10_000);
  if (!raw) {
    const data = await runCli<unknown[]>([
      "token", "trades",
      "--address", mint,
      "--chain", CHAIN,
      "--limit", String(limit),
      "--tag-filter", String(tagFilter),
    ]);
    if (data) {
      raw = data;
      cacheSet(key, raw);
    } else {
      raw = [];           // process empty for this call but don't cache the failure
    }
  }

  const cutoff = Date.now() - withinMins * 60_000;
  const trades: TradeRecord[] = [];
  const wallets = new Set<string>();
  const buyWallets = new Set<string>();
  const sellWallets = new Set<string>();
  let buys = 0, sells = 0, buyVolumeSol = 0, sellVolumeSol = 0;

  for (const r of raw as Array<{
    type: string; price: string; volume: string; time: string; userAddress: string;
  }>) {
    const ts = Number(r.time);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const t: TradeRecord = {
      type: r.type === "sell" ? "sell" : "buy",
      priceUsd: parseFloat(r.price),
      volumeSol: parseFloat(r.volume),
      timestamp: ts,
      walletAddress: r.userAddress,
    };
    trades.push(t);
    wallets.add(r.userAddress);
    if (t.type === "buy") {
      buys++;
      buyVolumeSol += t.volumeSol;
      buyWallets.add(r.userAddress);
    } else {
      sells++;
      sellVolumeSol += t.volumeSol;
      sellWallets.add(r.userAddress);
    }
  }

  return {
    windowMins: withinMins,
    trades,
    buys, sells,
    buyVolumeSol, sellVolumeSol,
    netFlowSol: buyVolumeSol - sellVolumeSol,
    uniqueWallets: wallets.size,
    uniqueBuyers: buyWallets.size,
    uniqueSellers: sellWallets.size,
  };
}

export const getSmartMoneyTrades = (mint: string, withinMins = 30) =>
  getTradesByTag(mint, 3, withinMins);

export const getBundlerTrades = (mint: string, withinMins = 30) =>
  getTradesByTag(mint, 9, withinMins);

export const getInsiderTrades = (mint: string, withinMins = 30) =>
  getTradesByTag(mint, 6, withinMins);

export const getWhaleTrades = (mint: string, withinMins = 30) =>
  getTradesByTag(mint, 4, withinMins);

export const getKolTrades = (mint: string, withinMins = 30) =>
  getTradesByTag(mint, 1, withinMins);

// Dev/creator activity — the highest-signal exit cue per our heuristic.
// If devHoldingPercent > 0 AND dev sells appear here, that's a strong exit signal.
export const getDevTrades = (mint: string, withinMins = 30) =>
  getTradesByTag(mint, 2, withinMins);

// ---------------------------------------------------------------------------
// Tool 3 — top holders snapshot (avg PnL, trend, holding %)
// ---------------------------------------------------------------------------
export async function getTopHoldersPnl(
  mint: string,
  rangeFilter: 1 | 2 | 3 = 1,
): Promise<TopHoldersSnapshot | null> {
  const key = `holders:${mint}:${rangeFilter}`;
  const hit = cacheGet<TopHoldersSnapshot>(key, 60_000);
  if (hit) return hit;

  type Raw = {
    holdingAmount: string; holdingPercent: string;
    averageBuyPriceUsd: string; averageSellPriceUsd: string;
    averagePnlUsd: string;
    averageBuyPricePercent: string; averageSellPricePercent: string;
    averageHoldingPeriod: string;
    clusterTrendType?: string[];
  };

  const data = await runCli<Raw>([
    "token", "cluster-top-holders",
    "--address", mint, "--chain", CHAIN,
    "--range-filter", String(rangeFilter),
  ]);
  if (!data) return null;

  const out: TopHoldersSnapshot = {
    rangeFilter,
    holdingPercent: parseFloat(data.holdingPercent) * 100, // returned as 0-1, normalize to %
    averageBuyPriceUsd: parseFloat(data.averageBuyPriceUsd),
    averageSellPriceUsd: parseFloat(data.averageSellPriceUsd),
    averagePnlUsd: parseFloat(data.averagePnlUsd),
    averageBuyPricePercent: parseFloat(data.averageBuyPricePercent) * 100,
    averageSellPricePercent: parseFloat(data.averageSellPricePercent) * 100,
    trendType: data.clusterTrendType ?? [],
    averageHoldingPeriodSecs: parseInt(data.averageHoldingPeriod) || 0,
  };
  cacheSet(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tool 4 — liquidity pools (track LP draining)
// ---------------------------------------------------------------------------
export async function getLiquidityPools(mint: string): Promise<LiquidityPool[]> {
  const key = `liquidity:${mint}`;
  const hit = cacheGet<LiquidityPool[]>(key, 30_000);
  if (hit) return hit;

  type Raw = {
    pool: string; protocolName: string; poolAddress: string;
    liquidityUsd: string; liquidityProviderFeePercent: string;
  };
  const data = await runCli<Raw[]>(["token", "liquidity", "--address", mint, "--chain", CHAIN]);
  const out: LiquidityPool[] = (data ?? []).map(p => ({
    pool: p.pool,
    protocolName: p.protocolName,
    poolAddress: p.poolAddress,
    liquidityUsd: parseFloat(p.liquidityUsd),
    feePercent: p.liquidityProviderFeePercent,
  }));
  cacheSet(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tool 5 — token risk profile (tags, dev stats, concentration)
// ---------------------------------------------------------------------------
export async function getTokenRisk(mint: string): Promise<TokenRisk | null> {
  const key = `risk:${mint}`;
  const hit = cacheGet<TokenRisk>(key, 120_000);
  if (hit) return hit;

  type Raw = {
    tokenTags?: string[];
    riskControlLevel?: string;
    bundleHoldingPercent?: string;
    top10HoldPercent?: string;
    sniperHoldingPercent?: string;
    suspiciousHoldingPercent?: string;
    lpBurnedPercent?: string;
    devHoldingPercent?: string;
    devCreateTokenCount?: string;
    devLaunchedTokenCount?: string;
    devRugPullTokenCount?: string;
    snipersTotal?: string;
    snipersClearAddressCount?: string;
    totalFee?: string;
    createTime?: string;
  };

  const data = await runCli<Raw>(["token", "advanced-info", "--address", mint, "--chain", CHAIN]);
  if (!data) return null;

  const num = (v: string | undefined): number => {
    if (v == null || v === "") return 0;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  const out: TokenRisk = {
    tokenTags: data.tokenTags ?? [],
    riskControlLevel: num(data.riskControlLevel),
    bundleHoldingPercent: num(data.bundleHoldingPercent),
    top10HoldPercent: num(data.top10HoldPercent),
    sniperHoldingPercent: num(data.sniperHoldingPercent),
    suspiciousHoldingPercent: num(data.suspiciousHoldingPercent),
    lpBurnedPercent: num(data.lpBurnedPercent),
    devHoldingPercent: num(data.devHoldingPercent),
    devCreateTokenCount: num(data.devCreateTokenCount),
    devLaunchedTokenCount: num(data.devLaunchedTokenCount),
    devRugPullTokenCount: num(data.devRugPullTokenCount),
    snipersTotal: num(data.snipersTotal),
    snipersClearAddressCount: num(data.snipersClearAddressCount),
    totalFeeUsd: num(data.totalFee),
    createdAt: num(data.createTime),
  };
  cacheSet(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tool 6 — recent smart money / KOL / whale signals scoped to this token
// ---------------------------------------------------------------------------
export async function getRecentSignals(
  mint: string,
  withinMins = 60,
): Promise<SignalRecord[]> {
  const key = `signals:${mint}`;
  let raw = cacheGet<unknown[]>(key, 30_000);
  if (!raw) {
    const data = await runCli<unknown[]>([
      "signal", "list",
      "--chain", CHAIN,
      "--token-address", mint,
    ]);
    if (data) {
      raw = data;
      cacheSet(key, raw);
    } else {
      raw = [];           // process empty for this call but don't cache the failure
    }
  }

  const cutoff = Date.now() - withinMins * 60_000;
  const out: SignalRecord[] = [];
  for (const r of raw as Array<{
    walletType: string; triggerWalletCount: string;
    amountUsd: string; price: string; soldRatioPercent: string;
    timestamp: string; token?: { marketCapUsd: string };
  }>) {
    const ts = Number(r.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    out.push({
      walletType: parseInt(r.walletType) || 0,
      triggerWalletCount: parseInt(r.triggerWalletCount) || 0,
      amountUsd: parseFloat(r.amountUsd) || 0,
      priceUsd: parseFloat(r.price) || 0,
      soldRatioPercent: parseFloat(r.soldRatioPercent) || 0,
      timestamp: ts,
      marketCapUsd: parseFloat(r.token?.marketCapUsd ?? "0") || 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool 7 — kline / candlestick data (chart pattern reading)
// ---------------------------------------------------------------------------
export async function getKline(
  mint: string,
  bar: "1m" | "5m" | "15m" | "1H" | "4H" | "1D" = "1m",
  limit = 60,
): Promise<Candle[]> {
  const key = `kline:${mint}:${bar}:${limit}`;
  const ttl = bar === "1m" ? 5_000 : bar === "5m" ? 15_000 : 60_000;
  const hit = cacheGet<Candle[]>(key, ttl);
  if (hit) return hit;

  type Raw = { ts: string; o: string; h: string; l: string; c: string; vol?: string; volUsd?: string; confirm?: string };
  const data = await runCli<Raw[]>([
    "market", "kline",
    "--address", mint,
    "--chain", CHAIN,
    "--bar", bar,
    "--limit", String(limit),
  ]);

  const out: Candle[] = (data ?? [])
    .map(c => ({
      ts: Number(c.ts),
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      // Only trust volUsd. If missing, set 0 — never silently use raw token units as if they were USD.
      volumeUsd: c.volUsd ? parseFloat(c.volUsd) : 0,
      confirmed: c.confirm === "1",
    }))
    .filter(c => Number.isFinite(c.ts) && c.open > 0)
    .sort((a, b) => a.ts - b.ts);
  cacheSet(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tool 8 — full position snapshot in parallel (one call gives the LLM
// everything it needs to make an exit decision)
// ---------------------------------------------------------------------------
export type PositionSnapshot = {
  mint: string;
  fetchedAt: number;
  momentum:    PriceMomentum   | null;
  smartMoney:  TradeWindow;
  bundlers:    TradeWindow;
  insiders:    TradeWindow;
  whales:      TradeWindow;
  dev:         TradeWindow;
  topHolders:  TopHoldersSnapshot | null;
  liquidity:   LiquidityPool[];
  risk:        TokenRisk | null;
  signals:     SignalRecord[];
  kline1m:     Candle[];   // 60 min of 1m candles (the granular view)
  kline5m:     Candle[];   // 5 hours of 5m candles (broader trend context)
  realtimeOverlay?: unknown; // optional OKX WSS cache merged by positionManager
};

export async function getPositionSnapshot(mint: string, withinMins = 30): Promise<PositionSnapshot> {
  const [
    momentum, smartMoney, bundlers, insiders, whales, dev,
    topHolders, liquidity, risk, signals, kline1m, kline5m,
  ] = await Promise.all([
    getPriceMomentum(mint),
    getSmartMoneyTrades(mint, withinMins),
    getBundlerTrades(mint, withinMins),
    getInsiderTrades(mint, withinMins),
    getWhaleTrades(mint, withinMins),
    getDevTrades(mint, withinMins),
    getTopHoldersPnl(mint, 1),
    getLiquidityPools(mint),
    getTokenRisk(mint),
    getRecentSignals(mint, 60),
    getKline(mint, "1m", 60),     // last hour, candle by candle
    getKline(mint, "5m", 60),     // last 5 hours for trend
  ]);

  return {
    mint, fetchedAt: Date.now(),
    momentum, smartMoney, bundlers, insiders, whales, dev,
    topHolders, liquidity, risk, signals, kline1m, kline5m,
  };
}
