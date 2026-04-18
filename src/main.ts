import { startScgPoller, loadPollerState } from "./scgPoller.js";
import { openPosition, tickPositions, tickLlmAdvisor, getPositions, loadPersistedPositions } from "./positionManager.js";
import { startServer } from "./server.js";
import { startTelegramBot } from "./telegramBot.js";
import { notifyBoot } from "./notifier.js";
import { unwrapResidualWsol } from "./jupClient.js";
import { CONFIG } from "./config.js";
import logger from "./logger.js";

async function main(): Promise<void> {
  logger.info(
    { dryRun: CONFIG.DRY_RUN, buySol: CONFIG.BUY_SIZE_SOL, maxConcurrent: CONFIG.MAX_CONCURRENT_POSITIONS },
    "memeautobuy starting",
  );

  await loadPersistedPositions();
  await loadPollerState();
  await unwrapResidualWsol().catch((err) => logger.warn({ err: String(err) }, "[wsol] boot-time unwrap failed"));

  const stopServer = startServer();
  logger.info({ url: `http://localhost:${CONFIG.DASHBOARD_PORT}/` }, "dashboard available");

  const stopTelegram = startTelegramBot();
  void notifyBoot();

  const stopPoller = startScgPoller(async (alert) => {
    try {
      await openPosition(alert);
    } catch (e) {
      logger.error({ err: String(e), mint: alert.mint }, "openPosition crashed");
    }
  });

  const tickInterval = setInterval(() => {
    tickPositions().catch((e) => logger.error({ err: String(e) }, "tickPositions crashed"));
  }, CONFIG.PRICE_POLL_MS);

  // LLM exit advisor — interval always runs; the gate is inside tickLlmAdvisor()
  // so /llm can toggle at runtime without a restart.
  if (CONFIG.LLM_EXIT_ENABLED) {
    if (!CONFIG.MINIMAX_API_KEY) {
      logger.warn("[llm] LLM_EXIT_ENABLED=true but MINIMAX_API_KEY is empty — advisor will skip every position");
    } else {
      logger.info("[llm] exit advisor active (polling every 30s for armed positions)");
    }
  }
  const llmInterval: NodeJS.Timeout = setInterval(() => {
    tickLlmAdvisor().catch((e) => logger.error({ err: String(e) }, "tickLlmAdvisor crashed"));
  }, CONFIG.LLM_POLL_MS);

  const shutdown = (sig: string): void => {
    logger.info(
      { sig, openPositions: getPositions().filter((p) => p.status === "open").length },
      "shutting down",
    );
    stopPoller();
    stopServer();
    stopTelegram();
    clearInterval(tickInterval);
    clearInterval(llmInterval);
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.error({ err: String(e) }, "fatal");
  process.exit(1);
});
