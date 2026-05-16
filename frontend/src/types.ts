export type PositionStatus = "opening" | "open" | "closing" | "closed" | "failed";

export type Position = {
  mint: string;
  name: string;
  status: PositionStatus;
  entrySolSpent: number;
  entryPricePerTokenSol: number;
  currentPricePerTokenSol: number;
  peakPricePerTokenSol: number;
  armed: boolean;
  openedAt: number;
  tokensHeld: string;
  originalTokensHeld?: string;
  tokenDecimals: number;
  exitReason?: string;
  moonbagMode?: boolean;
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
};

export type Alert = {
  at: number;
  mint: string;
  name: string;
  score: number;
  age_mins: number;
  liquidity: number;
  action: "fired" | "filtered" | "dedup";
  reason?: string;
};

export type TokenInfo = {
  mint: string;
  name: string;
  symbol: string;
  verified: boolean;
  organicScore: number;
  organicScoreLabel: string;       // "low" | "medium" | "high"
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

export type ClosedTrade = {
  mint: string;
  name: string;
  closedAt: number;
  openedAt: number;
  holdSecs: number;
  entrySol: number;
  exitSol: number;
  pnlSol: number;
  pnlPct: number;
  peakPnlPct: number;
  reason: string;
  llmReason?: string;
  exitSig?: string;
};

export type ExitSettings = {
  profitStrategy: {
    type: "trail" | "fixed_tp" | "tp_ladder" | "llm_managed";
    fixedTargetPct: number;
    ladderTargets: Array<{
      pnlPct: number;
      sellPct: number;
    }>;
    trailRemainder: boolean;
  };
  trail: {
    armPct: number;
    trailPct: number;
  };
  risk: {
    stopPct: number;
    maxHoldSecs: number;
  };
  runner: {
    keepPct: number;
    trailPct: number;
    timeoutSecs: number;
  };
  llm: {
    enabled: boolean;
  };
};

export type State = {
  config: {
    BUY_SIZE_SOL: number;
    ARM_PCT: number;
    TRAIL_PCT: number;
    STOP_PCT: number;
    MAX_HOLD_SECS: number;
    MAX_CONCURRENT_POSITIONS: number;
    SLIPPAGE_BPS: number;
    // SCG_POLL_MS: number; // [SCG Alpha temporarily disabled]
    PRICE_POLL_MS: number;
    DRY_RUN: boolean;
    LLM_EXIT_ENABLED?: boolean;
  };
  exitSettings?: ExitSettings;
  stats: {
    bootAt: number;
    realizedPnlSol: number;
    openCount: number;
    maxConcurrent: number;
    dryRun: boolean;
    now: number;
  };
  positions: Position[];
  alerts: Alert[];
  closedTrades?: ClosedTrade[];
  tokenInfo?: Record<string, TokenInfo>;
  // 1m kline closes (USD) per open position — last ~60 minutes, oldest first.
  // Used to render the real mini price chart on each position card.
  kline1m?: Record<string, number[]>;
  // Telegram bot @username (without the @), fetched server-side via getMe so
  // the dashboard can link "EDIT IN TELEGRAM" to https://t.me/<username>.
  telegramBotUsername?: string | null;
};
