import test from "node:test";
import assert from "node:assert/strict";
import type { Position, QuoteSymbol } from "../src/types.js";
import { migratePersistedPosition, quoteSymbolForChain } from "../src/types.js";

// ---------------------------------------------------------------------------
// Task 10: Quote-neutral accounting tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Migration: old Solana-only state → neutral fields
// ---------------------------------------------------------------------------

test("old persisted Solana row migrates neutral fields from Solana-specific ones", () => {
  const old = {
    mint: "SoLToken1111111111111111111111111111111",
    tokensHeld: "1000000",
    status: "open",
    entrySolSpent: 0.5,
    entryPricePerTokenSol: 0.000001,
    currentPricePerTokenSol: 0.000002,
    peakPricePerTokenSol: 0.000003,
    entrySig: "tx_sig_123",
    exitSig: "tx_sig_456",
  };
  const migrated = migratePersistedPosition(old);
  assert.equal(migrated.chain, "solana");
  assert.equal(migrated.quoteSymbol, "SOL");
  // Solana-specific fields preserved
  assert.equal(migrated.entrySolSpent, 0.5);
  assert.equal(migrated.entryPricePerTokenSol, 0.000001);
  assert.equal(migrated.currentPricePerTokenSol, 0.000002);
  assert.equal(migrated.peakPricePerTokenSol, 0.000003);
});

test("old persisted Solana row without chain defaults to solana/SOL", () => {
  const old = { mint: "OldToken111111111111111111111111111111", tokensHeld: "0", status: "closed" };
  const migrated = migratePersistedPosition(old);
  assert.equal(migrated.chain, "solana");
  assert.equal(migrated.quoteSymbol, "SOL");
});

test("robinhood persisted row gets ETH quote symbol", () => {
  const old = {
    chain: "robinhood",
    tokenAddress: "0xDD5690e04BcAC0f06e405362e0B3BadB92DAe711",
    mint: "0xDD5690e04BcAC0f06e405362e0B3BadB92DAe711",
    tokensHeld: "500",
    status: "open",
  };
  const migrated = migratePersistedPosition(old);
  assert.equal(migrated.chain, "robinhood");
  assert.equal(migrated.quoteSymbol, "ETH");
  assert.equal(migrated.tokenAddress, "0xdd5690e04bcac0f06e405362e0b3badb92dae711");
});

test("explicit quoteSymbol is preserved on migration", () => {
  const old = {
    chain: "solana",
    mint: "Token111111111111111111111111111111111",
    quoteSymbol: "SOL",
    tokensHeld: "100",
    status: "open",
  };
  const migrated = migratePersistedPosition(old);
  assert.equal(migrated.quoteSymbol, "SOL");
});

// ---------------------------------------------------------------------------
// quoteSymbolForChain utility
// ---------------------------------------------------------------------------

test("quoteSymbolForChain returns SOL for solana", () => {
  assert.equal(quoteSymbolForChain("solana"), "SOL");
});

test("quoteSymbolForChain returns ETH for robinhood", () => {
  assert.equal(quoteSymbolForChain("robinhood"), "ETH");
});

// ---------------------------------------------------------------------------
// Position compatibility: Solana fields readable after migration
// ---------------------------------------------------------------------------

test("Solana position has both old and neutral price fields after migration", () => {
  const old = {
    mint: "Token111111111111111111111111111111111",
    tokensHeld: "2000000",
    status: "open",
    entrySolSpent: 0.1,
    entryPricePerTokenSol: 0.00005,
    currentPricePerTokenSol: 0.00008,
    peakPricePerTokenSol: 0.00010,
    tokenDecimals: 6,
    armed: false,
    openedAt: 1000000,
    lastTickAt: 1000100,
  };
  const migrated = migratePersistedPosition(old) as unknown as Position & {
    entrySolSpent: number;
    entryPricePerTokenSol: number;
    currentPricePerTokenSol: number;
    peakPricePerTokenSol: number;
  };
  // Old Solana fields still accessible
  assert.equal(migrated.entrySolSpent, 0.1);
  assert.equal(migrated.entryPricePerTokenSol, 0.00005);
  assert.equal(migrated.currentPricePerTokenSol, 0.00008);
  assert.equal(migrated.peakPricePerTokenSol, 0.00010);
});

// ---------------------------------------------------------------------------
// Solana → neutral field population test
// ---------------------------------------------------------------------------

test("Solana position populated with neutral fields mirrors Solana fields", () => {
  const pos: Position = {
    chain: "solana",
    tokenAddress: "MintAddr1111111111111111111111111111111",
    mint: "MintAddr1111111111111111111111111111111",
    name: "TestToken",
    status: "open",
    quoteSymbol: "SOL",
    entryQuoteSpent: 0.5,
    tokensHeld: 1000000n,
    tokenDecimals: 6,
    entryQuotePrice: 0.0000005,
    currentQuotePrice: 0.0000010,
    peakQuotePrice: 0.0000015,
    buyTxHash: "buy_sig_123",
    // Solana compatibility aliases
    entrySolSpent: 0.5,
    entryPricePerTokenSol: 0.0000005,
    currentPricePerTokenSol: 0.0000010,
    peakPricePerTokenSol: 0.0000015,
    entrySig: "buy_sig_123",
    armed: false,
    openedAt: Date.now(),
    lastTickAt: Date.now(),
  };

  assert.equal(pos.quoteSymbol, "SOL");
  assert.equal(pos.entryQuoteSpent, 0.5);
  assert.equal(pos.entrySolSpent, 0.5);
  assert.equal(pos.entryQuotePrice, 0.0000005);
  assert.equal(pos.entryPricePerTokenSol, 0.0000005);
  assert.equal(pos.currentQuotePrice, 0.0000010);
  assert.equal(pos.currentPricePerTokenSol, 0.0000010);
  assert.equal(pos.peakQuotePrice, 0.0000015);
  assert.equal(pos.peakPricePerTokenSol, 0.0000015);
  assert.equal(pos.buyTxHash, "buy_sig_123");
});

// ---------------------------------------------------------------------------
// Robinhood position uses neutral fields
// ---------------------------------------------------------------------------

test("Robinhood position has ETH quote symbol and neutral fields", () => {
  const pos: Position = {
    chain: "robinhood",
    tokenAddress: "0xdd5690e04bcac0f06e405362e0b3badb92dae711",
    mint: "0xdd5690e04bcac0f06e405362e0b3badb92dae711",
    name: "RHToken",
    status: "open",
    quoteSymbol: "ETH",
    entryQuoteSpent: 0.01,
    tokensHeld: 5000000000000000000n,
    tokenDecimals: 18,
    entryQuotePrice: 0.000000000000002,
    currentQuotePrice: 0.000000000000004,
    peakQuotePrice: 0.000000000000006,
    buyTxHash: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    // Solana compat aliases (zeroed/nonsense for EVM, but present for type compat)
    entrySolSpent: 0,
    entryPricePerTokenSol: 0,
    currentPricePerTokenSol: 0,
    peakPricePerTokenSol: 0,
    entrySig: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    armed: false,
    openedAt: Date.now(),
    lastTickAt: Date.now(),
  };

  assert.equal(pos.quoteSymbol, "ETH");
  assert.equal(pos.entryQuoteSpent, 0.01);
  assert.equal(pos.chain, "robinhood");
  assert.equal(pos.buyTxHash, "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890");
});

// ---------------------------------------------------------------------------
// Partial exit compatibility (Solana)
// ---------------------------------------------------------------------------

test("partial exits preserve entrySol field for Solana positions", () => {
  const pos: Position = {
    chain: "solana",
    tokenAddress: "MintAddr2222222222222222222222222222222",
    mint: "MintAddr2222222222222222222222222222222",
    name: "PartialToken",
    status: "open",
    quoteSymbol: "SOL",
    entryQuoteSpent: 0.4,
    tokensHeld: 500000n,
    tokenDecimals: 6,
    entryQuotePrice: 0.0000004,
    currentQuotePrice: 0.0000005,
    peakQuotePrice: 0.0000008,
    entrySolSpent: 0.4,
    entryPricePerTokenSol: 0.0000004,
    currentPricePerTokenSol: 0.0000005,
    peakPricePerTokenSol: 0.0000008,
    armed: true,
    openedAt: Date.now() - 300000,
    lastTickAt: Date.now(),
    partialExits: [
      {
        at: Date.now() - 60000,
        sellPct: 0.5,
        entrySol: 0.2,
        exitSol: 0.3,
        pnlSol: 0.1,
        priceSol: 0.0000006,
        reason: "take_profit:50%",
      },
    ],
  };

  assert.equal(pos.partialExits!.length, 1);
  assert.equal(pos.partialExits![0]!.entrySol, 0.2);
  assert.equal(pos.partialExits![0]!.exitSol, 0.3);
  assert.equal(pos.partialExits![0]!.pnlSol, 0.1);
});

// ---------------------------------------------------------------------------
// Persistence round-trip: Solana
// ---------------------------------------------------------------------------

test("Solana position round-trips through serialize/deserialize", () => {
  const pos: Position = {
    chain: "solana",
    tokenAddress: "RoundTrip111111111111111111111111111111",
    mint: "RoundTrip111111111111111111111111111111",
    name: "RoundTripToken",
    status: "open",
    quoteSymbol: "SOL",
    entryQuoteSpent: 0.25,
    tokensHeld: 750000n,
    tokenDecimals: 6,
    entryQuotePrice: 0.000000333,
    currentQuotePrice: 0.0000005,
    peakQuotePrice: 0.0000006,
    buyTxHash: "buy_tx_rt",
    entrySolSpent: 0.25,
    entryPricePerTokenSol: 0.000000333,
    currentPricePerTokenSol: 0.0000005,
    peakPricePerTokenSol: 0.0000006,
    entrySig: "buy_tx_rt",
    armed: true,
    openedAt: 1700000000000,
    lastTickAt: 1700000005000,
    partialExits: [
      {
        at: 1700000003000,
        sellPct: 0.25,
        entrySol: 0.0625,
        exitSol: 0.1,
        pnlSol: 0.0375,
        priceSol: 0.0000004,
        reason: "take_profit:100%",
        sig: "sell_tx_rt",
      },
    ],
  };

  // Simulate serialize → deserialize
  const serialized = {
    ...pos,
    tokensHeld: pos.tokensHeld.toString(),
    originalTokensHeld: pos.originalTokensHeld?.toString(),
  };
  const raw = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>;
  const migrated = migratePersistedPosition(raw) as unknown as Position & {
    entrySolSpent: number;
    tokensHeld: bigint;
  };

  assert.equal(migrated.chain, "solana");
  assert.equal(migrated.quoteSymbol, "SOL");
  assert.equal(migrated.entrySolSpent, 0.25);
  assert.equal(migrated.entryQuoteSpent, 0.25);
  assert.equal(migrated.mint, "RoundTrip111111111111111111111111111111");
});

// ---------------------------------------------------------------------------
// Persistence round-trip: Robinhood
// ---------------------------------------------------------------------------

test("Robinhood position round-trips through serialize/deserialize", () => {
  const pos: Position = {
    chain: "robinhood",
    tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mint: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "RHTest",
    status: "open",
    quoteSymbol: "ETH",
    entryQuoteSpent: 0.02,
    tokensHeld: 1000000000000000000n,
    tokenDecimals: 18,
    entryQuotePrice: 0.00000000000000002,
    currentQuotePrice: 0.00000000000000004,
    peakQuotePrice: 0.00000000000000005,
    buyTxHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    exitTxHash: undefined,
    entrySolSpent: 0,
    entryPricePerTokenSol: 0,
    currentPricePerTokenSol: 0,
    peakPricePerTokenSol: 0,
    entrySig: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    armed: false,
    openedAt: 1700000000000,
    lastTickAt: 1700000005000,
  };

  const serialized = {
    ...pos,
    tokensHeld: pos.tokensHeld.toString(),
  };
  const raw = JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>;
  const migrated = migratePersistedPosition(raw) as unknown as Position & { tokensHeld: bigint };

  assert.equal(migrated.chain, "robinhood");
  assert.equal(migrated.quoteSymbol, "ETH");
  assert.equal(migrated.entryQuoteSpent, 0.02);
  assert.equal(migrated.tokenAddress, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

// ---------------------------------------------------------------------------
// Migration: old state without quoteSymbol gets correct default
// ---------------------------------------------------------------------------

test("old persisted Solana state without quoteSymbol defaults to SOL", () => {
  const old = {
    mint: "OldieButGoodie111111111111111111111111",
    tokensHeld: "5000",
    status: "open",
    entrySolSpent: 0.02,
    entryPricePerTokenSol: 0.000004,
  };
  const migrated = migratePersistedPosition(old);
  assert.equal(migrated.quoteSymbol, "SOL");
  assert.equal(migrated.chain, "solana");
});

test("robinhood state without quoteSymbol defaults to ETH", () => {
  const old = {
    chain: "robinhood",
    tokenAddress: "0xBEEF000000000000000000000000000000000000",
    mint: "0xBEEF000000000000000000000000000000000000",
    tokensHeld: "100",
    status: "open",
  };
  const migrated = migratePersistedPosition(old);
  assert.equal(migrated.quoteSymbol, "ETH");
  assert.equal(migrated.chain, "robinhood");
});
