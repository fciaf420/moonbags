import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import logger from "./logger.js";
import { getPositions, getStats, getClosedTrades } from "./positionManager.js";
import { getRecentAlertEvents } from "./scgPoller.js";
import { getTokenInfos } from "./jupTokensClient.js";
import { getKline } from "./okxClient.js";

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

  // Enrich every open position + every recently-FIRED alert with Jupiter
  // Tokens API metadata (verification, organic score, audit, holder count, mcap, etc).
  // Cached at the client so repeated dashboard polls only hit Jupiter at most once
  // per minute per mint.
  const enrichMints = Array.from(new Set([
    ...positions.map((p) => p.mint),
    ...alerts.filter((a) => a.action === "fired").slice(0, 20).map((a) => a.mint),
  ]));
  const tokenInfos = enrichMints.length > 0
    ? await getTokenInfos(enrichMints).catch(() => new Map())
    : new Map();

  const tokenInfoObj: Record<string, unknown> = {};
  for (const [mint, info] of tokenInfos) tokenInfoObj[mint] = info;

  // Per-position 1m kline closes — powers the real mini price chart in the UI.
  // okxClient caches each mint's kline for ~5s so repeated dashboard polls share the
  // same underlying CLI call as the LLM advisor when it's running.
  const openMints = positions.filter((p) => p.status === "open").map((p) => p.mint);
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
      SCG_POLL_MS: CONFIG.SCG_POLL_MS,
      PRICE_POLL_MS: CONFIG.PRICE_POLL_MS,
      DRY_RUN: CONFIG.DRY_RUN,
      LLM_EXIT_ENABLED: CONFIG.LLM_EXIT_ENABLED,
    },
    stats: { ...stats, now: Date.now() },
    positions: positions.map(serializePosition),
    alerts,
    closedTrades,
    tokenInfo: tokenInfoObj,
    kline1m: klineByMint,
    telegramBotUsername: botUsername,
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

export function startServer(): () => void {
  const port = CONFIG.DASHBOARD_PORT;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (method !== "GET") {
      res.writeHead(405);
      res.end("method not allowed");
      return;
    }

    const pathname = url.split("?")[0] ?? "/";

    if (pathname === "/api/state") {
      buildState()
        .then((state) => sendJson(res, 200, state))
        .catch((err) => {
          logger.error({ err: String(err) }, "[server] /api/state failed");
          sendJson(res, 500, { error: "internal" });
        });
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
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
