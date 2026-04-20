import { CONFIG, SETTABLE_SPECS, setConfigValue as setConfigValueRaw, toggleConfigValue as toggleConfigValueRaw, type SetConfigResult, type SettableKey } from "./config.js";
import logger from "./logger.js";
import { getPositions, forceClosePosition, getStats, getClosedTrades, getSignalStats, type ClosedTrade } from "./positionManager.js";
import { getWalletSolBalance, getWalletAddress } from "./jupClient.js";
import {
  isPaused,
  setPaused,
  addToBlacklist,
  removeFromBlacklist,
  getBlacklist,
  getPollerHealth,
  getRecentAlertEvents,
  hasSeenAlert,
  alertKey,
  SCG_URL,
} from "./scgPoller.js";
import type { ScgAlertsResponse } from "./types.js";
import { getPositionSnapshot } from "./okxClient.js";
import { escapeHtml } from "./notifier.js";
import { runBacktest, type BacktestTpTarget } from "./_backtest.js";
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
import {
  formatTpTargets,
  getRuntimeSettings,
  parseTpTargetsInput,
  setExitStrategy,
  setTpTargets,
  syncRuntimeSettingsFromConfig,
  updateRuntimeSettings,
  type ExitStrategyMode,
} from "./settingsStore.js";

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
type ExitTargetEdit = { kind: "tp_targets" };
const pendingExitEdits = new Map<number, ExitTargetEdit>();

const EXIT_STRATEGY_LABELS: Record<ExitStrategyMode, string> = {
  trail: "🌙 Trail",
  fixed_tp: "🎯 Fixed TP",
  tp_ladder: "🪜 TP Ladder",
  llm_managed: "🧠 LLM Managed",
};

const BACKTEST_LADDER_PRESETS: Record<string, BacktestTpTarget[]> = {
  fast: [{ pnlPct: 0.50, sellPct: 0.50 }, { pnlPct: 1.00, sellPct: 1.00 }],
  balanced: [{ pnlPct: 0.50, sellPct: 0.25 }, { pnlPct: 1.00, sellPct: 0.25 }, { pnlPct: 2.00, sellPct: 1.00 }],
  runner: [{ pnlPct: 0.50, sellPct: 0.25 }, { pnlPct: 1.00, sellPct: 0.25 }, { pnlPct: 2.00, sellPct: 0.25 }],
};

function setConfigValue(key: SettableKey, raw: string): SetConfigResult {
  const result = setConfigValueRaw(key, raw);
  if (result.ok) syncRuntimeSettingsFromConfig();
  return result;
}

function toggleConfigValue(key: SettableKey): SetConfigResult {
  const result = toggleConfigValueRaw(key);
  if (result.ok) syncRuntimeSettingsFromConfig();
  return result;
}

function strategySummaryLines(): string[] {
  const settings = getRuntimeSettings();
  const strategy = settings.exit.profitStrategy;
  const targets = strategy.type === "fixed_tp"
    ? formatTpTargets([{ pnlPct: strategy.fixedTargetPct, sellPct: 1 }])
    : formatTpTargets(strategy.ladderTargets);
  return [
    `Strategy: <b>${EXIT_STRATEGY_LABELS[strategy.type]}</b>`,
    `TP targets: <code>${escapeHtml(targets)}</code>`,
  ];
}

function formatRiskSummary(): string {
  const settings = getRuntimeSettings();
  const arm = `${(settings.exit.trail.armPct * 100).toFixed(0)}%`;
  const trail = `${(settings.exit.trail.trailPct * 100).toFixed(0)}%`;
  const stop = `${(settings.exit.risk.stopPct * 100).toFixed(0)}%`;
  const hold = SETTABLE_SPECS.MAX_HOLD_SECS.display(settings.exit.risk.maxHoldSecs);
  return `Arm ${arm} · Trail ${trail} · Stop ${stop} · Max hold ${hold}`;
}

async function promptForTpTargets(chatId: number): Promise<void> {
  const resp = await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      "Reply with TP targets as <b>profit:close</b> pairs.\n" +
      "Example: <code>50:25,100:25,200:25</code>\n" +
      `Current: <code>${escapeHtml(formatTpTargets(getRuntimeSettings().exit.profitStrategy.ladderTargets))}</code>`,
    parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true },
  }) as { ok?: boolean; result?: { message_id?: number } };

  const promptId = resp?.result?.message_id;
  if (typeof promptId === "number") {
    pendingExitEdits.set(promptId, { kind: "tp_targets" });
    setTimeout(() => pendingExitEdits.delete(promptId), 5 * 60_000).unref?.();
  }
}

async function applyTpTargets(chatId: number, raw: string): Promise<void> {
  const parsed = parseTpTargetsInput(raw);
  if (!parsed.ok) {
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: `❌ Could not update TP targets: ${escapeHtml(parsed.error)}`,
      parse_mode: "HTML",
    });
    return;
  }

  const targets = parsed.value;
  setTpTargets(targets);

  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `✅ <b>TP targets updated</b>\n` +
      `<code>${escapeHtml(formatTpTargets(targets))}</code>`,
    parse_mode: "HTML",
  });
  logger.info({ targets }, "[settings] tp targets updated via telegram");
}

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
// Settings menus — structured hub, exit strategy submenu, and legacy flat view.
// ---------------------------------------------------------------------------
const SETTINGS_LABELS: Record<SettableKey, string> = {
  BUY_SIZE_SOL:             "💰 Buy size",
  MAX_CONCURRENT_POSITIONS: "📊 Max positions",
  ARM_PCT:                  "⚡ Arm at",
  TRAIL_PCT:                "📉 Trail",
  STOP_PCT:                 "🛑 Stop loss",
  MAX_HOLD_SECS:            "⏱ Max hold",
  LLM_EXIT_ENABLED:         "🧠 LLM advisor",
  LLM_POLL_MS:              "🧠 LLM poll interval",
  MILESTONES_ENABLED:       "🎯 Milestones",
  MILESTONE_PCTS:           "🎯 Milestone %s",
  MOONBAG_PCT:              "🌙 Moonbag keep %",
  MB_TRAIL_PCT:             "🌙 Moonbag trail",
  MB_TIMEOUT_SECS:          "🌙 Moonbag timeout",
};

async function sendSettingsMenu(chatId: number): Promise<void> {
  const summary = [
    ...strategySummaryLines(),
    `Risk: <code>${escapeHtml(formatRiskSummary())}</code>`,
  ];
  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `<b>⚙️ Settings</b>\n\n` +
      `${summary.join("\n")}\n\n` +
      `Choose a section to edit.`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🎯 Exit Strategy", callback_data: "settings:exit" }, { text: "🛡 Risk Controls", callback_data: "settings:risk" }],
        [{ text: "🧰 Live Settings", callback_data: "settings:live" }, { text: "🏠 Dashboard", callback_data: "menu:start" }],
      ],
    },
  });
}

async function sendExitStrategyMenu(chatId: number): Promise<void> {
  const settings = getRuntimeSettings();
  const llmHint = CONFIG.LLM_EXIT_ENABLED ? "LLM is currently on." : "LLM is currently off.";
  const ladderHint = settings.exit.profitStrategy.type === "tp_ladder"
    ? "Ladder is active."
    : settings.exit.profitStrategy.type === "fixed_tp"
      ? "Fixed TP is active."
      : "TP targets are ready when you choose a TP strategy.";
  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `<b>🎯 Exit Strategy</b>\n\n` +
      `${strategySummaryLines().join("\n")}\n` +
      `<i>${escapeHtml(llmHint)} ${escapeHtml(ladderHint)}</i>\n\n` +
      `Pick the strategy you want to run.`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: `${settings.exit.profitStrategy.type === "trail" ? "✅ " : ""}🌙 Trail`, callback_data: "settings:strategy:trail" },
          { text: `${settings.exit.profitStrategy.type === "fixed_tp" ? "✅ " : ""}🎯 Fixed TP`, callback_data: "settings:strategy:fixed_tp" },
        ],
        [
          { text: `${settings.exit.profitStrategy.type === "tp_ladder" ? "✅ " : ""}🪜 TP Ladder`, callback_data: "settings:strategy:tp_ladder" },
          { text: `${settings.exit.profitStrategy.type === "llm_managed" ? "✅ " : ""}🧠 LLM Managed`, callback_data: "settings:strategy:llm_managed" },
        ],
        [{ text: "✏️ Edit TP Targets", callback_data: "settings:tp:edit" }],
        [{ text: "↩️ Back", callback_data: "menu:settings" }],
      ],
    },
  });
}

async function sendRiskControlsMenu(chatId: number): Promise<void> {
  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `<b>🛡 Risk Controls</b>\n\n` +
      `<code>${escapeHtml(formatRiskSummary())}</code>\n\n` +
      `These map to the live trade guardrails.`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚡ Arm", callback_data: "edit:ARM_PCT" },
          { text: "📉 Trail", callback_data: "edit:TRAIL_PCT" },
        ],
        [
          { text: "🛑 Stop", callback_data: "edit:STOP_PCT" },
          { text: "⏱ Max Hold", callback_data: "edit:MAX_HOLD_SECS" },
        ],
        [
          { text: "🌙 Moonbag", callback_data: "edit:MOONBAG_PCT" },
          { text: "↩️ Back", callback_data: "menu:settings" },
        ],
      ],
    },
  });
}

async function sendAllSettingsMenu(chatId: number): Promise<void> {
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
    text:
      `<b>🧰 Live Settings</b>\n\n` +
      `${lines.join("\n")}\n\n` +
      `<i>Trading changes sync to state/settings.json and apply live - no restart needed.</i>`,
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
    text: `✅ <b>${SETTINGS_LABELS[key]}</b> → <b>${escapeHtml(SETTABLE_SPECS[key].display(v))}</b>\n<i>Saved to state/settings.json. Live now.</i>`,
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

  if (data.startsWith("stats_adopt:")) {
    const parts = data.split(":");
    const mcapMin = Number(parts[1] ?? 0);
    const mcapMax = Number(parts[2] ?? 0);
    updateRuntimeSettings((draft) => {
      draft.alertFilter.mcapMin = mcapMin;
      draft.alertFilter.mcapMax = mcapMax;
    });
    const msg = (mcapMin === 0 && mcapMax === 0)
      ? "Filter cleared — all mcap alerts allowed."
      : `Filter set: ${fmtMcap(mcapMin)} – ${mcapMax > 0 ? fmtMcap(mcapMax) : "∞"}`;
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: `✅ ${msg}`, show_alert: true });
    return;
  }

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

  if (data === "menu:start") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
    await sendStartMenu(chatId);
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

  if (data === "settings:exit") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
    await sendExitStrategyMenu(chatId);
    return;
  }

  if (data === "settings:risk") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
    await sendRiskControlsMenu(chatId);
    return;
  }

  if (data === "settings:live") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
    await sendAllSettingsMenu(chatId);
    return;
  }

  if (data === "settings:tp:edit") {
    await tgPost("answerCallbackQuery", { callback_query_id: cq.id });
    await promptForTpTargets(chatId);
    return;
  }

  if (data.startsWith("settings:strategy:")) {
    const mode = data.slice("settings:strategy:".length) as ExitStrategyMode;
    if (mode !== "trail" && mode !== "fixed_tp" && mode !== "tp_ladder" && mode !== "llm_managed") {
      await tgPost("answerCallbackQuery", { callback_query_id: cq.id, text: "Unknown strategy" });
      return;
    }
    setExitStrategy(mode);
    await tgPost("answerCallbackQuery", {
      callback_query_id: cq.id,
      text: `${EXIT_STRATEGY_LABELS[mode]} selected`,
    });
    await sendExitStrategyMenu(chatId);
    logger.info({ strategy: mode }, "[settings] exit strategy updated via telegram");
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
// /ping — end-to-end connectivity check. Runs three independent checks so a
// user stuck with "I'm not getting signals" can see exactly which stage is
// broken: (1) can the bot reach the upstream alerts API, (2) is the poller
// actually processing what it receives (newest upstream alert present in the
// dedup set), and (3) can the bot deliver a message back to Telegram (the
// reply itself proves this). Each check reports its own pass/fail + error.
// ---------------------------------------------------------------------------
function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "never";
  if (ms < 1_000) return `${ms}ms ago`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

function formatRecentPollerDecisions(): string[] {
  const events = getRecentAlertEvents();
  if (events.length === 0) {
    return ["• recent alert decisions: none yet (startup seeds existing alerts, then waits for new ones)"];
  }

  const recent = events.slice(-25);
  const fired = recent.filter((e) => e.action === "fired").length;
  const filtered = recent.filter((e) => e.action === "filtered").length;
  const dedup = recent.filter((e) => e.action === "dedup").length;
  const lines = [`• recent alert decisions: ${fired} fired · ${filtered} filtered · ${dedup} dedup`];

  const latest = recent[recent.length - 1];
  if (latest) {
    const action = latest.action === "fired" ? "fired" : latest.action === "filtered" ? "filtered" : "deduped";
    const reason = latest.reason ? ` — ${escapeHtml(latest.reason)}` : "";
    lines.push(`• latest decision: ${action} <code>${escapeHtml(latest.name)}</code> ${formatAgo(Date.now() - latest.at)}${reason}`);
  }

  const reasonCounts = new Map<string, number>();
  for (const event of recent) {
    if (event.action !== "filtered" || !event.reason) continue;
    reasonCounts.set(event.reason, (reasonCounts.get(event.reason) ?? 0) + 1);
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${count} ${escapeHtml(reason)}`);
  if (topReasons.length > 0) {
    lines.push(`• filter reasons: ${topReasons.join(" · ")}`);
  }

  return lines;
}

async function handlePing(chatId: number): Promise<void> {
  const lines: string[] = ["🩺 <b>Connectivity check</b>"];

  // Check 1 — upstream reachability. Fresh fetch, timed, with its own error
  // surface. This isolates network/DNS/TLS/auth from the running poller.
  const t0 = Date.now();
  let upstreamOk = false;
  let newestKey: string | null = null;
  let newestName: string | null = null;
  let newestAgeMins: number | null = null;
  let upstreamAlertCount = 0;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(SCG_URL, { signal: controller.signal });
    clearTimeout(timeout);
    const latency = Date.now() - t0;
    if (!res.ok) {
      lines.push(`1. Upstream API: ❌ HTTP ${res.status} ${escapeHtml(res.statusText)} (${latency}ms)`);
    } else {
      const body = (await res.json().catch(() => ({}))) as ScgAlertsResponse;
      const alerts = Array.isArray(body?.alerts) ? body.alerts : [];
      upstreamAlertCount = alerts.length;
      // Newest = largest alert_time. Don't assume API order.
      let newest: ScgAlertsResponse["alerts"][number] | null = null;
      for (const a of alerts) {
        if (!newest || a.alert_time > newest.alert_time) newest = a;
      }
      if (newest) {
        newestKey = alertKey(newest);
        newestName = newest.name;
        newestAgeMins = newest.age_mins;
      }
      upstreamOk = true;
      lines.push(`1. Upstream API: ✅ HTTP 200 · ${alerts.length} alerts · ${latency}ms`);
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    lines.push(`1. Upstream API: ❌ ${escapeHtml(msg)}`);
  }

  // Check 2 — poller is processing what it receives. Compare newest upstream
  // alert against the poller's in-memory dedup set. If upstream has alert X
  // and dedup doesn't contain X, the poller isn't processing even though the
  // network is fine. Also surface pause state + last successful tick age.
  const health = getPollerHealth();
  const now = Date.now();
  const lastOkAgo = health.lastTickOkAt ? now - health.lastTickOkAt : Infinity;
  const paused = isPaused();
  const pollerRecentlyOk = Number.isFinite(lastOkAgo) && lastOkAgo <= Math.max(CONFIG.SCG_POLL_MS * 2, 5_000);

  if (!upstreamOk) {
    lines.push("2. Poller processing: ⚠️ skipped (upstream unreachable)");
  } else if (upstreamAlertCount === 0) {
    lines.push("2. Poller processing: ⚠️ upstream returned 0 alerts — nothing to verify");
  } else if (newestKey && hasSeenAlert(newestKey)) {
    lines.push(
      `2. Poller processing: ✅ newest upstream alert is in dedup set` +
        (newestName ? ` (<code>${escapeHtml(newestName)}</code>, age ${newestAgeMins}m)` : ""),
    );
  } else if (pollerRecentlyOk && !health.lastTickError) {
    lines.push(
      `2. Poller processing: ⚠️ newest upstream alert is not seen yet — poller is alive and may be one tick behind` +
        (newestName ? ` (<code>${escapeHtml(newestName)}</code>)` : ""),
    );
  } else {
    lines.push(
      `2. Poller processing: ❌ newest upstream alert NOT in dedup set — poller is behind or stalled` +
        (newestName ? ` (<code>${escapeHtml(newestName)}</code>)` : ""),
    );
  }

  // Check 3 — Telegram delivery. The reply itself is the proof; say so.
  lines.push("3. Telegram delivery: ✅ (you're reading this message)");

  // Runtime state useful for diagnosing
  lines.push("");
  lines.push("<b>Poller state</b>");
  lines.push(`• last successful poll: ${formatAgo(lastOkAgo)}`);
  lines.push(`• last HTTP status: ${health.lastHttpStatus ?? "—"}`);
  if (health.lastTickError) {
    lines.push(`• last error: <code>${escapeHtml(health.lastTickError)}</code>`);
  }
  lines.push(`• dedup set size: ${health.seenSize}`);
  lines.push(`• paused: ${paused ? "🟡 yes — run /resume" : "no"}`);
  lines.push(`• blacklisted mints: ${getBlacklist().length}`);
  lines.push(...formatRecentPollerDecisions());
  lines.push(
    `• runtime: node ${process.version} · ${process.platform}/${process.arch} · poll every ${CONFIG.SCG_POLL_MS}ms`,
  );

  await tgPost("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
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

// ---------------------------------------------------------------------------
// /stats — signal metadata distribution + best mcap range
// ---------------------------------------------------------------------------
function fmtMcap(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function handleStats(chatId: number): Promise<void> {
  const stats = await getSignalStats();

  if (stats.totalTrades === 0) {
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: "📊 No trades with signal metadata yet.\n\nMetadata is captured on new buys from this version forward.",
    });
    return;
  }

  const filter = stats.activeFilter;
  const filterStr = (filter.mcapMin > 0 || filter.mcapMax > 0)
    ? `${filter.mcapMin > 0 ? fmtMcap(filter.mcapMin) : "$0"} – ${filter.mcapMax > 0 ? fmtMcap(filter.mcapMax) : "∞"}`
    : "none";

  const tierLines = stats.byMcapTier
    .filter((t) => t.count > 0)
    .map((t) => {
      const star = stats.bestMcapTier?.label === t.label ? " ★" : "";
      const pnl = t.avgPnlPct >= 0 ? `+${t.avgPnlPct.toFixed(1)}%` : `${t.avgPnlPct.toFixed(1)}%`;
      return `  ${escapeHtml(t.label)}: ${(t.winRate * 100).toFixed(0)}% win | avg ${pnl} | ${t.count}${star}`;
    }).join("\n");

  const corrTop = Object.entries(stats.correlations)
    .filter(([, v]) => Math.abs(v) > 0.05)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${v >= 0 ? "+" : ""}${v.toFixed(2)}`)
    .join(" | ");

  const lines: string[] = [
    `📊 <b>Signal Stats</b> — ${stats.totalTrades} trades with metadata`,
    "",
    `<b>MCap at Entry</b>`,
    `  Median: ${fmtMcap(stats.mcap.median)} | Mean: ${fmtMcap(stats.mcap.mean)}`,
    `  Range: ${fmtMcap(stats.mcap.min)} – ${fmtMcap(stats.mcap.max)}`,
    "",
    `<b>Win Rate by MCap Tier</b>`,
    tierLines,
    "",
    corrTop ? `<b>Correlations w/ PnL</b>\n  ${corrTop}` : "",
    "",
    `<b>Active filter:</b> ${filterStr}`,
  ].filter((l) => l !== undefined);

  const keyboard: unknown[] = [];
  if (stats.bestMcapTier) {
    const t = stats.bestMcapTier;
    const minVal = t.minMcap;
    const maxVal = t.maxMcap;
    keyboard.push({
      text: `Adopt ${t.label} range`,
      callback_data: `stats_adopt:${minVal}:${maxVal}`,
    });
  }
  if (filter.mcapMin > 0 || filter.mcapMax > 0) {
    keyboard.push({ text: "Clear filter", callback_data: "stats_adopt:0:0" });
  }

  await tgPost("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: keyboard.length > 0 ? { inline_keyboard: [keyboard] } : undefined,
  });
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
// /mcapfilter [min] [max | off] — manually set the MCap entry filter.
// ---------------------------------------------------------------------------
async function handleMcapFilter(chatId: number, argText: string): Promise<void> {
  const arg = argText.trim().toLowerCase();

  if (!arg) {
    const { alertFilter } = getRuntimeSettings();
    const active = alertFilter.mcapMin > 0 || alertFilter.mcapMax > 0;
    const status = active
      ? `${alertFilter.mcapMin > 0 ? fmtMcap(alertFilter.mcapMin) : "$0"} – ${alertFilter.mcapMax > 0 ? fmtMcap(alertFilter.mcapMax) : "∞"}`
      : "none";
    await tgPost("sendMessage", {
      chat_id: chatId,
      text: `<b>MCap Entry Filter</b>\nCurrent: <b>${status}</b>\n\nUsage:\n<code>/mcapfilter 50000 200000</code> — $50k–$200k\n<code>/mcapfilter 50000</code> — $50k floor, no ceiling\n<code>/mcapfilter 0 500000</code> — no floor, $500k ceiling\n<code>/mcapfilter off</code> — clear filter`,
      parse_mode: "HTML",
    });
    return;
  }

  if (arg === "off" || arg === "clear" || arg === "0") {
    updateRuntimeSettings((draft) => { draft.alertFilter.mcapMin = 0; draft.alertFilter.mcapMax = 0; });
    await tgPost("sendMessage", { chat_id: chatId, text: "✅ MCap filter cleared — all alerts allowed.", parse_mode: "HTML" });
    return;
  }

  const parts = arg.split(/\s+/);
  const minVal = Number(parts[0]);
  const maxVal = parts[1] !== undefined ? Number(parts[1]) : 0;

  if (!Number.isFinite(minVal) || minVal < 0) {
    await tgPost("sendMessage", { chat_id: chatId, text: "❌ Invalid min value. Use a number like <code>50000</code>.", parse_mode: "HTML" });
    return;
  }
  if (parts[1] !== undefined && (!Number.isFinite(maxVal) || maxVal < 0)) {
    await tgPost("sendMessage", { chat_id: chatId, text: "❌ Invalid max value. Use a number like <code>200000</code> or omit for no ceiling.", parse_mode: "HTML" });
    return;
  }
  if (maxVal > 0 && maxVal <= minVal) {
    await tgPost("sendMessage", { chat_id: chatId, text: "❌ Max must be greater than min.", parse_mode: "HTML" });
    return;
  }

  updateRuntimeSettings((draft) => { draft.alertFilter.mcapMin = minVal; draft.alertFilter.mcapMax = maxVal; });
  const rangeStr = `${minVal > 0 ? fmtMcap(minVal) : "$0"} – ${maxVal > 0 ? fmtMcap(maxVal) : "∞"}`;
  await tgPost("sendMessage", {
    chat_id: chatId,
    text: `✅ MCap filter set: <b>${rangeStr}</b>\nAlerts outside this range will be ignored.`,
    parse_mode: "HTML",
  });
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
// tap (writes live to state/settings.json via setConfigValue, no restart needed).
// ---------------------------------------------------------------------------
let backtestInFlight = false;

async function handleBacktest(chatId: number, argText: string = ""): Promise<void> {
  // `/backtest` compares all deterministic exit modes against SCG alerts.
  // `/backtest hybrid` preserves the moonbag-heavy trail grid.
  const mode: "all" | "hybrid" = argText.trim().toLowerCase() === "hybrid" ? "hybrid" : "all";

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
    ? "\n⚠️ <b>LLM exit advisor is ON.</b> LLM decisions are not candle-backtestable; this compares deterministic exits only."
    : "";
  const startMsg = await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `🧪 <b>Running ${mode === "hybrid" ? "hybrid" : "exit strategy"} backtest...</b>\n` +
      `<i>Fetching SCG alerts + OHLCV from signal time with at least ~24h runway when available.\n` +
      `This takes ~60 seconds.</i>` +
      llmWarning,
    parse_mode: "HTML",
  }) as { result?: { message_id?: number } };
  const statusId = startMsg?.result?.message_id;

  try {
    const { topResults, allResults, samplesUsed, tokensFetched, durationMs, source, resolutionCounts, entrySourceCounts } = await runBacktest({
      bar: "5m",
      topN: 5,
      minCandles: 60,
      hybrid: mode === "hybrid",
      allStrategies: mode === "all",
      source: "scg",
    });

    if (!topResults.length) {
      await tgPost("sendMessage", {
        chat_id: chatId,
        text: "❌ Backtest returned no results. Check onchainos CLI connectivity.",
      });
      return;
    }

    // Where does the CURRENT config rank? For all-mode, match the structured exit type too.
    const settings = getRuntimeSettings();
    const currentStrategy = settings.exit.profitStrategy;
    const curArm = CONFIG.ARM_PCT;
    const curTrail = CONFIG.TRAIL_PCT;
    const curStop = CONFIG.STOP_PCT;
    const curMb = CONFIG.MOONBAG_PCT;
    const curMbTrail = CONFIG.MB_TRAIL_PCT;
    const curMbTimeoutMin = CONFIG.MB_TIMEOUT_SECS / 60;
    const curIdx = allResults.findIndex(
      (r) => {
        if (mode === "all" && r.strategyMode !== currentStrategy.type) return false;
        if (currentStrategy.type === "fixed_tp") {
          return Math.abs(r.fixedTargetPct - currentStrategy.fixedTargetPct) < 0.001 &&
            Math.abs(r.stop - curStop) < 0.001;
        }
        return Math.abs(r.arm - curArm) < 0.001 &&
          Math.abs(r.trail - curTrail) < 0.001 &&
          Math.abs(r.stop - curStop) < 0.001 &&
          (mode !== "hybrid" ||
            (Math.abs(r.moonbagPct - curMb) < 0.001 &&
             Math.abs(r.mbTrail - curMbTrail) < 0.001 &&
             Math.abs(r.mbTimeout - curMbTimeoutMin) < 0.01));
      },
    );
    const curRow = curIdx >= 0 ? allResults[curIdx] : null;

    // Compact formatting for hybrid rows (extra params)
    const fmtCombo = (r: typeof allResults[number]): string => {
      if (r.strategyMode === "fixed_tp") {
        return `🎯 Fixed TP +${(r.fixedTargetPct*100).toFixed(0)}% / STOP ${(r.stop*100).toFixed(0)}%`;
      }
      if (r.strategyMode === "tp_ladder") {
        const targets = r.ladderTargets.map((target) => `${(target.pnlPct*100).toFixed(0)}:${(target.sellPct*100).toFixed(0)}`).join(",");
        return `🪜 TP Ladder ${r.ladderLabel || "custom"} (${targets}) / ARM ${(r.arm*100).toFixed(0)}% / TRAIL ${(r.trail*100).toFixed(0)}% / STOP ${(r.stop*100).toFixed(0)}%`;
      }
      const base = `ARM ${(r.arm*100).toFixed(0)}% / TRAIL ${(r.trail*100).toFixed(0)}% / STOP ${(r.stop*100).toFixed(0)}%`;
      if (mode !== "hybrid") return base;
      if (r.moonbagPct === 0) return `${base} · MB off`;
      return `${base} · MB ${(r.moonbagPct*100).toFixed(0)}% @trail ${(r.mbTrail*100).toFixed(0)}% (${r.mbTimeout}m)`;
    };
    const fmtComboBtn = (r: typeof allResults[number]): string => {
      if (r.strategyMode === "fixed_tp") return `Fixed TP ${(r.fixedTargetPct*100).toFixed(0)}%`;
      if (r.strategyMode === "tp_ladder") return `Ladder ${r.ladderLabel || "custom"}`;
      const base = `ARM ${(r.arm*100).toFixed(0)} TRAIL ${(r.trail*100).toFixed(0)} STOP ${(r.stop*100).toFixed(0)}`;
      if (mode !== "hybrid") return base;
      if (r.moonbagPct === 0) return `${base} MB off`;
      return `${base} MB ${(r.moonbagPct*100).toFixed(0)}%`;
    };
    const callbackFor = (r: typeof allResults[number]): string => {
      if (r.strategyMode === "fixed_tp") {
        return `adopt:fixed:${r.fixedTargetPct.toFixed(2)}:${r.stop.toFixed(2)}`;
      }
      if (r.strategyMode === "tp_ladder") {
        return `adopt:ladder:${r.ladderLabel || "balanced"}:${r.arm.toFixed(2)}:${r.trail.toFixed(2)}:${r.stop.toFixed(2)}`;
      }
      return r.moonbagPct > 0
        ? `adopt:hybrid:${r.arm.toFixed(2)}:${r.trail.toFixed(2)}:${r.stop.toFixed(2)}:${r.moonbagPct.toFixed(2)}:${r.mbTrail.toFixed(2)}:${r.mbTimeout}`
        : `adopt:simple:${r.arm.toFixed(2)}:${r.trail.toFixed(2)}:${r.stop.toFixed(2)}`;
    };

    // Build message
    const lines: string[] = [];
    lines.push(`🧪 <b>Backtest complete</b> (${mode})`);
    const resolutionText = Object.entries(resolutionCounts).map(([k, v]) => `${v} ${k}`).join(" · ") || "none";
    const entryText = Object.entries(entrySourceCounts)
      .map(([k, v]) => `${v} ${k === "alert_mcap" ? "alert mcap" : "first candle"}`)
      .join(" · ") || "none";
    lines.push(`<i>${samplesUsed}/${tokensFetched} SCG alerts · ${allResults.length} combos · ${Math.round(durationMs/1000)}s · OHLCV from signal time · ${resolutionText} · entries ${entryText}</i>`);
    lines.push("");
    lines.push("Source: SCG alert_time + alert_mcap entry when available, requiring usable post-signal OHLCV. 1m cannot cover 24h with the current 299-candle cap, so recommendations mostly use 5m/15m/1H.");
    lines.push("");
    if (CONFIG.LLM_EXIT_ENABLED) {
      lines.push("⚠️ <b>LLM is ON</b> — LLM Managed is not modeled here. Adopting a deterministic result switches the exit strategy.");
      lines.push("");
    }

    if (curRow) {
      const curWinPct = (curRow.wins / (curRow.wins + curRow.losses || 1)) * 100;
      const rank = curIdx + 1;
      lines.push(`<b>Your current:</b>  ${fmtCombo(curRow)}`);
      lines.push(`   +${curRow.totalPnlPct.toFixed(0)}%  ·  avg +${curRow.avgExitPct.toFixed(0)}%/trade  ·  ${curRow.wins}W/${curRow.losses}L/${curRow.holding}H  ·  ${curWinPct.toFixed(0)}% win  ·  <b>rank #${rank}/${allResults.length}</b>`);
    } else {
      lines.push(`<b>Your current</b> (${EXIT_STRATEGY_LABELS[currentStrategy.type]}) isn't in the test grid.`);
    }
    lines.push("");
    const best = topResults[0]!;
    lines.push(`<b>Recommended:</b> ${fmtCombo(best)}`);
    lines.push(`   +${best.totalPnlPct.toFixed(0)}% · avg +${best.avgExitPct.toFixed(0)}%/trade · ${best.wins}W/${best.losses}L/${best.holding}H`);
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

    const buttons = topResults.map((r, i): [{ text: string; callback_data: string }] => {
      return [{ text: `Adopt #${i+1}: ${fmtComboBtn(r)}`, callback_data: callbackFor(r) }];
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
//   adopt:fixed:target:stop
//   adopt:ladder:preset:arm:trail:stop
async function handleAdopt(chatId: number, data: string): Promise<void> {
  const parts = data.split(":");
  if (parts[1] === "cancel") {
    await tgPost("sendMessage", { chat_id: chatId, text: "❌ Cancelled. Config unchanged." });
    return;
  }
  if (parts[1] === "fixed") {
    const target = parts[2];
    const stop = parts[3];
    if (!target || !stop) {
      await tgPost("sendMessage", { chat_id: chatId, text: "⚠️ Malformed fixed adopt data." });
      return;
    }
    const current = getRuntimeSettings();
    await tgPost("sendMessage", {
      chat_id: chatId,
      text:
        `⚠️ <b>Confirm adopt? (fixed TP)</b>\n\n` +
        `<pre>${escapeHtml(`Strategy  ${EXIT_STRATEGY_LABELS[current.exit.profitStrategy.type]} -> Fixed TP\nTP        +${(parseFloat(target)*100).toFixed(0)}%\nSTOP      ${(CONFIG.STOP_PCT*100).toFixed(0)}% -> ${(parseFloat(stop)*100).toFixed(0)}%`)}</pre>\n` +
        `Applies live, writes to state/settings.json. No restart needed.`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Yes, adopt", callback_data: `confirm-adopt:fixed:${target}:${stop}` }],
          [{ text: "❌ Cancel", callback_data: "adopt:cancel" }],
        ],
      },
    });
    return;
  }
  if (parts[1] === "ladder") {
    const preset = parts[2];
    const arm = parts[3];
    const trail = parts[4];
    const stop = parts[5];
    const targets = preset ? BACKTEST_LADDER_PRESETS[preset] : undefined;
    if (!preset || !targets || !arm || !trail || !stop) {
      await tgPost("sendMessage", { chat_id: chatId, text: "⚠️ Malformed ladder adopt data." });
      return;
    }
    const targetText = targets.map((target) => `${(target.pnlPct*100).toFixed(0)}:${(target.sellPct*100).toFixed(0)}`).join(",");
    await tgPost("sendMessage", {
      chat_id: chatId,
      text:
        `⚠️ <b>Confirm adopt? (TP ladder)</b>\n\n` +
        `<pre>${escapeHtml(`Strategy  -> TP Ladder\nTargets   ${targetText}\nARM       ${(CONFIG.ARM_PCT*100).toFixed(0)}% -> ${(parseFloat(arm)*100).toFixed(0)}%\nTRAIL     ${(CONFIG.TRAIL_PCT*100).toFixed(0)}% -> ${(parseFloat(trail)*100).toFixed(0)}%\nSTOP      ${(CONFIG.STOP_PCT*100).toFixed(0)}% -> ${(parseFloat(stop)*100).toFixed(0)}%`)}</pre>\n` +
        `Applies live, writes to state/settings.json. No restart needed.`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Yes, adopt", callback_data: `confirm-adopt:ladder:${preset}:${arm}:${trail}:${stop}` }],
          [{ text: "❌ Cancel", callback_data: "adopt:cancel" }],
        ],
      },
    });
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
      `Applies live, writes to state/settings.json. No restart needed.` +
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
  //      | "confirm-adopt:fixed:target:stop"
  //      | "confirm-adopt:ladder:preset:arm:trail:stop"
  const parts = data.split(":");
  if (parts[1] === "fixed") {
    const target = parts[2];
    const stop = parts[3];
    if (!target || !stop) {
      await tgPost("sendMessage", { chat_id: chatId, text: "⚠️ Malformed fixed confirm-adopt data." });
      return;
    }
    const stopResult = setConfigValue("STOP_PCT", stop);
    if (!stopResult.ok) {
      await tgPost("sendMessage", { chat_id: chatId, text: `⚠️ Adopt failed: ${stopResult.error}` });
      return;
    }
    setTpTargets([{ pnlPct: parseFloat(target), sellPct: 1 }]);
    const pct = (parseFloat(target) * 100).toFixed(0);
    logger.info({ target, stop }, "[telegram] fixed TP backtest config adopted");
    await tgPost("sendMessage", {
      chat_id: chatId,
      text:
        `✅ <b>Adopted Fixed TP</b>\n` +
        `TP: +${pct}%\n` +
        `STOP: ${(parseFloat(stop)*100).toFixed(0)}%\n\n` +
        `<i>Saved to state/settings.json and active on next tick. No restart needed.</i>`,
      parse_mode: "HTML",
    });
    return;
  }
  if (parts[1] === "ladder") {
    const preset = parts[2];
    const arm = parts[3];
    const trail = parts[4];
    const stop = parts[5];
    const targets = preset ? BACKTEST_LADDER_PRESETS[preset] : undefined;
    if (!preset || !targets || !arm || !trail || !stop) {
      await tgPost("sendMessage", { chat_id: chatId, text: "⚠️ Malformed ladder confirm-adopt data." });
      return;
    }
    type SetEntry = { key: SettableKey; value: string; result: ReturnType<typeof setConfigValue> };
    const results: SetEntry[] = [
      { key: "ARM_PCT", value: arm, result: setConfigValue("ARM_PCT", arm) },
      { key: "TRAIL_PCT", value: trail, result: setConfigValue("TRAIL_PCT", trail) },
      { key: "STOP_PCT", value: stop, result: setConfigValue("STOP_PCT", stop) },
    ];
    const failures = results.filter(r => !r.result.ok);
    if (failures.length > 0) {
      await tgPost("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Adopt partially failed:\n${failures.map(f => `${f.key}=${f.value} → ${(f.result as { ok: false; error: string }).error}`).join("\n")}`,
      });
      return;
    }
    setTpTargets(targets);
    const targetText = targets.map((target) => `${(target.pnlPct*100).toFixed(0)}:${(target.sellPct*100).toFixed(0)}`).join(",");
    logger.info({ preset, arm, trail, stop }, "[telegram] TP ladder backtest config adopted");
    await tgPost("sendMessage", {
      chat_id: chatId,
      text:
        `✅ <b>Adopted TP Ladder (${escapeHtml(preset)})</b>\n` +
        `Targets: <code>${escapeHtml(targetText)}</code>\n` +
        `ARM: ${(parseFloat(arm)*100).toFixed(0)}%\n` +
        `TRAIL: ${(parseFloat(trail)*100).toFixed(0)}%\n` +
        `STOP: ${(parseFloat(stop)*100).toFixed(0)}%\n\n` +
        `<i>Saved to state/settings.json and active on next tick. No restart needed.</i>`,
      parse_mode: "HTML",
    });
    return;
  }
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
  setExitStrategy("trail");

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
    ? "\n\n⚠️ <b>Reminder:</b> LLM is ON — MOONBAG params are saved but won't fire until you switch out of LLM Managed."
    : "";
  await tgPost("sendMessage", {
    chat_id: chatId,
    text:
      `✅ <b>Adopted new config (${mode})</b>\n` +
      summary.join("\n") + "\n\n" +
      `<i>Saved to state/settings.json and active on next tick. No restart needed.</i>` +
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
      { command: "stats",     description: "Signal stats by mcap tier + adopt best range filter" },
      { command: "mcapfilter", description: "Set MCap entry filter (e.g. /mcapfilter 50000 200000 or off)" },
      { command: "history",   description: "Last N closed trades (default 10)" },
      { command: "settings",  description: "Edit trading params live (no restart)" },
      { command: "llm",       description: "Toggle the LLM exit advisor on/off" },
      { command: "pause",     description: "Stop taking new SCG alerts" },
      { command: "resume",    description: "Resume taking new SCG alerts" },
      { command: "ping",      description: "Check upstream alerts API + poller + Telegram" },
      { command: "sellall",   description: "Emergency close-all (requires CONFIRM)" },
      { command: "skip",      description: "Blacklist a mint (or list/clear)" },
      { command: "mint",      description: "On-demand on-chain snapshot of any token" },
      { command: "wallet",    description: "Show wallet address + SOL balance" },
      { command: "backtest",        description: "Run simple backtest (ARM × TRAIL × STOP) + adopt live" },
      { command: "backtest_hybrid", description: "Run hybrid backtest (adds moonbag grid — only fires when LLM mode is OFF)" },
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
          if (replyToId !== undefined && pendingExitEdits.has(replyToId)) {
            const prompt = pendingExitEdits.get(replyToId)!;
            pendingExitEdits.delete(replyToId);
            if (prompt.kind === "tp_targets") {
              await applyTpTargets(chatId, text);
            }
            continue;
          }
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
              case "/stats":        await handleStats(chatId); break;
              case "/mcapfilter":  await handleMcapFilter(chatId, argText); break;
              case "/history":   await handleHistory(chatId, argText); break;
              case "/llm":       await handleLlm(chatId); break;
              case "/pause":     await handlePause(chatId); break;
              case "/resume":    await handleResume(chatId); break;
              case "/ping":      await handlePing(chatId); break;
              case "/sellall":   await handleSellAll(chatId); break;
              case "/skip":      await handleSkip(chatId, argText); break;
              case "/mint":      await handleMint(chatId, argText); break;
              case "/wallet":    await handleWallet(chatId); break;
              case "/backtest":        await handleBacktest(chatId, argText); break;
              case "/backtest_hybrid": await handleBacktest(chatId, "hybrid"); break;
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
