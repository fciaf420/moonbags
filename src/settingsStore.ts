import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import logger from "./logger.js";

const STATE_DIR = path.resolve("state");
const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");

export type ExitStrategyMode = "trail" | "fixed_tp" | "tp_ladder" | "llm_managed";

export type TpTarget = {
  pnlPct: number;  // decimal, e.g. 0.5 = +50%
  sellPct: number; // decimal, e.g. 0.25 = sell 25%
};

export type RuntimeSettings = {
  version: 1;
  buy: {
    sizeSol: number;
    maxConcurrentPositions: number;
  };
  exit: {
    profitStrategy: {
      type: ExitStrategyMode;
      fixedTargetPct: number;
      ladderTargets: TpTarget[];
      trailRemainder: boolean;
    };
    trail: {
      armPct: number;
      trailPct: number;
    };
    risk: {
      stopPct: number;
      maxHoldSecs: number;
    };
    runner: {
      keepPct: number;
      trailPct: number;
      timeoutSecs: number;
    };
    llm: {
      enabled: boolean;
    };
  };
  milestones: {
    enabled: boolean;
    pcts: number[];
  };
};

export const EXIT_STRATEGY_LABELS: Record<ExitStrategyMode, string> = {
  trail: "Trail",
  fixed_tp: "Fixed TP",
  tp_ladder: "TP Ladder",
  llm_managed: "LLM Managed",
};

const DEFAULT_TP_TARGETS: TpTarget[] = [
  { pnlPct: 0.5, sellPct: 0.25 },
  { pnlPct: 1.0, sellPct: 0.25 },
  { pnlPct: 2.0, sellPct: 0.25 },
];

function defaultSettings(): RuntimeSettings {
  return {
    version: 1,
    buy: {
      sizeSol: CONFIG.BUY_SIZE_SOL,
      maxConcurrentPositions: CONFIG.MAX_CONCURRENT_POSITIONS,
    },
    exit: {
      profitStrategy: {
        type: CONFIG.LLM_EXIT_ENABLED ? "llm_managed" : "trail",
        fixedTargetPct: CONFIG.MILESTONE_PCTS[0] ? CONFIG.MILESTONE_PCTS[0] / 100 : 1,
        ladderTargets: CONFIG.MILESTONE_PCTS.length > 0
          ? CONFIG.MILESTONE_PCTS.map((pct) => ({ pnlPct: pct / 100, sellPct: 0.25 }))
          : DEFAULT_TP_TARGETS,
        trailRemainder: true,
      },
      trail: {
        armPct: CONFIG.ARM_PCT,
        trailPct: CONFIG.TRAIL_PCT,
      },
      risk: {
        stopPct: CONFIG.STOP_PCT,
        maxHoldSecs: CONFIG.MAX_HOLD_SECS,
      },
      runner: {
        keepPct: CONFIG.MOONBAG_PCT,
        trailPct: CONFIG.MB_TRAIL_PCT,
        timeoutSecs: CONFIG.MB_TIMEOUT_SECS,
      },
      llm: {
        enabled: CONFIG.LLM_EXIT_ENABLED,
      },
    },
    milestones: {
      enabled: CONFIG.MILESTONES_ENABLED,
      pcts: CONFIG.MILESTONE_PCTS,
    },
  };
}

function num(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeTargets(value: unknown, fallback: TpTarget[]): TpTarget[] {
  if (!Array.isArray(value)) return fallback;
  const targets = value
    .map((raw) => {
      const rec = raw as Record<string, unknown>;
      return {
        pnlPct: num(rec.pnlPct, NaN, 0.01, 100),
        sellPct: num(rec.sellPct, NaN, 0.01, 1),
      };
    })
    .filter((t) => Number.isFinite(t.pnlPct) && Number.isFinite(t.sellPct))
    .sort((a, b) => a.pnlPct - b.pnlPct);
  return targets.length > 0 ? targets : fallback;
}

function normalizeSettings(raw: unknown): RuntimeSettings {
  const defaults = defaultSettings();
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const buy = (root.buy && typeof root.buy === "object" ? root.buy : {}) as Record<string, unknown>;
  const exit = (root.exit && typeof root.exit === "object" ? root.exit : {}) as Record<string, unknown>;
  const profit = (exit.profitStrategy && typeof exit.profitStrategy === "object" ? exit.profitStrategy : {}) as Record<string, unknown>;
  const trail = (exit.trail && typeof exit.trail === "object" ? exit.trail : {}) as Record<string, unknown>;
  const risk = (exit.risk && typeof exit.risk === "object" ? exit.risk : {}) as Record<string, unknown>;
  const runner = (exit.runner && typeof exit.runner === "object" ? exit.runner : {}) as Record<string, unknown>;
  const llm = (exit.llm && typeof exit.llm === "object" ? exit.llm : {}) as Record<string, unknown>;
  const milestones = (root.milestones && typeof root.milestones === "object" ? root.milestones : {}) as Record<string, unknown>;

  const rawType = profit.type;
  const type: ExitStrategyMode =
    rawType === "fixed_tp" || rawType === "tp_ladder" || rawType === "llm_managed" || rawType === "trail"
      ? rawType
      : defaults.exit.profitStrategy.type;

  const pcts = Array.isArray(milestones.pcts)
    ? milestones.pcts.map((p) => num(p, NaN, 0.01, 100000)).filter(Number.isFinite)
    : defaults.milestones.pcts;

  return {
    version: 1,
    buy: {
      sizeSol: num(buy.sizeSol, defaults.buy.sizeSol, 0.001, 1),
      maxConcurrentPositions: Math.round(num(buy.maxConcurrentPositions, defaults.buy.maxConcurrentPositions, 1, 50)),
    },
    exit: {
      profitStrategy: {
        type,
        fixedTargetPct: num(profit.fixedTargetPct, defaults.exit.profitStrategy.fixedTargetPct, 0.01, 100),
        ladderTargets: normalizeTargets(profit.ladderTargets, defaults.exit.profitStrategy.ladderTargets),
        trailRemainder: bool(profit.trailRemainder, defaults.exit.profitStrategy.trailRemainder),
      },
      trail: {
        armPct: num(trail.armPct, defaults.exit.trail.armPct, 0.01, 100),
        trailPct: num(trail.trailPct, defaults.exit.trail.trailPct, 0.01, 1),
      },
      risk: {
        stopPct: num(risk.stopPct, defaults.exit.risk.stopPct, 0.01, 100),
        maxHoldSecs: num(risk.maxHoldSecs, defaults.exit.risk.maxHoldSecs, 0),
      },
      runner: {
        keepPct: num(runner.keepPct, defaults.exit.runner.keepPct, 0, 0.9),
        trailPct: num(runner.trailPct, defaults.exit.runner.trailPct, 0.01, 1),
        timeoutSecs: num(runner.timeoutSecs, defaults.exit.runner.timeoutSecs, 0),
      },
      llm: {
        enabled: bool(llm.enabled, defaults.exit.llm.enabled),
      },
    },
    milestones: {
      enabled: bool(milestones.enabled, defaults.milestones.enabled),
      pcts,
    },
  };
}

function writeSettings(next: RuntimeSettings): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
}

function syncConfig(next: RuntimeSettings): void {
  (CONFIG as unknown as Record<string, unknown>).BUY_SIZE_SOL = next.buy.sizeSol;
  (CONFIG as unknown as Record<string, unknown>).MAX_CONCURRENT_POSITIONS = next.buy.maxConcurrentPositions;
  (CONFIG as unknown as Record<string, unknown>).ARM_PCT = next.exit.trail.armPct;
  (CONFIG as unknown as Record<string, unknown>).TRAIL_PCT = next.exit.trail.trailPct;
  (CONFIG as unknown as Record<string, unknown>).STOP_PCT = next.exit.risk.stopPct;
  (CONFIG as unknown as Record<string, unknown>).MAX_HOLD_SECS = next.exit.risk.maxHoldSecs;
  (CONFIG as unknown as Record<string, unknown>).MOONBAG_PCT = next.exit.runner.keepPct;
  (CONFIG as unknown as Record<string, unknown>).MB_TRAIL_PCT = next.exit.runner.trailPct;
  (CONFIG as unknown as Record<string, unknown>).MB_TIMEOUT_SECS = next.exit.runner.timeoutSecs;
  (CONFIG as unknown as Record<string, unknown>).LLM_EXIT_ENABLED =
    next.exit.llm.enabled || next.exit.profitStrategy.type === "llm_managed";
  (CONFIG as unknown as Record<string, unknown>).MILESTONES_ENABLED = next.milestones.enabled;
  (CONFIG as unknown as Record<string, unknown>).MILESTONE_PCTS = next.milestones.pcts;
}

function loadSettings(): RuntimeSettings {
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as unknown;
    return normalizeSettings(parsed);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const generated = defaultSettings();
    if (e.code !== "ENOENT") {
      logger.warn({ err: String(err) }, "[settings] invalid settings file, regenerating defaults");
    }
    writeSettings(generated);
    return generated;
  }
}

let currentSettings = loadSettings();
syncConfig(currentSettings);

export function getRuntimeSettings(): RuntimeSettings {
  return currentSettings;
}

export function saveRuntimeSettings(next: RuntimeSettings): RuntimeSettings {
  currentSettings = normalizeSettings(next);
  writeSettings(currentSettings);
  syncConfig(currentSettings);
  return currentSettings;
}

export function updateRuntimeSettings(mutator: (draft: RuntimeSettings) => void): RuntimeSettings {
  const draft = structuredClone(currentSettings);
  mutator(draft);
  return saveRuntimeSettings(draft);
}

export function syncRuntimeSettingsFromConfig(): RuntimeSettings {
  return updateRuntimeSettings((draft) => {
    draft.buy.sizeSol = CONFIG.BUY_SIZE_SOL;
    draft.buy.maxConcurrentPositions = CONFIG.MAX_CONCURRENT_POSITIONS;
    draft.exit.trail.armPct = CONFIG.ARM_PCT;
    draft.exit.trail.trailPct = CONFIG.TRAIL_PCT;
    draft.exit.risk.stopPct = CONFIG.STOP_PCT;
    draft.exit.risk.maxHoldSecs = CONFIG.MAX_HOLD_SECS;
    draft.exit.runner.keepPct = CONFIG.MOONBAG_PCT;
    draft.exit.runner.trailPct = CONFIG.MB_TRAIL_PCT;
    draft.exit.runner.timeoutSecs = CONFIG.MB_TIMEOUT_SECS;
    draft.exit.llm.enabled = CONFIG.LLM_EXIT_ENABLED;
    draft.milestones.enabled = CONFIG.MILESTONES_ENABLED;
    draft.milestones.pcts = CONFIG.MILESTONE_PCTS;
    if (CONFIG.LLM_EXIT_ENABLED) {
      draft.exit.profitStrategy.type = "llm_managed";
    } else if (draft.exit.profitStrategy.type === "llm_managed") {
      draft.exit.profitStrategy.type = "trail";
    }
  });
}

export function setExitStrategy(mode: ExitStrategyMode): RuntimeSettings {
  return updateRuntimeSettings((draft) => {
    draft.exit.profitStrategy.type = mode;
    // Only force llm.enabled on when switching TO llm_managed — never force it off.
    // TP Ladder, Trail, and Fixed TP can all coexist with LLM as an independent layer.
    if (mode === "llm_managed") draft.exit.llm.enabled = true;
    if (mode === "fixed_tp") {
      draft.milestones.enabled = true;
      draft.milestones.pcts = [Math.round(draft.exit.profitStrategy.fixedTargetPct * 100)];
    } else if (mode === "tp_ladder") {
      draft.milestones.enabled = true;
      draft.milestones.pcts = draft.exit.profitStrategy.ladderTargets.map((target) => Math.round(target.pnlPct * 100));
    }
  });
}

export function setTpTargets(targets: TpTarget[]): RuntimeSettings {
  const sorted = normalizeTargets(targets, DEFAULT_TP_TARGETS);
  return updateRuntimeSettings((draft) => {
    draft.exit.profitStrategy.ladderTargets = sorted;
    draft.exit.profitStrategy.fixedTargetPct = sorted[0]?.pnlPct ?? draft.exit.profitStrategy.fixedTargetPct;
    draft.exit.profitStrategy.type = sorted.length > 1 ? "tp_ladder" : "fixed_tp";
    draft.milestones.enabled = true;
    draft.milestones.pcts = sorted.map((target) => Math.round(target.pnlPct * 100));
  });
}

export function parseTpTargetsInput(raw: string): { ok: true; value: TpTarget[] } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: "enter at least one target like 50:25,100:25" };

  const targets: TpTarget[] = [];
  for (const chunk of text.split(",")) {
    const part = chunk.trim();
    if (!part) continue;
    const [profitRaw, sellRaw, extra] = part.split(":").map((s) => s.trim());
    if (!profitRaw || !sellRaw || extra) {
      return { ok: false, error: `bad target "${part}" - use profit:sell` };
    }
    const profitPct = Number(profitRaw.replace(/%$/u, ""));
    const sellPct = Number(sellRaw.replace(/%$/u, ""));
    if (!Number.isFinite(profitPct) || !Number.isFinite(sellPct) || profitPct <= 0 || sellPct <= 0) {
      return { ok: false, error: `bad target "${part}" - both values must be positive numbers` };
    }
    if (sellPct > 100) {
      return { ok: false, error: `bad target "${part}" - sell % must be <= 100` };
    }
    targets.push({ pnlPct: profitPct / 100, sellPct: sellPct / 100 });
  }

  if (targets.length === 0) return { ok: false, error: "enter at least one target like 50:25,100:25" };
  targets.sort((a, b) => a.pnlPct - b.pnlPct);
  return { ok: true, value: targets };
}

function trimPercent(value: number): string {
  const pct = value * 100;
  return Number.isInteger(pct) ? String(pct) : String(Number(pct.toFixed(2)));
}

export function formatTpTargets(targets: TpTarget[]): string {
  return targets.map((target) => `${trimPercent(target.pnlPct)}:${trimPercent(target.sellPct)}`).join(",");
}

