import test from "node:test";
import assert from "node:assert/strict";
import type { SignalAlert } from "../src/types.js";
import type { TradingAdapter } from "../src/tradingAdapter.js";
import {
  configureRobinhoodPositionRuntime,
  getPositions,
  loadPersistedPositions,
  openPosition,
  resetPositionForTests,
  setChainPaused,
  tickPositions,
  usesSolanaPositionMonitoring,
} from "../src/positionManager.js";
import { getRuntimeSettings, updateRuntimeSettings } from "../src/settingsStore.js";

const token = "0x00000000000000000000000000000000000000aa";
let usdPrice = 1;
let sellable = true;

function adapter(): TradingAdapter {
  return {
    chain: "robinhood",
    quoteSymbol: "ETH",
    async quoteBuy(_token, quoteAmount) { return { quoteReceived: quoteAmount / 100_000_000_000_000n, priceImpactPct: 0 }; },
    async quoteSell(_token, amount) {
      if (!sellable) return null;
      const received = BigInt(Math.floor(Number(amount) * 100_000_000_000_000 * usdPrice));
      return { quoteReceived: received, priceImpactPct: 0 };
    },
    async executeBuy() { throw new Error("live not enabled"); },
    async executeSell() { throw new Error("live not enabled"); },
    async getBalance() { return 1_000n; },
    async getDecimals() { return 0; },
    async getChainId() { return 4663; },
    isLive() { return false; },
  };
}

const alert = {
  chain: "robinhood", tokenAddress: token, mint: token, name: "Paper Token", source: "dexscreener",
  alert_mcap: 100_000, age_mins: 5, holders: 200, bs_ratio: 2, bundler_pct: 0,
  top10_pct: 20, kol_count: 0, signal_count: 10, rug_ratio: 0, liq_trend: "rising", score: 80,
} as SignalAlert;

function reset(): void {
  resetPositionForTests(token);
  sellable = true;
  usdPrice = 1;
  setChainPaused("robinhood", false);
  configureRobinhoodPositionRuntime({
    adapter: adapter(),
    priceFetcher: {
      fetchUsdPrice: async () => usdPrice,
      fetchUsdPrices: async addresses => new Map(addresses.map(address => [address, usdPrice])),
    },
  });
}

test("Robinhood positions never use Solana OKX monitoring", () => {
  assert.equal(usesSolanaPositionMonitoring("robinhood"), false);
  assert.equal(usesSolanaPositionMonitoring("solana"), true);
});

test("Robinhood dry-run entry requires a reverse sell quote", { concurrency: false }, async () => {
  reset();
  sellable = false;
  assert.equal(await openPosition(alert), null);
  assert.equal(getPositions().some(position => position.mint === token && position.status === "open"), false);
});

test("Robinhood position opens, arms, trails, and persists across restart", { concurrency: false }, async () => {
  reset();
  const original = structuredClone(getRuntimeSettings().exit);
  updateRuntimeSettings(settings => {
    settings.exit.profitStrategy.type = "trail";
    settings.exit.trail.armPct = 0.5;
    settings.exit.trail.trailPct = 0.2;
    settings.exit.risk.stopPct = 0.5;
    settings.exit.risk.maxHoldSecs = 3600;
  });
  try {
    const opened = await openPosition(alert);
    assert.equal(opened?.chain, "robinhood");
    resetPositionForTests(token);
    await loadPersistedPositions();
    assert.equal(getPositions().find(position => position.mint === token)?.chain, "robinhood");

    usdPrice = 2;
    await tickPositions();
    assert.equal(getPositions().find(position => position.mint === token)?.armed, true);

    usdPrice = 1.5;
    await tickPositions();
    const closed = getPositions().find(position => position.mint === token);
    assert.equal(closed?.status, "closed");
    assert.equal(closed?.exitReason, "trail");
  } finally {
    updateRuntimeSettings(settings => { settings.exit = original; });
    resetPositionForTests(token);
  }
});

test("Robinhood position supports stop, timeout, partial TP, and moonbag exit", { concurrency: false }, async () => {
  reset();
  const original = structuredClone(getRuntimeSettings().exit);
  try {
    updateRuntimeSettings(settings => {
      settings.exit.profitStrategy.type = "trail";
      settings.exit.risk.stopPct = 0.2;
      settings.exit.risk.maxHoldSecs = 3600;
    });
    await openPosition(alert);
    usdPrice = 0.7;
    await tickPositions();
    assert.equal(getPositions().find(position => position.mint === token)?.exitReason, "stop");

    resetPositionForTests(token); usdPrice = 1;
    updateRuntimeSettings(settings => { settings.exit.risk.maxHoldSecs = 1; settings.exit.risk.stopPct = 0.9; });
    await openPosition(alert);
    const timed = getPositions().find(position => position.mint === token);
    if (timed) timed.openedAt = Date.now() - 2_000;
    await tickPositions();
    assert.equal(getPositions().find(position => position.mint === token)?.exitReason, "timeout");

    resetPositionForTests(token); usdPrice = 1;
    updateRuntimeSettings(settings => {
      settings.exit.risk.maxHoldSecs = 3600;
      settings.exit.profitStrategy.type = "tp_ladder";
      settings.exit.profitStrategy.ladderTargets = [{ pnlPct: 0.5, sellPct: 0.5 }];
      settings.exit.profitStrategy.trailRemainder = true;
      settings.exit.runner.keepPct = 0.5;
      settings.exit.runner.trailPct = 0.2;
      settings.exit.runner.timeoutSecs = 3600;
    });
    await openPosition(alert);
    usdPrice = 1.6;
    await tickPositions();
    const afterTp = getPositions().find(position => position.mint === token);
    assert.equal(afterTp?.partialExits?.length, 1);
    assert.equal(afterTp?.moonbagMode, undefined);

    await tickPositions();
    assert.equal(getPositions().find(position => position.mint === token)?.armed, true);

    usdPrice = 0.5;
    await tickPositions();
    assert.equal(getPositions().find(position => position.mint === token)?.moonbagMode, true);

    usdPrice = 0.2;
    await tickPositions();
    assert.equal(getPositions().find(position => position.mint === token)?.exitReason, "moonbag_trail");
  } finally {
    updateRuntimeSettings(settings => { settings.exit = original; });
    resetPositionForTests(token);
  }
});
