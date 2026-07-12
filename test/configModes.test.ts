import test from "node:test";
import assert from "node:assert/strict";
import { requiredSolanaEnvForMode } from "../src/config.js";

test("Robinhood Dexscreener modes require no Solana credentials",()=>{
 assert.deepEqual(requiredSolanaEnvForMode("dexscreener_only",{}),[]);
 assert.deepEqual(requiredSolanaEnvForMode("dexscreener_watch",{}),[]);
});

test("Solana modes retain Solana credential requirements",()=>{
 assert.deepEqual(requiredSolanaEnvForMode("gmgn_watch",{}),["JUP_API_KEY","HELIUS_API_KEY","PRIV_B58"]);
});
