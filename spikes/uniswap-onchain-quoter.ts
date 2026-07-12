import { createPublicClient, http, parseAbi, formatUnits, getContract } from "viem";
import { arbitrum } from "viem/chains";

const CHAIN = { ...arbitrum, id: 4663, name: "Robinhood Chain", rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
const client = createPublicClient({ chain: CHAIN, transport: http() });

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

// V2 Router
const V2_ROUTER = "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba";
// V3 SwapRouter02
const V3_SWAP_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
// V3 Factory
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";

async function main() {
  // V2 Router quote: getAmountsOut
  try {
    const v2Abi = parseAbi(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"]);
    const amounts = await client.readContract({
      address: V2_ROUTER as `0x${string}`, abi: v2Abi,
      functionName: "getAmountsOut",
      args: [10000000000000000n, [WETH as `0x${string}`, USDG as `0x${string}`]],
    }) as bigint[];
    console.log(`V2: 0.01 ETH → ${formatUnits(amounts[1], 6)} USDG`);
  } catch(e: any) { console.log(`V2 quote failed: ${e.shortMessage ?? e.message}`); }

  // Try finding V3 pool
  try {
    const factoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);
    for (const fee of [100, 500, 3000, 10000]) {
      const pool = await client.readContract({
        address: V3_FACTORY as `0x${string}`, abi: factoryAbi,
        functionName: "getPool", args: [WETH as `0x${string}`, USDG as `0x${string}`, fee],
      }) as string;
      if (pool !== "0x0000000000000000000000000000000000000000") {
        console.log(`V3 pool found: ${pool} (fee=${fee})`);
        // Read slot0 for price
        const slot0Abi = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, ...)"]);
        const [sqrtPriceX96] = await client.readContract({
          address: pool as `0x${string}`, abi: slot0Abi, functionName: "slot0",
        }) as [bigint];
        console.log(`  sqrtPriceX96: ${sqrtPriceX96}`);
      }
    }
  } catch(e: any) { console.log(`V3 pool search: ${e.shortMessage ?? e.message}`); }
}
main().catch(e => console.error(e));
