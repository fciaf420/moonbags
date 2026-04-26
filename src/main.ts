// Force IPv4 DNS resolution — GMGN OpenAPI blocks IPv6 connections.
// Must run before any network calls so it has to be the first thing in main.ts.
import dns from "dns";
dns.setDefaultResultOrder("ipv4first");

// [SCG-DISABLED 2026-04-22] SCG polling retired — keeping OKX + GMGN only.
// Preserving import so scgPoller state (dedupe set, blacklist, etc.) still loads
// for historical telegram views; `startScgPoller` stays imported but unused below.
import { startScgPoller, loadPollerState } from "./scgPoller.js";
import { openPosition, tickPositions, tickLlmAdvisor, tickLlmHeartbeat, getPositions, loadPersistedPositions } from "./positionManager.js";
import { startServer } from "./server.js";
import { startTelegramBot } from "./telegramBot.js";
import { notifyBoot } from "./notifier.js";
import { unwrapResidualWsol } from "./jupClient.js";
import { startOkxWsService, stopOkxWsService, watchOkxWsMint } from "./okxWsService.js";
// [OKX-KOL-RETIRED 2026-04-22] The KOL signal source (src/okxSignalSource.ts)
// is kept on disk but no longer started. It is replaced by the SCG-alpha-style
// discovery source wired in below. Re-enable by restoring the start call.
import { stopOkxSignalSource } from "./okxSignalSource.js";
import { startOkxDiscoverySource, stopOkxDiscoverySource } from "./okxDiscoverySource.js";
import { startGmgnSignalSource, stopGmgnSignalSource } from "./gmgnSignalSource.js";
import { CONFIG } from "./config.js";
import { consultEntry } from "./llmEntryAdvisor.js";
import logger from "./logger.js";

async function main(): Promise<void> {
  logger.info(
    { dryRun: CONFIG.DRY_RUN, buySol: CONFIG.BUY_SIZE_SOL, maxConcurrent: CONFIG.MAX_CONCURRENT_POSITIONS },
    "memeautobuy starting",
  );

  await loadPersistedPositions();
  await loadPollerState();
  await unwrapResidualWsol().catch((err) => logger.warn({ err: String(err) }, "[wsol] boot-time unwrap failed"));

  let tickInFlight = false;
  let tickQueued = false;
  let lastTickCompletedAt: number = Date.now();
  const requestPositionTick = (source: string): void => {
    if (tickInFlight) {
      tickQueued = true;
      return;
    }
    tickInFlight = true;
    void (async () => {
      try {
        do {
          tickQueued = false;
          await tickPositions();
          lastTickCompletedAt = Date.now();
        } while (tickQueued);
      } catch (e) {
        logger.error({ err: String(e), source }, "tickPositions crashed");
      } finally {
        tickInFlight = false;
      }
    })();
  };

  startOkxWsService({
    onMintEvent: (mint) => {
      logger.debug({ mint }, "[okx-wss] event woke position tick");
      requestPositionTick("okx-wss");
    },
  });
  for (const position of getPositions().filter((p) => p.status === "open")) {
    void watchOkxWsMint(position.mint);
  }
  startOkxDiscoverySource({
    onAcceptedCandidate: async (alert) => {
      try {
        if (CONFIG.LLM_ENTRY_ENABLED) {
          const decision = await consultEntry(alert);
          if (decision.action === "skip") {
            logger.info({ mint: alert.mint, name: alert.name, reason: decision.reason }, "[llm-entry] skipped OKX signal");
            return;
          }
        }
        await openPosition(alert);
      } catch (e) {
        logger.error({ err: String(e), mint: alert.mint }, "openPosition crashed for OKX discovery signal");
      }
    },
  });
  startGmgnSignalSource({
    onAcceptedCandidate: async (alert) => {
      try {
        if (CONFIG.LLM_ENTRY_ENABLED) {
          const decision = await consultEntry(alert);
          if (decision.action === "skip") {
            logger.info({ mint: alert.mint, name: alert.name, reason: decision.reason }, "[llm-entry] skipped GMGN signal");
            return;
          }
        }
        await openPosition(alert);
      } catch (e) {
        logger.error({ err: String(e), mint: alert.mint }, "openPosition crashed for GMGN signal");
      }
    },
  });

  const stopServer = startServer();
  logger.info({ url: `http://localhost:${CONFIG.DASHBOARD_PORT}/` }, "dashboard available");

  const stopTelegram = startTelegramBot();
  void notifyBoot();

  // [SCG-DISABLED 2026-04-22] SCG poller no longer starts. OKX + GMGN sources above
  // are the only live signal producers. Re-enable by uncommenting this block.
  // const stopPoller = startScgPoller(async (alert) => {
  //   try {
  //     await openPosition(alert);
  //   } catch (e) {
  //     logger.error({ err: String(e), mint: alert.mint }, "openPosition crashed");
  //   }
  // });
  const stopPoller = (): void => { /* [SCG-DISABLED 2026-04-22] no-op shim */ };

  const tickInterval = setInterval(() => {
    requestPositionTick("interval");
  }, CONFIG.PRICE_POLL_MS);

  // Watchdog: if tickInFlight has been stuck for >90s the async task likely hung.
  // Force-reset the flags and re-trigger a tick so position monitoring recovers.
  const WATCHDOG_HANG_MS = 90_000;
  const watchdogInterval = setInterval(() => {
    if (tickInFlight && Date.now() - lastTickCompletedAt > WATCHDOG_HANG_MS) {
      logger.warn(
        { staleSinceMs: Date.now() - lastTickCompletedAt },
        "[watchdog] tickPositions appears hung — force-resetting tickInFlight and re-triggering",
      );
      tickInFlight = false;
      tickQueued = false;
      requestPositionTick("watchdog");
    }
  }, 60_000);

  // LLM exit advisor — interval always runs; the gate is inside tickLlmAdvisor()
  // so /llm can toggle at runtime without a restart.
  if (CONFIG.LLM_EXIT_ENABLED) {
    if (!CONFIG.LLM_API_KEY) {
      logger.warn("[llm] LLM_EXIT_ENABLED=true but LLM_API_KEY is empty — advisor will skip every position");
    } else {
      logger.info("[llm] exit advisor active (polling every 30s for armed positions)");
    }
  }
  const llmInterval: NodeJS.Timeout = setInterval(() => {
    tickLlmAdvisor().catch((e) => logger.error({ err: String(e) }, "tickLlmAdvisor crashed"));
    tickLlmHeartbeat().catch((e) => logger.error({ err: String(e) }, "tickLlmHeartbeat crashed"));
  }, CONFIG.LLM_POLL_MS);

  let shuttingDown = false;
  const shutdown = (sig: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { sig, openPositions: getPositions().filter((p) => p.status === "open").length },
      "shutting down",
    );
    stopPoller();
    stopServer();
    stopTelegram();
    clearInterval(tickInterval);
    clearInterval(watchdogInterval);
    clearInterval(llmInterval);
    void Promise.allSettled([
        stopOkxWsService(),
        stopOkxSignalSource(),
        stopOkxDiscoverySource(),
        stopGmgnSignalSource(),
      ])
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") logger.warn({ err: String(result.reason) }, "[shutdown] source stop failed");
        }
      })
      .finally(() => setTimeout(() => process.exit(0), 500));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.error({ err: String(e) }, "fatal");
  process.exit(1);
});
