import test from "node:test";
import assert from "node:assert/strict";
import {
  createDexscreenerPriceFetcher,
  type DexscreenerPriceFetcher,
} from "../src/robinhoodPriceFeed.js";

// ---------------------------------------------------------------------------
// Task 11: Robinhood pricing via Dexscreener.
//
// The price feed is an injected dependency so tests can swap in a mock without
// spawning the real CLI or hitting the REST API.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DexscreenerPriceFetcher interface
// ---------------------------------------------------------------------------

test("createDexscreenerPriceFetcher returns an object with the expected shape", () => {
  const fetcher = createDexscreenerPriceFetcher({ executablePath: "/bin/true" });
  assert.equal(typeof fetcher.fetchUsdPrice, "function");
  assert.equal(typeof fetcher.fetchUsdPrices, "function");
});

// ---------------------------------------------------------------------------
// fetchUsdPrice — single token
// ---------------------------------------------------------------------------

test("fetchUsdPrice returns null for unavailable price", async () => {
  // Simulate a CLI that returns empty output (no price data)
  const mockRun = async (_cmd: string, args: string[]): Promise<string> => {
    return JSON.stringify({ pairs: [] });
  };

  const fetcher = createDexscreenerPriceFetcher(
    { executablePath: "/bin/true" },
    mockRun,
  );

  const price = await fetcher.fetchUsdPrice(
    "0x1234567890abcdef1234567890abcdef12345678",
  );
  assert.equal(price, null);
});

test("fetchUsdPrice returns USD price from Dexscreener result", async () => {
  const mockRun = async (_cmd: string, args: string[]): Promise<string> => {
    return JSON.stringify({
      pairs: [
        {
          chainId: "robinhood",
          dexId: "uniswap",
          pairAddress: "0xPairAddress1111111111111111111111111111111",
          baseToken: {
            address: "0x1234567890abcdef1234567890abcdef12345678",
            name: "TestToken",
            symbol: "TEST",
          },
          priceUsd: "0.00042",
        },
      ],
    });
  };

  const fetcher = createDexscreenerPriceFetcher(
    { executablePath: "/bin/true" },
    mockRun,
  );

  const price = await fetcher.fetchUsdPrice(
    "0x1234567890abcdef1234567890abcdef12345678",
  );
  assert.equal(price, 0.00042);
});

test("fetchUsdPrice parses setup-tip-prefixed primaryPair output from the real CLI", async () => {
  const address="0x1234567890abcdef1234567890abcdef12345678";
  const mockRun=async ():Promise<string>=>`Tip: Run ds setup to pick your chains and preferences (takes 30 seconds).\n\n${JSON.stringify({primaryPair:{chainId:"robinhood",tokenAddress:address,priceUsd:"0.00077"}})}`;
  const fetcher=createDexscreenerPriceFetcher({executablePath:"/bin/true"},mockRun);
  assert.equal(await fetcher.fetchUsdPrice(address),0.00077);
});

test("fetchUsdPrice lowercases the address for lookup", async () => {
  const calledWith: string[] = [];
  const mockRun = async (_cmd: string, args: string[]): Promise<string> => {
    calledWith.push(...args);
    return JSON.stringify({
      pairs: [
        {
          chainId: "robinhood",
          baseToken: {
            address: "0xabcdef00000000000000000000000000000000FF",
          },
          priceUsd: "0.001",
        },
      ],
    });
  };

  const fetcher = createDexscreenerPriceFetcher(
    { executablePath: "/bin/true" },
    mockRun,
  );

  const price = await fetcher.fetchUsdPrice(
    "0xABCDEF00000000000000000000000000000000FF",
  );
  // Should match regardless of input case
  assert.equal(price, 0.001);
});

test("fetchUsdPrice returns null on CLI error", async () => {
  const mockRun = async (_cmd: string, _args: string[]): Promise<string> => {
    throw new Error("CLI not found");
  };

  const fetcher = createDexscreenerPriceFetcher(
    { executablePath: "/nonexistent/ds" },
    mockRun,
  );

  const price = await fetcher.fetchUsdPrice(
    "0x1234567890abcdef1234567890abcdef12345678",
  );
  assert.equal(price, null);
});

test("fetchUsdPrice returns null on malformed JSON", async () => {
  const mockRun = async (_cmd: string, _args: string[]): Promise<string> => {
    return "not json at all";
  };

  const fetcher = createDexscreenerPriceFetcher(
    { executablePath: "/bin/true" },
    mockRun,
  );

  const price = await fetcher.fetchUsdPrice(
    "0x1234567890abcdef1234567890abcdef12345678",
  );
  assert.equal(price, null);
});

// ---------------------------------------------------------------------------
// fetchUsdPrices — batch
// ---------------------------------------------------------------------------

test("fetchUsdPrices returns a Map of address → price", async () => {
  const mockRun = async (_cmd: string, args: string[]): Promise<string> => {
    // For batch, we call inspect for each address. Return different prices.
    const addr = args[1]?.toLowerCase() ?? "";
    if (addr.includes("aaaa")) {
      return JSON.stringify({
        pairs: [
          {
            chainId: "robinhood",
            baseToken: { address: addr },
            priceUsd: "0.001",
          },
        ],
      });
    }
    if (addr.includes("bbbb")) {
      return JSON.stringify({
        pairs: [
          {
            chainId: "robinhood",
            baseToken: { address: addr },
            priceUsd: "0.002",
          },
        ],
      });
    }
    return JSON.stringify({ pairs: [] });
  };

  const fetcher = createDexscreenerPriceFetcher(
    { executablePath: "/bin/true" },
    mockRun,
  );

  const result = await fetcher.fetchUsdPrices([
    "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  ]);

  assert.equal(result.size, 2);
  assert.equal(result.get("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), 0.001);
  assert.equal(result.get("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), 0.002);
  assert.equal(
    result.has("0xcccccccccccccccccccccccccccccccccccccccc"),
    false,
  );
});

test("fetchUsdPrices returns empty map for empty input", async () => {
  const fetcher = createDexscreenerPriceFetcher({
    executablePath: "/bin/true",
  });
  const result = await fetcher.fetchUsdPrices([]);
  assert.equal(result.size, 0);
});

// ---------------------------------------------------------------------------
// Real CLI executor helper — not called in tests, just verified for shape.
// ---------------------------------------------------------------------------

test("default executor is configured but not exercised in unit tests", () => {
  // The default executor uses execFile; in tests we always inject a mock.
  const fetcher = createDexscreenerPriceFetcher({
    executablePath: "/bin/true",
  });
  // Just verify construction succeeds
  assert.ok(fetcher);
});
