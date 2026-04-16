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
  getDecisions,
  computeTrends,
  readLlmTradeRecords,
  type DecisionRecord,
} from "./llmMemory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export type LlmDecision = {
  action: "hold" | "exit_now" | "set_trail";
  reason: string;
  newTrailPct?: number;
};

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
};

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------
const MINIMAX_ENDPOINT = "https://api.minimax.io/v1/chat/completions";
const MINIMAX_MODEL = "MiniMax-M2.7";
const HTTP_TIMEOUT_MS = 15_000;
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

Your job is to choose ONE of three actions:
  - "hold"       — leave the existing trailing stop alone
  - "set_trail"  — change the trail % in either direction. new_trail_pct must
                   be in (0, ceilingTrailPctDecimal]. Use this to tighten when
                   warranted, or LOOSEN (up to the ceiling) if a prior tighten
                   looks premature now.
  - "exit_now"   — sell the entire position immediately

EXIT PHILOSOPHY — DEFAULT ACTION IS HOLD.

Your job is to identify the MINORITY of cases where action is warranted.
For every 10 consultations, 8 should be hold. The static trail you were
given (currentTrailPctDecimal, with ceiling at ceilingTrailPctDecimal)
is already the backtest-optimized answer across 100 tokens. Your job is
to refine it in EXCEPTIONAL cases, not improve it in average ones.

Tighten (set_trail with new_trail_pct < current) ONLY if ≥2 of these
converge (single signals are noise):
  - Smart money net-SELLING AND wallet count > 3 unique sellers
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

Output: you MUST respond by calling the submit_decision tool. Do not write
prose. The "reason" field is shown to the user in Telegram — keep it to
1-2 sentences and reference the specific on-chain cue you used.`;

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
          enum: ["hold", "exit_now", "set_trail"],
          description:
            "hold = keep existing trail; exit_now = sell entire position immediately; set_trail = change the trail % (tighter or looser, capped at ceilingTrailPctDecimal).",
        },
        reason: {
          type: "string",
          description:
            "1-2 sentences explaining the decision, referencing the specific on-chain cue. Shown to the user in Telegram.",
        },
        new_trail_pct: {
          type: "number",
          description:
            "REQUIRED only when action = set_trail. Decimal in (0, ceilingTrailPctDecimal], e.g. 0.20 for a 20% trail. May be tighter OR looser than the current trail, but never above the ceiling.",
        },
      },
      required: ["action", "reason"],
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

async function buildTrackRecord(): Promise<TrackRecordSummary | null> {
  const records = await readLlmTradeRecords(200).catch(() => []);
  if (records.length < TRACK_RECORD_THRESHOLD) return null;
  const histogram: Record<string, number> = {};
  for (const r of records) {
    histogram[r.verdict] = (histogram[r.verdict] ?? 0) + 1;
  }
  return { total: records.length, histogram };
}

async function buildUserPrompt(ctx: LlmContext, snapshot: PositionSnapshot): Promise<string> {
  const trackRecord = await buildTrackRecord();
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
    snapshot: compactSnapshot(snapshot),
    trends: buildTrendsPayload(ctx.mint),
    recentDecisions: buildRecentDecisions(ctx.mint),
  };
  // Only inject track record once we have enough closed trades to be meaningful.
  if (trackRecord) payload.recent_track_record = trackRecord;

  return [
    "Decide the exit action for this position using the philosophy in the system prompt.",
    "Call submit_decision exactly once.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
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
function parseDecision(
  resp: ChatCompletionResponse,
  ctx: LlmContext,
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

  let args: { action?: string; reason?: string; new_trail_pct?: number };
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

  if (action === "hold" || action === "exit_now") {
    return { action, reason };
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
    return { action, reason, newTrailPct };
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

  const userPrompt = await buildUserPrompt(ctx, snapshot);
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  const start = Date.now();
  const resp = await callMinimax(apiKey, messages);
  if (!resp) return null;

  const decision = parseDecision(resp, ctx);
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
    };
    recordDecision(ctx.mint, decRec);
  }
  return decision;
}
