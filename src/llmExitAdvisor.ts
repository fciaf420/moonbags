/**
 * LLM exit advisor for open meme-token positions.
 *
 * Provider: MiniMax (OpenAI-compatible chat completions API).
 *   - Endpoint: https://api.minimax.io/v1/chat/completions
 *   - Model:    MiniMax-M2.7
 *   - Auth:     Bearer ${MINIMAX_API_KEY}
 *
 * Design choice: OPTION A (single-shot tool calling).
 *   We poll exit logic every ~30s and pre-fetch a full PositionSnapshot
 *   from okxClient.getPositionSnapshot() before calling the LLM. Freshness
 *   isn't an issue, so paying for extra round-trips just to let the model
 *   re-fetch the same data we already have wastes latency and tokens. We
 *   compress the snapshot into a compact text/JSON summary, force the model
 *   to call a single `submit_decision(action, reason, new_trail_pct?)` tool,
 *   and parse its arguments. The trailing stop remains the default exit —
 *   the LLM only overrides it when there's a clear cue.
 *
 * On any failure (missing key, network error, API error, malformed tool
 * call, schema mismatch) we return null and let the caller fall back to
 * the existing trail logic.
 */

import logger from "./logger.js";
import type {
  PositionSnapshot,
  PriceMomentum,
  TradeWindow,
  TopHoldersSnapshot,
  LiquidityPool,
  TokenRisk,
  SignalRecord,
  Candle,
} from "./okxClient.js";
import {
  recordSnapshot,
  recordDecision,
  appendLlmPromptAudit,
  getDecisions,
  computeTrends,
  readLlmTradeRecords,
  type DecisionRecord,
} from "./llmMemory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export type LlmDecision = {
  action: "hold" | "exit_now" | "set_trail" | "partial_exit";
  reason: string;
  citedFacts?: EvidenceKey[];
  evidenceKeys?: EvidenceKey[];
  gate?: EvidenceGate;
  newTrailPct?: number;
  // For partial_exit: fraction of CURRENT tokensHeld to sell (0.10 – 0.75).
  // The remaining position stays open with its existing trail/stop/LLM coverage.
  sellPct?: number;
};

export type LlmTpTarget = { pnlPct: number; sellPct: number };

export type LlmContext = {
  name: string;
  mint: string;
  entryPriceUsd: number;
  currentPriceUsd: number;
  pnlPct: number;
  peakPnlPct: number;
  drawdownFromPeakPct: number;
  currentTrailPct: number;
  ceilingTrailPct: number;       // CONFIG.TRAIL_PCT — max trail the LLM may set
  holdSecs: number;
  // TP ladder context — present when tp_ladder strategy is active alongside LLM.
  tpTargets?: LlmTpTarget[];
  tpTargetsHit?: number[];        // indices of targets already fired
  positionSizeRemainingPct?: number; // fraction of original tokens still held (1.0 = no sells yet)
};

const EVIDENCE_KEYS = [
  // ── Bearish / reactive ──────────────────────────────────────────────────
  "bundlerDistribution",
  "smartMoneySelling",
  "topHolderCapitulation",
  "volumeCliff",
  "roundTripRisk",
  // ── Proactive / overbought (sell-into-strength signals) ─────────────────
  "priceAcceleration",   // single 1m candle parabolic move detected
  "volumeBlowoff",       // 5m volume ≥ 3× hourly per-5m average
  "txRatioBurst",        // 5m tx count ≥ 2× hourly per-5m average
  "pctFromAthSpike",     // price within 5% of all-time high on a +100% winner
] as const;

const BEARISH_KEYS = [
  "bundlerDistribution",
  "smartMoneySelling",
  "topHolderCapitulation",
  "volumeCliff",
  "roundTripRisk",
] as const satisfies readonly (typeof EVIDENCE_KEYS)[number][];

const PROACTIVE_KEYS = [
  "priceAcceleration",
  "volumeBlowoff",
  "txRatioBurst",
  "pctFromAthSpike",
] as const satisfies readonly (typeof EVIDENCE_KEYS)[number][];

type EvidenceKey = typeof EVIDENCE_KEYS[number];

type EvidenceFact = {
  key: EvidenceKey;
  active: boolean;
  detail: string;
  metrics: Record<string, number | string | boolean | null>;
};

type EvidenceGate = {
  activeBearishKeys: EvidenceKey[];
  activeProactiveKeys: EvidenceKey[];
  partialExitAllowed: boolean;
  exitNowAllowed: boolean;
  tightenAllowed: boolean;
  reasons: string[];
  blockedAction?: "partial_exit" | "exit_now" | "set_trail";
};

type EvidencePacket = {
  facts: Record<EvidenceKey, EvidenceFact>;
  gate: EvidenceGate;
};

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------
const MINIMAX_ENDPOINT = "https://api.minimax.io/v1/chat/completions";
const MINIMAX_MODEL = "MiniMax-M2.7";
// M2.7 with reasoning_split: true (interleaved thinking) regularly takes
// 15-25s on convergence-rule reasoning over a rich snapshot. 20s was too
// tight — about half of consults were hitting this timeout. 45s gives
// comfortable headroom while still being under the 30s poll-to-30s poll
// window where back-to-back aborted calls could pile up.
const HTTP_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 2000;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an exit-decision advisor for a Solana meme-token auto-trading bot.

For each open position you are given:
  - the position context (entry, current price, PnL %, peak PnL %, drawdown
    from peak, the trailing-stop % currently in effect, the MAX trail allowed
    (ceilingTrailPctDecimal), hold duration)
  - an on-chain snapshot: price/volume momentum across 5m/1h/4h/24h, recent
    smart-money / bundler / dev / whale / insider trade windows, top-10
    holders' avg PnL and trend, liquidity pools, token risk profile, recent
    smart-money signals, and a compact 1m + 5m kline summary.
  - an \`evidence\` block of deterministic facts. Treat this as the source of
    truth for aggressive actions. Facts come in two categories:

    BEARISH (reactive — wait for confirmation of reversal):
    \`bundlerDistribution\`, \`smartMoneySelling\`, \`topHolderCapitulation\`,
    \`volumeCliff\`, \`roundTripRisk\`.

    PROACTIVE (overbought — sell INTO strength before the reversal):
    \`priceAcceleration\`  — single 1m candle body ≥ 35% or wick ≥ 50% on a
                             +100% winner. Classic blow-off extension.
    \`volumeBlowoff\`      — current 5m volume ≥ 3× the per-5m hourly average.
                             Volume climax; retail/FOMO chase near the top.
    \`txRatioBurst\`       — 5m transaction count ≥ 2× the per-5m hourly average.
                             Retail crowd piling in — a late-cycle FOMO surge.
    \`pctFromAthSpike\`    — token is within 5% of its all-time high while you
                             are up 100%+. ATH is the strongest resistance level.

    Proactive facts fire while the price is STILL RISING. They signal that the
    move is exhausting itself. When these fire, the correct action is to capture
    profit NOW, before the reversal is confirmed by on-chain data. Do not wait
    for bearish confirmation when the blow-off pattern is active.
  - a \`trends\` block showing how each signal has EVOLVED over the last ~5
    snapshots (oldest → newest, spanning ~2 minutes). Use it to distinguish:
      * ACCELERATING bullish (smart money + volume both climbing): don't tighten
      * DECELERATING pump (price rising but volume/flow fading): consider tightening
      * BLOWOFF TOP (vertical price + smart-money NET SELLING): consider exit
      * Cold start (trends == null): be conservative, prefer hold
  - a \`recentDecisions\` block showing YOUR prior decisions on this position.
    If you tightened recently and the trade continued up, that's signal that
    the tighten was premature — consider LOOSENING back up via set_trail.
    Do not keep tightening on every poll: that compounds errors.
  - (optional) a \`recent_track_record\` block. This ONLY appears after you
    have ≥20 closed trades on record, and shows your verdict histogram across
    recent trades: \`premature_tighten\` / \`correct_tighten\` / \`premature_exit\`
    / \`correct_exit\` / \`held_well\` / \`stuck_loser\` / \`mixed\`. If this
    block is present, use it to CORRECT your own biases:
      * High premature_tighten count → you over-tighten. Weight HOLD harder.
      * High premature_exit count → you jeet too early. Require stronger
        convergence before calling exit_now.
      * High stuck_loser count → you hold losers too long. Act on clear danger.
    If this block is absent, you're still in cold-start data-collection mode.

Position prices (entryPriceSol/currentPriceSol) are denominated in SOL per
token. The token's USD price lives in snapshot.momentum.priceUsd. Do not
compare these directly without converting.

Trade-window wording discipline:
  - netFlowSol is buyVolumeSol - sellVolumeSol. Negative means net selling;
    positive means net buying.
  - uniqueWallets is all active tagged wallets. Use uniqueSellers when making
    claims about "unique sellers" and uniqueBuyers for "unique buyers".
  - Do not call smart money "silent" if buys, sells, or netFlowSol are non-zero.

Your job is to choose ONE of four actions:
  - "hold"          — leave the existing trailing stop alone
  - "set_trail"     — change the trail % in either direction. new_trail_pct must
                      be in (0, ceilingTrailPctDecimal]. Use this to tighten when
                      warranted, or LOOSEN (up to the ceiling) if a prior tighten
                      looks premature now.
  - "partial_exit"  — sell a FRACTION (sell_pct in [0.10, 0.75]) of CURRENT
                      tokensHeld NOW. The remaining position stays open and
                      keeps running with existing trail/stop. Use to lock profit
                      on a runner while staying exposed for more upside.
  - "exit_now"      — sell the entire position immediately

TP LADDER AWARENESS:
If the position payload contains a \`tp_ladder_state\` block, the user has a
mechanical TP ladder running in parallel. Factor this in:
  - \`targets\` shows the configured sell tiers (pnlPct → sellPct).
  - \`targets_hit\` lists which tier indices have already fired and locked profit.
  - \`position_size_remaining_pct\` shows what fraction of the original is still held.
  Do NOT recommend partial_exit for a tier that has already fired (already captured).
  Do NOT partial_exit if the remaining position is small enough that exit_now is cleaner.
  If all tiers have fired and the trailing stop will handle the remainder, prefer hold.

You MUST cite exact evidence fact keys in cited_facts and in the reason text.
Example: "Facts: bundlerDistribution, volumeCliff." If the evidence gate says
partialExitAllowed or exitNowAllowed is false, you must not choose that action.

EXIT PHILOSOPHY — DEFAULT ACTION IS HOLD.

Your job is to identify the MINORITY of cases where action is warranted.
For every 10 consultations, 8 should be hold. The static trail you were
given (currentTrailPctDecimal, with ceiling at ceilingTrailPctDecimal)
is already the backtest-optimized answer across 100 tokens. Your job is
to refine it in EXCEPTIONAL cases, not improve it in average ones.

Tighten (set_trail with new_trail_pct < current) ONLY if ≥2 of these
converge (single signals are noise):
  - Smart money net-SELLING AND uniqueSellers > 3
  - Dev holding > 0% AND dev trade window shows sells
  - Bundlers net-SELLING over 30 min AND top holders capitulating
    (topHolders.averagePnlUsd << 0 and trending sell)
  - Volume cliff: volume5m < volume1h / 20

Exit (exit_now) ONLY if ≥3 of the above converge, OR a dev with holding
> 1% is selling hard (dev.sellVolumeSol >> dev.buyVolumeSol over 30m).

Loosen (set_trail with new_trail_pct > current) when YOUR OWN prior
decision was a tighten AND subsequent evidence has invalidated it:
  - Price continued up after you tightened
  - On-chain signals (smart money, dev, bundlers) all net-positive
  - Your recent decisions show repeated tightens with no exit trigger
Cap at ceilingTrailPctDecimal.

NEVER tighten on chart shape alone. A single vertical candle is NOISE.
Parabolic moves in meme coins often continue for 2-5 more candles —
your job is not to call the top. The trailing stop calls the top.

ALSO:
  - PAST DEV BEHAVIOR DOES NOT MATTER. devCreateTokenCount / devLaunched
    / devRugPull are HISTORY. Only CURRENT dev pressure matters.
  - If risk.devHoldingPercent === 0, the dev is OUT — there is no future
    dev dump pressure. Do NOT cite prior rugs as an exit reason.
  - Top-10 holders deeply underwater is only bearish WHEN combined with
    fading momentum. On its own, it's not a signal.

Constraints on set_trail:
  - new_trail_pct is a DECIMAL (0.0 to 1.0), NOT whole percent.
    e.g. 0.20 means 20% trail.
  - Must be in the interval (0, ceilingTrailPctDecimal].
  - May be TIGHTER than current (smaller) to lock in profit, or LOOSER
    than current (larger, up to ceiling) to undo a premature tighten.
  - If you can't justify a number different from the current trail, use "hold".

When to use partial_exit (the runner-capture tool):
  - The position has run significantly (peakPnlPct > +100%) AND you see
    MIXED signals — not enough convergence to exit_now, but a real
    deceleration / distribution worth de-risking.
  - Smart money slowing (not flipping to net-sell) → sell 0.20-0.30 to
    lock profit, hold remainder for continuation.
  - Token establishing a base at a new high → sell 0.25-0.40, let the rest
    ride for a potential V2 leg.
  - Bundlers starting to distribute but dev still holding/buying → sell
    0.30-0.50 to rebalance risk.
  - DO NOT use partial_exit for panic. If convergence fires (≥3 bearish
    signals), use exit_now (full exit) — partial exits on dying tokens
    just delay the inevitable loss.
  - DO NOT use partial_exit below +100% peak PnL — too early to scale out.
  - Typical sell_pct values: 0.20 – 0.50. For 0.75+, use exit_now.
  - You CAN fire partial_exit multiple times on the same position as it
    runs (e.g. 0.25 at +200%, another 0.25 at +500%, keep ~50% for the moon).
    But wait for meaningful price progress between partials — not every poll.

Output: you MUST respond by calling the submit_decision tool. Do not write
prose. The "reason" field is shown to the user in Telegram — keep it to
1-2 sentences and reference the specific on-chain cue you used. Include
"Facts: ..." with the exact evidence keys you relied on.`;

// ---------------------------------------------------------------------------
// Tool schema (OpenAI / MiniMax compatible)
// ---------------------------------------------------------------------------
const SUBMIT_DECISION_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_decision",
    description:
      "Submit the exit decision for the current position. Must be called exactly once.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["hold", "exit_now", "set_trail", "partial_exit"],
          description:
            "hold = keep existing trail; exit_now = sell entire position immediately; set_trail = change the trail % (tighter or looser, capped at ceilingTrailPctDecimal); partial_exit = sell a fraction (sell_pct) NOW and keep the rest running.",
        },
        reason: {
          type: "string",
          description:
            "1-2 sentences explaining the decision, referencing the specific on-chain cue. Must include exact evidence keys, e.g. 'Facts: bundlerDistribution, volumeCliff.' Shown to the user in Telegram.",
        },
        cited_facts: {
          type: "array",
          items: {
            type: "string",
            enum: [...EVIDENCE_KEYS],
          },
          description:
            "Exact deterministic evidence fact keys relied on for this decision. Bearish keys: bundlerDistribution, smartMoneySelling, topHolderCapitulation, volumeCliff, roundTripRisk. Proactive keys: priceAcceleration, volumeBlowoff, txRatioBurst, pctFromAthSpike.",
        },
        new_trail_pct: {
          type: "number",
          description:
            "REQUIRED only when action = set_trail. Decimal in (0, ceilingTrailPctDecimal], e.g. 0.20 for a 20% trail. May be tighter OR looser than the current trail, but never above the ceiling.",
        },
        sell_pct: {
          type: "number",
          description:
            "REQUIRED only when action = partial_exit. Decimal in [0.10, 0.75]: fraction of CURRENT tokensHeld to sell. The remaining position stays open and keeps running. For >0.75, use exit_now instead. Typical values: 0.25-0.50 to lock profit on a running winner.",
        },
      },
      required: ["action", "reason", "cited_facts"],
    },
  },
};

// ---------------------------------------------------------------------------
// Snapshot summarization — keep prompt compact (avoid 50KB blobs)
// ---------------------------------------------------------------------------
function fmtNum(n: number, digits = 2): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function summarizeMomentum(m: PriceMomentum | null): unknown {
  if (!m) return null;
  return {
    priceUsd: fmtNum(m.priceUsd, 8),
    marketCapUsd: fmtNum(m.marketCapUsd, 0),
    liquidityUsd: fmtNum(m.liquidityUsd, 0),
    holders: m.holders,
    pctFromAth: fmtNum(m.pctFromAth, 2),
    priceChange: {
      "5m": fmtNum(m.priceChange5m, 2),
      "1h": fmtNum(m.priceChange1h, 2),
      "4h": fmtNum(m.priceChange4h, 2),
      "24h": fmtNum(m.priceChange24h, 2),
    },
    volumeUsd: {
      "5m": fmtNum(m.volume5m, 0),
      "1h": fmtNum(m.volume1h, 0),
      "4h": fmtNum(m.volume4h, 0),
      "24h": fmtNum(m.volume24h, 0),
    },
    txs: { "5m": m.txs5m, "1h": m.txs1h, "4h": m.txs4h, "24h": m.txs24h },
  };
}

function summarizeWindow(w: TradeWindow): unknown {
  return {
    windowMins: w.windowMins,
    buys: w.buys,
    sells: w.sells,
    buyVolumeSol: fmtNum(w.buyVolumeSol, 4),
    sellVolumeSol: fmtNum(w.sellVolumeSol, 4),
    netFlowSol: fmtNum(w.netFlowSol, 4),
    uniqueWallets: w.uniqueWallets,
    uniqueBuyers: w.uniqueBuyers,
    uniqueSellers: w.uniqueSellers,
  };
}

function summarizeHolders(h: TopHoldersSnapshot | null): unknown {
  if (!h) return null;
  return {
    rangeFilter: h.rangeFilter,
    holdingPercent: fmtNum(h.holdingPercent, 2),
    averagePnlUsd: fmtNum(h.averagePnlUsd, 2),
    averageBuyPricePercent: fmtNum(h.averageBuyPricePercent, 2),
    averageSellPricePercent: fmtNum(h.averageSellPricePercent, 2),
    trendType: h.trendType,
    averageHoldingPeriodSecs: h.averageHoldingPeriodSecs,
  };
}

function summarizeLiquidity(pools: LiquidityPool[]): unknown {
  // top 3 pools by liquidity is enough context
  const top = [...pools].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, 3);
  const totalUsd = pools.reduce((s, p) => s + p.liquidityUsd, 0);
  return {
    totalLiquidityUsd: fmtNum(totalUsd, 0),
    poolCount: pools.length,
    topPools: top.map(p => ({
      protocol: p.protocolName,
      liquidityUsd: fmtNum(p.liquidityUsd, 0),
    })),
  };
}

function summarizeRisk(r: TokenRisk | null): unknown {
  if (!r) return null;
  return {
    tokenTags: r.tokenTags,
    riskControlLevel: r.riskControlLevel,
    bundleHoldingPercent: fmtNum(r.bundleHoldingPercent, 2),
    top10HoldPercent: fmtNum(r.top10HoldPercent, 2),
    sniperHoldingPercent: fmtNum(r.sniperHoldingPercent, 2),
    suspiciousHoldingPercent: fmtNum(r.suspiciousHoldingPercent, 2),
    lpBurnedPercent: fmtNum(r.lpBurnedPercent, 2),
    devHoldingPercent: fmtNum(r.devHoldingPercent, 2),
    // historical-only stats are kept here so the model can SEE we're aware
    // of them — but the system prompt instructs it to ignore them for exits.
    devHistory: {
      createTokenCount: r.devCreateTokenCount,
      launchedTokenCount: r.devLaunchedTokenCount,
      rugPullTokenCount: r.devRugPullTokenCount,
    },
    snipersTotal: r.snipersTotal,
    snipersClearAddressCount: r.snipersClearAddressCount,
  };
}

function summarizeSignals(signals: SignalRecord[]): unknown {
  // Keep only the 5 most recent signals, compress fields.
  const top = [...signals].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
  return top.map(s => ({
    walletType: s.walletType, // 1=SmartMoney, 2=KOL, 3=Whale
    triggerWalletCount: s.triggerWalletCount,
    amountUsd: fmtNum(s.amountUsd, 0),
    soldRatioPercent: fmtNum(s.soldRatioPercent, 2),
    ageSecs: Math.floor((Date.now() - s.timestamp) / 1000),
  }));
}

function summarizeKline(candles: Candle[], bar: string, keep: number): unknown {
  if (candles.length === 0) return { bar, candles: [] };
  // Keep only the most recent `keep` candles, and only the load-bearing fields.
  const slice = candles.slice(-keep);
  const closes = slice.map(c => c.close);
  const first = closes[0] ?? 0;
  const last = closes[closes.length - 1] ?? 0;
  const trendPct = first > 0 ? ((last / first) - 1) * 100 : 0;
  const totalVolUsd = slice.reduce((s, c) => s + c.volumeUsd, 0);
  return {
    bar,
    count: slice.length,
    trendPct: fmtNum(trendPct, 2),
    totalVolumeUsd: fmtNum(totalVolUsd, 0),
    closes: closes.map(c => fmtNum(c, 8)),
    volsUsd: slice.map(c => fmtNum(c.volumeUsd, 0)),
  };
}

function fact(
  key: EvidenceKey,
  active: boolean,
  detail: string,
  metrics: EvidenceFact["metrics"],
): EvidenceFact {
  return { key, active, detail, metrics };
}

function computeEvidence(ctx: LlmContext, snapshot: PositionSnapshot): EvidencePacket {
  const bundlers = snapshot.bundlers;
  const smartMoney = snapshot.smartMoney;
  const holders = snapshot.topHolders;
  const momentum = snapshot.momentum;
  const isSignificantWinner = ctx.pnlPct >= 1.0;  // position up 100%+

  // ── Bearish / reactive facts ─────────────────────────────────────────────

  const bundlerSellRatio = bundlers.buyVolumeSol > 0
    ? bundlers.sellVolumeSol / bundlers.buyVolumeSol
    : (bundlers.sellVolumeSol > 0 ? 999 : 0);
  const bundlerDistribution =
    bundlers.netFlowSol <= -50 &&
    bundlers.sellVolumeSol >= 50 &&
    bundlerSellRatio >= 1.5 &&
    bundlers.uniqueSellers >= 3;

  const smartMoneySelling =
    smartMoney.netFlowSol <= -25 &&
    smartMoney.sellVolumeSol >= 10 &&
    smartMoney.uniqueSellers > 3;

  const holderTrend = (holders?.trendType ?? []).map((t) => t.toLowerCase());
  const topHolderCapitulation =
    Boolean(holders) &&
    (holders?.averagePnlUsd ?? 0) < -100 &&
    holderTrend.some((t) => t.includes("sell"));

  const volumeCliffThreshold = momentum ? momentum.volume1h / 20 : 0;
  const volumeCliff =
    Boolean(momentum) &&
    (momentum?.volume1h ?? 0) > 0 &&
    (momentum?.volume5m ?? 0) < volumeCliffThreshold;

  const roundTripRisk =
    ctx.peakPnlPct >= 0.5 &&
    ctx.pnlPct <= 0.1 &&
    ctx.drawdownFromPeakPct >= Math.min(0.5, Math.max(0.25, ctx.currentTrailPct * 0.75));

  // ── Proactive / overbought facts (sell-into-strength) ────────────────────

  // priceAcceleration: single confirmed 1m candle body ≥ 35% or upper wick ≥ 50%
  // while already a significant winner — indicates parabolic blow-off extension.
  const recentCandles = snapshot.kline1m.slice(-5).filter(c => c.confirmed);
  const maxBodyMove = recentCandles.length > 0
    ? Math.max(...recentCandles.map(c => c.open > 0 ? (c.close - c.open) / c.open : 0))
    : 0;
  const maxWickMove = recentCandles.length > 0
    ? Math.max(...recentCandles.map(c => c.open > 0 ? (c.high - c.open) / c.open : 0))
    : 0;
  const priceAcceleration =
    isSignificantWinner &&
    (maxBodyMove >= 0.35 || maxWickMove >= 0.50);

  // volumeBlowoff: current 5m volume ≥ 3× the per-5m average derived from 1h.
  // Opposite of volumeCliff — a volume CLIMAX signal.
  const vol5mAvg = (momentum?.volume1h ?? 0) > 0 ? momentum!.volume1h / 12 : 0;
  const volumeBlowoffThreshold = vol5mAvg * 3;
  const volumeBlowoff =
    isSignificantWinner &&
    vol5mAvg > 0 &&
    (momentum?.volume5m ?? 0) >= volumeBlowoffThreshold;

  // txRatioBurst: 5m tx count ≥ 2× the per-5m average from 1h — retail FOMO climax.
  const txs5mAvg = (momentum?.txs1h ?? 0) > 0 ? momentum!.txs1h / 12 : 0;
  const txRatioBurstThreshold = txs5mAvg * 2;
  const txRatioBurst =
    isSignificantWinner &&
    txs5mAvg > 0 &&
    (momentum?.txs5m ?? 0) >= txRatioBurstThreshold;

  // pctFromAthSpike: token is within 5% of its all-time high while position is up 100%+.
  // ATH is strong resistance; a large winner trading at ATH is primed for reversal.
  const pctFromAth = momentum?.pctFromAth ?? -Infinity;
  const pctFromAthSpike =
    isSignificantWinner &&
    Number.isFinite(pctFromAth) &&
    pctFromAth >= -5;

  // ── Assemble facts Record ────────────────────────────────────────────────

  const facts: Record<EvidenceKey, EvidenceFact> = {
    bundlerDistribution: fact(
      "bundlerDistribution",
      bundlerDistribution,
      bundlerDistribution
        ? "Bundler-tagged wallets are net selling with enough seller breadth and sell/buy imbalance."
        : "Bundler flow is not broad or imbalanced enough to count as deterministic distribution.",
      {
        netFlowSol: fmtNum(bundlers.netFlowSol, 4),
        buyVolumeSol: fmtNum(bundlers.buyVolumeSol, 4),
        sellVolumeSol: fmtNum(bundlers.sellVolumeSol, 4),
        sellBuyRatio: fmtNum(bundlerSellRatio, 2),
        uniqueBuyers: bundlers.uniqueBuyers,
        uniqueSellers: bundlers.uniqueSellers,
      },
    ),
    smartMoneySelling: fact(
      "smartMoneySelling",
      smartMoneySelling,
      smartMoneySelling
        ? "Smart-money-tagged wallets are net selling with more than three unique sellers."
        : "Smart money is not net-selling with enough seller breadth.",
      {
        netFlowSol: fmtNum(smartMoney.netFlowSol, 4),
        buyVolumeSol: fmtNum(smartMoney.buyVolumeSol, 4),
        sellVolumeSol: fmtNum(smartMoney.sellVolumeSol, 4),
        uniqueBuyers: smartMoney.uniqueBuyers,
        uniqueSellers: smartMoney.uniqueSellers,
      },
    ),
    topHolderCapitulation: fact(
      "topHolderCapitulation",
      topHolderCapitulation,
      topHolderCapitulation
        ? "Top holders are underwater and trend data shows selling."
        : "Top holders are not both underwater and sell-trending.",
      {
        averagePnlUsd: fmtNum(holders?.averagePnlUsd ?? 0, 2),
        trendType: holderTrend.join(",") || null,
        holdingPercent: fmtNum(holders?.holdingPercent ?? 0, 2),
      },
    ),
    volumeCliff: fact(
      "volumeCliff",
      volumeCliff,
      volumeCliff
        ? "5m volume is below one twentieth of 1h volume."
        : "5m volume has not fallen below the deterministic volume-cliff threshold.",
      {
        volume5mUsd: fmtNum(momentum?.volume5m ?? 0, 0),
        volume1hUsd: fmtNum(momentum?.volume1h ?? 0, 0),
        thresholdUsd: fmtNum(volumeCliffThreshold, 0),
      },
    ),
    roundTripRisk: fact(
      "roundTripRisk",
      roundTripRisk,
      roundTripRisk
        ? "This was a meaningful winner and is now near flat/negative after a large peak drawdown."
        : "The trade has not met the deterministic round-trip-risk pattern.",
      {
        pnlPct: fmtNum(ctx.pnlPct * 100, 2),
        peakPnlPct: fmtNum(ctx.peakPnlPct * 100, 2),
        drawdownFromPeakPct: fmtNum(ctx.drawdownFromPeakPct * 100, 2),
        currentTrailPct: fmtNum(ctx.currentTrailPct * 100, 2),
      },
    ),
    priceAcceleration: fact(
      "priceAcceleration",
      priceAcceleration,
      priceAcceleration
        ? `Parabolic 1m candle detected on a +${fmtNum(ctx.pnlPct * 100, 0)}% winner: max body +${fmtNum(maxBodyMove * 100, 0)}%, max wick +${fmtNum(maxWickMove * 100, 0)}% in last 5 candles.`
        : "No parabolic single-candle move detected in the last 5 confirmed 1m candles.",
      {
        maxBodyMovePct: fmtNum(maxBodyMove * 100, 1),
        maxWickMovePct: fmtNum(maxWickMove * 100, 1),
        recentCandleCount: recentCandles.length,
        pnlPct: fmtNum(ctx.pnlPct * 100, 1),
      },
    ),
    volumeBlowoff: fact(
      "volumeBlowoff",
      volumeBlowoff,
      volumeBlowoff
        ? `Volume climax: 5m volume $${fmtNum(momentum?.volume5m ?? 0, 0)} is ${fmtNum(vol5mAvg > 0 ? (momentum?.volume5m ?? 0) / vol5mAvg : 0, 1)}× the hourly per-5m average ($${fmtNum(vol5mAvg, 0)}).`
        : "5m volume is not elevated enough to indicate a volume climax.",
      {
        volume5mUsd: fmtNum(momentum?.volume5m ?? 0, 0),
        vol5mAvgUsd: fmtNum(vol5mAvg, 0),
        multiplier: fmtNum(vol5mAvg > 0 ? (momentum?.volume5m ?? 0) / vol5mAvg : 0, 2),
        thresholdUsd: fmtNum(volumeBlowoffThreshold, 0),
      },
    ),
    txRatioBurst: fact(
      "txRatioBurst",
      txRatioBurst,
      txRatioBurst
        ? `Transaction burst: ${momentum?.txs5m ?? 0} txs in last 5m vs ${fmtNum(txs5mAvg, 0)} hourly average — retail FOMO climax.`
        : "Transaction rate is not elevated enough to indicate a retail burst.",
      {
        txs5m: momentum?.txs5m ?? 0,
        txs5mAvg: fmtNum(txs5mAvg, 1),
        txs1h: momentum?.txs1h ?? 0,
        thresholdTxs: fmtNum(txRatioBurstThreshold, 0),
      },
    ),
    pctFromAthSpike: fact(
      "pctFromAthSpike",
      pctFromAthSpike,
      pctFromAthSpike
        ? `Token is ${Math.abs(pctFromAth).toFixed(1)}% from its all-time high while position is up ${fmtNum(ctx.pnlPct * 100, 0)}% — ATH resistance zone.`
        : "Token is not near its all-time high.",
      {
        pctFromAth: fmtNum(pctFromAth, 2),
        pnlPct: fmtNum(ctx.pnlPct * 100, 1),
      },
    ),
  };

  // ── Gate logic ───────────────────────────────────────────────────────────

  const activeBearishKeys = BEARISH_KEYS.filter((key) => facts[key].active);
  const activeProactiveKeys = PROACTIVE_KEYS.filter((key) => facts[key].active);
  const bearishCount = activeBearishKeys.length;
  const proactiveCount = activeProactiveKeys.length;

  // Bearish path (existing): 2+ bearish facts including an anchor fact
  const bearishPartialAllowed =
    ctx.peakPnlPct >= 1 &&
    bearishCount >= 2 &&
    (facts.bundlerDistribution.active || facts.volumeCliff.active || facts.roundTripRisk.active);

  // Proactive path: 2+ proactive signals on a significant winner, OR 1 proactive + 1 bearish
  const proactivePartialAllowed =
    isSignificantWinner &&
    ctx.peakPnlPct >= 1 &&
    (proactiveCount >= 2 || (proactiveCount >= 1 && bearishCount >= 1));

  const partialExitAllowed = bearishPartialAllowed || proactivePartialAllowed;

  const exitNowAllowed =
    bearishCount >= 3 ||
    (facts.roundTripRisk.active && bearishCount >= 2 && ctx.pnlPct <= 0.1) ||
    (proactiveCount >= 3 && isSignificantWinner) ||
    (proactiveCount >= 2 && bearishCount >= 1 && isSignificantWinner);

  const tightenAllowed =
    bearishCount >= 2 ||
    (proactiveCount >= 2 && bearishCount >= 1);

  const reasons: string[] = [];
  if (!partialExitAllowed) {
    reasons.push(
      "partial_exit requires peakPnlPct >= +100% and either: (a) 2+ bearish facts with an anchor fact, or (b) 2+ proactive facts on a +100% winner, or (c) 1 proactive + 1 bearish on a +100% winner.",
    );
  }
  if (!exitNowAllowed) {
    reasons.push(
      "exit_now requires: 3+ bearish facts, or roundTripRisk+2 bearish near flat, or 3+ proactive facts on a +100% winner, or 2+ proactive + 1 bearish on a +100% winner.",
    );
  }
  if (!tightenAllowed) {
    reasons.push("tightening requires 2+ bearish facts, or 2+ proactive + 1 bearish.");
  }

  return {
    facts,
    gate: {
      activeBearishKeys,
      activeProactiveKeys,
      partialExitAllowed,
      exitNowAllowed,
      tightenAllowed,
      reasons,
    },
  };
}

function compactSnapshot(snapshot: PositionSnapshot): unknown {
  return {
    momentum: summarizeMomentum(snapshot.momentum),
    smartMoney: summarizeWindow(snapshot.smartMoney),
    bundlers: summarizeWindow(snapshot.bundlers),
    insiders: summarizeWindow(snapshot.insiders),
    whales: summarizeWindow(snapshot.whales),
    dev: summarizeWindow(snapshot.dev),
    topHolders: summarizeHolders(snapshot.topHolders),
    liquidity: summarizeLiquidity(snapshot.liquidity),
    risk: summarizeRisk(snapshot.risk),
    recentSignals: summarizeSignals(snapshot.signals),
    // 1m: last 20 candles ≈ 20 minutes; 5m: last 12 candles ≈ 1 hour broader trend.
    kline1m: summarizeKline(snapshot.kline1m, "1m", 20),
    kline5m: summarizeKline(snapshot.kline5m, "5m", 12),
    realtimeOverlay: snapshot.realtimeOverlay ?? null,
  };
}

// ---------------------------------------------------------------------------
// Trend + decision-history payload builders
// ---------------------------------------------------------------------------
function buildTrendsPayload(mint: string): unknown {
  const t = computeTrends(mint);
  if (!t) return null;
  const fmtArr = (arr: number[], digits = 2): number[] =>
    arr.map((v) => fmtNum(v, digits));
  return {
    samples: t.samples,
    ageSecs_oldest_to_newest: t.ageSecs,
    price_usd: fmtArr(t.price, 10),
    volume5m_usd: fmtArr(t.volume5m, 0),
    priceChange5m_pct: fmtArr(t.priceChange5m, 2),
    holders: t.holders,
    smartMoney_netFlowSol: fmtArr(t.smartMoneyNetFlow, 4),
    bundlers_netFlowSol: fmtArr(t.bundlersNetFlow, 4),
    dev_netFlowSol: fmtArr(t.devNetFlow, 4),
    whales_netFlowSol: fmtArr(t.whalesNetFlow, 4),
    topHolders_avgPnl_usd: fmtArr(t.topHoldersAvgPnl, 2),
    liquidity_usd: fmtArr(t.liquidityTotal, 0),
  };
}

function buildRecentDecisions(mint: string): Array<Record<string, unknown>> {
  const decs = getDecisions(mint);
  if (decs.length === 0) return [];
  const now = Date.now();
  // keep last 5, oldest → newest
  const slice = decs.slice(-5);
  return slice.map((d) => {
    const base: Record<string, unknown> = {
      ageSecs: Math.floor((now - d.at) / 1000),
      action: d.action,
      reason: d.reason,
    };
    if (
      (d.action === "set_trail" || d.action === "tighten_trail") &&
      d.newTrailPct != null
    ) {
      base.from = fmtNum(d.oldTrailPct, 4);
      base.to = fmtNum(d.newTrailPct, 4);
    }
    return base;
  });
}

// ---------------------------------------------------------------------------
// User-prompt builder
// ---------------------------------------------------------------------------
// Minimum closed LlmTradeRecords before the track-record injection self-activates.
// Below this threshold we skip injection entirely; above it, we auto-include the
// verdict histogram in every consult. No config flag — it just turns on once
// there's enough data, and turns off automatically if state/llm_decisions.json
// gets cleared. Intentionally simple.
const TRACK_RECORD_THRESHOLD = 20;

type TrackRecordSummary = {
  total: number;
  histogram: Record<string, number>;
};

type SimilarCaseSummary = {
  totalMatched: number;
  activeEvidenceKeys: EvidenceKey[];
  cases: Array<{
    name: string;
    verdict: string;
    evidenceKeys: EvidenceKey[];
    peakPnlPct: number;
    exitPnlPct: number;
    exitReason: string;
    lastAction: string | null;
    lesson: string;
  }>;
};

type PromptBuild = {
  payload: Record<string, unknown>;
  userPrompt: string;
  evidence: EvidencePacket;
  similarCases: SimilarCaseSummary | null;
};

async function buildTrackRecord(): Promise<TrackRecordSummary | null> {
  const records = await readLlmTradeRecords(200).catch(() => []);
  if (records.length < TRACK_RECORD_THRESHOLD) return null;
  const histogram: Record<string, number> = {};
  for (const r of records) {
    histogram[r.verdict] = (histogram[r.verdict] ?? 0) + 1;
  }
  return { total: records.length, histogram };
}

function inferEvidenceKeysFromText(text: string): EvidenceKey[] {
  const s = text.toLowerCase();
  const keys = new Set<EvidenceKey>();
  if (s.includes("bundler")) keys.add("bundlerDistribution");
  if (s.includes("smart money") && (s.includes("sell") || s.includes("selling"))) keys.add("smartMoneySelling");
  if (s.includes("top holder") && (s.includes("capitulat") || s.includes("underwater") || s.includes("sell"))) {
    keys.add("topHolderCapitulation");
  }
  if (s.includes("volume cliff") || s.includes("volume fading") || s.includes("volume decelerat")) {
    keys.add("volumeCliff");
  }
  if (
    s.includes("round trip") ||
    s.includes("round-trip") ||
    s.includes("gave back") ||
    s.includes("winner become") ||
    s.includes("protect peak")
  ) {
    keys.add("roundTripRisk");
  }
  return [...keys];
}

function evidenceKeysForRecord(record: Awaited<ReturnType<typeof readLlmTradeRecords>>[number]): EvidenceKey[] {
  const keys = new Set<EvidenceKey>();
  for (const d of record.decisions ?? []) {
    for (const key of [...(d.evidenceKeys ?? []), ...(d.citedFacts ?? [])]) {
      if ((EVIDENCE_KEYS as readonly string[]).includes(key)) keys.add(key as EvidenceKey);
    }
    for (const key of inferEvidenceKeysFromText(d.reason ?? "")) keys.add(key);
  }
  if (record.verdict === "round_trip_loss" || record.verdict === "held_partial_gain") {
    keys.add("roundTripRisk");
  }
  return [...keys];
}

function lessonForVerdict(verdict: string): string {
  switch (verdict) {
    case "round_trip_loss":
      return "Protect runners when deterministic risk appears; holding let a winner round-trip.";
    case "held_partial_gain":
      return "Holding stayed profitable but gave back too much of the peak.";
    case "premature_exit":
      return "Prior aggressive exit was too early; require stronger convergence.";
    case "premature_tighten":
      return "Prior tightening was too early; avoid reacting to one noisy signal.";
    case "correct_exit":
      return "Aggressive exit captured most of the available peak.";
    case "correct_tighten":
      return "Tightening helped capture a useful part of the move.";
    case "held_well":
      return "Holding worked; avoid unnecessary intervention in similar conditions.";
    case "stuck_loser":
      return "Weak trades need faster protection when risk evidence is active.";
    default:
      return "Mixed outcome; use only as weak context.";
  }
}

async function buildSimilarCases(evidence: EvidencePacket): Promise<SimilarCaseSummary | null> {
  const active = evidence.gate.activeBearishKeys;
  if (active.length === 0) return null;
  const records = await readLlmTradeRecords(200).catch(() => []);
  if (records.length === 0) return null;

  const scored = records
    .map((record) => {
      const evidenceKeys = evidenceKeysForRecord(record);
      const overlap = evidenceKeys.filter((key) => active.includes(key)).length;
      return { record, evidenceKeys, overlap };
    })
    .filter((row) => row.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.record.closedAt - a.record.closedAt);

  if (scored.length === 0) return null;

  return {
    totalMatched: scored.length,
    activeEvidenceKeys: active,
    cases: scored.slice(0, 5).map(({ record, evidenceKeys }) => {
      const last = record.decisions?.[record.decisions.length - 1];
      return {
        name: record.name,
        verdict: record.verdict,
        evidenceKeys,
        peakPnlPct: fmtNum(record.peakPnlPct * 100, 2),
        exitPnlPct: fmtNum(record.exitPnlPct * 100, 2),
        exitReason: record.exitReason,
        lastAction: last?.action ?? null,
        lesson: lessonForVerdict(record.verdict),
      };
    }),
  };
}

async function buildUserPrompt(ctx: LlmContext, snapshot: PositionSnapshot): Promise<PromptBuild> {
  const trackRecord = await buildTrackRecord();
  const evidence = computeEvidence(ctx, snapshot);
  const similarCases = await buildSimilarCases(evidence);
  const payload: Record<string, unknown> = {
    position: {
      name: ctx.name,
      mint: ctx.mint,
      // The position is priced in SOL-per-token, NOT USD-per-token. The
      // separate `snapshot.momentum.priceUsd` IS the USD price.
      entryPriceSol: fmtNum(ctx.entryPriceUsd, 12),    // bump precision for tiny SOL values
      currentPriceSol: fmtNum(ctx.currentPriceUsd, 12),
      // All "...Pct" fields are in WHOLE PERCENT (e.g. 234 means +234%).
      // The trail fields are named *Decimal* explicitly because new_trail_pct
      // must be in the SAME decimal scale (0.0 – 1.0+).
      pnlPct: fmtNum(ctx.pnlPct * 100, 2),
      peakPnlPct: fmtNum(ctx.peakPnlPct * 100, 2),
      drawdownFromPeakPct: fmtNum(ctx.drawdownFromPeakPct * 100, 2),
      currentTrailPctDecimal: fmtNum(ctx.currentTrailPct, 4),
      ceilingTrailPctDecimal: fmtNum(ctx.ceilingTrailPct, 4),
      holdSecs: ctx.holdSecs,
    },
    evidence,
    snapshot: compactSnapshot(snapshot),
    trends: buildTrendsPayload(ctx.mint),
    recentDecisions: buildRecentDecisions(ctx.mint),
  };
  // TP ladder state — inject when ladder is active so LLM avoids double-selling tiers.
  if (ctx.tpTargets && ctx.tpTargets.length > 0) {
    payload.tp_ladder_state = {
      targets: ctx.tpTargets.map((t, i) => ({
        index: i,
        pnlPct: fmtNum(t.pnlPct * 100, 1),
        sellPct: fmtNum(t.sellPct * 100, 1),
        fired: (ctx.tpTargetsHit ?? []).includes(i),
      })),
      position_size_remaining_pct: ctx.positionSizeRemainingPct != null
        ? fmtNum(ctx.positionSizeRemainingPct * 100, 1)
        : null,
    };
  }
  // Only inject track record once we have enough closed trades to be meaningful.
  if (trackRecord) payload.recent_track_record = trackRecord;
  if (similarCases) payload.similar_cases = similarCases;

  const userPrompt = [
    "Decide the exit action for this position using the philosophy in the system prompt.",
    "Aggressive actions are only allowed when evidence.gate allows them.",
    "The reason must cite exact evidence keys from evidence.facts.",
    "Call submit_decision exactly once.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");

  return { payload, userPrompt, evidence, similarCases };
}

// ---------------------------------------------------------------------------
// Network plumbing — single fetch with timeout
// ---------------------------------------------------------------------------
type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: ChatMessage;
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string };
};

async function callMinimax(
  apiKey: string,
  messages: ChatMessage[],
): Promise<ChatCompletionResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(MINIMAX_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages,
        tools: [SUBMIT_DECISION_TOOL],
        tool_choice: { type: "function", function: { name: "submit_decision" } },
        temperature: 0.2,
        max_tokens: MAX_OUTPUT_TOKENS,
        // M2.7 has native interleaved thinking. Setting reasoning_split=true via
        // extra_body keeps thinking content out of message.content, which prevents
        // the <think> block from eating the tool-call JSON budget.
        extra_body: { reasoning_split: true },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, body: text.slice(0, 500) },
        "[llm] minimax http error",
      );
      return null;
    }
    return (await res.json()) as ChatCompletionResponse;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[llm] minimax request failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Decision-parsing
// ---------------------------------------------------------------------------
function normalizeCitedFacts(raw: unknown, reason: string): EvidenceKey[] {
  const out = new Set<EvidenceKey>();
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === "string" && (EVIDENCE_KEYS as readonly string[]).includes(value)) {
        out.add(value as EvidenceKey);
      }
    }
  }
  for (const key of EVIDENCE_KEYS) {
    if (reason.includes(key)) out.add(key);
  }
  return [...out];
}

function reasonWithFactCitations(reason: string, citedFacts: EvidenceKey[]): string {
  if (citedFacts.length === 0) return reason;
  const missing = citedFacts.filter((key) => !reason.includes(key));
  if (missing.length === 0) return reason;
  return `${reason} Facts: ${missing.join(", ")}.`;
}

function blockDecision(
  decision: LlmDecision,
  evidence: EvidencePacket,
  blockedAction: NonNullable<EvidenceGate["blockedAction"]>,
  reason: string,
): LlmDecision {
  return {
    action: "hold",
    reason,
    citedFacts: decision.citedFacts,
    evidenceKeys: [...evidence.gate.activeBearishKeys, ...evidence.gate.activeProactiveKeys],
    gate: { ...evidence.gate, blockedAction },
  };
}

function applyEvidenceGate(
  decision: LlmDecision,
  ctx: LlmContext,
  evidence: EvidencePacket,
): LlmDecision {
  const gate = evidence.gate;
  const active = [...gate.activeBearishKeys, ...gate.activeProactiveKeys];
  const factText = active.length > 0 ? active.join(", ") : "none";

  if (decision.action === "partial_exit" && !gate.partialExitAllowed) {
    logger.warn(
      { mint: ctx.mint, activeFacts: active, requested: decision.action },
      "[llm] partial_exit blocked by evidence gate",
    );
    return blockDecision(
      decision,
      evidence,
      "partial_exit",
      `Evidence gate blocked partial_exit; deterministic facts are insufficient. Active facts: ${factText}.`,
    );
  }

  if (decision.action === "exit_now" && !gate.exitNowAllowed) {
    logger.warn(
      { mint: ctx.mint, activeFacts: active, requested: decision.action },
      "[llm] exit_now blocked by evidence gate",
    );
    return blockDecision(
      decision,
      evidence,
      "exit_now",
      `Evidence gate blocked exit_now; deterministic facts are insufficient. Active facts: ${factText}.`,
    );
  }

  if (
    decision.action === "set_trail" &&
    decision.newTrailPct != null &&
    decision.newTrailPct < ctx.currentTrailPct &&
    !gate.tightenAllowed
  ) {
    logger.warn(
      { mint: ctx.mint, activeFacts: active, requested: decision.action },
      "[llm] tightening blocked by evidence gate",
    );
    return blockDecision(
      decision,
      evidence,
      "set_trail",
      `Evidence gate blocked trail tightening; deterministic facts are insufficient. Active facts: ${factText}.`,
    );
  }

  return { ...decision, evidenceKeys: [...gate.activeBearishKeys, ...gate.activeProactiveKeys], gate };
}

function parseDecision(
  resp: ChatCompletionResponse,
  ctx: LlmContext,
  evidence: EvidencePacket,
): LlmDecision | null {
  if (resp.error) {
    logger.warn({ err: resp.error }, "[llm] minimax api error");
    return null;
  }
  const msg = resp.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  if (!call || call.function?.name !== "submit_decision") {
    logger.warn({ msg }, "[llm] no submit_decision tool call in response");
    return null;
  }

  let args: {
    action?: string;
    reason?: string;
    cited_facts?: unknown;
    new_trail_pct?: number;
    sell_pct?: number;
  };
  try {
    args = JSON.parse(call.function.arguments) as typeof args;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, raw: call.function.arguments },
      "[llm] failed to parse tool arguments",
    );
    return null;
  }

  // Accept legacy "tighten_trail" action from older model outputs and alias to set_trail.
  let action = args.action;
  if (action === "tighten_trail") action = "set_trail";

  const reason = (args.reason ?? "").trim();
  if (!reason) {
    logger.warn("[llm] decision missing reason");
    return null;
  }
  const citedFacts = normalizeCitedFacts(args.cited_facts, reason);
  if (action !== "hold" && citedFacts.length === 0) {
    logger.warn({ action, reason }, "[llm] non-hold decision missing evidence citations");
    return null;
  }
  const citedReason = reasonWithFactCitations(reason, citedFacts);

  if (action === "hold" || action === "exit_now") {
    return applyEvidenceGate({ action, reason: citedReason, citedFacts }, ctx, evidence);
  }
  if (action === "set_trail") {
    const newTrailPct = Number(args.new_trail_pct);
    if (
      !Number.isFinite(newTrailPct) ||
      newTrailPct <= 0 ||
      newTrailPct > ctx.ceilingTrailPct
    ) {
      logger.warn(
        {
          newTrailPct,
          currentTrailPct: ctx.currentTrailPct,
          ceilingTrailPct: ctx.ceilingTrailPct,
        },
        "[llm] set_trail with invalid new_trail_pct (must be in (0, ceilingTrailPctDecimal])",
      );
      return null;
    }
    return applyEvidenceGate({ action, reason: citedReason, citedFacts, newTrailPct }, ctx, evidence);
  }
  if (action === "partial_exit") {
    const sellPct = Number(args.sell_pct);
    // Reject values outside the allowed band. For >0.75 the LLM should use
    // exit_now instead (closer to full exit is cleaner than multi-step near-total sells).
    if (!Number.isFinite(sellPct) || sellPct < 0.10 || sellPct > 0.75) {
      logger.warn(
        { sellPct },
        "[llm] partial_exit with invalid sell_pct (must be in [0.10, 0.75])",
      );
      return null;
    }
    return applyEvidenceGate({ action, reason: citedReason, citedFacts, sellPct }, ctx, evidence);
  }

  logger.warn({ action }, "[llm] unknown action in decision");
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function consultLlm(
  ctx: LlmContext,
  snapshot: PositionSnapshot,
): Promise<LlmDecision | null> {
  // Record the snapshot into L2 memory BEFORE prompting. computeTrends() uses
  // the ring including this latest sample, so the newest entry in the trend
  // vectors is "what the LLM is looking at right now".
  recordSnapshot(ctx.mint, snapshot);

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    logger.warn("[llm] MINIMAX_API_KEY missing — skipping LLM consult");
    return null;
  }

  const prompt = await buildUserPrompt(ctx, snapshot);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt.userPrompt },
  ];

  const start = Date.now();
  const resp = await callMinimax(apiKey, messages);
  if (!resp) {
    void appendLlmPromptAudit({
      at: start,
      mint: ctx.mint,
      name: ctx.name,
      context: {
        pnlPct: fmtNum(ctx.pnlPct * 100, 2),
        peakPnlPct: fmtNum(ctx.peakPnlPct * 100, 2),
        drawdownFromPeakPct: fmtNum(ctx.drawdownFromPeakPct * 100, 2),
        currentTrailPct: fmtNum(ctx.currentTrailPct, 4),
      },
      evidence: prompt.evidence,
      similarCases: prompt.similarCases,
      payload: prompt.payload,
      userPrompt: prompt.userPrompt,
      error: "no_response",
      latencyMs: Date.now() - start,
    });
    return null;
  }

  const rawToolArguments = resp.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  const decision = parseDecision(resp, ctx, prompt.evidence);
  void appendLlmPromptAudit({
    at: start,
    mint: ctx.mint,
    name: ctx.name,
    context: {
      pnlPct: fmtNum(ctx.pnlPct * 100, 2),
      peakPnlPct: fmtNum(ctx.peakPnlPct * 100, 2),
      drawdownFromPeakPct: fmtNum(ctx.drawdownFromPeakPct * 100, 2),
      currentTrailPct: fmtNum(ctx.currentTrailPct, 4),
    },
    evidence: prompt.evidence,
    similarCases: prompt.similarCases,
    payload: prompt.payload,
    userPrompt: prompt.userPrompt,
    rawToolArguments,
    decision,
    gate: decision?.gate,
    error: decision ? undefined : "parse_or_gate_failed",
    latencyMs: Date.now() - start,
  });
  if (decision) {
    logger.info(
      {
        mint: ctx.mint,
        name: ctx.name,
        action: decision.action,
        newTrailPct: decision.newTrailPct,
        latencyMs: Date.now() - start,
      },
      "[llm] decision",
    );
    // Record the decision into L2 memory so the NEXT consult sees it.
    const decRec: DecisionRecord = {
      at: Date.now(),
      action: decision.action,
      newTrailPct: decision.newTrailPct,
      oldTrailPct: ctx.currentTrailPct,
      reason: decision.reason,
      pnlPct: ctx.pnlPct,
      peakPnlPct: ctx.peakPnlPct,
      citedFacts: decision.citedFacts,
      evidenceKeys: decision.evidenceKeys,
      gate: decision.gate ? {
        partialExitAllowed: decision.gate.partialExitAllowed,
        exitNowAllowed: decision.gate.exitNowAllowed,
        tightenAllowed: decision.gate.tightenAllowed,
        blockedAction: decision.gate.blockedAction,
      } : undefined,
    };
    recordDecision(ctx.mint, decRec);
  }
  return decision;
}
