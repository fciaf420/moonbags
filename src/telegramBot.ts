import { CONFIG, SETTABLE_SPECS, setConfigValue, toggleConfigValue, type SettableKey } from "./config.js";
import logger from "./logger.js";
import { getPositions, forceClosePosition, getStats, getClosedTrades, type ClosedTrade } from "./positionManager.js";
import { getWalletSolBalance, getWalletAddress } from "./jupClient.js";
import { isPaused, setPaused, addToBlacklist, removeFromBlacklist, getBlacklist } from "./scgPoller.js";
import { getPositionSnapshot } from "./okxClient.js";
import { escapeHtml } from "./notifier.js";
import { runBacktest } from "./_backtest.js";
import {
  getUpdateBlockerDetails,
  getUpdatePreview,
  pullUpdate,
  restartWithPm2,
  type UpdateBlocker,
  type UpdatePreview,
} from "./updateManager.js";
import { formatDoctorHtml, runDoctor, type DoctorReport } from "./doctor.js";
import type { Position } from "./types.js";

type Update = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    message?: { chat: { id: number } };
    data?: string;
  };
};

// Tracks pending edit prompts: when the bot asks "reply with new value", we
// remember which setting key the user is responding to. Keyed by the prompt
// message_id so the user's reply (which references it) can be matched back.
const pendingEdits = new Map<number, SettableKey>();

function enabled(): boolean {
  return Boolean(CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID);
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function tgPost(method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) logger.warn({ method, status: res.status, json }, "[telegram] non-OK response");
  return json;
}

function formatPosition(p: Position): string {
  const entry = p.entryPricePerTokenSol;
  const cur = p.currentPricePerTokenSol;
  const peak = p.peakPricePerTokenSol;
  const pnl = entry > 0 ? ((cur / entry) - 1) * 100 : 0;
  const drawdown = peak > 0 ? (1 - cur / peak) * 100 : 0;
  const armed = p.armed ? " ⚡" : "";
  const icon = pnl >= 0 ? "🟢" : "🔴";
  const mint = `${p.mint.slice(0, 4)}…${p.mint.slice(-4)}`;
  return (
    `${icon} <b>${escapeHtml(p.name)}</b>${armed}  <code>${escapeHtml(mint)}</code>\n` +
    `   PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%  peak: ${entry > 0 ? ((peak / entry - 1) * 100).toFixed(0) : "0"}%  pullback: ${drawdown.toFixed(1)}%`
  );
}

function sellButtons(positions: Position[]): Array<[{ text: string; callback_data: string }]> {
  return positions.map((p) => {
    const entry = p.entryPricePerTokenSol;
    const cur = p.currentPricePerTokenSol;
    const pnl = entry > 0 ? ((cur / entry) - 1) * 100 : 0;
    return [{ text: `🚨 Sell ${p.name} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}%)`, callback_data: `sell:${p.mint}` }];
  });
}

function fmtUptime(bootAt: number): string {
  const secs = Math.floor((Date.now() - bootAt) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
}

// ---------------------------------------------------------------------------
// Settings menu — list editable values, with [Edit]/[Toggle] buttons.
// ---------------------------------------------------------------------------
const SETTINGS_LABELS: Record<SettableKey, string> = {
  BUY_SIZE_SOL:             "💰 Buy size",
  MAX_CONCURRENT_POSITIONS: "📊 Max positions",
  ARM_PCT:                  "⚡ Arm at",
  TRAIL_PCT:                "📉 Trail",
  STOP_PCT:                 "🛑 Stop loss",
  MAX_HOLD_SECS:            "⏱ Max hold",
  LLM_EXIT_ENABLED:         "🧠 LLM advisor",
  MILESTONES_ENABLED:       "🎯 Milestones",
  MILESTONE_PCTS:           "🎯 Milestone %s",
  MOONBAG_PCT:              "🌙 Moonbag keep %",
  MB_TRAIL_PCT:             "🌙 Moonbag trail",
  MB_TIMEOUT_SECS:          "🌙 Moonbag timeout",
};

async function sendSettingsMenu(chatId: number): Promise<void> {
  const keys = Object.keys(SETTABLE_SPECS) as SettableKey[];
  const lines = keys.map((k) => {
    const spec = SETTABLE_SPECS[k];
    const v = (CONFIG as unknown as Record<string, unknown>)[k] as number | boolean | number[];
    return `${SETTINGS_LABELS[k]}: <b>${spec.display(v)}</b>`;
  });

  const buttons = keys.map((k): [{ text: string; callback_data: string }] => {
    const spec = SETTABLE_SPECS[k];
    if (spec.type === "boolean") {
      return [{ text: `Toggle ${SETTINGS_LABELS[k]}`, callback_data: `toggle:${k}` }];
    }
    return [{ text: `Edit ${SETTINGS_LABELS[k]}`, callback_data: `edit:${k}` }];
  });

  await tgPost("sendMessage", {
    chat_id: chatId,
    text: `<b>⚙️ Settings</b>\n\n${lines.join("\n")}\n\n<i>Changes save to .env and apply live — no restart needed.</i>`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
}

async function promptForEdit(chatId: number, key: SettableKey): Promise<void> {
  const spec = SETTABLE_SPECS[key];
  const current = (CONFIG as unknown as Record<string, unknown>)[key] as number | boolean | number[];
  const hint =
    key === "ARM_PCT" || key === "TRAIL_PCT" || key === "STOP_PCT"
      ? `(decimal — e.g. 0.55 for 55%)`
      : key === "BUY_SIZE_SOL"
        ? `(SOL — e.g. 0.05)`
        : key === "MAX_HOLD_SECS"
          ? `(seconds — e.g. 3600 for 1h)`
          : key === "MILESTONE_PCTS"
            ? `(comma-separated % — e.g. 100,200,500,1000 for +100% +200% +500% +1000%)`
            : "";

  const resp = await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `Reply with the new value for <b>${SETTINGS_LABELS[key]}</b>\n` +
      `Current: <b>${spec.display(current)}</b>  ${hint}`,
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true },
  }) as { ok?: boolean; result?: { message_id?: number } };

  const promptId = resp?.result?.message_id;
  if (typeof promptId === "number") {
    pendingEdits.set(promptId, key);
    // auto-clean stale prompts after 5 min
    setTimeout(() => pendingEdits.delete(promptId), 5 * 60_000).unref?.();
  }
}

async function applyEdit(chatId: number, key: SettableKey, raw: string): Promise<void> {
  const result = setConfigValue(key, raw.trim());
  if (result.ok === false) {
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: `❌ Could not update <b>${SETTINGS_LABELS[key]}</b>: ${result.error}`,
      parse_mode: "HTML",
    });
    return;
  }

  const v = (CONFIG as unknown as Record<string, unknown>)[key] as number | boolean;
  await tgPost("sendMessage", {
    chat_id: chatId,
    text: `✅ <b>${SETTINGS_LABELS[key]}</b> → <b>${escapeHtml(SETTABLE_SPECS[key].display(v))}</b>\n<i>Saved to .env. Live now.</i>`,
    parse_mode: "HTML",
  });
  logger.info({ key, value: v }, "[settings] updated via telegram");
}

async function sendStartMenu(chatId: number): Promise<void> {
  const stats = getStats();
  const sol = await getWalletSolBalance().catch(() => null);
  const addr = getWalletAddress();
  const open = getPositions().filter((p) => p.status === "open" || p.status === "opening");

  const armed = open.filter((p) => p.armed).length;
  const llmActive = CONFIG.LLM_EXIT_ENABLED && Boolean(CONFIG.MINIMAX_API_KEY);
  const mode = stats.dryRun ? "🧪 DRY" : "🟢 LIVE";
  const pnlIcon = stats.realizedPnlSol >= 0 ? "🟢" : "🔴";
  const pnlSign = stats.realizedPnlSol >= 0 ? "+" : "";
  const llmIcon = llmActive ? "🤖 ON" : "⚪️ OFF";
  const shortAddr = addr ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : "—";

  const text =
    `<b>🌙 MoonBags</b>  |  ${mode}\n` +
    `\n` +
    `💰 SOL balance: <b>${sol == null ? "?" : sol.toFixed(4)}</b>\n` +
    `📊 Open positions: <b>${open.length}</b> / ${stats.maxConcurrent}  ${armed > 0 ? `(${armed} armed ⚡)` : ""}\n` +
    `${pnlIcon} Realized PnL: <b>${pnlSign}${stats.realizedPnlSol.toFixed(4)} SOL</b>\n` +
    `\n` +
    `⚙️ Buy size: ${CONFIG.BUY_SIZE_SOL} SOL  |  arm: +${(CONFIG.ARM_PCT * 100).toFixed(0)}%  trail: ${(CONFIG.TRAIL_PCT * 100).toFixed(0)}%  stop: -${(CONFIG.STOP_PCT * 100).toFixed(0)}%\n` +
    `🧠 LLM advisor: ${llmIcon}\n` +
    `⏱ Uptime: ${fmtUptime(stats.bootAt)}\n` +
    `👛 Wallet: <code>${escapeHtml(shortAddr)}</code>`;

  await tgPost("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Positions", callback_data: "menu:positions" }, { text: "⚙️ Settings", callback_data: "menu:settings" }],
        [{ text: "🔄 Refresh", callback_data: "menu:refresh" }],
      ],
    },
  });
}

async function sendPositions(chatId: number): Promise<void> {
  const open = getPositions().filter((p) => p.status === "open" || p.status === "opening");

  if (open.length === 0) {
    await tgPost("sendMessage", { chat_id: chatId, text: "📭 No open positions" });
    return;
  }

  await tgPost("sendMessage", {
    chat_id: chatId,
    text: `📊 <b>Open Positions (${open.length})</b>\n\n${open.map(formatPosition).join("\n\n")}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: sellButtons(open) },
  });
}

async function handleCallback(cq: NonNullable<Update["callback_query"]>): Promise<void> {
  const chatId = cq.message?.chat.id;
  if (!chatId) return;
  const data = cq.data ?? "";

  if (data.startsWith("sell:")) {
    const mint = data.slice(5);
    const result = await forceClosePosition(mint);
    await tgPost("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: result.ok ? "✅ Sell initiated" : `❌ ${result.reason}`,
      show_alert: !result.ok,
    });
    if (result.ok) {
      // refresh positions after a brief delay so prices have a moment to update
      setTimeout(() => sendPositions(chatId).catch(() => {}), 1500);
    }
    return;
  }

  if (data === "menu:positions") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
    await sendPositions(chatId);
    return;
  }

  if (data === "menu:refresh") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Refreshed" });
    await sendStartMenu(chatId);
    return;
  }

  if (data === "menu:settings") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
    await sendSettingsMenu(chatId);
    return;
  }

  if (data.startsWith("confirm-adopt:")) {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Applying..." });
    await handleAdoptConfirmed(chatId, data);
    return;
  }

  if (data === "update:confirm") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Updating..." });
    await handleUpdateConfirmed(chatId);
    return;
  }

  if (data === "update:cancel") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Cancelled" });
    await tgPost("sendMessage", { chat_id: chatId, text: "❌ Update cancelled. Code unchanged." });
    return;
  }

  if (data === "doctor:refresh") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Running..." });
    await handleDoctor(chatId);
    return;
  }

  if (data === "setup:refresh") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Refreshing..." });
    await handleSetupStatus(chatId);
    return;
  }

  if (data.startsWith("adopt:")) {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
    await handleAdopt(chatId, data);
    return;
  }

  if (data.startsWith("edit:")) {
    const key = data.slice(5) as SettableKey;
    if (key in SETTABLE_SPECS) {
      await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
      await promptForEdit(chatId, key);
    } else {
      await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Unknown setting" });
    }
    return;
  }

  if (data.startsWith("toggle:")) {
    const key = data.slice(7) as SettableKey;
    if (!(key in SETTABLE_SPECS) || SETTABLE_SPECS[key].type !== "boolean") {
      await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Unknown toggle" });
      return;
    }
    const result = toggleConfigValue(key);
    if (result.ok === false) {
      await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: `❌ ${result.error}`, show_alert: true });
      return;
    }

    const v = (CONFIG as unknown as Record<string, unknown>)[key] as boolean;
    await tgPost("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `${SETTINGS_LABELS[key]}: ${SETTABLE_SPECS[key].display(v)}`,
    });
    await sendSettingsMenu(chatId);  // refresh menu so they see the new state
    logger.info({ key, value: v }, "[settings] toggled via telegram");
    return;
  }

  await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Unknown action" });
}

// ---------------------------------------------------------------------------
// /pause and /resume — stop / resume taking new SCG alerts.
// Open positions keep running regardless.
// ---------------------------------------------------------------------------
async function handlePause(chatId: number): Promise<void> {
  if (isPaused()) {
    await tgPost("sendMessage", { chat_id: chatId, text: "⏸ Already paused. Use /resume to start taking new alerts again." });
    return;
  }
  setPaused(true);
  logger.info("[telegram] bot paused via /pause");
  await tgPost("sendMessage", {
    chat_id: chatId,
    text: "⏸ <b>Paused</b> — new SCG alerts will be ignored.\nOpen positions keep running.\nUse /resume to resume.",
    parse_mode: "HTML",
  });
}

async function handleResume(chatId: number): Promise<void> {
  if (!isPaused()) {
    await tgPost("sendMessage", { chat_id: chatId, text: "▶️ Not paused." });
    return;
  }
  setPaused(false);
  logger.info("[telegram] bot resumed via /resume");
  await tgPost("sendMessage", { chat_id: chatId, text: "▶️ <b>Resumed</b> — taking new alerts again.", parse_mode: "HTML" });
}

// ---------------------------------------------------------------------------
// /sellall — force-close every open position. Requires "CONFIRM" text reply.
// ---------------------------------------------------------------------------
const pendingSellAll = new Set<number>();   // chatIds awaiting "CONFIRM" text

async function handleSellAll(chatId: number): Promise<void> {
  const open = getPositions().filter((p) => p.status === "open");
  if (open.length === 0) {
    await tgPost("sendMessage", { chat_id: chatId, text: "📭 No open positions to sell." });
    return;
  }
  pendingSellAll.add(chatId);
  setTimeout(() => pendingSellAll.delete(chatId), 60_000).unref?.();
  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `⚠️ <b>Sell ALL ${open.length} open positions?</b>\n\n` +
      open.map((p) => `• ${escapeHtml(p.name)}`).join("\n") +
      `\n\nReply <b>CONFIRM</b> (all caps) within 60s to proceed. Anything else cancels.`,
    parse_mode: "HTML",
  });
}

async function executeSellAll(chatId: number): Promise<void> {
  pendingSellAll.delete(chatId);
  const open = getPositions().filter((p) => p.status === "open");
  if (open.length === 0) {
    await tgPost("sendMessage", { chat_id: chatId, text: "📭 No open positions — nothing to sell." });
    return;
  }
  let ok = 0, fail = 0;
  for (const p of open) {
    const r = await forceClosePosition(p.mint);
    if (r.ok) ok++; else fail++;
  }
  logger.info({ ok, fail }, "[telegram] /sellall executed");
  await tgPost("sendMessage", {
    chat_id: chatId,
    text: `🚨 <b>Sellall executed</b>\n✅ Triggered: ${ok}\n❌ Failed: ${fail}`,
    parse_mode: "HTML",
  });
}

// ---------------------------------------------------------------------------
// /pnl — scoreboard: today + all-time PnL, win rate, best/worst trade.
// ---------------------------------------------------------------------------
function summarizePnl(trades: ClosedTrade[]): { pnlSol: number; wins: number; losses: number; best?: ClosedTrade; worst?: ClosedTrade } {
  if (trades.length === 0) return { pnlSol: 0, wins: 0, losses: 0 };
  let pnlSol = 0, wins = 0, losses = 0;
  let best = trades[0]!, worst = trades[0]!;
  for (const t of trades) {
    pnlSol += t.pnlSol;
    if (t.pnlSol >= 0) wins++; else losses++;
    if (t.pnlSol > best.pnlSol) best = t;
    if (t.pnlSol < worst.pnlSol) worst = t;
  }
  return { pnlSol, wins, losses, best, worst };
}

async function handlePnl(chatId: number): Promise<void> {
  const all = await getClosedTrades(500);
  if (all.length === 0) {
    await tgPost("sendMessage", { chat_id: chatId, text: "📭 No closed trades yet." });
    return;
  }
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const today = all.filter((t) => t.closedAt >= todayStart.getTime());

  const sAll = summarizePnl(all);
  const sToday = summarizePnl(today);

  const fmtTrade = (t: ClosedTrade | undefined): string => {
    if (!t) return "—";
    const sign = t.pnlSol >= 0 ? "+" : "";
    return `${escapeHtml(t.name)}  ${sign}${t.pnlSol.toFixed(4)} SOL (${sign}${t.pnlPct.toFixed(0)}%)`;
  };

  const fmtSection = (label: string, s: ReturnType<typeof summarizePnl>): string => {
    const total = s.wins + s.losses;
    const wr = total > 0 ? ((s.wins / total) * 100).toFixed(0) : "0";
    const sign = s.pnlSol >= 0 ? "+" : "";
    const icon = s.pnlSol >= 0 ? "🟢" : "🔴";
    return `${icon} <b>${label}</b>  ${sign}${s.pnlSol.toFixed(4)} SOL\n` +
           `   ${total} trades  ·  ${wr}% win  (${s.wins}W / ${s.losses}L)`;
  };

  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `📈 <b>PnL</b>\n\n` +
      fmtSection("Today", sToday) + "\n\n" +
      fmtSection("All-time", sAll) + "\n\n" +
      `🏆 Best:  ${fmtTrade(sAll.best)}\n` +
      `💀 Worst: ${fmtTrade(sAll.worst)}`,
    parse_mode: "HTML",
  });
}

// ---------------------------------------------------------------------------
// /history [N] — last N closed trades (default 10).
// ---------------------------------------------------------------------------
async function handleHistory(chatId: number, argText: string): Promise<void> {
  const n = Math.min(50, Math.max(1, parseInt(argText) || 10));
  const trades = await getClosedTrades(n);
  if (trades.length === 0) {
    await tgPost("sendMessage", { chat_id: chatId, text: "📭 No closed trades yet." });
    return;
  }
  const lines = trades.map((t) => {
    const sign = t.pnlSol >= 0 ? "+" : "";
    const icon = t.pnlSol >= 0 ? "🟢" : "🔴";
    const hold = t.holdSecs >= 3600 ? `${Math.floor(t.holdSecs/3600)}h` : t.holdSecs >= 60 ? `${Math.floor(t.holdSecs/60)}m` : `${t.holdSecs}s`;
    return `${icon} <b>${escapeHtml(t.name)}</b>  ${sign}${t.pnlSol.toFixed(4)} SOL (${sign}${t.pnlPct.toFixed(0)}%)  ${escapeHtml(t.reason)} · ${hold}`;
  });
  await tgPost("sendMessage", {
    chat_id: chatId,
    text: `📜 <b>Last ${trades.length} trades</b>\n\n${lines.join("\n")}`,
    parse_mode: "HTML",
  });
}

// ---------------------------------------------------------------------------
// /llm — quick toggle for LLM advisor.
// ---------------------------------------------------------------------------
async function handleLlm(chatId: number): Promise<void> {
  const result = toggleConfigValue("LLM_EXIT_ENABLED");
  if (result.ok === false) {
    await tgPost("sendMessage", { chat_id: chatId, text: `❌ ${result.error}` });
    return;
  }
  const now = CONFIG.LLM_EXIT_ENABLED;
  const keySet = Boolean(CONFIG.MINIMAX_API_KEY);
  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `🧠 LLM advisor: <b>${now ? "🤖 ON" : "⚪️ OFF"}</b>` +
      (now && !keySet ? `\n⚠️ MINIMAX_API_KEY is empty — LLM will skip every position.` : ""),
    parse_mode: "HTML",
  });
  logger.info({ llm: now }, "[telegram] LLM toggled via /llm");
}

// ---------------------------------------------------------------------------
// /skip <mint> — blacklist a token so SCG alerts for it are ignored.
// ---------------------------------------------------------------------------
async function handleSkip(chatId: number, argText: string): Promise<void> {
  const mint = argText.trim();
  if (!mint) {
    const list = getBlacklist();
    if (list.length === 0) {
      await tgPost("sendMessage", {
        chat_id: chatId,
        text: "Usage: <code>/skip &lt;mint&gt;</code>\nOr <code>/skip clear</code> to reset the blacklist.\n\nCurrent blacklist: empty.",
        parse_mode: "HTML",
      });
      return;
    }
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: `🚫 <b>Blacklist (${list.length})</b>\n${list.map((m) => `• <code>${escapeHtml(m)}</code>`).join("\n")}`,
      parse_mode: "HTML",
    });
    return;
  }
  if (mint.toLowerCase() === "clear") {
    for (const m of getBlacklist()) removeFromBlacklist(m);
    await tgPost("sendMessage", { chat_id: chatId, text: "✅ Blacklist cleared." });
    return;
  }
  addToBlacklist(mint);
  logger.info({ mint }, "[telegram] added to blacklist");
  await tgPost("sendMessage", {
    chat_id: chatId,
    text: `🚫 Added to blacklist: <code>${escapeHtml(mint)}</code>\nSCG alerts for this token will be ignored.`,
    parse_mode: "HTML",
  });
}

// ---------------------------------------------------------------------------
// /mint <mint> — on-demand full on-chain snapshot for any token.
// ---------------------------------------------------------------------------
async function handleMint(chatId: number, argText: string): Promise<void> {
  const mint = argText.trim();
  if (!mint) {
    await tgPost("sendMessage", { chat_id: chatId, text: "Usage: <code>/mint &lt;contract_address&gt;</code>", parse_mode: "HTML" });
    return;
  }
  await tgPost("sendMessage", { chat_id: chatId, text: "🔍 Fetching snapshot..." });
  const snap = await getPositionSnapshot(mint, 30).catch(() => null);
  if (!snap || !snap.momentum) {
    await tgPost("sendMessage", { chat_id: chatId, text: `❌ Could not fetch data for <code>${escapeHtml(mint)}</code>`, parse_mode: "HTML" });
    return;
  }
  const m = snap.momentum;
  const r = snap.risk;
  const h = snap.topHolders;
  const dev = snap.dev;
  const sm = snap.smartMoney;
  const bu = snap.bundlers;
  const devTag = r?.tokenTags.find((t) => t.startsWith("devHoldingStatus")) ?? "—";
  const fmtFlow = (w: typeof sm): string => `${w.buys}b/${w.sells}s  ${w.netFlowSol >= 0 ? "+" : ""}${w.netFlowSol.toFixed(2)} SOL`;

  const text =
    `🔎 <b>${escapeHtml(`${mint.slice(0,6)}…${mint.slice(-4)}`)}</b>\n\n` +
    `📈 $${m.priceUsd.toExponential(3)}  mcap $${(m.marketCapUsd/1000).toFixed(1)}K  liq $${(m.liquidityUsd/1000).toFixed(1)}K\n` +
    `   5m ${m.priceChange5m.toFixed(1)}%  1h ${m.priceChange1h.toFixed(1)}%  4h ${m.priceChange4h.toFixed(1)}%  24h ${m.priceChange24h.toFixed(1)}%\n` +
    `   ATH: ${m.pctFromAth.toFixed(1)}%  holders ${m.holders}\n\n` +
    `🤝 <b>30m flow</b>\n` +
    `   dev:   ${fmtFlow(dev)}\n` +
    `   smart: ${fmtFlow(sm)}\n` +
    `   bndlr: ${fmtFlow(bu)}\n\n` +
    (r ? `🛡️ dev holds ${r.devHoldingPercent}%  (${escapeHtml(devTag)})\n   LP burned ${r.lpBurnedPercent.toFixed(0)}%  top10 ${r.top10HoldPercent}%\n` : "") +
    (h ? `👥 top10 avg PnL $${h.averagePnlUsd.toFixed(0)}  trend [${escapeHtml(h.trendType.join(","))}]\n` : "") +
    `\n<a href="https://gmgn.ai/sol/token/${escapeHtml(mint)}">GMGN</a>`;

  await tgPost("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}

// ---------------------------------------------------------------------------
// /wallet — full wallet address + SOL balance.
// ---------------------------------------------------------------------------
async function handleWallet(chatId: number): Promise<void> {
  const addr = getWalletAddress();
  const sol = await getWalletSolBalance().catch(() => null);
  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `👛 <b>Wallet</b>\n\n` +
      `Address: <code>${escapeHtml(addr ?? "—")}</code>\n` +
      `SOL balance: <b>${sol == null ? "?" : sol.toFixed(4)}</b>` +
      (addr ? `\n\n<a href="https://solscan.io/account/${escapeHtml(addr)}">Solscan</a>` : ""),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

function formatSetupStatusHtml(report: DoctorReport): string {
  const setupIds = new Set([
    "os",
    "node",
    "git",
    "npm",
    "env:file",
    "env:JUP_API_KEY",
    "env:HELIUS_API_KEY",
    "env:PRIV_B58",
    "env:okx",
    "env:telegram",
    "onchainos:version",
    "onchainos:hot-tokens",
    "pm2",
    "pm2:moonbags",
  ]);
  return formatDoctorHtml({
    ok: report.checks.filter((check) => setupIds.has(check.id)).every((check) => check.status !== "fail"),
    checks: report.checks.filter((check) => setupIds.has(check.id)),
  }, "MoonBags Setup Status");
}

async function handleDoctor(chatId: number): Promise<void> {
  await tgPost("sendMessage", { chat_id: chatId, text: "🩺 Running doctor checks..." });
  const report = await runDoctor({ network: true });
  await tgPost("sendMessage", {
    chat_id: chatId,
    text: formatDoctorHtml(report),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "🔄 Run doctor again", callback_data: "doctor:refresh" }]],
    },
  });
}

async function handleSetupStatus(chatId: number): Promise<void> {
  const report = await runDoctor({ network: false });
  await tgPost("sendMessage", {
    chat_id: chatId,
    text: formatSetupStatusHtml(report),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "🔄 Refresh setup status", callback_data: "setup:refresh" }]],
    },
  });
}

// ---------------------------------------------------------------------------
// /backtest — run a backtest on ~100 hot-token Solana candidates, present top 5
// combos vs the user's current config, and let them adopt any row with a
// tap (writes live to .env via setConfigValue, no restart needed).
// ---------------------------------------------------------------------------
let backtestInFlight = false;

async function handleBacktest(chatId: number, argText: string = ""): Promise<void> {
  // `/backtest hybrid` grids over moonbag params additionally.
  const mode: "simple" | "hybrid" = argText.trim().toLowerCase() === "hybrid" ? "hybrid" : "simple";

  if (backtestInFlight) {
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: "⏳ Backtest already running. Wait for it to finish — they take ~60s.",
    });
    return;
  }
  backtestInFlight = true;

  // Status message we'll update as progress happens
  const llmWarning = CONFIG.LLM_EXIT_ENABLED
    ? "\n⚠️ <b>LLM exit advisor is ON.</b> This backtest models static-trail mode only — " +
      (mode === "hybrid"
        ? "MOONBAG params would only fire with LLM off."
        : "adopted ARM/TRAIL/STOP become ceilings the LLM can tighten against.")
    : "";
  const startMsg = await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `🧪 <b>Running ${mode === "hybrid" ? "hybrid" : "simple"} backtest...</b>\n` +
      `<i>Fetching ~100 hot-tokens on Solana + 5m klines. Entry = oldest candle per token (no filter — mirrors bot receiving alert).\n` +
      `This takes ~60 seconds.</i>` +
      llmWarning,
    parse_mode: "HTML",
  }) as { result?: { message_id?: number } };
  const statusId = startMsg?.result?.message_id;

  try {
    const { topResults, allResults, samplesUsed, tokensFetched, durationMs } = await runBacktest({
      bar: "5m",
      topN: 5,
      minCandles: 60,
      hybrid: mode === "hybrid",
    });

    if (!topResults.length) {
      await tgPost("sendMessage", {
        chat_id: chatId,
        text: "❌ Backtest returned no results. Check onchainos CLI connectivity.",
      });
      return;
    }

    // Where does the CURRENT config rank? For hybrid we also match on moonbag params.
    const curArm = CONFIG.ARM_PCT;
    const curTrail = CONFIG.TRAIL_PCT;
    const curStop = CONFIG.STOP_PCT;
    const curMb = CONFIG.MOONBAG_PCT;
    const curMbTrail = CONFIG.MB_TRAIL_PCT;
    const curMbTimeoutMin = CONFIG.MB_TIMEOUT_SECS / 60;
    const curIdx = allResults.findIndex(
      (r) =>
        Math.abs(r.arm - curArm) < 0.001 &&
        Math.abs(r.trail - curTrail) < 0.001 &&
        Math.abs(r.stop - curStop) < 0.001 &&
        (mode === "simple" ||
          (Math.abs(r.moonbagPct - curMb) < 0.001 &&
           Math.abs(r.mbTrail - curMbTrail) < 0.001 &&
           Math.abs(r.mbTimeout - curMbTimeoutMin) < 0.01)),
    );
    const curRow = curIdx >= 0 ? allResults[curIdx] : null;

    // Compact formatting for hybrid rows (extra params)
    const fmtCombo = (r: typeof allResults[number]): string => {
      const base = `ARM ${(r.arm*100).toFixed(0)}% / TRAIL ${(r.trail*100).toFixed(0)}% / STOP ${(r.stop*100).toFixed(0)}%`;
      if (mode !== "hybrid") return base;
      if (r.moonbagPct === 0) return `${base} · MB off`;
      return `${base} · MB ${(r.moonbagPct*100).toFixed(0)}% @trail ${(r.mbTrail*100).toFixed(0)}% (${r.mbTimeout}m)`;
    };
    const fmtComboBtn = (r: typeof allResults[number]): string => {
      const base = `ARM ${(r.arm*100).toFixed(0)} TRAIL ${(r.trail*100).toFixed(0)} STOP ${(r.stop*100).toFixed(0)}`;
      if (mode !== "hybrid") return base;
      if (r.moonbagPct === 0) return `${base} MB off`;
      return `${base} MB ${(r.moonbagPct*100).toFixed(0)}%`;
    };

    // Build message
    const lines: string[] = [];
    lines.push(`🧪 <b>Backtest complete</b> (${mode})`);
    lines.push(`<i>${samplesUsed}/${tokensFetched} tokens · ${allResults.length} combos · ${Math.round(durationMs/1000)}s · 5m bars · entry at oldest candle</i>`);
    lines.push("");
    if (CONFIG.LLM_EXIT_ENABLED) {
      lines.push(`⚠️ <b>LLM is ON</b> — ${mode === "hybrid"
        ? "MOONBAG params only take effect with LLM off."
        : "adopted params are ceilings the LLM can tighten against."}`);
      lines.push("");
    }

    if (curRow) {
      const curWinPct = (curRow.wins / (curRow.wins + curRow.losses || 1)) * 100;
      const rank = curIdx + 1;
      lines.push(`<b>Your current:</b>  ${fmtCombo(curRow)}`);
      lines.push(`   +${curRow.totalPnlPct.toFixed(0)}%  ·  avg +${curRow.avgExitPct.toFixed(0)}%/trade  ·  ${curRow.wins}W/${curRow.losses}L/${curRow.holding}H  ·  ${curWinPct.toFixed(0)}% win  ·  <b>rank #${rank}/${allResults.length}</b>`);
    } else {
      lines.push(`<b>Your current</b> (ARM ${(curArm*100).toFixed(0)}% / TRAIL ${(curTrail*100).toFixed(0)}% / STOP ${(curStop*100).toFixed(0)}%) isn't in the test grid.`);
    }
    lines.push("");
    lines.push(`<b>Top 5 combos:</b>`);

    for (let i = 0; i < topResults.length; i++) {
      const r = topResults[i]!;
      const winPct = (r.wins / (r.wins + r.losses || 1)) * 100;
      const isCurrent = curIdx === i;
      const marker = isCurrent ? " ← your current" : "";
      lines.push(
        `<b>#${i+1}</b>  ${fmtCombo(r)}${marker}\n` +
        `   +${r.totalPnlPct.toFixed(0)}%  ·  avg +${r.avgExitPct.toFixed(0)}%/trade  ·  ${r.wins}W/${r.losses}L/${r.holding}H  ·  ${winPct.toFixed(0)}% win`,
      );
    }
    lines.push("");
    lines.push(`<i>Tap a row to adopt (applies live, no restart needed).</i>`);

    // Buttons — callback_data carries mode + params so adopt handler knows what to write.
    // simple  → adopt:simple:arm:trail:stop
    // hybrid  → adopt:hybrid:arm:trail:stop:mbPct:mbTrail:mbTimeoutMin
    const buttons = topResults.map((r, i): [{ text: string; callback_data: string }] => {
      const data = mode === "hybrid"
        ? `adopt:hybrid:${r.arm.toFixed(2)}:${r.trail.toFixed(2)}:${r.stop.toFixed(2)}:${r.moonbagPct.toFixed(2)}:${r.mbTrail.toFixed(2)}:${r.mbTimeout}`
        : `adopt:simple:${r.arm.toFixed(2)}:${r.trail.toFixed(2)}:${r.stop.toFixed(2)}`;
      return [{ text: `Adopt #${i+1}: ${fmtComboBtn(r)}`, callback_data: data }];
    });
    buttons.push([{ text: "❌ Cancel", callback_data: "adopt:cancel" }]);

    // Replace the status message with final result
    if (statusId) {
      await tgPost("editMessageText", {
        chat_id: chatId,
        message_id: statusId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttons },
      });
    } else {
      await tgPost("sendMessage", {
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttons },
      });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[telegram] backtest failed");
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: `❌ Backtest failed: ${escapeHtml((err as Error).message)}`,
      parse_mode: "HTML",
    });
  } finally {
    backtestInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// /update — pull origin/main and restart through pm2.
// ---------------------------------------------------------------------------
function formatUpdateBlocker(blocker: UpdateBlocker, preview?: UpdatePreview): string[] {
  if (blocker.code === "up_to_date") {
    return [`✅ <b>${escapeHtml(blocker.title)}</b> — ${escapeHtml(blocker.detail)}`];
  }

  const lines = [`❌ <b>Cannot update:</b> ${escapeHtml(blocker.title)}`, escapeHtml(blocker.detail)];
  if (blocker.code === "dirty_worktree" && preview) {
    const shown = preview.dirtyFiles.slice(0, 8);
    if (shown.length > 0) {
      lines.push("", "<b>Local changes:</b>");
      for (const file of shown) lines.push(`• <code>${escapeHtml(file)}</code>`);
      if (preview.dirtyFiles.length > shown.length) {
        lines.push(`• ...and ${preview.dirtyFiles.length - shown.length} more`);
      }
    }
  }
  if (blocker.nextSteps.length > 0) {
    lines.push("", "<b>Fix:</b>");
    for (const step of blocker.nextSteps) lines.push(`<code>${escapeHtml(step)}</code>`);
  }
  return lines;
}

function formatUpdatePreview(preview: UpdatePreview): string {
  const blocker = getUpdateBlockerDetails(preview);
  const openCount = getPositions().filter((p) => p.status === "open" || p.status === "opening").length;
  const lines: string[] = [
    "🔄 <b>MoonBags update check</b>",
    "",
    `Current: <code>${escapeHtml(preview.currentSha)}</code>`,
    `Remote:  <code>${escapeHtml(preview.remoteSha)}</code>`,
    `Behind: <b>${preview.behind}</b> commit(s)  ·  Ahead: <b>${preview.ahead}</b>`,
    `Open positions: <b>${openCount}</b>`,
    "",
  ];

  if (preview.commits.length > 0) {
    lines.push("<b>Incoming commits:</b>");
    for (const commit of preview.commits) {
      lines.push(`• <code>${escapeHtml(commit)}</code>`);
    }
    lines.push("");
  }

  if (preview.packageFilesChanged) {
    lines.push("📦 <i>package files changed; npm install will run.</i>");
  }
  if (openCount > 0) {
    lines.push("⚠️ <i>Restart pauses management briefly while pm2 brings the bot back.</i>");
  }

  if (blocker) {
    lines.push("", ...formatUpdateBlocker(blocker, preview));
  } else {
    lines.push("\nTap confirm to pull <code>origin/main</code> and restart <code>moonbags</code> with pm2.");
  }

  return lines.join("\n");
}

async function handleUpdate(chatId: number): Promise<void> {
  try {
    const preview = await getUpdatePreview();
    const blocker = getUpdateBlockerDetails(preview);
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: formatUpdatePreview(preview),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: blocker ? undefined : {
        inline_keyboard: [
          [{ text: "✅ Confirm Update + Restart", callback_data: "update:confirm" }],
          [{ text: "❌ Cancel", callback_data: "update:cancel" }],
        ],
      },
    });
  } catch (err) {
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: `❌ Update check failed: ${escapeHtml((err as Error).message)}`,
      parse_mode: "HTML",
    });
  }
}

async function handleUpdateConfirmed(chatId: number): Promise<void> {
  try {
    const preview = await getUpdatePreview();
    const blocker = getUpdateBlockerDetails(preview);
    if (blocker) {
      await tgPost("sendMessage", {
        chat_id: chatId,
        text: formatUpdateBlocker(blocker, preview).join("\n"),
        parse_mode: "HTML",
      });
      return;
    }

    await tgPost("sendMessage", {
      chat_id: chatId,
      text: "⏳ Pulling latest <code>origin/main</code>...",
      parse_mode: "HTML",
    });

    const result = await pullUpdate(preview);
    const lines = [
      "✅ <b>Update pulled</b>",
      `${escapeHtml(result.previousSha)} → ${escapeHtml(result.currentSha)}`,
      result.packageFilesChanged ? "📦 npm install completed." : "📦 Dependencies unchanged.",
      "",
      "🔁 Restarting <code>moonbags</code> with pm2 now...",
    ];

    await tgPost("sendMessage", {
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
    });

    setTimeout(() => {
      restartWithPm2().catch((err) => {
        logger.error({ err: (err as Error).message }, "[telegram] pm2 restart failed after update");
      });
    }, 750).unref?.();
  } catch (err) {
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: `❌ Update failed: ${escapeHtml((err as Error).message)}`,
      parse_mode: "HTML",
    });
  }
}

// First-tap handler — does NOT apply. Shows a side-by-side diff vs current
// settings and asks for explicit confirmation. The confirm tap uses the
// callback_data prefix `confirm-adopt:` to route to the actual apply path.
// Formats:
//   adopt:cancel
//   adopt:simple:arm:trail:stop
//   adopt:hybrid:arm:trail:stop:mbPct:mbTrail:mbTimeoutMin
async function handleAdopt(chatId: number, data: string): Promise<void> {
  const parts = data.split(":");
  if (parts[1] === "cancel") {
    await tgPost("sendMessage", { chat_id: chatId, text: "❌ Cancelled. Config unchanged." });
    return;
  }
  const mode = parts[1] === "hybrid" ? "hybrid" : "simple";
  const arm   = parts[2];
  const trail = parts[3];
  const stop  = parts[4];
  if (!arm || !trail || !stop) {
    await tgPost("sendMessage", { chat_id: chatId, text: "⚠️ Malformed adopt data." });
    return;
  }

  const newArm = parseFloat(arm);
  const newTrail = parseFloat(trail);
  const newStop = parseFloat(stop);
  const curArm = CONFIG.ARM_PCT;
  const curTrail = CONFIG.TRAIL_PCT;
  const curStop = CONFIG.STOP_PCT;

  // Build a side-by-side diff so the user sees exactly what will change.
  const diffRowPct = (label: string, cur: number, next: number): string => {
    const unchanged = Math.abs(cur - next) < 0.001;
    if (unchanged) {
      return `${label.padEnd(8)}${(cur * 100).toFixed(0)}%  (unchanged)`;
    }
    const delta = (next - cur) * 100;
    const arrow = delta >= 0 ? "↑" : "↓";
    const sign = delta >= 0 ? "+" : "";
    return `${label.padEnd(8)}${(cur * 100).toFixed(0)}% → <b>${(next * 100).toFixed(0)}%</b>  ${arrow} ${sign}${delta.toFixed(0)}%`;
  };
  const diffRowMin = (label: string, curMin: number, nextMin: number): string => {
    const unchanged = Math.abs(curMin - nextMin) < 0.01;
    if (unchanged) return `${label.padEnd(8)}${Math.round(curMin)}m  (unchanged)`;
    const delta = nextMin - curMin;
    const arrow = delta >= 0 ? "↑" : "↓";
    const sign = delta >= 0 ? "+" : "";
    return `${label.padEnd(8)}${Math.round(curMin)}m → <b>${Math.round(nextMin)}m</b>  ${arrow} ${sign}${Math.round(delta)}m`;
  };

  const diffLines = [
    diffRowPct("ARM:", curArm, newArm),
    diffRowPct("TRAIL:", curTrail, newTrail),
    diffRowPct("STOP:", curStop, newStop),
  ];

  let hybridExtra = "";
  if (mode === "hybrid") {
    const mbPct        = parts[5];
    const mbTrail      = parts[6];
    const mbTimeoutMin = parts[7];
    if (!mbPct || !mbTrail || !mbTimeoutMin) {
      await tgPost("sendMessage", { chat_id: chatId, text: "⚠️ Malformed hybrid adopt data." });
      return;
    }
    const newMb = parseFloat(mbPct);
    const newMbTrail = parseFloat(mbTrail);
    const newMbTimeoutMin = parseFloat(mbTimeoutMin);
    const curMb = CONFIG.MOONBAG_PCT;
    const curMbTrail = CONFIG.MB_TRAIL_PCT;
    const curMbTimeoutMin = CONFIG.MB_TIMEOUT_SECS / 60;
    diffLines.push(diffRowPct("MB:", curMb, newMb));
    diffLines.push(diffRowPct("MBTRAIL:", curMbTrail, newMbTrail));
    diffLines.push(diffRowMin("MBTIME:", curMbTimeoutMin, newMbTimeoutMin));
    if (CONFIG.LLM_EXIT_ENABLED) {
      hybridExtra = "\n⚠️ <b>LLM_EXIT_ENABLED is ON</b> — MOONBAG params will NOT take effect. Partial exits are LLM-driven.\nSet LLM_EXIT_ENABLED=false in /settings for these to fire.";
    }
  }

  // Confirm callback_data preserves mode + params
  const confirmData = mode === "hybrid"
    ? `confirm-adopt:hybrid:${arm}:${trail}:${stop}:${parts[5]}:${parts[6]}:${parts[7]}`
    : `confirm-adopt:simple:${arm}:${trail}:${stop}`;

  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `⚠️ <b>Confirm adopt? (${mode})</b>\n\n` +
      `<pre>${diffLines.map(l => escapeHtml(l)).join("\n")}</pre>\n` +
      `Applies live, writes to .env. No restart needed.` +
      hybridExtra,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Yes, adopt", callback_data: confirmData }],
        [{ text: "❌ Cancel", callback_data: "adopt:cancel" }],
      ],
    },
  });
}

// Confirm tap — actually applies the settings. Fires setConfigValue for
// each of ARM_PCT / TRAIL_PCT / STOP_PCT (+ moonbag in hybrid) in sequence;
// partial failure is surfaced per-field.
async function handleAdoptConfirmed(chatId: number, data: string): Promise<void> {
  // data = "confirm-adopt:simple:arm:trail:stop"
  //      | "confirm-adopt:hybrid:arm:trail:stop:mbPct:mbTrail:mbTimeoutMin"
  const parts = data.split(":");
  const mode = parts[1] === "hybrid" ? "hybrid" : "simple";
  const arm   = parts[2];
  const trail = parts[3];
  const stop  = parts[4];
  if (!arm || !trail || !stop) {
    await tgPost("sendMessage", { chat_id: chatId, text: "⚠️ Malformed confirm-adopt data." });
    return;
  }

  type SetEntry = { key: SettableKey; value: string; result: ReturnType<typeof setConfigValue> };
  const results: SetEntry[] = [
    { key: "ARM_PCT", value: arm, result: setConfigValue("ARM_PCT", arm) },
    { key: "TRAIL_PCT", value: trail, result: setConfigValue("TRAIL_PCT", trail) },
    { key: "STOP_PCT", value: stop, result: setConfigValue("STOP_PCT", stop) },
  ];

  if (mode === "hybrid") {
    const mbPct = parts[5];
    const mbTrail = parts[6];
    const mbTimeoutMin = parts[7];
    if (!mbPct || !mbTrail || !mbTimeoutMin) {
      await tgPost("sendMessage", { chat_id: chatId, text: "⚠️ Malformed hybrid confirm-adopt data." });
      return;
    }
    const mbSecs = String(Math.round(parseFloat(mbTimeoutMin) * 60));
    results.push({ key: "MOONBAG_PCT", value: mbPct, result: setConfigValue("MOONBAG_PCT", mbPct) });
    results.push({ key: "MB_TRAIL_PCT", value: mbTrail, result: setConfigValue("MB_TRAIL_PCT", mbTrail) });
    results.push({ key: "MB_TIMEOUT_SECS", value: mbSecs, result: setConfigValue("MB_TIMEOUT_SECS", mbSecs) });
  }

  const failures = results.filter(r => !r.result.ok);
  if (failures.length > 0) {
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: `⚠️ Adopt partially failed:\n${failures.map(f => `${f.key}=${f.value} → ${(f.result as { ok: false; error: string }).error}`).join("\n")}`,
    });
    return;
  }

  logger.info({ mode, arm, trail, stop, extra: mode === "hybrid" ? { mb: parts[5], mbTrail: parts[6], mbTimeoutMin: parts[7] } : undefined }, "[telegram] backtest config adopted");

  const summary = [
    `ARM: ${(parseFloat(arm)*100).toFixed(0)}%`,
    `TRAIL: ${(parseFloat(trail)*100).toFixed(0)}%`,
    `STOP: ${(parseFloat(stop)*100).toFixed(0)}%`,
  ];
  if (mode === "hybrid") {
    summary.push(`MOONBAG: ${(parseFloat(parts[5]!)*100).toFixed(0)}%`);
    summary.push(`MB_TRAIL: ${(parseFloat(parts[6]!)*100).toFixed(0)}%`);
    summary.push(`MB_TIMEOUT: ${Math.round(parseFloat(parts[7]!))}m`);
  }
  const llmWarning = mode === "hybrid" && CONFIG.LLM_EXIT_ENABLED
    ? "\n\n⚠️ <b>Reminder:</b> LLM is ON — MOONBAG params saved to .env but won't fire until you set LLM_EXIT_ENABLED=false."
    : "";
  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `✅ <b>Adopted new config (${mode})</b>\n` +
      summary.join("\n") + "\n\n" +
      `<i>Saved to .env and active on next tick. No restart needed.</i>` +
      llmWarning,
    parse_mode: "HTML",
  });
}

export function startTelegramBot(): () => void {
  if (!enabled()) {
    logger.info("[telegram] disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable");
    return () => {};
  }

  const allowedChat = String(CONFIG.TELEGRAM_CHAT_ID);
  let offset = 0;
  let stopped = false;

  // Register slash commands
  void tgPost("setMyCommands", {
    commands: [
      { command: "start",     description: "MoonBags dashboard" },
      { command: "positions", description: "Open positions + force-sell buttons" },
      { command: "pnl",       description: "Today's PnL + all-time stats" },
      { command: "history",   description: "Last N closed trades (default 10)" },
      { command: "settings",  description: "Edit trading params live (no restart)" },
      { command: "llm",       description: "Toggle the LLM exit advisor on/off" },
      { command: "pause",     description: "Stop taking new SCG alerts" },
      { command: "resume",    description: "Resume taking new SCG alerts" },
      { command: "sellall",   description: "Emergency close-all (requires CONFIRM)" },
      { command: "skip",      description: "Blacklist a mint (or list/clear)" },
      { command: "mint",      description: "On-demand on-chain snapshot of any token" },
      { command: "wallet",    description: "Show wallet address + SOL balance" },
      { command: "backtest",  description: "Run backtest + adopt live (add 'hybrid' for moonbag grid)" },
      { command: "doctor",    description: "Run setup and runtime health checks" },
      { command: "setup_status", description: "Show setup checklist" },
      { command: "update",    description: "Pull latest code and restart via pm2" },
    ],
  });

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const res = await fetch(apiUrl("getUpdates") + `?timeout=25&offset=${offset}`);
        const json = (await res.json()) as { ok: boolean; result?: Update[] };

        if (!json.ok || !json.result) {
          await new Promise((r) => setTimeout(r, 2_000));
          continue;
        }

        for (const u of json.result) {
          offset = Math.max(offset, u.update_id + 1);

          const fromChat = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
          if (fromChat === undefined || String(fromChat) !== allowedChat) continue;

          if (u.callback_query) {
            await handleCallback(u.callback_query).catch((e) =>
              logger.warn({ err: (e as Error).message }, "[telegram] callback error"),
            );
            continue;
          }

          const text = (u.message?.text ?? "").trim();
          const chatId = u.message!.chat.id;

          // Reply to a settings prompt? (force_reply messages have reply_to_message)
          const replyToId = u.message?.reply_to_message?.message_id;
          if (replyToId !== undefined && pendingEdits.has(replyToId)) {
            const key = pendingEdits.get(replyToId)!;
            pendingEdits.delete(replyToId);
            await applyEdit(chatId, key, text);
            continue;
          }

          // Awaiting CONFIRM for /sellall?
          if (pendingSellAll.has(chatId)) {
            if (text === "CONFIRM") {
              await executeSellAll(chatId);
            } else {
              pendingSellAll.delete(chatId);
              await tgPost("sendMessage", { chat_id: chatId, text: "❌ Cancelled — did not sell." });
            }
            continue;
          }

          // Parse "/cmd args..." into command + rest
          const [rawCmd, ...restParts] = text.split(/\s+/);
          const cmd = rawCmd ? rawCmd.split("@")[0] : "";   // strip /start@MoonBagsBot → /start
          const argText = restParts.join(" ");

          try {
            switch (cmd) {
              case "/start":     await sendStartMenu(chatId); break;
              case "/positions": await sendPositions(chatId); break;
              case "/settings":  await sendSettingsMenu(chatId); break;
              case "/pnl":       await handlePnl(chatId); break;
              case "/history":   await handleHistory(chatId, argText); break;
              case "/llm":       await handleLlm(chatId); break;
              case "/pause":     await handlePause(chatId); break;
              case "/resume":    await handleResume(chatId); break;
              case "/sellall":   await handleSellAll(chatId); break;
              case "/skip":      await handleSkip(chatId, argText); break;
              case "/mint":      await handleMint(chatId, argText); break;
              case "/wallet":    await handleWallet(chatId); break;
              case "/backtest":  await handleBacktest(chatId, argText); break;
              case "/doctor":    await handleDoctor(chatId); break;
              case "/setup_status": await handleSetupStatus(chatId); break;
              case "/update":    await handleUpdate(chatId); break;
            }
          } catch (err) {
            logger.warn({ err: (err as Error).message, cmd }, "[telegram] command handler threw");
            // Best effort: tell the user something went wrong, but don't crash the loop.
            await tgPost("sendMessage", {
              chat_id: chatId,
              text: `⚠️ Command failed: ${escapeHtml((err as Error).message ?? "unknown error")}`,
              parse_mode: "HTML",
            }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "[telegram] poll error");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  void loop();
  logger.info("[telegram] bot polling started");

  return () => {
    stopped = true;
    logger.info("[telegram] bot polling stopped");
  };
}
