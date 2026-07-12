import test from "node:test";
import assert from "node:assert/strict";
import { createRobinhoodWatchSource, type RobinhoodSourceSettings } from "../src/dexscreenerRobinhoodSource.js";

const address = "0xdd5690e04bcac0f06e405362e0b3badb92dae711";
const base = { chainId:"robinhood", tokenAddress:address, tokenSymbol:"MEME", tokenName:"Meme", dexId:"uniswap", pairAddress:"0x0B94EF4674E218181d306554431127466bAD887a", pairUrl:"x", priceUsd:1, priceChangeH1:10, priceChangeH24:20, volumeH24:100000, txnsH1:100, liquidityUsd:50000, marketCap:100000, fdv:100000, holdersCount:200, holdersSource:"blockscout", score:80, tags:[], analytics:{compressionScore:1,breakoutReadiness:1,volumeVelocity:2,txnVelocity:2,relativeStrength:1,chainBaselineH1:1} };
const settings: RobinhoodSourceSettings = { enabled:true, executablePath:"ds", pollMs:1000, seedLimit:10, cooldownMins:10, watchlistTtlMins:30, maxWatchTokens:10, minScans:2, minLiquidityUsd:10000, minHolders:100, maxMarketCapUsd:200000, minBuySellRatio:1, minH1Transactions:50, minH1PriceAcceleration:0, minH1VolumeAcceleration:1, maxAdjustedTop10Pct:50 };

test("first scan seeds without firing and repeated momentum scan fires once", async () => {
  let now=1000; let scan=0; const accepted:string[]=[];
  const runner=async()=>JSON.stringify([{...base, txnsH1:100+scan*20, volumeH24:100000+scan++*30000}]);
  const source=createRobinhoodWatchSource({runner, clock:()=>now, settings, concentration:async()=>({rawTop10Pct:20,adjustedTop10Pct:15,holderCount:200,excludedAddresses:[]}), onAcceptedCandidate:a=>accepted.push(a.mint)});
  await source.refresh(); assert.deepEqual(accepted,[]);
  now+=1000; await source.refresh(); assert.deepEqual(accepted,[address]);
  now+=1000; await source.refresh(); assert.equal(accepted.length,1);
  assert.equal(source.status().candidatesAccepted,1);
});

test("cooldown prevents refiring after watch entry is rediscovered", async () => {
  let now=1000; const runner=async()=>JSON.stringify([base]); const accepted:string[]=[];
  const source=createRobinhoodWatchSource({runner,clock:()=>now,settings:{...settings,minH1VolumeAcceleration:0},concentration:async()=>({rawTop10Pct:10,adjustedTop10Pct:10,holderCount:200,excludedAddresses:[]}),onAcceptedCandidate:a=>accepted.push(a.mint)});
  await source.refresh(); now+=1000; await source.refresh(); now+=1000; await source.refresh();
  assert.equal(accepted.length,1);
});

test("paper journal receives snapshots rejections and acceptances", async () => {
  let now=1000;
  const events: Array<{ type: string; reason?: string }> = [];
  const source=createRobinhoodWatchSource({
    runner:async()=>JSON.stringify([base]), clock:()=>now,
    settings:{...settings,minScans:2,minLiquidityUsd:100000},
    concentration:async()=>({rawTop10Pct:10,adjustedTop10Pct:10,holderCount:200,excludedAddresses:[]}),
    onPaperEvent:event=>events.push(event),
  });
  await source.refresh();
  now+=1000; await source.refresh();
  assert.ok(events.some(event=>event.type==="snapshot"));
  assert.ok(events.some(event=>event.type==="rejected"&&event.reason==="liquidity"));

  const acceptedEvents: Array<{ type: string }> = [];
  const acceptedSource=createRobinhoodWatchSource({
    runner:async()=>JSON.stringify([base]), clock:()=>now,
    settings:{...settings,minH1VolumeAcceleration:0},
    concentration:async()=>({rawTop10Pct:10,adjustedTop10Pct:10,holderCount:200,excludedAddresses:[]}),
    onPaperEvent:event=>acceptedEvents.push(event),
  });
  await acceptedSource.refresh();
  now+=1000; await acceptedSource.refresh();
  assert.ok(acceptedEvents.some(event=>event.type==="accepted"));
});
