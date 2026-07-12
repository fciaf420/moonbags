import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import logger from "./logger.js";
import { forceClosePosition, getPositions, getStats, getClosedTrades, getSignalStats, usesSolanaPositionMonitoring, type SignalStats } from "./positionManager.js";
import { getRecentAlertEvents } from "./privateSignalPoller.js";
import { getTokenInfos } from "./jupTokensClient.js";
import { getKline } from "./okxClient.js";
import { getRuntimeSettings } from "./settingsStore.js";
import { getDexscreenerRobinhoodStatus } from "./dexscreenerRobinhoodSource.js";

// One-time fetch of the Telegram bot username so the dashboard can deep-link
// to it. Cached for the process lifetime.
let cachedBotUsername: string | null = null;
let botUsernameFetched = false;
async function getBotUsername(): Promise<string | null> {
  if (botUsernameFetched) return cachedBotUsername;
  botUsernameFetched = true;
  if (!CONFIG.TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/getMe`);
    if (!res.ok) return null;
    const json = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    cachedBotUsername = json.result?.username ?? null;
  } catch (err) {
    logger.debug({ err: String(err) }, "[server] getBotUsername failed");
  }
  return cachedBotUsername;
}
import type { Position } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const PLACEHOLDER_HTML = "<h1>memeautobuy dashboard</h1><p>frontend not yet built</p>";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serializePosition(p: Position): Record<string, unknown> {
  // BigInt cannot be JSON-serialized natively; render token counters as strings.
  return {
    ...p,
    tokensHeld: p.tokensHeld.toString(),
    originalTokensHeld: p.originalTokensHeld?.toString(),
  };
}

async function buildState(): Promise<Record<string, unknown>> {
  const stats = getStats();
  const closedTrades = await getClosedTrades(50);
  const positions = getPositions();
  const alerts = getRecentAlertEvents().slice().reverse();
  const botUsername = await getBotUsername();
  const runtimeSettings = getRuntimeSettings();

  // Enrich every open position + every recently-FIRED alert with Jupiter
  // Tokens API metadata (verification, organic score, audit, holder count, mcap, etc).
  // Cached at the client so repeated dashboard polls only hit Jupiter at most once
  // per minute per mint.
  const enrichMints = Array.from(new Set([
    ...positions.filter((p) => usesSolanaPositionMonitoring(p.chain)).map((p) => p.mint),
    ...alerts.filter((a) => a.action === "fired" && !/^0x[0-9a-f]{40}$/i.test(a.mint)).slice(0, 20).map((a) => a.mint),
  ]));
  const tokenInfos = enrichMints.length > 0
    ? await getTokenInfos(enrichMints).catch(() => new Map())
    : new Map();

  const tokenInfoObj: Record<string, unknown> = {};
  for (const [mint, info] of tokenInfos) tokenInfoObj[mint] = info;

  // Per-position 1m kline closes — powers the real mini price chart in the UI.
  // okxClient caches each mint's kline for ~5s so repeated dashboard polls share the
  // same underlying CLI call as the LLM advisor when it's running.
  const openMints = positions
    .filter((p) => p.status === "open" && usesSolanaPositionMonitoring(p.chain))
    .map((p) => p.mint);
  const klineByMint: Record<string, number[]> = {};
  if (openMints.length > 0) {
    const results = await Promise.all(
      openMints.map((m) => getKline(m, "1m", 60).catch(() => [])),
    );
    for (let i = 0; i < openMints.length; i++) {
      const candles = results[i] ?? [];
      if (candles.length > 0) klineByMint[openMints[i]!] = candles.map((c) => c.close);
    }
  }

  return {
    config: {
      BUY_SIZE_SOL: CONFIG.BUY_SIZE_SOL,
      ARM_PCT: CONFIG.ARM_PCT,
      TRAIL_PCT: CONFIG.TRAIL_PCT,
      STOP_PCT: CONFIG.STOP_PCT,
      MAX_HOLD_SECS: CONFIG.MAX_HOLD_SECS,
      MAX_CONCURRENT_POSITIONS: CONFIG.MAX_CONCURRENT_POSITIONS,
      SLIPPAGE_BPS: CONFIG.SLIPPAGE_BPS,
      PRIVATE_SIGNAL_POLL_MS: CONFIG.PRIVATE_SIGNAL_POLL_MS,
      PRICE_POLL_MS: CONFIG.PRICE_POLL_MS,
      DRY_RUN: CONFIG.DRY_RUN,
      LLM_EXIT_ENABLED: CONFIG.LLM_EXIT_ENABLED,
    },
    exitSettings: runtimeSettings.exit,
    stats: { ...stats, now: Date.now() },
    positions: positions.map(serializePosition),
    alerts,
    closedTrades,
    tokenInfo: tokenInfoObj,
    kline1m: klineByMint,
    telegramBotUsername: botUsername,
    sources: { dexscreenerRobinhood: getDexscreenerRobinhoodStatus() },
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, relPath: string): Promise<void> {
  const safeRel = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.resolve(PUBLIC_DIR, safeRel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

async function serveIndex(res: http.ServerResponse): Promise<void> {
  try {
    const data = await readFile(path.join(PUBLIC_DIR, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": data.length });
    res.end(data);
  } catch {
    const body = PLACEHOLDER_HTML;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }
}

function fmt$(n: number): string {
  if (n === 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function serveStatsHtml(res: http.ServerResponse, stats: SignalStats): void {
  const filter = stats.activeFilter;
  const filterStr = (filter.mcapMin > 0 || filter.mcapMax > 0)
    ? `${filter.mcapMin > 0 ? fmt$(filter.mcapMin) : "$0"} – ${filter.mcapMax > 0 ? fmt$(filter.mcapMax) : "∞"}`
    : "none";

  const tierRows = stats.byMcapTier.map((t) => `
    <tr>
      <td>${t.label}</td>
      <td>${t.count}</td>
      <td>${(t.winRate * 100).toFixed(0)}%</td>
      <td style="color:${t.avgPnlPct >= 0 ? "#22c55e" : "#ef4444"}">${t.avgPnlPct >= 0 ? "+" : ""}${t.avgPnlPct.toFixed(1)}%</td>
      <td style="color:${t.medianPnlPct >= 0 ? "#22c55e" : "#ef4444"}">${t.medianPnlPct >= 0 ? "+" : ""}${t.medianPnlPct.toFixed(1)}%</td>
      ${stats.bestMcapTier?.label === t.label ? "<td>★ best</td>" : "<td></td>"}
    </tr>`).join("");

  const corrRows = Object.entries(stats.correlations).map(([k, v]) => `
    <tr><td>${k}</td><td style="color:${v >= 0 ? "#22c55e" : "#ef4444"}">${v >= 0 ? "+" : ""}${v.toFixed(3)}</td></tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="refresh" content="30"/>
<title>Signal Stats — memeautobuy</title>
<style>
  body{background:#0f172a;color:#e2e8f0;font-family:monospace;padding:1.5rem;max-width:900px;margin:0 auto}
  h1{color:#f8fafc;font-size:1.4rem}
  h2{color:#94a3b8;font-size:1rem;margin-top:1.5rem}
  table{border-collapse:collapse;width:100%;margin-top:.5rem}
  th,td{padding:.35rem .7rem;text-align:left;border-bottom:1px solid #1e293b}
  th{color:#64748b;font-size:.8rem;text-transform:uppercase}
  .kv{display:flex;gap:2rem;flex-wrap:wrap;margin-top:.5rem}
  .kv span{color:#64748b;font-size:.85rem}
  .kv b{color:#f1f5f9}
  .badge{background:#1e293b;border-radius:4px;padding:.15rem .5rem;font-size:.8rem}
  footer{color:#334155;margin-top:2rem;font-size:.75rem}
</style>
</head>
<body>
<h1>Signal Stats</h1>
<p><span class="badge">${stats.totalTrades} trades with metadata</span>
   &nbsp;<span class="badge">filter: ${filterStr}</span></p>

<h2>MCap at Entry</h2>
<div class="kv">
  <div><span>Median</span><br/><b>${fmt$(stats.mcap.median)}</b></div>
  <div><span>Mean</span><br/><b>${fmt$(stats.mcap.mean)}</b></div>
  <div><span>Stdev</span><br/><b>${fmt$(stats.mcap.stdev)}</b></div>
  <div><span>Min</span><br/><b>${fmt$(stats.mcap.min)}</b></div>
  <div><span>Max</span><br/><b>${fmt$(stats.mcap.max)}</b></div>
</div>

<h2>Win Rate by MCap Tier</h2>
<table>
  <thead><tr><th>Tier</th><th>Trades</th><th>Win %</th><th>Avg PnL</th><th>Median PnL</th><th></th></tr></thead>
  <tbody>${tierRows}</tbody>
</table>

<h2>Pearson Correlation with PnL%</h2>
<table>
  <thead><tr><th>Field</th><th>r</th></tr></thead>
  <tbody>${corrRows}</tbody>
</table>

<footer>Auto-refreshes every 30s · Use /stats in Telegram to adopt the best range</footer>
</body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
}

export function startServer(): () => void {
  const port = CONFIG.DASHBOARD_PORT;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const pathname = url.split("?")[0] ?? "/";
    const manualSellMatch = pathname.match(/^\/api\/positions\/([^/]+)\/sell$/);

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (method === "POST" && manualSellMatch) {
      const mint = decodeURIComponent(manualSellMatch[1] ?? "");
      const existing = getPositions().find((position) => position.mint === mint);
      if (!existing) {
        sendJson(res, 404, { ok: false, reason: "not found" });
        return;
      }
      forceClosePosition(mint)
        .then((result) => {
          if (!result.ok) {
            sendJson(res, 409, result);
            return;
          }
          sendJson(res, 202, result);
        })
        .catch((err) => {
          logger.error({ err: String(err), mint }, "[server] manual sell failed");
          sendJson(res, 500, { ok: false, reason: "internal" });
        });
      return;
    }

    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (pathname === "/api/state") {
      buildState()
        .then((state) => sendJson(res, 200, state))
        .catch((err) => {
          logger.error({ err: String(err) }, "[server] /api/state failed");
          sendJson(res, 500, { error: "internal" });
        });
      return;
    }

    if (pathname === "/api/stats") {
      getSignalStats()
        .then((stats) => sendJson(res, 200, stats))
        .catch((err) => {
          logger.error({ err: String(err) }, "[server] /api/stats failed");
          sendJson(res, 500, { error: "internal" });
        });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    if (pathname === "/stats") {
      getSignalStats()
        .then((stats) => serveStatsHtml(res, stats))
        .catch((err) => {
          logger.error({ err: String(err) }, "[server] /stats failed");
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("internal error");
        });
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      void serveIndex(res);
      return;
    }

    if (pathname.startsWith("/static/")) {
      const rel = pathname.slice("/static/".length);
      void serveStatic(req, res, rel);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  server.listen(port, () => {
    logger.info({ port }, "[server] dashboard listening");
  });

  return () => {
    server.close();
    logger.info("[server] stopped");
  };
}
