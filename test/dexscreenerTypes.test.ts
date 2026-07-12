import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRobinhoodHotOutput } from "../src/dexscreenerTypes.js";

const fixture = readFileSync(new URL("fixtures/dexscreener-robinhood-hot.json", import.meta.url), "utf8");

test("parses actual Robinhood hot output", () => {
  const rows = parseRobinhoodHotOutput(fixture);
  assert.equal(rows[0]?.chainId, "robinhood");
  assert.equal(rows[0]?.tokenAddress, "0xdd5690e04bcac0f06e405362e0b3badb92dae711");
  assert.equal(rows[0]?.analytics.txnVelocity, 24);
});
test("strips scanner setup tip prefix", () => assert.equal(parseRobinhoodHotOutput(`Tip: Run ds setup first\n\n${fixture}`).length, 1));
test("rejects malformed JSON", () => assert.throws(() => parseRobinhoodHotOutput("no json"), /JSON array/));
test("rejects wrong chain", () => assert.throws(() => parseRobinhoodHotOutput('[{"chainId":"solana","tokenAddress":"So1"}]'), /chainId/));
test("rejects missing or invalid contract address", () => {
  assert.throws(() => parseRobinhoodHotOutput('[{"chainId":"robinhood"}]'), /tokenAddress/);
  assert.throws(() => parseRobinhoodHotOutput('[{"chainId":"robinhood","tokenAddress":"bad"}]'), /tokenAddress/);
});
