import test from "node:test";
import assert from "node:assert/strict";
import { analyzeRobinhoodPaperTrades, type RobinhoodPaperEvent } from "../scripts/analyze-robinhood-paper-trades.js";

function closedTrade(index: number, pnlPct: number): RobinhoodPaperEvent[] {
  const tokenAddress = `0x${index.toString(16).padStart(40, "0")}`;
  return [
    { type: "accepted", at: index * 1000, tokenAddress, pairAgeMins: 20, liquidityUsd: 50_000, holders: 200, adjustedTop10Pct: 25, buySellRatio: 1.5, transactionAcceleration: 1.2, score: 70 },
    { type: "closed", at: index * 1000 + 500, tokenAddress, pnlPct, maxFavorableExcursionPct: Math.max(pnlPct, 10), maxAdverseExcursionPct: Math.min(pnlPct, -5), liquidityChangePct: 2, holderChangePct: 3 },
  ];
}

test("paper analysis blocks live enablement below minimum sample", () => {
  const result = analyzeRobinhoodPaperTrades(closedTrade(1, 12), 30);
  assert.equal(result.completedTrades, 1);
  assert.equal(result.liveEligible, false);
  assert.match(result.liveEligibilityReason, /1\/30/);
});

test("paper analysis summarizes completed trades once sample is met", () => {
  const events = Array.from({ length: 30 }, (_, i) => closedTrade(i + 1, i % 3 === 0 ? -10 : 20)).flat();
  const result = analyzeRobinhoodPaperTrades(events, 30);
  assert.equal(result.completedTrades, 30);
  assert.equal(result.liveEligible, true);
  assert.equal(result.winRate, 2 / 3);
  assert.equal(result.averagePnlPct, 10);
  assert.ok(Math.abs(result.averageMaxFavorableExcursionPct - 16.666666666666668) < 1e-9);
  assert.ok(Math.abs(result.averageMaxAdverseExcursionPct - (-6.666666666666667)) < 1e-9);
});
