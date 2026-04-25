import { CONFIG } from "./config.js";
import logger from "./logger.js";

/**
 * Escape HTML special chars so Telegram's parse_mode="HTML" doesn't reject
 * the message. Apply to ALL user/external-derived text before interpolating
 * into HTML messages.
 */
export function escapeHtml(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function enabled(): boolean {
  return Boolean(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID);
}

async function send(text: string, extra?: Record<string, unknown>): Promise<void> {
  if (!enabled()) return;
  try {
    const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body }, "[notifier] telegram send non-OK");
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[notifier] telegram send failed");
  }
}

function short(sig: string): string {
  return sig.length > 12 ? `${sig.slice(0, 6)}…${sig.slice(-4)}` : sig;
}

function mcapFmt(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}K`;
  return `$${usd.toFixed(0)}`;
}

function holdFmt(secs: number): string {
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  if (secs >= 60) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${secs}s`;
}

function gmgn(mint: string): string {
  return `https://gmgn.ai/sol/token/${mint}`;
}

function solscan(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}

function solscanToken(mint: string): string {
  return `https://solscan.io/token/${mint}`;
}

export function notifyBoot(): Promise<void> {
  const mbLine = CONFIG.MOONBAG_PCT > 0
    ? `\nmoonbag: ${(CONFIG.MOONBAG_PCT * 100).toFixed(0)}%  mb-trail: ${(CONFIG.MB_TRAIL_PCT * 100).toFixed(0)}%  mb-timeout: ${(CONFIG.MB_TIMEOUT_SECS / 60).toFixed(0)}m`
    : "";
  return send(
    `🌙 <b>MoonBags</b> online\n` +
    `mode: ${CONFIG.DRY_RUN ? "DRY RUN" : "LIVE"}  |  buy: ${CONFIG.BUY_SIZE_SOL} SOL\n` +
    `arm: +${(CONFIG.ARM_PCT * 100).toFixed(0)}%  trail: ${(CONFIG.TRAIL_PCT * 100).toFixed(0)}%  stop: -${(CONFIG.STOP_PCT * 100).toFixed(0)}%` +
    mbLine,
  );
}

export function notifyBuy(args: {
  name: string;
  mint: string;
  source?: string;
  sourceMeta?: Record<string, unknown>;
  solSpent: number;
  entryMcap: number;
  entryPrice: number;
  signature: string;
}): Promise<void> {
  const source = args.source ? args.source.toUpperCase() : "SCG";
  const wallets = typeof args.sourceMeta?.triggerWalletCount === "number"
    ? ` · ${args.sourceMeta.triggerWalletCount} wallets`
    : "";
  const amount = typeof args.sourceMeta?.amountUsd === "number"
    ? ` · $${Math.round(args.sourceMeta.amountUsd).toLocaleString("en-US")}`
    : "";
  const text =
    `🟢 <b>BUY ${escapeHtml(args.name)}</b>\n` +
    `source: <b>${escapeHtml(source)}</b>${wallets}${amount}\n` +
    `mcap: ${mcapFmt(args.entryMcap)}  |  spent: ${args.solSpent.toFixed(4)} SOL\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>  ·  <a href="${solscan(escapeHtml(args.signature))}">tx ${escapeHtml(short(args.signature))}</a>`;
  return send(text);
}

export function notifySell(args: {
  name: string;
  mint: string;
  reason: string;
  entrySol: number;
  exitSol: number;
  pnlSolPct: number;
  peakPnlPct: number;
  holdSecs: number;
  signature: string;
  llmReason?: string;
}): Promise<void> {
  const pnlSol = args.exitSol - args.entrySol;
  const icon = args.pnlSolPct >= 0 ? "🟢" : "🔴";
  const sign = pnlSol >= 0 ? "+" : "";
  const llmLine = args.llmReason ? `\nLLM: <i>"${escapeHtml(args.llmReason)}"</i>` : "";
  const text =
    `${icon} <b>SELL ${escapeHtml(args.name)}</b> — ${args.reason}\n` +
    `PnL: <b>${sign}${pnlSol.toFixed(4)} SOL (${sign}${args.pnlSolPct.toFixed(1)}%)</b>\n` +
    `peak: +${args.peakPnlPct.toFixed(1)}%  |  held: ${holdFmt(args.holdSecs)}` +
    llmLine + `\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>  ·  <a href="${solscan(escapeHtml(args.signature))}">tx ${escapeHtml(short(args.signature))}</a>`;
  return send(text);
}

export function notifyArmed(args: { name: string; mint: string; pnlPct: number }): Promise<void> {
  return send(
    `⚡ <b>ARMED ${escapeHtml(args.name)}</b> — trailing active\n` +
    `+${(args.pnlPct * 100).toFixed(1)}% from entry\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>`,
  );
}

export function notifyMoonbagStart(args: {
  name: string; mint: string;
  moonbagPct: number; mbTrailPct: number; mbTimeoutMins: number;
}): Promise<void> {
  return send(
    `🌙 <b>MOONBAG ${escapeHtml(args.name)}</b>\n` +
    `Keeping ${(args.moonbagPct * 100).toFixed(0)}%  |  trail: ${(args.mbTrailPct * 100).toFixed(0)}%  |  timeout: ${args.mbTimeoutMins.toFixed(0)}m\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>`,
  );
}

export function notifyBuyFail(args: { name: string; mint: string; attempts: number; reason?: string; source?: string }): Promise<void> {
  const sourceLabel = args.source ? escapeHtml(args.source.toUpperCase()) : "GMGN";
  const reasonLine = args.reason ? `\n⚠️ ${escapeHtml(args.reason)}` : "";
  return send(
    `❌ <b>BUY FAILED ${escapeHtml(args.name)}</b>\n` +
    `${sourceLabel}${reasonLine}\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>  ·  <a href="${solscanToken(escapeHtml(args.mint))}">Solscan</a>`,
  );
}

export function notifySellFail(args: {
  name: string;
  mint: string;
  reason: string;
  attempts: number;
}): Promise<void> {
  return send(
    `⚠️ <b>SELL STUCK ${escapeHtml(args.name)}</b> — ${args.reason}\n` +
    `${args.attempts} attempts failed — manual action needed\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>`,
  );
}

export function notifyLlmActive(args: {
  name: string;
  mint: string;
  trailPct: number;
  pnlPct: number;
}): Promise<void> {
  const sign = args.pnlPct >= 0 ? "+" : "";
  return send(
    `🤖 <b>LLM watching ${escapeHtml(args.name)}</b>\n` +
    `trail: ${(args.trailPct * 100).toFixed(0)}%  |  PnL: ${sign}${(args.pnlPct * 100).toFixed(1)}%\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>`,
  );
}

export function notifyLlmHeartbeat(items: Array<{
  name: string;
  mint: string;
  pnlPct: number;
  peakPnlPct: number;
  trailPct: number;
  floorPnlPct: number;
  heldMs: number;
  lastCheckedMs: number | null;
  decisionCount: number;
  lastAction: string;
  lastReason: string;
  lastDecisionMs: number | null;
}>): Promise<void> {
  const fmtAge = (ms: number): string => {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m ago`;
  };
  const fmtHeld = (ms: number): string => {
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };
  const actionEmoji: Record<string, string> = {
    hold: "🟡",
    set_trail: "🟠",
    exit_now: "🔴",
    partial_exit: "🟣",
  };
  const count = items.length;
  const header = `🧠 <b>LLM check-in</b>  (watching ${count} position${count !== 1 ? "s" : ""})`;
  const blocks = items.map((item) => {
    const posEmoji = item.pnlPct >= 0 ? "🟢" : "🔴";
    const sign = (n: number) => n >= 0 ? "+" : "";
    const pullbackPct = item.peakPnlPct > 0
      ? (1 - (1 + item.pnlPct) / (1 + item.peakPnlPct)) * 100
      : 0;
    const emoji = actionEmoji[item.lastAction] ?? "⚪";
    const checkedStr = item.lastCheckedMs !== null ? fmtAge(item.lastCheckedMs) : "—";
    const decisionStr = item.lastDecisionMs !== null ? fmtAge(item.lastDecisionMs) : "—";
    return (
      `${posEmoji} <b>${escapeHtml(item.name)}</b> ⚡  held ${fmtHeld(item.heldMs)}\n` +
      `   PnL: ${sign(item.pnlPct)}${(item.pnlPct * 100).toFixed(1)}%  peak: ${sign(item.peakPnlPct)}${(item.peakPnlPct * 100).toFixed(1)}%  pullback: ${pullbackPct.toFixed(1)}%\n` +
      `   trail: ${(item.trailPct * 100).toFixed(0)}%  floor: ${sign(item.floorPnlPct)}${(item.floorPnlPct * 100).toFixed(1)}%\n` +
      `   🤖 Last checked ${checkedStr}  ·  ${item.decisionCount} decision${item.decisionCount !== 1 ? "s" : ""} total\n` +
      `   ${emoji} ${item.lastAction.replace("_", " ")}  ${decisionStr}\n` +
      `      <i>"${escapeHtml(item.lastReason)}"</i>\n` +
      `   <a href="${gmgn(escapeHtml(item.mint))}">GMGN</a>`
    );
  });
  return send([header, ...blocks].join("\n\n"));
}

export function notifyLlmTighten(args: {
  name: string;
  mint: string;
  oldTrailPct: number;
  newTrailPct: number;
  reason: string;
}): Promise<void> {
  // Direction-aware: the L1 upgrade allows the LLM to LOOSEN a previously-set
  // trail (up to CONFIG.TRAIL_PCT ceiling). Keep the function name for
  // backward-compat with existing callers, but emit the right copy per direction.
  const loosened = args.newTrailPct > args.oldTrailPct;
  const verb = loosened ? "loosened" : "tightened";
  const icon = loosened ? "🔓" : "🔒";
  return send(
    `🤖 <b>LLM ${verb} ${escapeHtml(args.name)}</b>  ${icon} ${(args.oldTrailPct * 100).toFixed(0)}% → ${(args.newTrailPct * 100).toFixed(0)}%\n` +
    `<i>"${escapeHtml(args.reason)}"</i>\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>`,
  );
}

/**
 * LLM partial-exit notification — fires when the LLM decides to sell a
 * fraction of the position to lock profit while keeping the rest running.
 * Shows how much was sold, the PnL captured on that piece, and the current
 * PnL of the still-held remainder.
 */
export function notifyLlmPartial(args: {
  name: string;
  mint: string;
  sellPct: number;         // e.g. 0.30
  exitSol: number;         // SOL received on this partial sell
  partialPnlSol: number;   // net SOL profit/loss on this partial sell
  partialPnlPct: number;   // PnL % on the piece that was sold
  currentPnlPct: number;   // current total PnL of remaining position (informational)
  reason: string;
  signature: string;
}): Promise<void> {
  const partialSign = args.partialPnlPct >= 0 ? "+" : "";
  const pnlSolSign = args.partialPnlSol >= 0 ? "+" : "";
  const currentSign = args.currentPnlPct >= 0 ? "+" : "";
  return send(
    `💰 <b>LLM partial ${escapeHtml(args.name)}</b>  sold ${(args.sellPct * 100).toFixed(0)}%\n` +
    `Locked: <b>${partialSign}${args.partialPnlPct.toFixed(1)}%</b> (${pnlSolSign}${args.partialPnlSol.toFixed(4)} SOL profit; ${args.exitSol.toFixed(4)} SOL received)\n` +
    `Remainder still open at ${currentSign}${args.currentPnlPct.toFixed(1)}%\n` +
    `<i>"${escapeHtml(args.reason)}"</i>\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>  ·  <a href="${solscan(escapeHtml(args.signature))}">tx ${escapeHtml(short(args.signature))}</a>`,
  );
}

export function notifyTakeProfitPartial(args: {
  name: string;
  mint: string;
  targetPnlPct: number;
  sellPct: number;
  exitSol: number;
  partialPnlSol: number;
  partialPnlPct: number;
  currentPnlPct: number;
  signature: string;
}): Promise<void> {
  const partialSign = args.partialPnlPct >= 0 ? "+" : "";
  const pnlSolSign = args.partialPnlSol >= 0 ? "+" : "";
  const currentSign = args.currentPnlPct >= 0 ? "+" : "";
  return send(
    `🎯 <b>TP ${escapeHtml(args.name)}</b>  +${(args.targetPnlPct * 100).toFixed(0)}% hit, sold ${(args.sellPct * 100).toFixed(0)}%\n` +
    `Locked: <b>${partialSign}${args.partialPnlPct.toFixed(1)}%</b> (${pnlSolSign}${args.partialPnlSol.toFixed(4)} SOL; ${args.exitSol.toFixed(4)} SOL received)\n` +
    `Remainder still open at ${currentSign}${args.currentPnlPct.toFixed(1)}%\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>  ·  <a href="${solscan(escapeHtml(args.signature))}">tx ${escapeHtml(short(args.signature))}</a>`,
  );
}

/**
 * Milestone alert — fires when a position crosses a PnL-% threshold for the
 * first time (e.g. +100%, +200%). Includes an inline sell button so the user
 * can take profit in one tap directly from the notification.
 */
export function notifyMilestone(args: {
  name: string;
  mint: string;
  milestonePct: number;      // the threshold crossed, e.g. 200 for +200%
  currentPnlPct: number;     // actual current PnL (always >= milestonePct)
  peakPnlPct: number;
  entrySol: number;
  unrealizedSol: number;     // current unrealized PnL in SOL
}): Promise<void> {
  const multiple = 1 + args.milestonePct / 100;            // e.g. 200% → 3x
  const multipleStr = multiple >= 2 ? `${multiple.toFixed(multiple >= 10 ? 0 : 1)}x` : "";
  const icon = multiple >= 10 ? "👑" : multiple >= 5 ? "💎" : multiple >= 3 ? "🌙" : "🚀";
  const unrealized = args.unrealizedSol >= 0 ? "+" : "";
  return send(
    `${icon} <b>${escapeHtml(args.name)} hit +${args.milestonePct}%</b>${multipleStr ? `  (${multipleStr})` : ""}\n` +
    `Now: +${args.currentPnlPct.toFixed(1)}%  |  Peak: +${args.peakPnlPct.toFixed(1)}%\n` +
    `Unrealized: <b>${unrealized}${args.unrealizedSol.toFixed(4)} SOL</b>\n` +
    `<a href="${gmgn(escapeHtml(args.mint))}">GMGN</a>`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: `🚨 Sell ${args.name}`, callback_data: `sell:${args.mint}` },
        ]],
      },
    },
  );
}
