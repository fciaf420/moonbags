import test from "node:test";
import assert from "node:assert/strict";
import { RobinhoodUniswapAdapter } from "../src/robinhoodUniswapAdapter.js";
import type { Address } from "viem";

// ---------------------------------------------------------------------------
// Mock viem at the module level so the adapter never hits a real RPC.
// We patch the underlying RobinhoodEvmClient constructor behaviours via
// dependency injection on the public client methods.
// ---------------------------------------------------------------------------

// We'll mock getChainId, getBalance, readContract on the public client.
// The adapter's constructor creates a RobinhoodEvmClient which creates a
// viem public client; we intercept via the transport and mock at the
// RobinhoodEvmClient level by replacing its publicClient methods.

function mockClient(overrides: {
  chainId?: number;
  ethBalance?: bigint;
  erc20Balance?: bigint;
  erc20Decimals?: number;
  amountsOut?: readonly bigint[];
  throwOn?: Set<string>;
}) {
  const throws = overrides.throwOn ?? new Set<string>();
  return {
    getChainId: throws.has("getChainId")
      ? () => { throw new Error("RPC down"); }
      : () => Promise.resolve(overrides.chainId ?? 4663),
    getBalance: throws.has("getBalance")
      ? () => { throw new Error("RPC down"); }
      : () => Promise.resolve(overrides.ethBalance ?? 0n),
    readContract: (args: { functionName: string }) => {
      if (throws.has("readContract")) throw new Error("RPC down");
      if (args.functionName === "balanceOf") return Promise.resolve(overrides.erc20Balance ?? 0n);
      if (args.functionName === "decimals") return Promise.resolve(overrides.erc20Decimals ?? 18);
      if (args.functionName === "getAmountsOut") return Promise.resolve(overrides.amountsOut ?? [100n, 250n]);
      throw new Error("unknown function");
    },
    getTransactionReceipt: throws.has("getTransactionReceipt")
      ? () => { throw new Error("RPC down"); }
      : () => Promise.resolve({ status: "success" }),
  };
}

function makeAdapter(overrides: Parameters<typeof mockClient>[0] = {}, fetcher?: typeof fetch) {
  const adapter = new RobinhoodUniswapAdapter({
    rpcUrl: "http://localhost:8545",
    walletAddress: "0xDD5690e04BcAC0f06e405362e0B3BadB92DAe711",
    apiKey: "test-key",
    fetcher,
  });
  // Reach into the private client and replace publicClient with our mock.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (adapter as any).client.publicClient = mockClient(overrides);
  return adapter;
}

// ---------------------------------------------------------------------------
// Chain identity
// ---------------------------------------------------------------------------

test("chain is robinhood", () => {
  const a = makeAdapter();
  assert.equal(a.chain, "robinhood");
});

test("quoteSymbol is ETH", () => {
  const a = makeAdapter();
  assert.equal(a.quoteSymbol, "ETH");
});

// ---------------------------------------------------------------------------
// getChainId
// ---------------------------------------------------------------------------

test("getChainId returns 4663", async () => {
  const a = makeAdapter({ chainId: 4663 });
  const id = await a.getChainId();
  assert.equal(id, 4663);
});

test("getChainId returns non-4663 value", async () => {
  const a = makeAdapter({ chainId: 1 });
  const id = await a.getChainId();
  assert.equal(id, 1);
});

test("getChainId propagates RPC errors", async () => {
  const a = makeAdapter({ throwOn: new Set(["getChainId"]) });
  await assert.rejects(() => a.getChainId(), /RPC down/);
});

// ---------------------------------------------------------------------------
// getBalance — ETH
// ---------------------------------------------------------------------------

test("getBalance returns ETH balance when no tokenAddress", async () => {
  const a = makeAdapter({ ethBalance: 1_000_000_000_000_000_000n });
  const bal = await a.getBalance();
  assert.equal(bal, 1_000_000_000_000_000_000n);
});

test("getBalance returns null on RPC error", async () => {
  const a = makeAdapter({ throwOn: new Set(["getBalance"]) });
  const bal = await a.getBalance();
  assert.equal(bal, null);
});

// ---------------------------------------------------------------------------
// getBalance — ERC-20
// ---------------------------------------------------------------------------

test("getBalance returns ERC-20 balance when tokenAddress provided", async () => {
  const a = makeAdapter({ erc20Balance: 123456n });
  const bal = await a.getBalance("0xToken1111111111111111111111111111111111");
  assert.equal(bal, 123456n);
});

test("getBalance returns null on ERC-20 readContract error", async () => {
  const a = makeAdapter({ throwOn: new Set(["readContract"]) });
  const bal = await a.getBalance("0xToken1111111111111111111111111111111111");
  assert.equal(bal, null);
});

// ---------------------------------------------------------------------------
// getDecimals
// ---------------------------------------------------------------------------

test("getDecimals returns token decimals", async () => {
  const a = makeAdapter({ erc20Decimals: 9 });
  const d = await a.getDecimals("0xToken1111111111111111111111111111111111");
  assert.equal(d, 9);
});

test("getDecimals returns 18 (default ERC-20)", async () => {
  const a = makeAdapter({ erc20Decimals: 18 });
  const d = await a.getDecimals("0xToken1111111111111111111111111111111111");
  assert.equal(d, 18);
});

// ---------------------------------------------------------------------------
// isLive
// ---------------------------------------------------------------------------

test("isLive returns false by default", () => {
  const a = makeAdapter();
  assert.equal(a.isLive(), false);
});

// ---------------------------------------------------------------------------
// Not-implemented methods
// ---------------------------------------------------------------------------

test("executeBuy throws live not enabled when gates fail", async () => {
  const a = makeAdapter();
  await assert.rejects(
    () => a.executeBuy("0xToken1111111111111111111111111111111111", 1000000n),
    /live not enabled/,
  );
});

test("executeSell throws live not enabled when gates fail", async () => {
  const a = makeAdapter();
  await assert.rejects(
    () => a.executeSell("0xToken1111111111111111111111111111111111", 1000000n) as Promise<unknown>,
    /live not enabled/,
  );
});

test("quoteSell requests a reverse Uniswap API quote on Robinhood Chain", async () => {
  let body: Record<string,unknown> = {};
  const fetcher: typeof fetch = async (_url, init) => {
    body=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ routing:"CLASSIC", quote:{ output:{ amount:"42000" }, priceImpact:2.5 } }),{status:200});
  };
  const a=makeAdapter({},fetcher);
  assert.deepEqual(await a.quoteSell("0x1111111111111111111111111111111111111111",1_000_000n),{
    quoteReceived:42_000n,
    priceImpactPct:2.5,
  });
  assert.equal(body.tokenIn,"0x1111111111111111111111111111111111111111");
  assert.equal(body.tokenOut,"0x0000000000000000000000000000000000000000");
  assert.equal(body.amount,"1000000");
});

test("quoteBuy requests an official Uniswap API quote on Robinhood Chain", async () => {
  let request: RequestInit | undefined;
  const fetcher: typeof fetch = async (_url, init) => {
    request = init;
    return new Response(JSON.stringify({ routing: "CLASSIC", quote: { output: { amount: "84000" }, priceImpact: 1.25 } }), { status: 200 });
  };
  const a = makeAdapter({}, fetcher);
  assert.deepEqual(await a.quoteBuy("0x1111111111111111111111111111111111111111", 1_000_000n), {
    quoteReceived: 84_000n,
    priceImpactPct: 1.25,
  });
  assert.equal((request?.headers as Record<string,string>)["x-api-key"], "test-key");
  assert.deepEqual(JSON.parse(String(request?.body)), {
    tokenIn: "0x0000000000000000000000000000000000000000",
    tokenOut: "0x1111111111111111111111111111111111111111",
    tokenInChainId: 4663,
    tokenOutChainId: 4663,
    type: "EXACT_INPUT",
    amount: "1000000",
    swapper: "0xDD5690e04BcAC0f06e405362e0B3BadB92DAe711",
    slippageTolerance: 0.5,
  });
});

test("quoteSell retries one transient Uniswap API failure", async () => {
  let attempts = 0;
  const fetcher: typeof fetch = async () => {
    attempts++;
    if (attempts === 1) return new Response("temporary", { status: 503 });
    return new Response(JSON.stringify({ quote: { output: { amount: "42000" } } }), { status: 200 });
  };
  const a = makeAdapter({}, fetcher);
  assert.deepEqual(await a.quoteSell("0x1111111111111111111111111111111111111111", 1_000_000n), {
    quoteReceived: 42_000n,
    priceImpactPct: 0,
  });
  assert.equal(attempts, 2);
});

// ---------------------------------------------------------------------------
// validateRobinhoodChain utility
// ---------------------------------------------------------------------------

test("validateRobinhoodChain returns true for chain 4663", async () => {
  const { validateRobinhoodChain } = await import("../src/robinhoodUniswapAdapter.js");
  const a = makeAdapter({ chainId: 4663 });
  assert.equal(await validateRobinhoodChain(a), true);
});

test("validateRobinhoodChain returns false for wrong chain", async () => {
  const { validateRobinhoodChain } = await import("../src/robinhoodUniswapAdapter.js");
  const a = makeAdapter({ chainId: 1 });
  assert.equal(await validateRobinhoodChain(a), false);
});

test("validateRobinhoodChain returns false on error", async () => {
  const { validateRobinhoodChain } = await import("../src/robinhoodUniswapAdapter.js");
  const a = makeAdapter({ throwOn: new Set(["getChainId"]) });
  assert.equal(await validateRobinhoodChain(a), false);
});
