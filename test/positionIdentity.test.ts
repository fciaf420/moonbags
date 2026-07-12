import test from "node:test";
import assert from "node:assert/strict";
import { canonicalPositionKey, migratePersistedPosition } from "../src/types.js";

test("canonical Solana identity preserves mint case", () => assert.equal(canonicalPositionKey("solana", "SoLmint"), "solana:SoLmint"));
test("canonical Robinhood identity lowercases addresses", () => assert.equal(canonicalPositionKey("robinhood", "0xDD5690e04BcAC0f06e405362e0B3BadB92DAe711"), "robinhood:0xdd5690e04bcac0f06e405362e0b3badb92dae711"));
test("invalid EVM addresses are rejected", () => assert.throws(() => canonicalPositionKey("robinhood", "0x123"), /address/));
test("old persisted rows migrate to Solana", () => {
  const old = { mint: "LegacyMint", tokensHeld: "2", status: "open" };
  const migrated = migratePersistedPosition(old);
  assert.equal(migrated.chain, "solana");
  assert.equal(migrated.tokenAddress, "LegacyMint");
  assert.equal(migrated.mint, "LegacyMint");
});
