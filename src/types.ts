export type SupportedChain = "solana" | "robinhood";
export type QuoteSymbol = "SOL" | "ETH";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function canonicalPositionKey(chain: SupportedChain, tokenAddress: string): string {
  if (!tokenAddress) throw new Error("token address is required");
  if (chain === "robinhood") {
    if (!EVM_ADDRESS.test(tokenAddress)) throw new Error("invalid Robinhood EVM address");
    return `${chain}:${tokenAddress.toLowerCase()}`;
  }
  return `${chain}:${tokenAddress}`;
}

export function migratePersistedPosition<T extends Record<string, unknown>>(raw: T): T & { chain: SupportedChain; tokenAddress: string; mint: string; quoteSymbol: QuoteSymbol } {
  const chain: SupportedChain = raw.chain === "robinhood" ? "robinhood" : "solana";
  const tokenAddress = String(raw.tokenAddress ?? raw.mint ?? "");
  canonicalPositionKey(chain, tokenAddress);

  // Derive quoteSymbol from chain or explicit field.
  const explicitQuote = raw.quoteSymbol as string | undefined;
  let quoteSymbol: QuoteSymbol;
  if (explicitQuote === "ETH" || explicitQuote === "SOL") {
    quoteSymbol = explicitQuote;
  } else {
    quoteSymbol = chain === "robinhood" ? "ETH" : "SOL";
  }

  return { ...raw, chain, tokenAddress: chain === "robinhood" ? tokenAddress.toLowerCase() : tokenAddress, mint: String(raw.mint ?? tokenAddress), quoteSymbol };
}

export function quoteSymbolForChain(chain: SupportedChain): QuoteSymbol {
  return chain === "robinhood" ? "ETH" : "SOL";
}

export interface SignalAlert {
  chain?: SupportedChain;
  tokenAddress?: string;
  mint: string;
  name: string;
  source?: "private" | "okx" | string;
  sourceMeta?: Record<string, unknown>;
  logo?: string;
  score: number;
  alert_time: number;
  alert_mcap: number;
  current_mcap: number;
  return_pct: number;
  max_return_pct: number;
  max_mcap: number;
  age_mins: number;
  holders: number;
  bs_ratio: number;
  bot_degen_pct: number;
  holder_growth_pct: number;
  liquidity: number;
  bundler_pct: number;
  top10_pct: number;
  kol_count: number;
  signal_count: number;
  degen_call_count: number;
  rug_ratio: number;
  twitter_handle?: string;
  twitter_followers: number;
  liq_trend: "rising" | "falling" | string;
  tracked_prices?: Record<string, { price: number; mcap: number; pct: number }>;
  completed: boolean;
}

export interface SignalMeta {
  alert_mcap: number;
  age_mins: number;
  holders: number;
  bs_ratio: number;
  bundler_pct: number;
  top10_pct: number;
  kol_count: number;
  signal_count: number;
  rug_ratio: number;
  liq_trend: string;
  score: number;
  source?: string;
}

export interface SignalAlertsResponse {
  alerts: SignalAlert[];
}

export type PositionStatus = "opening" | "open" | "closing" | "closed" | "failed";

export interface Position {
  chain?: SupportedChain;
  tokenAddress?: string;
  mint: string;
  name: string;
  status: PositionStatus;
  entrySig?: string;
  exitSig?: string;

  // ---- Quote-neutral accounting (Task 10) ----
  /** Quote asset symbol: "SOL" or "ETH". */
  quoteSymbol: QuoteSymbol;

  /** Amount of quote asset spent on entry (SOL or ETH). */
  entryQuoteSpent: number;

  /** Number of tokens held. */
  tokensHeld: bigint;

  /** Token decimals. */
  tokenDecimals: number;

  /** Token price in quote units at entry. */
  entryQuotePrice: number;

  /** Current token price in quote units. */
  currentQuotePrice: number;

  /** Peak token price in quote units. */
  peakQuotePrice: number;

  /** Buy transaction hash (or Solana signature). */
  buyTxHash?: string;

  /** Exit transaction hash (or Solana signature). */
  exitTxHash?: string;

  /** Cumulative realized PnL in quote units (for dashboard). */
  realizedPnlQuote?: number;

  // ---- Solana compatibility aliases (populated alongside neutral fields) ----
  entrySolSpent: number;
  entryPricePerTokenSol: number;
  currentPricePerTokenSol: number;
  peakPricePerTokenSol: number;

  // ---- Position lifecycle ----
  armed: boolean;
  openedAt: number;
  lastTickAt: number;
  exitReason?: "trail" | "stop" | "timeout" | "take_profit" | "manual" | "error" | "moonbag_trail" | "moonbag_timeout" | "llm";
  sellFailureCount?: number;
  lastSellAttemptAt?: number;
  moonbagMode?: boolean;
  moonbagPeakPriceSol?: number;
  moonbagStartedAt?: number;
  originalTokensHeld?: bigint;
  // LLM exit advisor state
  dynamicTrailPct?: number;
  lastLlmCheckAt?: number;
  llmActiveNotified?: boolean;
  lastLlmAction?: string;
  lastLlmReason?: string;
  llmWatchStartedAt?: number;
  lastLlmHeartbeatAt?: number;
  llmDecisionCount?: number;
  lastLlmDecisionAt?: number;
  // Milestone notifications
  milestonesHit?: number[];
  // TP ladder targets already executed
  tpTargetsHit?: number[];
  // LLM-managed partial exits
  partialExits?: Array<{
    at: number;
    sellPct: number;
    entrySol?: number;
    exitSol: number;
    pnlSol?: number;
    priceSol: number;
    reason: string;
    sig?: string;
  }>;
  signalMeta?: SignalMeta;
}

export interface JupOrderResponse {
  requestId: string;
  transaction: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown;
  [k: string]: unknown;
}

export interface JupExecuteResponse {
  signature?: string;
  status: "Success" | "Failed" | string;
  error?: string;
  [k: string]: unknown;
}
