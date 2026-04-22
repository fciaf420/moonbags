import { execFile } from "node:child_process";
import os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import dotenv from "dotenv";

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 8_000;
const PM2_PROCESS = "moonbags";

export type DoctorStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

type EnvMap = Record<string, string>;

type CommandOutcome = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
};

function statusRank(status: DoctorStatus): number {
  if (status === "fail") return 2;
  if (status === "warn") return 1;
  return 0;
}

function loadEnv(): EnvMap {
  let parsed: EnvMap = {};
  if (existsSync(".env")) {
    parsed = dotenv.parse(readFileSync(".env"));
  }
  return { ...process.env, ...parsed } as EnvMap;
}

function hasValue(env: EnvMap, key: string): boolean {
  return Boolean(env[key]?.trim());
}

function envNumber(env: EnvMap, key: string): number | null {
  if (!hasValue(env, key)) return null;
  const value = Number(env[key]);
  return Number.isFinite(value) ? value : null;
}

function envBool(env: EnvMap, key: string): boolean | null {
  if (!hasValue(env, key)) return null;
  const value = env[key]!.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return null;
}

function firstLine(raw: string): string {
  return raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function run(command: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<CommandOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout,
      env: {
        ...process.env,
        PATH: `${process.env.HOME ?? ""}/.local/bin:${process.env.PATH ?? ""}`,
      },
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? "").trim(),
      error: e.message ?? String(err),
    };
  }
}

async function fetchOk(url: string, init?: RequestInit): Promise<{ ok: boolean; status?: number; detail: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    return {
      ok: res.ok,
      status: res.status,
      detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 160)).catch(() => "")}`,
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

function checkEnvVars(env: EnvMap): DoctorCheck[] {
  const dryRun = (env.DRY_RUN ?? "true").trim().toLowerCase();
  const isDryRun = ["", "1", "true", "yes", "y", "on"].includes(dryRun);
  const checks: DoctorCheck[] = [];

  const required = [
    ["JUP_API_KEY", "Jupiter API key"],
    ["HELIUS_API_KEY", "Helius API key"],
  ] as const;

  for (const [key, label] of required) {
    checks.push({
      id: `env:${key}`,
      label,
      status: hasValue(env, key) ? "ok" : "fail",
      detail: hasValue(env, key) ? "set" : `${key} is missing from .env`,
      fix: hasValue(env, key) ? undefined : "Run npm run setup and paste the missing key.",
    });
  }

  checks.push({
    id: "env:PRIV_B58",
    label: "Wallet private key",
    status: hasValue(env, "PRIV_B58") ? "ok" : isDryRun ? "warn" : "fail",
    detail: hasValue(env, "PRIV_B58")
      ? "set"
      : isDryRun
        ? "missing, but DRY_RUN=true"
        : "PRIV_B58 is missing while DRY_RUN=false",
    fix: hasValue(env, "PRIV_B58") ? undefined : "Run npm run setup to generate/import a wallet.",
  });

  const okxSet = hasValue(env, "OKX_API_KEY") && hasValue(env, "OKX_SECRET_KEY") &&
    (hasValue(env, "OKX_PASSPHRASE") || hasValue(env, "OKX_API_PASSPHRASE"));
  checks.push({
    id: "env:okx",
    label: "OKX OnchainOS keys",
    status: okxSet ? "ok" : "warn",
    detail: okxSet ? "set" : "missing one or more OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE",
    fix: okxSet ? undefined : "Create keys at https://web3.okx.com/onchain-os/dev-portal, then run npm run setup.",
  });

  const gmgnSet = hasValue(env, "GMGN_API_KEY");
  checks.push({
    id: "env:gmgn",
    label: "GMGN OpenAPI key",
    status: gmgnSet ? "ok" : "warn",
    detail: gmgnSet ? "set" : "missing GMGN_API_KEY (GMGN source modes disabled)",
    fix: gmgnSet ? undefined : "Create a GMGN API key at https://gmgn.ai/ai?chain=sol and add GMGN_API_KEY to .env.",
  });

  const telegramSet = hasValue(env, "TELEGRAM_BOT_TOKEN") && hasValue(env, "TELEGRAM_CHAT_ID");
  checks.push({
    id: "env:telegram",
    label: "Telegram bot settings",
    status: telegramSet ? "ok" : "warn",
    detail: telegramSet ? "set" : "missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID",
    fix: telegramSet ? undefined : "Run npm run setup after creating a bot with @BotFather.",
  });

  const numericFilters = [
    "MAX_ALERT_AGE_MINS",
    "MIN_LIQUIDITY_USD",
    "MIN_SCORE",
    "MAX_RUG_RATIO",
    "MAX_BUNDLER_PCT",
    "MAX_TOP10_PCT",
  ];
  const invalidFilters = numericFilters.filter((key) => hasValue(env, key) && envNumber(env, key) === null);
  if (invalidFilters.length > 0) {
    checks.push({
      id: "env:alert_filters",
      label: "Entry alert filters",
      status: "fail",
      detail: `invalid numeric filter values: ${invalidFilters.join(", ")}`,
      fix: "Use numbers for alert filters. Set them to 0 to disable filtering.",
    });
  } else {
    const enabledFilters = numericFilters
      .map((key) => [key, envNumber(env, key)] as const)
      .filter(([, value]) => value !== null && value > 0)
      .map(([key, value]) => `${key}=${value}`);
    const risingLiq = envBool(env, "REQUIRE_RISING_LIQ");
    if (risingLiq === null && hasValue(env, "REQUIRE_RISING_LIQ")) {
      checks.push({
        id: "env:alert_filters_bool",
        label: "Entry alert filters",
        status: "fail",
        detail: "invalid REQUIRE_RISING_LIQ value",
        fix: "Set REQUIRE_RISING_LIQ=true or false.",
      });
    } else if (enabledFilters.length > 0 || risingLiq === true) {
      checks.push({
        id: "env:alert_filters",
        label: "Entry alert filters",
        status: "warn",
        detail: [...enabledFilters, ...(risingLiq === true ? ["REQUIRE_RISING_LIQ=true"] : [])].join(", "),
        fix: "These filters can block entry signals. Set numeric filters to 0 and REQUIRE_RISING_LIQ=false for open SCG alerts.",
      });
    } else {
      checks.push({
        id: "env:alert_filters",
        label: "Entry alert filters",
        status: "ok",
        detail: "open defaults (0 disables numeric filters)",
      });
    }
  }

  return checks;
}

export async function runDoctor(options: { network?: boolean } = {}): Promise<DoctorReport> {
  const network = options.network ?? true;
  const env = loadEnv();
  const checks: DoctorCheck[] = [];

  const platform = os.platform();
  const osLabel =
    platform === "darwin" ? `macOS ${os.release()}` :
    platform === "linux" ? `Linux ${os.release()}` :
    platform === "win32" ? `Windows ${os.release()}` :
    `${platform} ${os.release()}`;
  checks.push({
    id: "os",
    label: "Operating system",
    status: platform === "darwin" || platform === "linux" ? "ok" : "warn",
    detail: osLabel,
    fix: platform === "win32"
      ? "Use WSL2 Ubuntu for the one-command installer and pm2 process management."
      : platform === "darwin" || platform === "linux"
        ? undefined
        : "macOS and Linux are the tested install targets.",
  });

  checks.push({
    id: "env:file",
    label: ".env file",
    status: existsSync(".env") ? "ok" : "fail",
    detail: existsSync(".env") ? "found" : "missing",
    fix: existsSync(".env") ? undefined : "Run npm run setup.",
  });

  const node = process.versions.node;
  const major = Number.parseInt(node.split(".")[0] ?? "0", 10);
  checks.push({
    id: "node",
    label: "Node.js",
    status: major >= 20 ? "ok" : "fail",
    detail: `v${node}`,
    fix: major >= 20 ? undefined : "Install Node.js 20 or newer.",
  });

  const git = await run("git", ["--version"]);
  checks.push({
    id: "git",
    label: "Git",
    status: git.ok ? "ok" : "fail",
    detail: git.ok ? firstLine(git.stdout) : git.error ?? "not found",
    fix: git.ok ? undefined : "Install git, then rerun npm run doctor.",
  });

  const npm = await run("npm", ["--version"]);
  checks.push({
    id: "npm",
    label: "npm",
    status: npm.ok ? "ok" : "fail",
    detail: npm.ok ? `v${firstLine(npm.stdout)}` : npm.error ?? "not found",
    fix: npm.ok ? undefined : "Install Node.js 20+, which includes npm.",
  });

  const onchainos = await run("onchainos", ["--version"]);
  checks.push({
    id: "onchainos:version",
    label: "OnchainOS CLI",
    status: onchainos.ok ? "ok" : "fail",
    detail: onchainos.ok ? firstLine(onchainos.stdout || onchainos.stderr) : onchainos.error ?? "not found",
    fix: onchainos.ok ? undefined : "Run npm run install:onchainos, then export PATH=\"$HOME/.local/bin:$PATH\".",
  });

  // Hot-tokens discovery — `token trending` was removed in onchainos v2.3.0,
  // so we only check hot-tokens now (which is what the backtester uses).
  const hotTokens = await run("onchainos", ["token", "hot-tokens", "--help"]);
  checks.push({
    id: "onchainos:hot-tokens",
    label: "OnchainOS hot-tokens",
    status: hotTokens.ok ? "ok" : "fail",
    detail: hotTokens.ok ? "available" : firstLine(hotTokens.stderr || hotTokens.stdout || (hotTokens.error ?? "failed")),
    fix: hotTokens.ok ? undefined : "Run npm run install:onchainos, open a new terminal, then verify onchainos token hot-tokens --help.",
  });

  const okxWssEnabled = envBool(env, "OKX_WSS_ENABLED") === true;
  if (okxWssEnabled) {
    const wss = await run("onchainos", ["ws", "channel-info", "--chain", "solana", "--channel", "price-info"]);
    checks.push({
      id: "onchainos:wss",
      label: "OnchainOS WSS",
      status: wss.ok ? "ok" : "fail",
      detail: wss.ok ? "price-info channel available" : firstLine(wss.stderr || wss.stdout || (wss.error ?? "failed")),
      fix: wss.ok ? undefined : "Update OnchainOS with npm run install:onchainos, then restart moonbags with the updated PATH.",
    });
  } else {
    checks.push({
      id: "onchainos:wss",
      label: "OnchainOS WSS",
      status: "warn",
      detail: "disabled (OKX_WSS_ENABLED=false)",
      fix: "Optional: set OKX_WSS_ENABLED=true to stream open-position market data.",
    });
  }

  const pm2 = await run("pm2", ["--version"]);
  checks.push({
    id: "pm2",
    label: "PM2",
    status: pm2.ok ? "ok" : "warn",
    detail: pm2.ok ? `v${firstLine(pm2.stdout)}` : "not installed or not on PATH",
    fix: pm2.ok ? undefined : "Install with npm install -g pm2.",
  });

  if (pm2.ok) {
    const pm2Process = await run("pm2", ["describe", PM2_PROCESS]);
    checks.push({
      id: "pm2:moonbags",
      label: "PM2 moonbags process",
      status: pm2Process.ok ? "ok" : "warn",
      detail: pm2Process.ok ? "found" : "not found",
      fix: pm2Process.ok ? undefined : `Start it with pm2 start "npm run start" --name ${PM2_PROCESS} && pm2 save.`,
    });
  }

  checks.push(...checkEnvVars(env));

  if (network) {
    const scg = await fetchOk("https://api.scgalpha.com/api/alerts");
    checks.push({
      id: "network:scg",
      label: "SCG Alpha feed",
      status: scg.ok ? "ok" : "warn",
      detail: scg.detail,
      fix: scg.ok ? undefined : "Check internet/DNS. The bot cannot find new alerts while this feed is unreachable.",
    });

    const rpcUrl = (env.RPC_URL || "https://beta.helius-rpc.com?api-key=${HELIUS_API_KEY}")
      .replace("${HELIUS_API_KEY}", env.HELIUS_API_KEY ?? "");
    if (rpcUrl && hasValue(env, "HELIUS_API_KEY")) {
      const rpc = await fetchOk(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "doctor", method: "getHealth" }),
      });
      checks.push({
        id: "network:rpc",
        label: "Solana RPC",
        status: rpc.ok ? "ok" : "warn",
        detail: rpc.detail,
        fix: rpc.ok ? undefined : "Check HELIUS_API_KEY and RPC_URL in .env.",
      });
    }
  }

  checks.sort((a, b) => statusRank(b.status) - statusRank(a.status));
  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

function icon(status: DoctorStatus): string {
  if (status === "ok") return "✅";
  if (status === "warn") return "⚠️";
  return "❌";
}

export function formatDoctorPlain(report: DoctorReport): string {
  const lines = [
    "MoonBags Doctor",
    report.ok ? "No blocking failures found." : "Fix the failed checks below.",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${icon(check.status)} ${check.label}: ${check.detail}`);
    if (check.fix) lines.push(`   Fix: ${check.fix}`);
  }
  return lines.join("\n");
}

export function formatDoctorHtml(report: DoctorReport, title = "MoonBags Doctor"): string {
  const escape = (s: string): string => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = [
    `<b>${escape(title)}</b>`,
    report.ok ? "✅ No blocking failures found." : "❌ Fix the failed checks below.",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${icon(check.status)} <b>${escape(check.label)}</b>: ${escape(check.detail)}`);
    if (check.fix) lines.push(`   Fix: <code>${escape(check.fix)}</code>`);
  }
  return lines.join("\n");
}
