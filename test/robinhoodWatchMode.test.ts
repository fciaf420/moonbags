import test from "node:test";
import assert from "node:assert/strict";
import { dispatchRobinhoodWatchCandidate } from "../src/dexscreenerRobinhoodSource.js";
import type { SignalAlert } from "../src/types.js";

test("watch-only dispatch notifies but never opens a position", async()=>{
 let notified=0, opened=0;
 const alert={chain:"robinhood",tokenAddress:"0x1111111111111111111111111111111111111111",mint:"0x1111111111111111111111111111111111111111",name:"Watch",source:"dexscreener"} as SignalAlert;
 await dispatchRobinhoodWatchCandidate(alert,{mode:"watch",notify:async()=>{notified++},openPosition:async()=>{opened++}});
 assert.equal(notified,1); assert.equal(opened,0);
});

test("live dispatch notifies and opens a Robinhood position", async()=>{
 let notified=0, opened=0;
 const alert={chain:"robinhood",tokenAddress:"0x1111111111111111111111111111111111111111",mint:"0x1111111111111111111111111111111111111111",name:"Live",source:"dexscreener"} as SignalAlert;
 await dispatchRobinhoodWatchCandidate(alert,{mode:"live",notify:async()=>{notified++},openPosition:async()=>{opened++}});
 assert.equal(notified,1); assert.equal(opened,1);
});
