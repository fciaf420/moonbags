import type { Address } from "viem";
import type {
  TradingAdapter,
  BuyOutcome,
  SellSuccess,
  QuoteResult,
} from "./tradingAdapter.js";
import type { SupportedChain } from "./types.js";
import { RobinhoodEvmClient, type RobinhoodEvmClientConfig } from "./robinhoodEvmClient.js";
import { CONFIG } from "./config.js";
import logger from "./logger.js";

// ---------------------------------------------------------------------------
// Robinhood Uniswap trading adapter.
//
// Read-only balance/decimals/chain-ID are live (backed by viem RPC).
// Quotes use the official Uniswap Trading API across supported protocols.
// Live execution requires ALL gates to pass (Task 12).
// ---------------------------------------------------------------------------

const ROBINHOOD_CHAIN_ID = 4663;
const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
const UNISWAP_QUOTE_URL = "https://trade-api.gateway.uniswap.org/v1/quote";

export interface RobinhoodUniswapAdapterConfig extends RobinhoodEvmClientConfig {
  apiKey?: string;
  fetcher?: typeof fetch;
}

export interface LiveGateOptions {
  dryRun: boolean;
  liveEnabled: boolean;
  sourceMode: string;
  chainId: number;
  hasPrivKey: boolean;
  ethBalance: number;
  minEthBalance: number;
  buyAmountEth: number;
  maxBuyEth: number;
  hasBuyQuote: boolean;
  hasSellQuote: boolean;
  hasExistingPosition: boolean;
}

export interface LiveGateCheck {
  ok: boolean;
  missing: string[];
}

export function checkLiveGates(opts: LiveGateOptions): LiveGateCheck {
  const missing: string[] = [];
  if (opts.dryRun) missing.push("global dry-run disabled");
  if (!opts.liveEnabled) missing.push("ROBINHOOD_LIVE_ENABLED is true");
  if (opts.sourceMode !== "dexscreener_live" && opts.sourceMode !== "dexscreener_only") missing.push("source is dexscreener_live or dexscreener_only");
  if (opts.chainId !== ROBINHOOD_CHAIN_ID) missing.push("chain ID is exactly 4663");
  if (!opts.hasPrivKey) missing.push("EVM_PRIV_KEY is configured");
  if (opts.ethBalance < opts.minEthBalance) missing.push("wallet ETH balance >= minimum");
  if (opts.buyAmountEth > opts.maxBuyEth) missing.push("buy amount <= maximum buy ETH");
  if (!opts.hasBuyQuote || !opts.hasSellQuote) missing.push("fresh buy AND sell quotes exist");
  if (opts.hasExistingPosition) missing.push("no existing position or in-flight tx for contract");
  return { ok: missing.length === 0, missing };
}

function configuredGates(): LiveGateOptions {
  return {
    dryRun: CONFIG.DRY_RUN,
    liveEnabled: CONFIG.ROBINHOOD_LIVE_ENABLED,
    sourceMode: "dexscreener_watch",
    chainId: 0,
    hasPrivKey: Boolean(CONFIG.EVM_PRIV_KEY),
    ethBalance: 0,
    minEthBalance: CONFIG.ROBINHOOD_MIN_ETH_BALANCE,
    buyAmountEth: 0,
    maxBuyEth: CONFIG.ROBINHOOD_MAX_BUY_ETH,
    hasBuyQuote: false,
    hasSellQuote: false,
    hasExistingPosition: false,
  };
}

export class RobinhoodUniswapAdapter implements TradingAdapter {
  readonly chain: SupportedChain = "robinhood";
  readonly quoteSymbol = "ETH";

  private client: RobinhoodEvmClient;
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly walletAddress: Address;

  constructor(config: RobinhoodUniswapAdapterConfig) {
    this.client = new RobinhoodEvmClient(config);
    this.apiKey = config.apiKey ?? "";
    this.fetcher = config.fetcher ?? fetch;
    this.walletAddress = config.walletAddress;
  }

  isLive(): boolean {
    const gates = checkLiveGates(configuredGates());
    return gates.ok;
  }

  async executeBuy(_tokenAddress: string, _quoteAmountRaw: bigint): Promise<BuyOutcome> {
    const gates = checkLiveGates(configuredGates());
    if (!gates.ok) throw new Error(`live not enabled: ${gates.missing.join(", ")}`);
    throw new Error("RobinhoodUniswapAdapter.executeBuy: gates pass but signing not yet implemented");
  }

  async executeSell(_tokenAddress: string, _tokenAmountRaw: bigint): Promise<SellSuccess | null> {
    const gates = checkLiveGates(configuredGates());
    if (!gates.ok) {
      logger.warn({ missing: gates.missing }, "[robinhood] executeSell blocked by live gates");
      throw new Error(`live not enabled: ${gates.missing.join(", ")}`);
    }
    throw new Error("RobinhoodUniswapAdapter.executeSell: gates pass but signing not yet implemented");
  }

  private async quote(tokenIn: string, tokenOut: string, amount: bigint): Promise<QuoteResult | null> {
    if (!this.apiKey) return null;
    const init: RequestInit = {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        tokenIn,
        tokenOut,
        tokenInChainId: ROBINHOOD_CHAIN_ID,
        tokenOutChainId: ROBINHOOD_CHAIN_ID,
        type: "EXACT_INPUT",
        amount: amount.toString(),
        swapper: this.walletAddress,
        slippageTolerance: 0.5,
      }),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetcher(UNISWAP_QUOTE_URL, init);
        if (!response.ok) {
          if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
          return null;
        }
        const result = await response.json() as { quote?: { output?: { amount?: string }, priceImpact?: number } };
        const output = result.quote?.output?.amount;
        return output ? { quoteReceived: BigInt(output), priceImpactPct: result.quote?.priceImpact ?? 0 } : null;
      } catch {
        if (attempt === 1) return null;
      }
    }
    return null;
  }

  async quoteSell(tokenAddress: string, tokenAmountRaw: bigint): Promise<QuoteResult | null> {
    try { return await this.quote(tokenAddress, NATIVE_ETH, tokenAmountRaw); }
    catch { return null; }
  }

  async quoteBuy(tokenAddress: string, quoteAmountRaw: bigint): Promise<QuoteResult | null> {
    try { return await this.quote(NATIVE_ETH, tokenAddress, quoteAmountRaw); }
    catch { return null; }
  }

  async getBalance(tokenAddress?: string): Promise<bigint | null> {
    try {
      if (!tokenAddress) return await this.client.getEthBalance();
      return await this.client.getErc20Balance(tokenAddress as Address);
    } catch { return null; }
  }

  async getDecimals(tokenAddress: string): Promise<number> {
    return this.client.getErc20Decimals(tokenAddress as Address);
  }

  async getChainId(): Promise<number> {
    return this.client.getChainId();
  }
}

/** Factory: create a Robinhood adapter from env-configurable RPC + wallet. */
export function createRobinhoodAdapter(config: {
  rpcUrl: string;
  walletAddress: Address;
  apiKey?: string;
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
