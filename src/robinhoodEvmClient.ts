import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { robinhood } from "viem/chains";

// ---------------------------------------------------------------------------
// Robinhood EVM client — read-only chain interactions via viem.
//
// NO signing paths. This provides the read primitives the trading adapter
// needs: chain ID validation, balance reads, decimal lookups, receipts.
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "decimals", type: "uint8" }],
  },
] as const;

export interface RobinhoodEvmClientConfig {
  rpcUrl: string;
  walletAddress: Address;
}

export class RobinhoodEvmClient {
  readonly publicClient: PublicClient;
  readonly walletAddress: Address;

  constructor(config: RobinhoodEvmClientConfig) {
    this.walletAddress = config.walletAddress;
    this.publicClient = createPublicClient({
      chain: robinhood,
      transport: http(config.rpcUrl),
    });
  }

  /** Validate chain ID is 4663 (Robinhood). */
  async getChainId(): Promise<number> {
    return this.publicClient.getChainId();
  }

  /** Read native ETH balance in wei. */
  async getEthBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.walletAddress });
  }

  /** Read ERC-20 token balance in base units. */
  async getErc20Balance(tokenAddress: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.walletAddress],
    });
  }

  /** Read ERC-20 decimals. */
  async getErc20Decimals(tokenAddress: Address): Promise<number> {
    return this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: "decimals",
    });
  }

  /** Get transaction receipt. */
  async getTransactionReceipt(txHash: Address) {
    return this.publicClient.getTransactionReceipt({ hash: txHash });
  }
}
