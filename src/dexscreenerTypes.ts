export type DexscreenerRobinhoodCandidate = {
  chainId: "robinhood";
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  dexId: string;
  pairAddress: string;
  pairUrl: string;
  priceUsd: number;
  priceChangeH1: number;
  priceChangeH24: number;
  volumeH24: number;
  txnsH1: number;
  liquidityUsd: number;
  marketCap: number;
  fdv: number;
  holdersCount: number;
  holdersSource: string;
  score: number;
  tags: string[];
  analytics: {
    compressionScore: number;
    breakoutReadiness: number;
    volumeVelocity: number;
    txnVelocity: number;
    relativeStrength: number;
    chainBaselineH1: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseRobinhoodHotOutput(output: string): DexscreenerRobinhoodCandidate[] {
  const start = output.indexOf("[");
  if (start < 0) throw new Error("Dexscreener output did not contain a JSON array");
  let value: unknown;
  try { value = JSON.parse(output.slice(start)); }
  catch (error) { throw new Error(`Invalid Dexscreener JSON array: ${String(error)}`); }
  if (!Array.isArray(value)) throw new Error("Dexscreener output must be a JSON array");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`row ${index}: expected object`);
    const row = raw as Record<string, unknown>;
    if (row.chainId !== "robinhood") throw new Error(`row ${index}: chainId must be robinhood`);
    if (typeof row.tokenAddress !== "string" || !EVM_ADDRESS.test(row.tokenAddress)) throw new Error(`row ${index}: invalid tokenAddress`);
    const analytics = row.analytics;
    if (!analytics || typeof analytics !== "object") throw new Error(`row ${index}: missing analytics`);
    return { ...row, tokenAddress: row.tokenAddress.toLowerCase() } as DexscreenerRobinhoodCandidate;
  });
}
