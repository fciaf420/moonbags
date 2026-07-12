import type { Address } from "viem";
import type {
  TradingAdapter,
  BuyOutcome,
  SellSuccess,
  QuoteResult,
} from "./tradingAdapter.js";
import type { SupportedChain } from "./types.js";
import { RobinhoodEvmClient, type RobinhoodEvmClientConfig } from "./robinhoodEvmClient.js";

// ---------------------------------------------------------------------------
// Robinhood Uniswap trading adapter.
//
// Read-only balance/decimals/chain-ID are live (backed by viem RPC).
// Quote, buy, and sell methods throw "not implemented" — these will be
// completed after Task 7 (Uniswap quote spike) validates the API contract.
// ---------------------------------------------------------------------------

const ROBINHOOD_CHAIN_ID = 4663;

export class RobinhoodUniswapAdapter implements TradingAdapter {
  readonly chain: SupportedChain = "robinhood";
  readonly quoteSymbol = "ETH";

  private client: RobinhoodEvmClient;

  constructor(config: RobinhoodEvmClientConfig) {
    this.client = new RobinhoodEvmClient(config);
  }

  async executeBuy(_tokenAddress: string, _quoteAmountRaw: bigint): Promise<BuyOutcome> {
    throw new Error("RobinhoodUniswapAdapter.executeBuy not implemented — waiting for Uniswap quote spike (Task 7)");
  }

  async executeSell(_tokenAddress: string, _tokenAmountRaw: bigint): Promise<SellSuccess | null> {
    throw new Error("RobinhoodUniswapAdapter.executeSell not implemented — waiting for Uniswap quote spike (Task 7)");
  }

  async quoteSell(_tokenAddress: string, _tokenAmountRaw: bigint): Promise<QuoteResult | null> {
    throw new Error("RobinhoodUniswapAdapter.quoteSell not implemented — waiting for Uniswap quote spike (Task 7)");
  }

  async quoteBuy(_tokenAddress: string, _quoteAmountRaw: bigint): Promise<QuoteResult | null> {
    throw new Error("RobinhoodUniswapAdapter.quoteBuy not implemented — waiting for Uniswap quote spike (Task 7)");
  }

  async getBalance(tokenAddress?: string): Promise<bigint | null> {
    try {
      if (!tokenAddress) {
        return await this.client.getEthBalance();
      }
      return await this.client.getErc20Balance(tokenAddress as Address);
    } catch {
      return null;
    }
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    return this.client.getErc20Decimals(tokenAddress as Address);
  }

  async getChainId(): Promise<number> {
    return this.client.getChainId();
  }

  isLive(): boolean {
    // Live mode requires explicit config; default to false.
    return false;
  }
}

/** Factory: create a Robinhood adapter from env-configurable RPC + wallet. */
export function createRobinhoodAdapter(config: {
  rpcUrl: string;
  walletAddress: Address;
}): RobinhoodUniswapAdapter {
  return new RobinhoodUniswapAdapter(config);
}

/** Validate the adapter's chain ID is the expected Robinhood chain. */
export async function validateRobinhoodChain(
  adapter: RobinhoodUniswapAdapter,
): Promise<boolean> {
  try {
    const id = await adapter.getChainId();
    return id === ROBINHOOD_CHAIN_ID;
  } catch {
    return false;
  }
}
