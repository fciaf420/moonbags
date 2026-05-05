import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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

function checkSourceMode(env: EnvMap): DoctorCheck | null {
  if (!existsSync("state/settings.json")) return null;
  let sourceMode = "";
  try {
    const raw = JSON.parse(readFileSync("state/settings.json", "utf8")) as { signals?: { sourceMode?: string } };
    sourceMode = raw.signals?.sourceMode ?? "";
  } catch {
    return {
      id: "runtime:sourceMode",
      label: "Source mode (state/settings.json)",
      status: "warn",
      detail: "unreadable",
      fix: "state/settings.json is corrupt. Delete it and pick a mode via /sources on next boot.",
    };
  }
  if (!sourceMode) return null;

  const needsOkx = ["okx_only", "okx_watch", "hybrid"].includes(sourceMode);
  const needsGmgn = ["gmgn_only", "gmgn_live", "gmgn_watch", "hybrid"].includes(sourceMode);
  const needsPrivateFeed = ["private_only", "okx_watch", "gmgn_watch", "gmgn_live", "hybrid"].includes(sourceMode);
  const hasOkx = hasValue(env, "OKX_API_KEY") && hasValue(env, "OKX_SECRET_KEY") &&
    (hasValue(env, "OKX_PASSPHRASE") || hasValue(env, "OKX_API_PASSPHRASE"));
  const hasGmgn = hasValue(env, "GMGN_API_KEY");
  const privateSource = env.PRIVATE_SIGNAL_SOURCE?.trim() || (hasValue(env, "DATABASE_URL") ? "postgres" : "direct");
  const hasPrivateDirect = hasValue(env, "PRIVATE_SIGNAL_API_URL") && hasValue(env, "PRIVATE_SIGNAL_API_KEY");
  const hasPrivatePostgres = hasValue(env, "DATABASE_URL");
  const hasPrivateFeed = privateSource === "postgres" ? hasPrivatePostgres : hasPrivateDirect;

  if (sourceMode === "private_only" && !hasPrivateFeed) {
    return {
      id: "runtime:sourceMode",
      label: "Source mode",
      status: "fail",
      detail: `sourceMode="private_only" requires a configured Private Feed`,
      fix: "Set PRIVATE_SIGNAL_SOURCE=postgres with DATABASE_URL, or set PRIVATE_SIGNAL_API_URL + PRIVATE_SIGNAL_API_KEY.",
    };
  }

  if (needsOkx && !hasOkx) {
    return {
      id: "runtime:sourceMode",
      label: "Source mode",
      status: "fail",
      detail: `sourceMode="${sourceMode}" requires OKX credentials`,
      fix: "Add OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE to .env or switch to a GMGN-only mode in /sources.",
    };
  }
  if (needsGmgn && !hasGmgn && !["hybrid"].includes(sourceMode)) {
    return {
      id: "runtime:sourceMode",
      label: "Source mode",
      status: "fail",
      detail: `sourceMode="${sourceMode}" requires GMGN_API_KEY`,
      fix: "Add GMGN_API_KEY to .env (get one at https://gmgn.ai/ai?chain=sol) or switch to an OKX-only mode.",
    };
  }
  if (needsPrivateFeed && !hasPrivateFeed) {
    return {
      id: "runtime:sourceMode",
      label: "Source mode",
      status: "warn",
      detail: `sourceMode="${sourceMode}" can use Private Feed but it is not configured`,
      fix: "Set PRIVATE_SIGNAL_SOURCE=postgres with DATABASE_URL, or set PRIVATE_SIGNAL_API_URL + PRIVATE_SIGNAL_API_KEY.",
    };
  }

  return {
    id: "runtime:sourceMode",
    label: "Source mode",
    status: "ok",
    detail: `sourceMode="${sourceMode}"`,
  };
}

async function probeGmgn(apiKey: string, host?: string): Promise<{ ok: boolean; detail: string }> {
  const base = host || "https://openapi.gmgn.ai";
  const url = new URL("/v1/market/rank", base);
  url.searchParams.set("chain", "sol");
  url.searchParams.set("interval", "5m");
  url.searchParams.set("limit", "1");
  url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("client_id", randomUUID());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "X-APIKEY": apiKey },
      signal: ac.signal,
    });
    const body = await res.text();
    if (!res.ok) {
      const errTag = (() => {
        try { const j = JSON.parse(body) as { error?: string }; return j.error ?? ""; } catch { return ""; }
      })();
      return { ok: false, detail: `HTTP ${res.status}${errTag ? ` (${errTag})` : ""}` };
    }
    return { ok: true, detail: `HTTP ${res.status} · key accepted` };
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

  const privateSource = env.PRIVATE_SIGNAL_SOURCE?.trim() || (hasValue(env, "DATABASE_URL") ? "postgres" : "direct");
  const privateDirectSet = hasValue(env, "PRIVATE_SIGNAL_API_URL") && hasValue(env, "PRIVATE_SIGNAL_API_KEY");
  const privatePostgresSet = hasValue(env, "DATABASE_URL");
  const privateSet = privateSource === "postgres" ? privatePostgresSet : privateDirectSet;
  checks.push({
    id: "env:private",
    label: "Private Feed",
    status: privateSet ? "ok" : "warn",
    detail: privateSet ? `${privateSource} configured` : "not configured (Private Feed source disabled)",
    fix: privateSet ? undefined : "Set PRIVATE_SIGNAL_SOURCE=postgres with DATABASE_URL, or set PRIVATE_SIGNAL_API_URL + PRIVATE_SIGNAL_API_KEY.",
  });

  const telegramSet = hasValue(env, "TELEGRAM_BOT_TOKEN") && hasValue(env, "TELEGRAM_CHAT_ID");
  checks.push({
    id: "env:telegram",
    label: "Telegram bot settings",
    status: telegramSet ? "ok" : "warn",
    detail: telegramSet ? "set" : "missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID",
    fix: telegramSet ? undefined : "Run npm run setup after creating a bot with @BotFather.",
  });

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

  // Runtime sanity — what sourceMode is persisted, and does it have creds?
  const sourceModeCheck = checkSourceMode(env);
  if (sourceModeCheck) checks.push(sourceModeCheck);

  if (network) {
    if (hasValue(env, "GMGN_API_KEY")) {
      const gmgn = await probeGmgn(env.GMGN_API_KEY!.trim(), env.GMGN_HOST?.trim());
      checks.push({
        id: "network:gmgn",
        label: "GMGN OpenAPI",
        status: gmgn.ok ? "ok" : "warn",
        detail: gmgn.detail,
        fix: gmgn.ok ? undefined : "Verify GMGN_API_KEY is valid and not rate-limit-banned. Check openapi.gmgn.ai reachability.",
      });
    }

    if ((env.PRIVATE_SIGNAL_SOURCE?.trim() || "direct") !== "postgres" && hasValue(env, "PRIVATE_SIGNAL_API_URL") && hasValue(env, "PRIVATE_SIGNAL_API_KEY")) {
      const privateFeed = await fetchOk(env.PRIVATE_SIGNAL_API_URL!.trim(), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${env.PRIVATE_SIGNAL_API_KEY!.trim()}`,
        },
      });
      checks.push({
        id: "network:private",
        label: "Private Feed API",
        status: privateFeed.ok ? "ok" : "warn",
        detail: privateFeed.detail,
        fix: privateFeed.ok ? undefined : "Verify PRIVATE_SIGNAL_API_URL and PRIVATE_SIGNAL_API_KEY are valid.",
      });
    }

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
