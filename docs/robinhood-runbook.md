# Robinhood Chain Canary Runbook

## Safety state

Robinhood live execution is **disabled by default**. The adapter provides read-only V2 Router quotes, but signing is intentionally not implemented. Do not treat a passing quote or gate test as authorization to trade.

## Required gates

Every gate must pass immediately before any future signing path:

1. `DRY_RUN=false`.
2. `ROBINHOOD_LIVE_ENABLED=true`.
3. Source mode is `dexscreener_live` or `dexscreener_only`.
4. RPC chain ID is exactly `4663`.
5. `EVM_PRIV_KEY` is configured outside Telegram/runtime settings.
6. Wallet ETH balance is at least `ROBINHOOD_MIN_ETH_BALANCE`.
7. Buy amount does not exceed `ROBINHOOD_MAX_BUY_ETH`.
8. Gas, slippage, and price impact are within hard caps.
9. Fresh buy and reverse-sell quotes both exist.
10. No chain-qualified position or transaction is already in flight.
11. Paper analysis reports the configured minimum completed sample.

## Wallet and funding

- Use a dedicated Robinhood Chain wallet with capital limited to the canary amount.
- Fund it manually with ETH on chain `4663`.
- Keep the private key only in `.env`; never paste it into Telegram.
- Maintain the configured gas reserve after every planned purchase.
- Do not bridge automatically.

## Preflight

Invoke through the `terminal` tool:

```bash
npm test
npm run typecheck
npm run doctor
node --import tsx scripts/analyze-robinhood-paper-trades.ts state/robinhood-paper-events.jsonl 30
```

Stop if any command fails or `liveEligible` is false.

## First canary

1. Set maximum concurrent Robinhood positions to one.
2. Use the minimum practical buy amount below `ROBINHOOD_MAX_BUY_ETH`.
3. Require manual approval for each initial entry.
4. Confirm a fresh token→WETH reverse quote before entry.
5. Keep chain-scoped pause available throughout the transaction.
6. Do not increase size after a buy alone; a successful full exit and restart recovery are required.

## Blockscout verification

For every canary transaction verify:

- chain ID `4663`;
- expected wallet;
- expected token contract;
- successful receipt;
- actual ETH and token balance deltas;
- approval amount is bounded, never unlimited;
- full exit succeeds;
- no duplicate transaction exists for the chain-qualified position key.

## Pause and emergency exit

- Pause Robinhood entries without pausing Solana management.
- Emergency sell must identify the position by `robinhood:<lowercase contract>`.
- Emergency exit still requires a fresh executable sell quote.
- If the quote is unavailable, preserve the position state, alert, and retry manually; never report it as sold.

## Restart recovery

1. Stop the process cleanly.
2. Confirm the position is persisted with chain, token address, quote symbol, token amount, and transaction hash.
3. Restart in dry-run/watch mode first.
4. Reconcile the persisted amount with the on-chain ERC-20 balance.
5. Resume management only after chain ID and sellability checks pass.

## Secret rotation

1. Pause Robinhood.
2. Stop the process.
3. Replace `EVM_PRIV_KEY` and, if needed, `EVM_RPC_URL` in `.env`.
4. Restart in `DRY_RUN=true`.
5. Verify address, chain ID, balance, quotes, and persisted state.
6. Never expose or modify secrets through Telegram settings.

## Expansion criteria

Do not increase automation, concurrent positions, or size until multiple complete buy/sell/restart cycles finish without manual repair and the paper/canary evidence remains acceptable.
