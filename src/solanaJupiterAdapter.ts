import type {
  TradingAdapter,
  BuyOutcome,
  SellSuccess,
  QuoteResult,
} from "./tradingAdapter.js";
import type { SupportedChain } from "./types.js";
import { CONFIG, SOL_MINT } from "./config.js";
import {
  buyTokenWithSol,
  sellTokenForSol,
  getWalletTokenBalance,
  getWalletSolBalance,
  getTokenDecimals,
  quoteTokenToSol,
  getOrder,
} from "./jupClient.js";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Solana Jupiter trading adapter.
//
// Wraps existing jupClient.ts functions behind the chain-neutral
// TradingAdapter interface. Does NOT rewrite jupClient.ts internals.
// ---------------------------------------------------------------------------

export class SolanaJupiterAdapter implements TradingAdapter {
  readonly chain: SupportedChain = "solana";
  readonly quoteSymbol = "SOL";

  async executeBuy(tokenAddress: string, quoteAmountRaw: bigint): Promise<BuyOutcome> {
    const result = await buyTokenWithSol(tokenAddress, quoteAmountRaw);
    if ("error" in result) {
      return { error: result.error };
    }
    return {
      signature: result.signature,
      tokensReceivedRaw: result.tokensReceivedRaw,
      tokenDecimals: result.tokenDecimals,
    };
  }

  async executeSell(tokenAddress: string, tokenAmountRaw: bigint): Promise<SellSuccess | null> {
    const result = await sellTokenForSol(tokenAddress, tokenAmountRaw);
    if (!result) return null;
    return {
      signature: result.signature,
      quoteReceived: result.solReceivedLamports,
    };
  }

  async quoteSell(tokenAddress: string, tokenAmountRaw: bigint): Promise<QuoteResult | null> {
    const result = await quoteTokenToSol(tokenAddress, tokenAmountRaw);
    if (!result) return null;
    return {
      quoteReceived: result.outSolLamports,
      priceImpactPct: result.priceImpactPct,
    };
  }

  async quoteBuy(tokenAddress: string, quoteAmountRaw: bigint): Promise<QuoteResult | null> {
    try {
      const order = await getOrder({
        inputMint: SOL_MINT,
        outputMint: tokenAddress,
        amountRaw: quoteAmountRaw,
        taker: "11111111111111111111111111111111",
      });
      return {
        quoteReceived: BigInt(order.outAmount),
        priceImpactPct: Number(order.priceImpactPct ?? 0),
      };
    } catch (err) {
      logger.debug({ tokenAddress, err: (err as Error).message }, "SolanaJupiterAdapter.quoteBuy error");
      return null;
    }
  }

  async getBalance(tokenAddress?: string): Promise<bigint | null> {
    if (!tokenAddress) {
      const sol = await getWalletSolBalance();
      if (sol === null) return null;
      return BigInt(Math.floor(sol * 1e9));
    }
    return getWalletTokenBalance(tokenAddress);
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    return getTokenDecimals(tokenAddress);
  }

  async getChainId(): Promise<number> {
    // Solana doesn't have an EVM-style chain ID. Return 0 as a sentinel.
    return 0;
  }

  isLive(): boolean {
    return !CONFIG.DRY_RUN;
  }
}

/** Singleton adapter instance for the Solana chain. */
let _solanaAdapter: SolanaJupiterAdapter | undefined;

export function getSolanaAdapter(): SolanaJupiterAdapter {
  if (!_solanaAdapter) {
    _solanaAdapter = new SolanaJupiterAdapter();
  }
  return _solanaAdapter;
}
