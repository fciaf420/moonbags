# Robinhood Dexscreener MoonBags Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Extend MoonBags so it discovers fresh Robinhood Chain tokens with the Dexscreener scanner, qualifies momentum over repeated scans, and manages dry-run then live Uniswap entries/exits from a dedicated EVM wallet.

**Architecture:** Keep Dexscreener as an external discovery process and consume its JSON from a new `dexscreenerRobinhoodSource.ts`, modeled on the existing OKX/GMGN source lifecycle. Refactor the position manager behind a small chain execution/market-data adapter so existing stop, trail, take-profit, persistence, and Telegram behavior can work with either Solana/Jupiter or Robinhood/Uniswap without mixing keys or transaction logic. Use Uniswap’s officially supported chain `4663` path for execution, subject to a quote-only spike before implementation.

**Tech Stack:** Node.js 20, TypeScript, built-in `node:test`, `tsx`, `viem`, Dexscreener CLI/MCP, Robinhood Chain RPC, Blockscout v2 API, Uniswap Trading API.

---

## Assumptions and decisions

1. **MoonBags remains multi-chain.** Existing Solana behavior must continue to work; Robinhood support is additive.
2. **Dexscreener discovers; MoonBags decides.** Do not merge Python scanner internals into the TypeScript repository.
3. **The first release is watch-only.** No signing until discovery, filtering, simulated positions, pricing, persistence, and simulated exits work together.
4. **Uniswap is the preferred execution route.** Robinhood documents Uniswap as its public DEX, and Uniswap documents swapping support for chain ID `4663`. The quote-only spike below must prove the exact current API contract before implementation.
5. **Use a dedicated EVM key.** Never reinterpret `PRIV_B58` as an EVM key.
6. **One process, two adapters.** Avoid a second copied position manager; extract only the execution and pricing seams needed by the existing lifecycle.
7. **Initial discovery thresholds are conservative placeholders.** Record rejected and accepted candidates, then tune from observed Robinhood data before live entry.

## Success criteria

- `npm test` and `npm run typecheck` pass.
- Existing Solana tests prove the Jupiter adapter behavior is unchanged.
- Repeated Robinhood scans do not emit historical or duplicate candidates.
- Accepted candidates contain chain ID, contract address, liquidity, pair age, transaction acceleration, and Blockscout holder count.
- Watch mode sends no quote, approval, or transaction.
- Dry-run mode opens, ticks, trails/stops, persists, restarts, and closes a simulated Robinhood position.
- EVM quote mode validates chain ID `4663`, buy/sell routability, gas, price impact, allowance, and sellability without signing.
- Live mode is impossible unless explicit EVM enablement, wallet, limits, and a sell quote are all present.

---

### Task 1: Establish a test harness and clean baseline

**Objective:** Add a repeatable TypeScript test command before changing behavior.

**Files:**
- Modify: `package.json`
- Create: `test/smoke.test.ts`

**Steps:**

1. Add the script:
   ```json
   "test": "node --import tsx --test test/*.test.ts"
   ```
2. Write `test/smoke.test.ts` with one built-in `node:test` assertion.
3. Run:
   ```bash
   npm test
   npm run typecheck
   npm run doctor
   ```
4. Verify the test passes and record any pre-existing doctor failure without fixing unrelated code.
5. Commit:
   ```bash
   git add package.json test/smoke.test.ts
   git commit -m "test: add TypeScript test harness"
   ```

---

### Task 2: Prove the machine-readable Dexscreener contract

**Objective:** Freeze the Robinhood scanner output MoonBags will consume.

**Files:**
- Create: `test/fixtures/dexscreener-robinhood-hot.json`
- Create: `src/dexscreenerTypes.ts`
- Create: `test/dexscreenerTypes.test.ts`

**Steps:**

1. Run from the scanner repository:
   ```bash
   ./ds setup
   ./ds hot --chains robinhood --limit 10 --json
   ```
2. Save a redacted representative result as the fixture. Preserve actual field names; do not invent aliases.
3. Write a failing parser test covering valid output, malformed JSON, setup-tip prefixes, wrong `chainId`, and missing contract address.
4. Implement only the parser/types required by the fixture.
5. Run:
   ```bash
   npm test -- test/dexscreenerTypes.test.ts
   npm run typecheck
   ```
6. Commit:
   ```bash
   git add src/dexscreenerTypes.ts test/dexscreenerTypes.test.ts test/fixtures/dexscreener-robinhood-hot.json
   git commit -m "feat: parse Robinhood Dexscreener candidates"
   ```

---

### Task 3: Add chain identity without changing Solana execution

**Objective:** Make signals and persisted positions distinguish Solana mints from Robinhood ERC-20 addresses.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/positionManager.ts`
- Create: `test/positionIdentity.test.ts`

**Steps:**

1. Write failing tests for canonical keys:
   - `solana:<mint>`
   - `robinhood:<lowercase-address>`
   - invalid EVM addresses rejected.
2. Add `chain: "solana" | "robinhood"` and `tokenAddress` to `SignalAlert` and `Position`.
3. Keep `mint` as a temporary deprecated alias for Solana call sites during migration.
4. Change dedupe maps/sets from raw mint to canonical chain-qualified position keys.
5. Add backward-compatible deserialization: old state rows without `chain` load as `solana`.
6. Run tests and typecheck.
7. Commit:
   ```bash
   git add src/types.ts src/positionManager.ts test/positionIdentity.test.ts
   git commit -m "refactor: add chain-qualified position identity"
   ```

---

### Task 4: Implement a watchlist-based Robinhood source

**Objective:** Poll Dexscreener, seed history, track repeated snapshots, and emit only fresh qualified momentum.

**Files:**
- Create: `src/dexscreenerRobinhoodSource.ts`
- Create: `test/dexscreenerRobinhoodSource.test.ts`
- Modify: `src/settingsStore.ts`

**Steps:**

1. Model lifecycle functions after existing sources: start, refresh, status, and stop.
2. Inject the CLI runner and clock in tests; never spawn the real CLI from unit tests.
3. Add source modes `dexscreener_watch`, `dexscreener_live`, and `dexscreener_only`.
4. Add settings under `signals.dexscreener`:
   - enabled
   - executable path
   - poll interval
   - seed limit
   - cooldown
   - watchlist TTL and cap
   - minimum repeated scans
   - minimum liquidity and holders
   - maximum market cap
   - minimum buy/sell ratio
   - minimum H1 transaction count
   - minimum H1 price/volume acceleration
5. First poll must seed state and emit nothing.
6. Subsequent polls update snapshots and emit only when the same contract satisfies the configured trigger across the minimum scan count.
7. Reuse `checkSignalMintCooldown`, `markSignalMintAccepted`, pause, blacklist, and `recordAlertEvent` behavior.
8. Run tests and typecheck.
9. Commit:
   ```bash
   git add src/dexscreenerRobinhoodSource.ts src/settingsStore.ts test/dexscreenerRobinhoodSource.test.ts
   git commit -m "feat: add Robinhood Dexscreener signal source"
   ```

---

### Task 5: Add Blockscout concentration filtering

**Objective:** Reject dangerous holder distributions without counting pools and system contracts as ordinary whales.

**Files:**
- Create: `src/robinhoodBlockscout.ts`
- Create: `test/robinhoodBlockscout.test.ts`
- Modify: `src/dexscreenerRobinhoodSource.ts`
- Modify: `src/settingsStore.ts`

**Steps:**

1. Write fixtures for:
   - token metadata from `/api/v2/tokens/{address}`
   - holders from `/api/v2/tokens/{address}/holders`
   - verified contracts and pool/router addresses.
2. Implement paginated holder retrieval with timeout, cache, and bounded page count.
3. Calculate two values:
   - raw top-holder concentration;
   - adjusted concentration excluding labeled pools, routers, bridges, vaults, zero/burn addresses, and verified system contracts.
4. Fail closed for live entry when concentration data is unavailable; watch mode may record `unknown`.
5. Add configurable maximum adjusted top-10 concentration.
6. Run tests and typecheck.
7. Commit:
   ```bash
   git add src/robinhoodBlockscout.ts src/dexscreenerRobinhoodSource.ts src/settingsStore.ts test/robinhoodBlockscout.test.ts
   git commit -m "feat: filter Robinhood holder concentration"
   ```

---

### Task 6: Wire watch-only discovery into the application

**Objective:** Start the Robinhood source and expose candidates without buying.

**Files:**
- Modify: `src/main.ts`
- Modify: `src/notifier.ts`
- Modify: `src/server.ts`
- Modify: `src/telegramBot.ts`
- Create: `test/robinhoodWatchMode.test.ts`

**Steps:**

1. Add start/stop wiring alongside the existing OKX and GMGN sources.
2. In watch mode, notify and record accepted candidates but never call `openPosition()`.
3. Add source status, last scan, candidate/rejection counters, and rejection reason to dashboard/API output.
4. Add Telegram source controls matching existing `/sources` conventions.
5. Test that watch mode cannot invoke the position opening callback.
6. Run:
   ```bash
   npm test
   npm run typecheck
   DRY_RUN=true npm start
   ```
7. Observe at least one full seed + rescan cycle and confirm zero transaction attempts.
8. Commit:
   ```bash
   git add src/main.ts src/notifier.ts src/server.ts src/telegramBot.ts test/robinhoodWatchMode.test.ts
   git commit -m "feat: wire Robinhood watch mode"
   ```

---

### Task 7: Spike the official Uniswap quote path

**Objective:** Verify the exact current Robinhood quote, approval, and transaction API before writing production execution code.

**Files:**
- Create: `spikes/uniswap-robinhood-quote.ts`
- Create: `docs/robinhood-uniswap-spike.md`

**Steps:**

1. Create a Uniswap developer API key.
2. Using current official Uniswap Trading API documentation, request an unsigned ETH→token quote on chain `4663` for a liquid token seen in Dexscreener.
3. Request the reverse token→ETH quote.
4. Record exact endpoint, headers, request/response schema, routing type, approval behavior, calldata fields, price impact, gas estimate, and error behavior.
5. Verify the returned transaction targets against official deployment data and Blockscout.
6. Do not sign or broadcast.
7. If the API cannot quote both directions, stop the implementation and evaluate direct Universal Router v2.0 integration as a separate plan amendment.
8. Commit the findings, not secrets:
   ```bash
   git add spikes/uniswap-robinhood-quote.ts docs/robinhood-uniswap-spike.md
   git commit -m "spike: verify Robinhood Uniswap quote flow"
   ```

---

### Task 8: Add the EVM wallet and execution adapter

**Objective:** Provide quote, buy, sell, balance, decimals, receipt, and recovery operations for Robinhood without touching Jupiter code.

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts`
- Create: `src/tradingAdapter.ts`
- Create: `src/robinhoodEvmClient.ts`
- Create: `src/robinhoodUniswapAdapter.ts`
- Create: `test/robinhoodUniswapAdapter.test.ts`

**Steps:**

1. Add `viem`.
2. Define the minimum adapter used by position management: quote buy/sell, execute buy/sell, read balance/decimals, and recover receipt state.
3. Add Robinhood configuration for RPC, chain ID, dedicated EVM key, Uniswap API credential, buy size in ETH, slippage/price-impact limits, max gas, and explicit live enablement.
4. Validate `eth_chainId === 4663` before every signing path.
5. Implement quote-only and dry-run paths first.
6. Implement ERC-20 approval only when required by the verified Uniswap response; use exact-amount approval rather than unlimited approval.
7. Verify receipt status and actual token balance delta rather than trusting quoted output.
8. Unit-test every HTTP/RPC/signing boundary with mocks; assert secrets never enter logs.
9. Run tests and typecheck.
10. Commit:
   ```bash
   git add package.json src/config.ts src/tradingAdapter.ts src/robinhoodEvmClient.ts src/robinhoodUniswapAdapter.ts test/robinhoodUniswapAdapter.test.ts
   git commit -m "feat: add Robinhood Uniswap trading adapter"
   ```

---

### Task 9: Extract Solana into the same adapter contract

**Objective:** Preserve current Jupiter behavior while removing direct Solana imports from position lifecycle logic.

**Files:**
- Create: `src/solanaJupiterAdapter.ts`
- Modify: `src/jupClient.ts`
- Modify: `src/positionManager.ts`
- Create: `test/solanaJupiterAdapter.test.ts`

**Steps:**

1. Write characterization tests around existing `buyTokenWithSol`, `sellTokenForSol`, balance, decimals, and sell-quote behavior.
2. Wrap those functions in the trading adapter without rewriting `jupClient.ts` internals.
3. Resolve the adapter from `position.chain`.
4. Replace direct calls in `positionManager.ts` with adapter calls.
5. Keep all existing Solana notifications and stored-state migration passing.
6. Run the full suite and typecheck.
7. Commit:
   ```bash
   git add src/solanaJupiterAdapter.ts src/jupClient.ts src/positionManager.ts test/solanaJupiterAdapter.test.ts
   git commit -m "refactor: route Solana trading through adapter"
   ```

---

### Task 10: Make position accounting quote-asset neutral

**Objective:** Reuse MoonBags’ exit logic for both SOL and ETH positions without corrupting historical state.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/positionManager.ts`
- Modify: `src/settingsStore.ts`
- Modify: `src/notifier.ts`
- Modify: `src/server.ts`
- Create: `test/multichainPositionAccounting.test.ts`

**Steps:**

1. Add neutral fields for entry quote spent, current/entry/peak quote price, realized quote PnL, quote symbol, and chain transaction hashes.
2. Deserialize old SOL fields into neutral fields while continuing to write enough compatibility data for one release.
3. Key PnL and notification labels by `quoteSymbol` (`SOL` or `ETH`).
4. Keep percentage-based arm, trail, stop, TP ladder, and moonbag logic shared.
5. Ensure token amounts stay `bigint`; avoid converting raw balances to floating point before display/PnL boundaries.
6. Test Solana state migration, Robinhood persistence, partial exits, restart recovery, and dedupe.
7. Run full tests and typecheck.
8. Commit:
   ```bash
   git add src/types.ts src/positionManager.ts src/settingsStore.ts src/notifier.ts src/server.ts test/multichainPositionAccounting.test.ts
   git commit -m "refactor: make position accounting chain neutral"
   ```

---

### Task 11: Add Robinhood pricing and exit simulation

**Objective:** Tick positions and prove sellability using Dexscreener plus executable Uniswap sell quotes.

**Files:**
- Modify: `src/priceFeed.ts`
- Create: `src/robinhoodPriceFeed.ts`
- Modify: `src/positionManager.ts`
- Create: `test/robinhoodPriceFeed.test.ts`
- Create: `test/robinhoodPositionLifecycle.test.ts`

**Steps:**

1. Use Dexscreener USD price for frequent ticks.
2. Periodically verify with an executable token→ETH Uniswap quote for the held amount.
3. If sources diverge beyond a configured tolerance, suppress automatic profit exits and alert; emergency/manual exit remains available through a fresh executable quote.
4. Simulate buy, price rise, arm, trail, partial TP, stop, timeout, and restart recovery.
5. Require a sell quote before accepting a dry-run entry; unsellable tokens are rejected.
6. Run the complete suite and typecheck.
7. Commit:
   ```bash
   git add src/priceFeed.ts src/robinhoodPriceFeed.ts src/positionManager.ts test/robinhoodPriceFeed.test.ts test/robinhoodPositionLifecycle.test.ts
   git commit -m "feat: manage Robinhood position lifecycle"
   ```

---

### Task 12: Add hard live-trading gates

**Objective:** Make accidental Robinhood mainnet execution structurally difficult.

**Files:**
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Modify: `src/robinhoodUniswapAdapter.ts`
- Modify: `src/telegramBot.ts`
- Create: `test/robinhoodLiveGates.test.ts`

**Steps:**

1. Require all of the following for live Robinhood execution:
   - global dry run disabled;
   - Robinhood-specific live flag enabled;
   - source in an explicit live mode;
   - chain ID exactly `4663`;
   - wallet ETH balance above gas reserve;
   - buy amount, gas, slippage, and price impact under hard caps;
   - fresh buy and sell quotes;
   - no existing position or in-flight transaction for the contract.
2. Do not allow Telegram runtime settings to modify wallet keys, RPC, chain ID, or the Robinhood live flag.
3. Add pause and emergency sell controls scoped by chain-qualified position key.
4. Test every missing prerequisite fails closed.
5. Run full tests and typecheck.
6. Commit:
   ```bash
   git add src/config.ts src/main.ts src/robinhoodUniswapAdapter.ts src/telegramBot.ts test/robinhoodLiveGates.test.ts
   git commit -m "feat: enforce Robinhood live trading gates"
   ```

---

### Task 13: Paper-trade and tune from observed data

**Objective:** Validate that “hot” detection is early enough and not merely buying completed pumps.

**Files:**
- Create: `scripts/analyze-robinhood-paper-trades.ts`
- Create: `docs/robinhood-paper-results.md`

**Steps:**

1. Run watch/dry-run continuously for at least several market cycles.
2. Persist every snapshot, rejection, accepted entry, simulated exit, max favorable excursion, max adverse excursion, liquidity change, and holder change.
3. Compare outcomes by pair age, liquidity, holders, adjusted concentration, buy/sell ratio, transaction acceleration, and score component.
4. Choose thresholds from observed precision/recall and survivorship, not anecdotal winners.
5. Require a minimum sample before live enablement; document the chosen threshold and why.
6. Commit analysis and configuration changes separately.

---

### Task 14: Canary rollout with dedicated capital

**Objective:** Prove complete live buy/recovery/sell behavior at minimal exposure.

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Create: `docs/robinhood-runbook.md`

**Steps:**

1. Document wallet funding, ETH gas reserve, startup, pause, force sell, state recovery, and secret rotation.
2. Start with one concurrent position and the minimum practical buy size.
3. Manually approve each of the first live entries.
4. Verify on Blockscout:
   - chain `4663`;
   - expected wallet;
   - expected token contract;
   - successful receipt;
   - actual balance delta;
   - approval amount;
   - successful full exit.
5. Do not increase automation or size until multiple buy/sell/restart cycles complete without manual repair.
6. Run final checks:
   ```bash
   npm test
   npm run typecheck
   npm run doctor
   ```
7. Commit:
   ```bash
   git add .env.example README.md docs/robinhood-runbook.md
   git commit -m "docs: add Robinhood trading runbook"
   ```

---

## Recommended initial entry model

Use a **two-stage watchlist**, not immediate purchase of the top `hot` row:

1. **Discovery gate:** Robinhood chain only, fresh pair, sufficient liquidity, non-null Blockscout holders, bounded market cap, and valid token address.
2. **Momentum confirmation:** at least two scans with rising transactions/volume, buy/sell ratio above threshold, no material liquidity withdrawal, holder growth, and acceptable adjusted concentration.
3. **Execution gate:** fresh Uniswap buy quote, fresh reverse sell quote, bounded price impact/gas, chain ID `4663`, and no duplicate/in-flight position.
4. **Exit management:** MoonBags percentage-based stop, arm/trail, TP ladder, moonbag remainder, timeout, and emergency manual sell using executable ETH-denominated quotes.

## Explicitly out of scope for v1

- Copying Python scanner internals into MoonBags.
- Bridging funds automatically.
- Multi-wallet rotation.
- MEV/private orderflow optimization.
- Arbitrary EVM chains beyond Robinhood.
- Smart-contract wallet or account-abstraction execution.
- Unlimited ERC-20 approvals.
- LLM-controlled live entry before deterministic gates are validated.
