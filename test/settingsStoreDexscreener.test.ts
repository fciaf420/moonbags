import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings } from "../src/settingsStore.js";

test("normalization preserves persisted Dexscreener settings",()=>{
 const normalized=normalizeSettings({signals:{sourceMode:"dexscreener_only",dexscreener:{
  enabled:true, executablePath:"/custom/ds", pollMs:45000, seedLimit:20,
  mintCooldownMins:30, watchlistTtlMins:90, maxWatchTokens:60, minScans:3,
  minLiquidityUsd:20000, minHolders:150, maxMarketCapUsd:1000000,
  minBuySellRatio:1.25, minH1Transactions:75, minH1PriceAcceleration:2,
  minH1VolumeAcceleration:1.2, maxAdjustedTop10Pct:40,
 }}});
 assert.equal(normalized.signals.dexscreener.enabled,true);
 assert.equal(normalized.signals.dexscreener.executablePath,"/custom/ds");
 assert.equal(normalized.signals.dexscreener.minHolders,150);
 assert.equal(normalized.signals.dexscreener.maxAdjustedTop10Pct,40);
});
