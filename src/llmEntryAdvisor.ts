/**
 * LLM entry gate — consults the LLM before opening a position.
 *
 * Called from main.ts onAcceptedCandidate callbacks after all existing signal
 * filters have passed. The LLM sees the pre-buy token snapshot and decides
 * "enter" or "skip". On any failure (timeout, missing key, API error) we
 * default to "enter" so the gate is never load-bearing — existing filters
 * remain the real safety floor.
 *
 * Uses the same provider config as llmExitAdvisor (LLM_API_KEY / LLM_ENDPOINT
 * / LLM_MODEL) so one API key covers both modes.
 */

import logger from "./logger.js";
import { CONFIG } from "./config.js";
import type { SignalAlert } from "./types.js";
import type { JupAudit } from "./jupGate.js";

const REQUEST_TIMEOUT_MS = 6_000;

const SYSTEM_PROMPT = `You are an entry filter for a Solana meme-coin trading bot. Your ONLY job is to decide whether to open a new position on a token that has already passed basic signal filters.

You will receive a compact snapshot of the token's quality signals. Respond by calling the submit_entry_decision tool with either "enter" or "skip" and a short reason (max 20 words).

Key signals to weigh:
- SKIP: rug_ratio > 0.5, bundler_pct > 40%, top10_pct > 70%, bs_ratio < 0.9, organic_score "low"
- SKIP: organic_vol_pct < 3% AND organic_buyers_pct < 2% (almost certainly bot-coordinated)
- ENTER: bs_ratio > 1.2, holders > 300 and growing, liquidity > $15k, organic_score "medium" or "high"
- BORDERLINE: use rug_ratio, bundler rate, and holder momentum to break ties

Be decisive. When signals are mixed but no hard red flags, default to "enter".`;

const SUBMIT_DECISION_TOOL = {
  type: "function",
  function: {
    name: "submit_entry_decision",
    description: "Submit the entry decision for this token.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["enter", "skip"],
          description: '"enter" to open the position, "skip" to pass.',
        },
        reason: {
          type: "string",
          description: "One short sentence explaining the decision (max 20 words).",
        },
      },
      required: ["action", "reason"],
    },
  },
};

export type EntryDecision = {
  action: "enter" | "skip";
  reason: string;
};

function buildSnapshot(alert: SignalAlert, jupAudit: JupAudit | null): string {
  const lines: string[] = [
    `token: ${alert.name} (${alert.mint.slice(0, 8)}...)`,
    `source: ${alert.source ?? "unknown"}`,
    `mcap: $${(alert.current_mcap / 1000).toFixed(0)}k`,
    `liquidity: $${(alert.liquidity / 1000).toFixed(0)}k`,
    `holders: ${alert.holders}`,
    `holder_growth_1h: ${alert.holder_growth_pct.toFixed(1)}%`,
    `age: ${alert.age_mins.toFixed(0)} mins`,
    `bs_ratio: ${alert.bs_ratio.toFixed(2)}`,
    `rug_ratio: ${alert.rug_ratio.toFixed(2)}`,
    `bundler_pct: ${alert.bundler_pct.toFixed(1)}%`,
    `top10_pct: ${alert.top10_pct.toFixed(1)}%`,
    `bot_degen_pct: ${alert.bot_degen_pct.toFixed(1)}%`,
    `kol_count: ${alert.kol_count}`,
    `signal_count: ${alert.signal_count}`,
    `liq_trend: ${alert.liq_trend}`,
  ];

  if (jupAudit) {
    lines.push(`jup_fees: ${jupAudit.fees.toFixed(2)}`);
    lines.push(`jup_organic_score: ${jupAudit.organicScoreLabel || "unknown"}`);
    if (jupAudit.organicVolumePct !== null) {
      lines.push(`organic_vol_pct: ${jupAudit.organicVolumePct.toFixed(1)}%`);
    }
    if (jupAudit.organicBuyersPct !== null) {
      lines.push(`organic_buyers_pct: ${jupAudit.organicBuyersPct.toFixed(1)}%`);
    }
  }

  return lines.join("\n");
}

export async function consultEntry(
  alert: SignalAlert,
): Promise<EntryDecision> {
  const fallback: EntryDecision = { action: "enter", reason: "llm-entry timeout/error — defaulting to enter" };

  const apiKey = CONFIG.LLM_API_KEY;
  if (!apiKey) {
    logger.debug({ mint: alert.mint }, "[llm-entry] no LLM_API_KEY — skipping consult");
    return fallback;
  }

  const jupAudit = (alert.sourceMeta?.jupAudit as JupAudit | null | undefined) ?? null;
  const snapshot = buildSnapshot(alert, jupAudit);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(CONFIG.LLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.LLM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Token snapshot:\n${snapshot}` },
        ],
        tools: [SUBMIT_DECISION_TOOL],
        tool_choice: { type: "function", function: { name: "submit_entry_decision" } },
        temperature: 0.1,
        max_tokens: 128,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      logger.warn({ mint: alert.mint, status: res.status }, "[llm-entry] http error — defaulting enter");
      return fallback;
    }

    const json = (await res.json()) as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{
            function?: { arguments?: string };
          }>;
        };
      }>;
    };

    const toolCall = json.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) {
      logger.warn({ mint: alert.mint }, "[llm-entry] no tool call in response — defaulting enter");
      return fallback;
    }

    const args = JSON.parse(toolCall.function.arguments) as { action?: string; reason?: string };
    const action = args.action === "skip" ? "skip" : "enter";
    const reason = typeof args.reason === "string" ? args.reason.slice(0, 120) : "no reason";

    logger.info({ mint: alert.mint, name: alert.name, action, reason }, "[llm-entry] decision");
    return { action, reason };
  } catch (err) {
    logger.warn({ mint: alert.mint, err: (err as Error).message }, "[llm-entry] request failed — defaulting enter");
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
