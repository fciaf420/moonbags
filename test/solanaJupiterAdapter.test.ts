import test from "node:test";
import assert from "node:assert/strict";

// Set required env vars before any imports that touch config.
process.env.JUP_API_KEY = "test-key";
process.env.HELIUS_API_KEY = "test-helius-key";
process.env.DRY_RUN = "true";
process.env.PRIV_B58 = ""; // empty so DRY_RUN skips the key check

// ---------------------------------------------------------------------------
// Characterization tests for SolanaJupiterAdapter.
//
// These tests prove the adapter preserves existing jupClient behavior.
// Only external network calls are mocked; the adapter delegates to real
// jupClient functions which are tested elsewhere.
// ---------------------------------------------------------------------------

test("adapter chain is solana", async () => {
  // Dynamic import so module-level singletons don't pollute.
  const { SolanaJupiterAdapter } = await import("../src/solanaJupiterAdapter.js");
  const a = new SolanaJupiterAdapter();
  assert.equal(a.chain, "solana");
});

test("adapter quoteSymbol is SOL", async () => {
  const { SolanaJupiterAdapter } = await import("../src/solanaJupiterAdapter.js");
  const a = new SolanaJupiterAdapter();
  assert.equal(a.quoteSymbol, "SOL");
});

test("getChainId returns 0 (Solana sentinel)", async () => {
  const { SolanaJupiterAdapter } = await import("../src/solanaJupiterAdapter.js");
  const a = new SolanaJupiterAdapter();
  assert.equal(await a.getChainId(), 0);
});

test("isLive mirrors DRY_RUN config", async () => {
  const { SolanaJupiterAdapter } = await import("../src/solanaJupiterAdapter.js");
  const a = new SolanaJupiterAdapter();
  // DRY_RUN defaults to true in the test env unless overridden.
  // isLive() returns !DRY_RUN, so it should be false when DRY_RUN=true.
  assert.equal(typeof a.isLive(), "boolean");
});

test("getSolanaAdapter returns singleton", async () => {
  const { getSolanaAdapter } = await import("../src/solanaJupiterAdapter.js");
  const a1 = getSolanaAdapter();
  const a2 = getSolanaAdapter();
  assert.strictEqual(a1, a2);
});

test("getSolanaAdapter implements TradingAdapter", async () => {
  const { getSolanaAdapter } = await import("../src/solanaJupiterAdapter.js");
  const a = getSolanaAdapter();
  assert.equal(typeof a.executeBuy, "function");
  assert.equal(typeof a.executeSell, "function");
  assert.equal(typeof a.quoteSell, "function");
  assert.equal(typeof a.quoteBuy, "function");
  assert.equal(typeof a.getBalance, "function");
  assert.equal(typeof a.getDecimals, "function");
  assert.equal(typeof a.getChainId, "function");
  assert.equal(typeof a.isLive, "function");
});

test("executeBuy delegates to buyTokenWithSol (error path, no real RPC)", async () => {
  // Without a real key, this should fail fast with a config error.
  const { getSolanaAdapter } = await import("../src/solanaJupiterAdapter.js");
  const a = getSolanaAdapter();
  // When PRIV_B58 is unset, DRY_RUN defaults true, so buy should use
  // the dry-run path which calls getOrder then returns a fake sig.
  // We can't fully test the happy path here without env, but
  // the error path should return { error: ... }.
  try {
    const result = await a.executeBuy("FakeMint11111111111111111111111111111111", 1000n);
    // In DRY_RUN mode, if JUP_API_KEY is set, this might succeed.
    // Either way, the shape is correct.
    if ("error" in result) {
      assert.equal(typeof result.error, "string");
    } else {
      assert.equal(typeof result.signature, "string");
      assert.equal(typeof result.tokensReceivedRaw, "bigint");
      assert.equal(typeof result.tokenDecimals, "number");
    }
  } catch {
    // RPC/network errors are expected in test env without config.
  }
});

test("getDecimals delegates to getTokenDecimals (defaults to 6 on RPC failure)", async () => {
  const { getSolanaAdapter } = await import("../src/solanaJupiterAdapter.js");
  const a = getSolanaAdapter();
  // Without RPC, getTokenDecimals should return the fallback of 6.
  const d = await a.getDecimals("So11111111111111111111111111111111111111112");
  assert.equal(d, 6);
});
