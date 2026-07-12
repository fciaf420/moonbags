import type { SupportedChain } from "./types.js";

// ---------------------------------------------------------------------------
// Chain-neutral trading adapter interface.
//
// Every chain implementation (Solana/Jupiter, Robinhood/Uniswap) must satisfy
// this contract. Position lifecycle logic operates against this interface
// rather than importing chain-specific code directly.
// ---------------------------------------------------------------------------

export interface BuySuccess {
  signature: string;
  tokensReceivedRaw: bigint;
  tokenDecimals: number;
}

export interface BuyError {
  error: string;
}

export type BuyOutcome = BuySuccess | BuyError;

export interface SellSuccess {
  signature: string;
  quoteReceived: bigint; // lamports for Solana, wei for EVM
}

export interface QuoteResult {
  quoteReceived: bigint;
  priceImpactPct: number;
}

export interface TradingAdapter {
  /** Chain this adapter serves. */
  readonly chain: SupportedChain;

  /** Quote symbol (e.g. "SOL", "ETH"). */
  readonly quoteSymbol: string;

  /** Execute a buy: quoteAsset → token. */
  executeBuy(tokenAddress: string, quoteAmountRaw: bigint): Promise<BuyOutcome>;

  /** Execute a sell: token → quoteAsset. */
  executeSell(tokenAddress: string, tokenAmountRaw: bigint): Promise<SellSuccess | null>;

  /** Get a sell quote estimate: tokenAmountRaw → quoteAsset. */
  quoteSell(tokenAddress: string, tokenAmountRaw: bigint): Promise<QuoteResult | null>;

  /** Get a buy quote estimate: quoteAmountRaw → token. */
  quoteBuy(tokenAddress: string, quoteAmountRaw: bigint): Promise<QuoteResult | null>;

  /** Get wallet balance for a token (pass undefined for native balance). */
  getBalance(tokenAddress?: string): Promise<bigint | null>;

  /** Get token decimals. */
  getDecimals(tokenAddress: string): Promise<number>;

  /** Get chain ID (numeric for EVM, sentinel for non-EVM). */
  getChainId(): Promise<number>;

  /** Whether live trading is enabled for this adapter. */
  isLive(): boolean;
}
