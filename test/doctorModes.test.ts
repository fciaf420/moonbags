import test from "node:test";
import assert from "node:assert/strict";
import { checkEnvVarsForMode } from "../src/doctor.js";

const base = { DRY_RUN: "true", EVM_RPC_URL: "https://rpc.mainnet.chain.robinhood.com" };

test("Robinhood modes do not require Jupiter Helius or Solana wallet", () => {
  const checks = checkEnvVarsForMode(base, "dexscreener_only");
  const ids = new Set(checks.map(check => check.id));
  assert.equal(ids.has("env:JUP_API_KEY"), false);
  assert.equal(ids.has("env:HELIUS_API_KEY"), false);
  assert.equal(ids.has("env:PRIV_B58"), false);
  assert.equal(ids.has("env:EVM_RPC_URL"), true);
});

test("Solana modes retain Jupiter Helius and Solana wallet checks", () => {
  const checks = checkEnvVarsForMode(base, "gmgn_watch");
  const ids = new Set(checks.map(check => check.id));
  assert.equal(ids.has("env:JUP_API_KEY"), true);
  assert.equal(ids.has("env:HELIUS_API_KEY"), true);
  assert.equal(ids.has("env:PRIV_B58"), true);
  assert.equal(ids.has("env:EVM_RPC_URL"), false);
});

test("Robinhood watch mode does not require an EVM signing key", () => {
  const checks = checkEnvVarsForMode(base, "dexscreener_watch");
  assert.equal(checks.some(check => check.id === "env:EVM_PRIV_KEY"), false);
});

test("Robinhood live mode requires EVM key only when dry-run is disabled and live is enabled", () => {
  const checks = checkEnvVarsForMode({ ...base, DRY_RUN: "false", ROBINHOOD_LIVE_ENABLED: "true" }, "dexscreener_live");
  const key = checks.find(check => check.id === "env:EVM_PRIV_KEY");
  assert.equal(key?.status, "fail");
});
