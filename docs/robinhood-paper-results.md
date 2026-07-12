# Robinhood Paper-Trading Results

## Status

- Required completed-paper-trade sample: **30**
- Current completed sample: **0**
- Live eligible: **No**
- Reason: no completed Robinhood paper-trade lifecycle has been recorded yet.

This document must be regenerated from `state/robinhood-paper-events.jsonl`; results must never be inferred from isolated winners or current trending rows.

## Capture

The watch source records JSONL events for:

- every Dexscreener snapshot;
- every deterministic rejection and its reason;
- every accepted candidate;
- lifecycle closes once Robinhood position management is enabled.

## Analyze

Invoke through the `terminal` tool:

```bash
node --import tsx scripts/analyze-robinhood-paper-trades.ts state/robinhood-paper-events.jsonl 30
```

`liveEligible` must remain `false` until at least 30 completed paper trades are present. Meeting the sample size is necessary but not sufficient: observed sellability, drawdown, liquidity loss, holder changes, and failure rates must also be reviewed before any canary.

## Threshold policy

Do not tune from anecdotal winners. Compare completed outcomes by:

- pair age;
- liquidity;
- holder count and growth;
- adjusted top-10 concentration;
- buy/sell ratio;
- transaction and volume acceleration;
- component and aggregate score;
- maximum favorable/adverse excursion.

Threshold changes must be committed separately from raw observations.
