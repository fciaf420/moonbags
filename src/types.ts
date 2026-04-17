export interface ScgAlert {
  mint: string;
  name: string;
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

export interface ScgAlertsResponse {
  alerts: ScgAlert[];
}

export type PositionStatus = "opening" | "open" | "closing" | "closed" | "failed";

export interface Position {
  mint: string;
  name: string;
  status: PositionStatus;
  entrySig?: string;
  exitSig?: string;
  entrySolSpent: number;
  tokensHeld: bigint;
  tokenDecimals: number;
  entryPricePerTokenSol: number;
  currentPricePerTokenSol: number;
  peakPricePerTokenSol: number;
  armed: boolean;
  openedAt: number;
  lastTickAt: number;
  exitReason?: "trail" | "stop" | "timeout" | "manual" | "error" | "moonbag_trail" | "moonbag_timeout" | "llm";
  sellFailureCount?: number;
  lastSellAttemptAt?: number;
  moonbagMode?: boolean;
  moonbagPeakPriceSol?: number;
  moonbagStartedAt?: number;
  originalTokensHeld?: bigint;
  // LLM exit advisor state
  dynamicTrailPct?: number;       // when set, overrides CONFIG.TRAIL_PCT for this position
  lastLlmCheckAt?: number;        // throttle: don't ask LLM more than once per LLM_POLL_MS
  llmActiveNotified?: boolean;    // dedupe: only send "LLM watching" once per position
  lastLlmReason?: string;         // surfaced in the SELL Telegram message when LLM triggers exit
  // Milestone notifications: which PnL-% thresholds have already fired (fire-once dedupe)
  milestonesHit?: number[];
  // LLM-managed partial exits — log each time the LLM decides to sell a fraction
  // of the position to lock profit while keeping the rest running.
  partialExits?: Array<{
    at: number;           // timestamp ms
    sellPct: number;      // fraction of then-current tokensHeld that was sold
    entrySol?: number;    // proportional entry basis assigned to the sold piece
    exitSol: number;      // SOL received from this partial sell
    pnlSol?: number;      // net SOL profit/loss from the sold piece
    priceSol: number;     // token price in SOL at time of sell
    reason: string;       // LLM's reason
    sig?: string;         // tx signature
  }>;
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
