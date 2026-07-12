import test from "node:test";
import assert from "node:assert/strict";
import { checkLiveGates, type LiveGateOptions } from "../src/robinhoodUniswapAdapter.js";

// ---------------------------------------------------------------------------
// Task 12: Live trading gates for Robinhood chain.
//
// Every gate is tested independently — ANY single missing prerequisite
// must block signing.
// ---------------------------------------------------------------------------

// These are the gates enumerated in the plan. They must all be checked
// before any Robinhood signing path proceeds.

const GATES = [
  "global dry-run disabled",
  "ROBINHOOD_LIVE_ENABLED is true",
  "source is dexscreener_live or dexscreener_only",
  "chain ID is exactly 4663",
  "EVM_PRIV_KEY is configured",
  "wallet ETH balance >= minimum",
  "buy amount <= maximum buy ETH",
  "fresh buy AND sell quotes exist",
  "no existing position or in-flight tx for contract",
] as const;

// ---------------------------------------------------------------------------
// Simulated gate checker (mirrors robinhoodUniswapAdapter live-gate logic)
// ---------------------------------------------------------------------------

function allGood(): LiveGateOptions {
  return {
    dryRun: false,
    liveEnabled: true,
    sourceMode: "dexscreener_live",
    chainId: 4663,
    hasPrivKey: true,
    ethBalance: 0.5,
    minEthBalance: 0.01,
    buyAmountEth: 0.02,
    maxBuyEth: 0.1,
    hasBuyQuote: true,
    hasSellQuote: true,
    hasExistingPosition: false,
  };
}

// ---------------------------------------------------------------------------
// Gate-by-gate tests
// ---------------------------------------------------------------------------

test("all gates pass when everything is configured", () => {
  const r = checkLiveGates(allGood());
  assert.equal(r.ok, true);
});

test("gate: global dry-run must be false", () => {
  const r = checkLiveGates({ ...allGood(), dryRun: true });
  assert.equal(r.ok, false);
  assert.ok((r as { missing: string[] }).missing.includes("global dry-run disabled"));
});

test("gate: ROBINHOOD_LIVE_ENABLED must be true", () => {
  const r = checkLiveGates({ ...allGood(), liveEnabled: false });
  assert.equal(r.ok, false);
  assert.ok((r as { missing: string[] }).missing.includes("ROBINHOOD_LIVE_ENABLED is true"));
});

test("gate: source must be dexscreener_live or _only", () => {
  for (const mode of ["dexscreener_watch", "private_only", "okx_watch", "gmgn_watch"]) {
    const r = checkLiveGates({ ...allGood(), sourceMode: mode });
    assert.equal(r.ok, false, `source ${mode} should block`);
    assert.ok(
      (r as { missing: string[] }).missing.includes("source is dexscreener_live or dexscreener_only"),
      `source ${mode}: missing gate not reported`,
    );
  }
});

test("gate: chain ID must be 4663", () => {
  const r = checkLiveGates({ ...allGood(), chainId: 1 });
  assert.equal(r.ok, false);
  assert.ok((r as { missing: string[] }).missing.includes("chain ID is exactly 4663"));
});

test("gate: EVM_PRIV_KEY must be configured", () => {
  const r = checkLiveGates({ ...allGood(), hasPrivKey: false });
  assert.equal(r.ok, false);
  assert.ok((r as { missing: string[] }).missing.includes("EVM_PRIV_KEY is configured"));
});

test("gate: wallet ETH balance must meet minimum", () => {
  const r = checkLiveGates({ ...allGood(), ethBalance: 0.001, minEthBalance: 0.01 });
  assert.equal(r.ok, false);
  assert.ok((r as { missing: string[] }).missing.includes("wallet ETH balance >= minimum"));
});

test("gate: buy amount must not exceed max", () => {
  const r = checkLiveGates({ ...allGood(), buyAmountEth: 0.5, maxBuyEth: 0.1 });
  assert.equal(r.ok, false);
  assert.ok((r as { missing: string[] }).missing.includes("buy amount <= maximum buy ETH"));
});

test("gate: fresh buy AND sell quotes required", () => {
  let r = checkLiveGates({ ...allGood(), hasBuyQuote: false, hasSellQuote: true });
  assert.equal(r.ok, false);
  r = checkLiveGates({ ...allGood(), hasBuyQuote: true, hasSellQuote: false });
  assert.equal(r.ok, false);
  r = checkLiveGates({ ...allGood(), hasBuyQuote: false, hasSellQuote: false });
  assert.equal(r.ok, false);
});

test("gate: no existing position or in-flight tx for contract", () => {
  const r = checkLiveGates({ ...allGood(), hasExistingPosition: true });
  assert.equal(r.ok, false);
  assert.ok((r as { missing: string[] }).missing.includes("no existing position or in-flight tx for contract"));
});

test("multiple failures report all missing gates", () => {
  const r = checkLiveGates({
    dryRun: true,
    liveEnabled: false,
    sourceMode: "dexscreener_watch",
    chainId: 1,
    hasPrivKey: false,
    ethBalance: 0,
    minEthBalance: 0.01,
    buyAmountEth: 1,
    maxBuyEth: 0.1,
    hasBuyQuote: false,
    hasSellQuote: false,
    hasExistingPosition: true,
  });
  assert.equal(r.ok, false);
  const missing = (r as { missing: string[] }).missing;
  assert.ok(missing.length >= 5, `expected >=5 missing gates, got ${missing.length}: ${missing.join(", ")}`);
});
