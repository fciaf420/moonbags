import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import logger from "./logger.js";

const STATE_DIR = path.resolve("state");
const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");

export type ExitStrategyMode = "trail" | "fixed_tp" | "tp_ladder" | "llm_managed";
export type SourceMode = "scg_only" | "okx_watch" | "hybrid" | "okx_only" | "gmgn_watch" | "gmgn_live" | "gmgn_only";

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
  alertFilter: {
    mcapMin: number;
    mcapMax: number;
  };
  signals: {
    sourceMode: SourceMode;
    okx: {
      enabled: boolean;
      seedLimit: number;
      mintCooldownMins: number;
      entryFilter: {
        minHolders: number;
        walletTypes: number[];
        minAmountUsd: number;
      };
      // [OKX-DISCOVERY 2026-04-22] SCG-alpha-style discovery source config —
      // consumed by src/okxDiscoverySource.ts. Mirrors signals.gmgn shape so
      // the /sources UI can render both sources uniformly.
      discovery: {
        enabled: boolean;
        pollMs: number;
        mintCooldownMins: number;
        watchlistTtlMins: number;
        maxWatchMints: number;
        seedLimit: number;
        timeFrame: string;
        rankBy: string;
        includeBundleInfo: boolean;
        baseline: {
          minHolders: number;
          minLiquidityUsd: number;
          minMcapUsd: number;
          maxMcapUsd: number;
          maxTop10HolderRate: number;
          maxRugRatio: number;
          maxBundlerRate: number;
          maxBotRate: number;
          maxCreatorBalanceRate: number;
          requireNotWashTrading: boolean;
        };
        trigger: {
          minScans: number;
          minHolderGrowthPct: number;
          maxLiquidityDropPct: number;
          minBuySellRatio: number;
        };
      };
    };
    gmgn: {
      enabled: boolean;
      pollMs: number;
      mintCooldownMins: number;
      watchlistTtlMins: number;
      maxWatchMints: number;
      baseline: {
        minHolders: number;
        minLiquidityUsd: number;
        minMcapUsd: number;
        maxMcapUsd: number;
        maxTop10HolderRate: number;
        maxRugRatio: number;
        maxBundlerRate: number;
        maxBotRate: number;
        maxCreatorBalanceRate: number;
        requireNotWashTrading: boolean;
      };
      trigger: {
        minScans: number;
        minHolderGrowthPct: number;
        maxLiquidityDropPct: number;
        minBuySellRatio: number;
        minSmartOrKolCount: number;
      };
    };
  };
  marketData: {
    wss: {
      enabled: boolean;
      pollMs: number;
      triggerTickMs: number;
      channels: string[];
    };
  };
  // [JUP-GATE 2026-04-22] Global Jup datapi audit gate applied during
  // deep-dive by both GMGN and OKX discovery sources. See src/jupGate.ts.
  jupGate: {
    enabled: boolean;
    minFees: number;
    allowedScoreLabels: string[];
    minOrganicVolumePct: number;
    minOrganicBuyersPct: number;
  };
};

export const EXIT_STRATEGY_LABELS: Record<ExitStrategyMode, string> = {
  trail: "Trail",
  fixed_tp: "Fixed TP",
  tp_ladder: "TP Ladder",
  llm_managed: "LLM Managed",
};

export const SOURCE_MODE_LABELS: Record<SourceMode, string> = {
  scg_only: "SCG only",
  okx_watch: "OKX Watch",
  hybrid: "Hybrid (OKX + GMGN live)",
  okx_only: "OKX only",
  gmgn_watch: "GMGN Watch",
  gmgn_live: "GMGN Live",
  gmgn_only: "GMGN only",
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
    alertFilter: {
      mcapMin: CONFIG.MIN_ALERT_MCAP,
      mcapMax: CONFIG.MAX_ALERT_MCAP,
    },
    signals: {
      // [SCG-DISABLED 2026-04-22] Default flipped from "scg_only" to "gmgn_watch"
      // since SCG polling is off. Pick "okx_watch" or "gmgn_watch" — both are conservative
      // (watch-only, no auto-buy until you flip enabled). Change back to "scg_only"
      // when re-enabling SCG.
      sourceMode: "gmgn_watch",
      okx: {
        enabled: false,
        seedLimit: 100,
        mintCooldownMins: 60,
        entryFilter: {
          // 2026-04-22 — lowered from 500 → 100. Filter analysis on 156 OKX
          // signals showed minHolders=500 cut winrate from 35% → 28%; data
          // says 100-250 is the right floor for this source.
          minHolders: 100,
          walletTypes: [1, 2],
          // 2026-04-22 — new field. Combined with mcapMin=25k this lifts
          // winrate to 45% with medFinal -5% on the OKX signal stream.
          minAmountUsd: 500,
        },
        discovery: {
          enabled: true,
          pollMs: 30_000,
          mintCooldownMins: 60,
          watchlistTtlMins: 180,
          maxWatchMints: 120,
          seedLimit: 100,
          timeFrame: "1",
          rankBy: "5",
          includeBundleInfo: false,
          baseline: {
            minHolders: 200,
            minLiquidityUsd: 10_000,
            minMcapUsd: 0,
            maxMcapUsd: 0,
            maxTop10HolderRate: 0.5,
            maxRugRatio: 0.3,
            maxBundlerRate: 0.5,
            maxBotRate: 0.5,
            maxCreatorBalanceRate: 0.2,
            requireNotWashTrading: true,
          },
          trigger: {
            minScans: 2,
            minHolderGrowthPct: 5,
            maxLiquidityDropPct: 30,
            minBuySellRatio: 1.15,
          },
        },
      },
      gmgn: {
        enabled: false,
        pollMs: 60_000,
        mintCooldownMins: 60,
        watchlistTtlMins: 180,
        maxWatchMints: 120,
        baseline: {
          minHolders: 200,
          minLiquidityUsd: 10_000,
          minMcapUsd: 0,
          maxMcapUsd: 0,
          maxTop10HolderRate: 0.5,
          maxRugRatio: 0.3,
          maxBundlerRate: 0.5,
          maxBotRate: 0.5,
          maxCreatorBalanceRate: 0.2,
          requireNotWashTrading: true,
        },
        trigger: {
          minScans: 2,
          minHolderGrowthPct: 5,
          maxLiquidityDropPct: 30,
          minBuySellRatio: 1.15,
          minSmartOrKolCount: 1,
        },
      },
    },
    marketData: {
      wss: {
        enabled: CONFIG.OKX_WSS_ENABLED,
        pollMs: 1000,
        triggerTickMs: 1000,
        channels: ["price-info", "trades", "dex-token-candle1m"],
      },
    },
    jupGate: {
      enabled: true,
      minFees: 1,
      allowedScoreLabels: ["medium", "high"],
      minOrganicVolumePct: 0,
      minOrganicBuyersPct: 0,
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

function normalizeStringList(value: unknown, fallback: string[], allowEmpty = false): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  if (items.length > 0) return Array.from(new Set(items));
  // An explicitly empty array is meaningful for some fields (e.g.
  // jupGate.allowedScoreLabels: [] means "any label"). Only fall back
  // to defaults when the caller opts in.
  return allowEmpty ? [] : fallback;
}

function normalizeNumberList(value: unknown, fallback: number[], min = -Infinity, max = Infinity): number[] {
  if (!Array.isArray(value)) return fallback;
  const items = value
    .map((item) => Math.round(num(item, NaN, min, max)))
    .filter(Number.isFinite);
  return items.length > 0 ? Array.from(new Set(items)) : fallback;
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

  const alertFilter = (root.alertFilter && typeof root.alertFilter === "object" ? root.alertFilter : {}) as Record<string, unknown>;
  const signals = (root.signals && typeof root.signals === "object" ? root.signals : {}) as Record<string, unknown>;
  const okxSignals = (signals.okx && typeof signals.okx === "object" ? signals.okx : {}) as Record<string, unknown>;
  const okxEntryFilter = (
    okxSignals.entryFilter && typeof okxSignals.entryFilter === "object" ? okxSignals.entryFilter : {}
  ) as Record<string, unknown>;
  const okxDiscovery = (
    okxSignals.discovery && typeof okxSignals.discovery === "object" ? okxSignals.discovery : {}
  ) as Record<string, unknown>;
  const okxDiscoveryBaseline = (
    okxDiscovery.baseline && typeof okxDiscovery.baseline === "object" ? okxDiscovery.baseline : {}
  ) as Record<string, unknown>;
  const okxDiscoveryTrigger = (
    okxDiscovery.trigger && typeof okxDiscovery.trigger === "object" ? okxDiscovery.trigger : {}
  ) as Record<string, unknown>;
  const gmgnSignals = (signals.gmgn && typeof signals.gmgn === "object" ? signals.gmgn : {}) as Record<string, unknown>;
  const gmgnBaseline = (
    gmgnSignals.baseline && typeof gmgnSignals.baseline === "object" ? gmgnSignals.baseline : {}
  ) as Record<string, unknown>;
  const gmgnTrigger = (
    gmgnSignals.trigger && typeof gmgnSignals.trigger === "object" ? gmgnSignals.trigger : {}
  ) as Record<string, unknown>;
  const marketData = (root.marketData && typeof root.marketData === "object" ? root.marketData : {}) as Record<string, unknown>;
  const wss = (marketData.wss && typeof marketData.wss === "object" ? marketData.wss : {}) as Record<string, unknown>;
  const jupGate = (root.jupGate && typeof root.jupGate === "object" ? root.jupGate : {}) as Record<string, unknown>;

  const rawType = profit.type;
  const type: ExitStrategyMode =
    rawType === "fixed_tp" || rawType === "tp_ladder" || rawType === "llm_managed" || rawType === "trail"
      ? rawType
      : defaults.exit.profitStrategy.type;

  const pcts = Array.isArray(milestones.pcts)
    ? milestones.pcts.map((p) => num(p, NaN, 0.01, 100000)).filter(Number.isFinite)
    : defaults.milestones.pcts;
  const rawSourceMode = signals.sourceMode;
  const sourceMode: SourceMode =
    rawSourceMode === "okx_watch" ||
    rawSourceMode === "hybrid" ||
    rawSourceMode === "okx_only" ||
    rawSourceMode === "gmgn_watch" ||
    rawSourceMode === "gmgn_live" ||
    rawSourceMode === "gmgn_only" ||
    rawSourceMode === "scg_only"
      ? rawSourceMode
      : defaults.signals.sourceMode;

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
    alertFilter: {
      mcapMin: num(alertFilter.mcapMin, defaults.alertFilter.mcapMin, 0),
      mcapMax: num(alertFilter.mcapMax, defaults.alertFilter.mcapMax, 0),
    },
    signals: {
      sourceMode,
      okx: {
        enabled: bool(okxSignals.enabled, sourceMode === "okx_watch" || sourceMode === "hybrid" || sourceMode === "okx_only"),
        seedLimit: Math.round(num(okxSignals.seedLimit, defaults.signals.okx.seedLimit, 0, 5000)),
        mintCooldownMins: num(okxSignals.mintCooldownMins, defaults.signals.okx.mintCooldownMins, 0, 1440),
        entryFilter: {
          minHolders: Math.round(num(okxEntryFilter.minHolders, defaults.signals.okx.entryFilter.minHolders, 0, 1_000_000_000)),
          walletTypes: normalizeNumberList(okxEntryFilter.walletTypes, defaults.signals.okx.entryFilter.walletTypes, 1, 99),
          minAmountUsd: num(okxEntryFilter.minAmountUsd, defaults.signals.okx.entryFilter.minAmountUsd, 0, 1_000_000_000),
        },
        discovery: {
          enabled: bool(okxDiscovery.enabled, defaults.signals.okx.discovery.enabled),
          pollMs: Math.round(num(okxDiscovery.pollMs, defaults.signals.okx.discovery.pollMs, 15_000, 600_000)),
          mintCooldownMins: num(okxDiscovery.mintCooldownMins, defaults.signals.okx.discovery.mintCooldownMins, 0, 1440),
          watchlistTtlMins: num(okxDiscovery.watchlistTtlMins, defaults.signals.okx.discovery.watchlistTtlMins, 5, 1440 * 7),
          maxWatchMints: Math.round(num(okxDiscovery.maxWatchMints, defaults.signals.okx.discovery.maxWatchMints, 10, 1000)),
          seedLimit: Math.round(num(okxDiscovery.seedLimit, defaults.signals.okx.discovery.seedLimit, 10, 100)),
          timeFrame: typeof okxDiscovery.timeFrame === "string" && okxDiscovery.timeFrame.trim()
            ? okxDiscovery.timeFrame.trim()
            : defaults.signals.okx.discovery.timeFrame,
          rankBy: typeof okxDiscovery.rankBy === "string" && okxDiscovery.rankBy.trim()
            ? okxDiscovery.rankBy.trim()
            : defaults.signals.okx.discovery.rankBy,
          includeBundleInfo: bool(okxDiscovery.includeBundleInfo, defaults.signals.okx.discovery.includeBundleInfo),
          baseline: {
            minHolders: Math.round(num(okxDiscoveryBaseline.minHolders, defaults.signals.okx.discovery.baseline.minHolders, 0, 1_000_000_000)),
            minLiquidityUsd: num(okxDiscoveryBaseline.minLiquidityUsd, defaults.signals.okx.discovery.baseline.minLiquidityUsd, 0),
            minMcapUsd: num(okxDiscoveryBaseline.minMcapUsd, defaults.signals.okx.discovery.baseline.minMcapUsd, 0),
            maxMcapUsd: num(okxDiscoveryBaseline.maxMcapUsd, defaults.signals.okx.discovery.baseline.maxMcapUsd, 0),
            maxTop10HolderRate: num(okxDiscoveryBaseline.maxTop10HolderRate, defaults.signals.okx.discovery.baseline.maxTop10HolderRate, 0, 1),
            maxRugRatio: num(okxDiscoveryBaseline.maxRugRatio, defaults.signals.okx.discovery.baseline.maxRugRatio, 0, 1),
            maxBundlerRate: num(okxDiscoveryBaseline.maxBundlerRate, defaults.signals.okx.discovery.baseline.maxBundlerRate, 0, 1),
            maxBotRate: num(okxDiscoveryBaseline.maxBotRate, defaults.signals.okx.discovery.baseline.maxBotRate, 0, 1),
            maxCreatorBalanceRate: num(okxDiscoveryBaseline.maxCreatorBalanceRate, defaults.signals.okx.discovery.baseline.maxCreatorBalanceRate, 0, 1),
            requireNotWashTrading: bool(okxDiscoveryBaseline.requireNotWashTrading, defaults.signals.okx.discovery.baseline.requireNotWashTrading),
          },
          trigger: {
            minScans: Math.round(num(okxDiscoveryTrigger.minScans, defaults.signals.okx.discovery.trigger.minScans, 1, 20)),
            minHolderGrowthPct: num(okxDiscoveryTrigger.minHolderGrowthPct, defaults.signals.okx.discovery.trigger.minHolderGrowthPct, 0, 1000),
            maxLiquidityDropPct: num(okxDiscoveryTrigger.maxLiquidityDropPct, defaults.signals.okx.discovery.trigger.maxLiquidityDropPct, 0, 100),
            minBuySellRatio: num(okxDiscoveryTrigger.minBuySellRatio, defaults.signals.okx.discovery.trigger.minBuySellRatio, 0, 1000),
          },
        },
      },
      gmgn: {
        enabled: bool(gmgnSignals.enabled, sourceMode === "gmgn_watch" || sourceMode === "gmgn_live" || sourceMode === "gmgn_only"),
        pollMs: Math.round(num(gmgnSignals.pollMs, defaults.signals.gmgn.pollMs, 15_000, 600_000)),
        mintCooldownMins: num(gmgnSignals.mintCooldownMins, defaults.signals.gmgn.mintCooldownMins, 0, 1440),
        watchlistTtlMins: num(gmgnSignals.watchlistTtlMins, defaults.signals.gmgn.watchlistTtlMins, 5, 1440),
        maxWatchMints: Math.round(num(gmgnSignals.maxWatchMints, defaults.signals.gmgn.maxWatchMints, 10, 1000)),
        baseline: {
          minHolders: Math.round(num(gmgnBaseline.minHolders, defaults.signals.gmgn.baseline.minHolders, 0, 1_000_000_000)),
          minLiquidityUsd: num(gmgnBaseline.minLiquidityUsd, defaults.signals.gmgn.baseline.minLiquidityUsd, 0),
          minMcapUsd: num(gmgnBaseline.minMcapUsd, defaults.signals.gmgn.baseline.minMcapUsd, 0),
          maxMcapUsd: num(gmgnBaseline.maxMcapUsd, defaults.signals.gmgn.baseline.maxMcapUsd, 0),
          maxTop10HolderRate: num(gmgnBaseline.maxTop10HolderRate, defaults.signals.gmgn.baseline.maxTop10HolderRate, 0, 1),
          maxRugRatio: num(gmgnBaseline.maxRugRatio, defaults.signals.gmgn.baseline.maxRugRatio, 0, 1),
          maxBundlerRate: num(gmgnBaseline.maxBundlerRate, defaults.signals.gmgn.baseline.maxBundlerRate, 0, 1),
          maxBotRate: num(gmgnBaseline.maxBotRate, defaults.signals.gmgn.baseline.maxBotRate, 0, 1),
          maxCreatorBalanceRate: num(gmgnBaseline.maxCreatorBalanceRate, defaults.signals.gmgn.baseline.maxCreatorBalanceRate, 0, 1),
          requireNotWashTrading: bool(gmgnBaseline.requireNotWashTrading, defaults.signals.gmgn.baseline.requireNotWashTrading),
        },
        trigger: {
          minScans: Math.round(num(gmgnTrigger.minScans, defaults.signals.gmgn.trigger.minScans, 1, 20)),
          minHolderGrowthPct: num(gmgnTrigger.minHolderGrowthPct, defaults.signals.gmgn.trigger.minHolderGrowthPct, 0, 1000),
          maxLiquidityDropPct: num(gmgnTrigger.maxLiquidityDropPct, defaults.signals.gmgn.trigger.maxLiquidityDropPct, 0, 100),
          minBuySellRatio: num(gmgnTrigger.minBuySellRatio, defaults.signals.gmgn.trigger.minBuySellRatio, 0, 1000),
          minSmartOrKolCount: Math.round(num(gmgnTrigger.minSmartOrKolCount, defaults.signals.gmgn.trigger.minSmartOrKolCount, 0, 1000)),
        },
      },
    },
    marketData: {
      wss: {
        enabled: bool(wss.enabled, defaults.marketData.wss.enabled),
        pollMs: Math.round(num(wss.pollMs, defaults.marketData.wss.pollMs, 500, 60_000)),
        triggerTickMs: Math.round(num(wss.triggerTickMs, defaults.marketData.wss.triggerTickMs, 250, 60_000)),
        channels: normalizeStringList(wss.channels, defaults.marketData.wss.channels),
      },
    },
    jupGate: {
      enabled: bool(jupGate.enabled, defaults.jupGate.enabled),
      minFees: num(jupGate.minFees, defaults.jupGate.minFees, 0, 1_000_000_000),
      allowedScoreLabels: normalizeStringList(jupGate.allowedScoreLabels, defaults.jupGate.allowedScoreLabels, true),
      minOrganicVolumePct: num(jupGate.minOrganicVolumePct, defaults.jupGate.minOrganicVolumePct, 0, 100),
      minOrganicBuyersPct: num(jupGate.minOrganicBuyersPct, defaults.jupGate.minOrganicBuyersPct, 0, 100),
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
  (CONFIG as unknown as Record<string, unknown>).MIN_ALERT_MCAP = next.alertFilter.mcapMin;
  (CONFIG as unknown as Record<string, unknown>).MAX_ALERT_MCAP = next.alertFilter.mcapMax;
  (CONFIG as unknown as Record<string, unknown>).OKX_WSS_ENABLED = next.marketData.wss.enabled;
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
    draft.alertFilter.mcapMin = CONFIG.MIN_ALERT_MCAP;
    draft.alertFilter.mcapMax = CONFIG.MAX_ALERT_MCAP;
    draft.marketData.wss.enabled = CONFIG.OKX_WSS_ENABLED;
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
