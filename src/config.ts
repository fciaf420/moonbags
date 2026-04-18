import dotenv from "dotenv";

dotenv.config();

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const JUP_BASE = "https://api.jup.ag/ultra/v1";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for env var ${name}: ${raw}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean for env var ${name}: ${raw}`);
}

function str(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  return raw;
}

/**
 * Parse a comma-separated list of positive numbers from an env var.
 * E.g. "100,200,500,1000" → [100, 200, 500, 1000].
 * Invalid values are dropped silently; returns `fallback` on fully empty/invalid input.
 */
function numList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parts = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return parts.length > 0 ? parts.sort((a, b) => a - b) : fallback;
}

function resolveRpcUrl(): string {
  const raw = process.env.RPC_URL ?? "https://beta.helius-rpc.com?api-key=${HELIUS_API_KEY}";
  const helius = process.env.HELIUS_API_KEY ?? "";
  return raw.replace("${HELIUS_API_KEY}", helius);
}

const DRY_RUN = bool("DRY_RUN", true);

const JUP_API_KEY = str("JUP_API_KEY");
const HELIUS_API_KEY = str("HELIUS_API_KEY");
const PRIV_B58 = str("PRIV_B58");

const missing: string[] = [];
if (!JUP_API_KEY) missing.push("JUP_API_KEY");
if (!HELIUS_API_KEY) missing.push("HELIUS_API_KEY");
if (!PRIV_B58) missing.push("PRIV_B58");

if (missing.length > 0) {
  if (DRY_RUN && missing.length === 1 && missing[0] === "PRIV_B58") {
    console.warn("[config] DRY_RUN=true and PRIV_B58 missing — continuing without a signing key.");
  } else if (DRY_RUN && missing.every((m) => m === "PRIV_B58")) {
    console.warn("[config] DRY_RUN=true and PRIV_B58 missing — continuing without a signing key.");
  } else {
    const hardMissing = missing.filter((m) => !(DRY_RUN && m === "PRIV_B58"));
    if (hardMissing.length > 0) {
      throw new Error(`Missing required env vars: ${hardMissing.join(", ")}`);
    } else {
      console.warn("[config] DRY_RUN=true and PRIV_B58 missing — continuing without a signing key.");
    }
  }
}

// CONFIG is mutable so /settings in the Telegram bot can update values live.
// API keys, wallet keys, and DRY_RUN are still NOT mutable via the in-process
// updater (see SETTABLE_KEYS below). Trading edits are persisted by settingsStore.
export const CONFIG = ({
  JUP_API_KEY: JUP_API_KEY ?? "",
  HELIUS_API_KEY: HELIUS_API_KEY ?? "",
  PRIV_B58: PRIV_B58 ?? "",
  RPC_URL: resolveRpcUrl(),
  BUY_SIZE_SOL: num("BUY_SIZE_SOL", 0.02),
  MAX_CONCURRENT_POSITIONS: num("MAX_CONCURRENT_POSITIONS", 10),
  ARM_PCT: num("ARM_PCT", 0.5),
  TRAIL_PCT: num("TRAIL_PCT", 0.55),
  STOP_PCT: num("STOP_PCT", 0.4),
  MAX_HOLD_SECS: num("MAX_HOLD_SECS", 99_999_999_999_999_999),
  MAX_ALERT_AGE_MINS: num("MAX_ALERT_AGE_MINS", 0),
  MIN_LIQUIDITY_USD: num("MIN_LIQUIDITY_USD", 0),
  MIN_SCORE: num("MIN_SCORE", 0),
  MAX_RUG_RATIO: num("MAX_RUG_RATIO", 0),
  MAX_BUNDLER_PCT: num("MAX_BUNDLER_PCT", 0),
  MAX_TOP10_PCT: num("MAX_TOP10_PCT", 0),
  REQUIRE_RISING_LIQ: bool("REQUIRE_RISING_LIQ", false),
  SCG_POLL_MS: num("SCG_POLL_MS", 3000),
  PRICE_POLL_MS: num("PRICE_POLL_MS", 2000),
  SLIPPAGE_BPS: num("SLIPPAGE_BPS", 0), // unused with Ultra (automatic slippage via RTSE)
  MOONBAG_PCT: num("MOONBAG_PCT", 0),
  MB_TRAIL_PCT: num("MB_TRAIL_PCT", 0.60),
  MB_TIMEOUT_SECS: num("MB_TIMEOUT_SECS", 7200),
  DASHBOARD_PORT: num("DASHBOARD_PORT", 8787),
  TELEGRAM_BOT_TOKEN: str("TELEGRAM_BOT_TOKEN") ?? "",
  TELEGRAM_CHAT_ID: str("TELEGRAM_CHAT_ID") ?? "",
  LLM_EXIT_ENABLED: bool("LLM_EXIT_ENABLED", false),
  LLM_POLL_MS: num("LLM_POLL_MS", 30_000),
  MINIMAX_API_KEY: str("MINIMAX_API_KEY") ?? "",
  // Milestone alerts — when a position crosses one of these PnL % thresholds
  // on its way up, send a Telegram notification with a force-sell button.
  // Default [100, 200, 500, 1000] = 2x / 3x / 6x / 11x.
  MILESTONES_ENABLED: bool("MILESTONES_ENABLED", true),
  MILESTONE_PCTS: numList("MILESTONE_PCTS", [100, 200, 500, 1000]),
  DRY_RUN,
});

export type Config = typeof CONFIG;

// ---------------------------------------------------------------------------
// Runtime config editing (used by Telegram /settings menu).
// Only whitelisted keys can be modified at runtime — API keys, wallet keys,
// RPC URLs, and DRY_RUN are intentionally excluded from live editing.
// ---------------------------------------------------------------------------
export type SettableKey =
  | "BUY_SIZE_SOL"
  | "MAX_CONCURRENT_POSITIONS"
  | "ARM_PCT"
  | "TRAIL_PCT"
  | "STOP_PCT"
  | "MAX_HOLD_SECS"
  | "LLM_EXIT_ENABLED"
  | "MILESTONES_ENABLED"
  | "MILESTONE_PCTS"
  | "MOONBAG_PCT"
  | "MB_TRAIL_PCT"
  | "MB_TIMEOUT_SECS"
  | "LLM_POLL_MS";

export type SettableValue = number | boolean | number[];

type Validator = (v: SettableValue) => string | null; // returns error msg or null
type Spec = {
  type: "number" | "boolean" | "numlist";
  validate: Validator;
  display: (v: SettableValue) => string;
};

export const SETTABLE_SPECS: Record<SettableKey, Spec> = {
  BUY_SIZE_SOL: {
    type: "number",
    validate: (v) => (typeof v === "number" && v >= 0.001 && v <= 1.0 ? null : "must be 0.001 – 1.0 SOL"),
    display: (v) => `${(v as number).toString()} SOL`,
  },
  MAX_CONCURRENT_POSITIONS: {
    type: "number",
    validate: (v) =>
      typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 50
        ? null
        : "must be an integer 1 – 50",
    display: (v) => `${v}`,
  },
  ARM_PCT: {
    type: "number",
    validate: (v) => (typeof v === "number" && v >= 0.05 && v <= 5.0 ? null : "must be 0.05 – 5.0 (5% – 500%)"),
    display: (v) => `${((v as number) * 100).toFixed(0)}%`,
  },
  TRAIL_PCT: {
    type: "number",
    validate: (v) => (typeof v === "number" && v >= 0.05 && v <= 5.0 ? null : "must be 0.05 – 5.0 (5% – 500%)"),
    display: (v) => `${((v as number) * 100).toFixed(0)}%`,
  },
  STOP_PCT: {
    type: "number",
    validate: (v) => (typeof v === "number" && v >= 0.05 && v <= 5.0 ? null : "must be 0.05 – 5.0 (5% – 500%)"),
    display: (v) => `${((v as number) * 100).toFixed(0)}%`,
  },
  MAX_HOLD_SECS: {
    type: "number",
    validate: (v) =>
      typeof v === "number" && Number.isFinite(v) && v >= 60 ? null : "must be ≥ 60 seconds",
    display: (v) => {
      const n = v as number;
      if (n >= 99_999_999) return "∞";
      if (n >= 86400) return `${(n / 86400).toFixed(1)}d`;
      if (n >= 3600) return `${(n / 3600).toFixed(1)}h`;
      if (n >= 60) return `${Math.round(n / 60)}m`;
      return `${n}s`;
    },
  },
  LLM_EXIT_ENABLED: {
    type: "boolean",
    validate: (v) => (typeof v === "boolean" ? null : "must be true/false"),
    display: (v) => (v ? "🤖 ON" : "⚪️ OFF"),
  },
  MILESTONES_ENABLED: {
    type: "boolean",
    validate: (v) => (typeof v === "boolean" ? null : "must be true/false"),
    display: (v) => (v ? "🎯 ON" : "⚪️ OFF"),
  },
  MILESTONE_PCTS: {
    type: "numlist",
    validate: (v) => {
      if (!Array.isArray(v)) return "must be a comma-separated list of positive numbers";
      if (v.length === 0) return "at least one milestone required";
      if (v.length > 10) return "max 10 milestones";
      if (v.some((n) => typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 100000)) {
        return "each milestone must be a positive number (1 – 100000)";
      }
      return null;
    },
    display: (v) => {
      const arr = v as number[];
      return arr.map((n) => `+${n}%`).join(", ");
    },
  },
  // Moonbag (partial kept after trail fires) — only active when LLM_EXIT_ENABLED=false.
  // When LLM is on, partial exits are driven by the advisor's `partial_exit` action.
  MOONBAG_PCT: {
    type: "number",
    validate: (v) => (typeof v === "number" && v >= 0 && v <= 0.9 ? null : "must be 0 – 0.9 (fraction kept, 0 = disabled)"),
    display: (v) => (v === 0 ? "off" : `${((v as number) * 100).toFixed(0)}%`),
  },
  MB_TRAIL_PCT: {
    type: "number",
    validate: (v) => (typeof v === "number" && v >= 0.05 && v <= 0.95 ? null : "must be 0.05 – 0.95"),
    display: (v) => `${((v as number) * 100).toFixed(0)}%`,
  },
  MB_TIMEOUT_SECS: {
    type: "number",
    validate: (v) =>
      typeof v === "number" && Number.isFinite(v) && v >= 60 && v <= 86400
        ? null
        : "must be 60 – 86400 seconds",
    display: (v) => {
      const n = v as number;
      if (n >= 3600) return `${(n / 3600).toFixed(1)}h`;
      return `${Math.round(n / 60)}m`;
    },
  },
  LLM_POLL_MS: {
    type: "number",
    validate: (v) =>
      typeof v === "number" && Number.isFinite(v) && v >= 5_000 && v <= 300_000
        ? null
        : "must be 5000 – 300000 ms (5s – 5min)",
    display: (v) => {
      const n = v as number;
      if (n >= 60_000) return `${(n / 60_000).toFixed(1)}m`;
      return `${Math.round(n / 1000)}s`;
    },
  },
};

export type SetConfigResult = { ok: true } | { ok: false; error: string };

export function setConfigValue(key: SettableKey, raw: string): SetConfigResult {
  const spec = SETTABLE_SPECS[key];
  let parsed: SettableValue;
  if (spec.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: "not a valid number" };
    parsed = n;
  } else if (spec.type === "boolean") {
    const v = raw.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(v)) parsed = true;
    else if (["0", "false", "no", "n", "off"].includes(v)) parsed = false;
    else return { ok: false, error: "must be true/false" };
  } else {
    // numlist — comma-separated positive numbers
    const parts = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (parts.length === 0) return { ok: false, error: "no valid numbers in list" };
    parsed = parts.sort((a, b) => a - b);
  }
  const err = spec.validate(parsed);
  if (err) return { ok: false, error: err };

  // mutate in-memory CONFIG (typed as readonly but the object isn't frozen anymore)
  (CONFIG as unknown as Record<string, unknown>)[key] = parsed;
  return { ok: true };
}

export function toggleConfigValue(key: SettableKey): SetConfigResult {
  if (SETTABLE_SPECS[key].type !== "boolean") {
    return { ok: false, error: "not a boolean setting" };
  }
  const current = (CONFIG as unknown as Record<string, unknown>)[key] as boolean;
  return setConfigValue(key, String(!current));
}
