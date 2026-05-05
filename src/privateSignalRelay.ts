import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

import { CONFIG } from "./config.js";
import logger from "./logger.js";
import { closePrivateSignalDb, ensurePrivateSignalSchema, insertPrivateSignalAlerts } from "./privateSignalDb.js";

function requireRelayConfig(): void {
  const missing = [
    ["PRIVATE_SIGNAL_API_URL", CONFIG.PRIVATE_SIGNAL_API_URL],
    ["PRIVATE_SIGNAL_API_KEY", CONFIG.PRIVATE_SIGNAL_API_KEY],
    ["DATABASE_URL", CONFIG.DATABASE_URL],
  ].filter(([, value]) => !String(value ?? "").trim()).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing required relay env vars: ${missing.join(", ")}`);
  }
}

async function fetchUpstreamAlerts(): Promise<unknown[]> {
  const res = await fetch(CONFIG.PRIVATE_SIGNAL_API_URL, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${CONFIG.PRIVATE_SIGNAL_API_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Private Feed upstream HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { alerts?: unknown[] };
  return Array.isArray(body.alerts) ? body.alerts : [];
}

async function tick(): Promise<void> {
  const alerts = await fetchUpstreamAlerts();
  const inserted = await insertPrivateSignalAlerts(alerts);
  logger.info({ alerts: alerts.length, inserted }, "[private-feed-relay] poll complete");
}

async function main(): Promise<void> {
  requireRelayConfig();
  await ensurePrivateSignalSchema();
  logger.info({ pollMs: CONFIG.PRIVATE_SIGNAL_POLL_MS }, "[private-feed-relay] started");

  let running = false;
  const runTick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      logger.error({ err: (err as Error).message }, "[private-feed-relay] poll failed");
    } finally {
      running = false;
    }
  };

  await runTick();
  const interval = setInterval(() => void runTick(), CONFIG.PRIVATE_SIGNAL_POLL_MS);

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, "[private-feed-relay] shutting down");
    clearInterval(interval);
    await closePrivateSignalDb().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, "[private-feed-relay] fatal");
  process.exit(1);
});
