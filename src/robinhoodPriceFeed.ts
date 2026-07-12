import { execFile } from "node:child_process";
import { promisify } from "node:util";
import logger from "./logger.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Robinhood Dexscreener price feed.
//
// Fetches USD prices from the Dexscreener inspect endpoint
// (`./ds inspect <address> --chain robinhood --json`).
//
// The fetcher is an injected dependency: callers provide a `runCli` function
// so unit tests can swap in a mock without spawning the real CLI.
// ---------------------------------------------------------------------------

export type RunCliFn = (cmd: string, args: string[]) => Promise<string>;

export interface DexscreenerPriceFetcher {
  /** Fetch USD price for a single token address. Returns null if unavailable. */
  fetchUsdPrice(tokenAddress: string): Promise<number | null>;
  /** Fetch USD prices for a batch of token addresses. */
  fetchUsdPrices(tokenAddresses: string[]): Promise<Map<string, number>>;
}

export interface DexscreenerPriceFeedConfig {
  executablePath: string;
}

interface DexscreenerPair {
  chainId?: string;
  baseToken?: { address?: string };
  priceUsd?: string;
}

interface DexscreenerInspectOutput {
  pairs?: DexscreenerPair[];
}

function defaultRunCli(executablePath: string): RunCliFn {
  return async (cmd: string, args: string[]) => {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5_000 });
    return stdout;
  };
}

/** Fetch a single token's USD price from Dexscreener inspect. */
async function fetchSingle(
  runCli: RunCliFn,
  executablePath: string,
  tokenAddress: string,
): Promise<number | null> {
  const addr = tokenAddress.toLowerCase();
  try {
    const stdout = await runCli(executablePath, [
      "inspect",
      addr,
      "--chain",
      "robinhood",
      "--json",
    ]);
    const parsed = JSON.parse(stdout) as DexscreenerInspectOutput;
    const pairs = parsed.pairs ?? [];

    for (const pair of pairs) {
      if (
        pair.baseToken?.address?.toLowerCase() === addr &&
        pair.priceUsd
      ) {
        const price = parseFloat(pair.priceUsd);
        if (Number.isFinite(price) && price > 0) {
          return price;
        }
      }
    }
    return null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tokenAddress },
      "[robinhoodPriceFeed] inspect failed",
    );
    return null;
  }
}

/** Fetch USD prices for a batch of token addresses. */
async function fetchBatch(
  runCli: RunCliFn,
  executablePath: string,
  tokenAddresses: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (tokenAddresses.length === 0) return out;

  const results = await Promise.allSettled(
    tokenAddresses.map((addr) =>
      fetchSingle(runCli, executablePath, addr),
    ),
  );

  for (let i = 0; i < tokenAddresses.length; i++) {
    const addr = tokenAddresses[i]!;
    const result = results[i]!;
    if (
      result.status === "fulfilled" &&
      result.value !== null
    ) {
      out.set(addr.toLowerCase(), result.value);
    }
  }

  return out;
}

/**
 * Create a DexscreenerPriceFetcher.
 *
 * Pass a custom `runCli` function for testing. If omitted, the default
 * implementation uses `execFile` to call the real CLI binary.
 */
export function createDexscreenerPriceFetcher(
  config: DexscreenerPriceFeedConfig,
  runCli?: RunCliFn,
): DexscreenerPriceFetcher {
  const effectiveRunCli = runCli ?? defaultRunCli(config.executablePath);

  return {
    async fetchUsdPrice(tokenAddress: string): Promise<number | null> {
      return fetchSingle(effectiveRunCli, config.executablePath, tokenAddress);
    },

    async fetchUsdPrices(
      tokenAddresses: string[],
    ): Promise<Map<string, number>> {
      return fetchBatch(effectiveRunCli, config.executablePath, tokenAddresses);
    },
  };
}
