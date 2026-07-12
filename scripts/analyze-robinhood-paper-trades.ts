import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type RobinhoodPaperEvent =
  | {
      type: "accepted";
      at: number;
      tokenAddress: string;
      pairAgeMins: number;
      liquidityUsd: number;
      holders: number;
      adjustedTop10Pct: number;
      buySellRatio: number;
      transactionAcceleration: number;
      score: number;
    }
  | {
      type: "closed";
      at: number;
      tokenAddress: string;
      pnlPct: number;
      maxFavorableExcursionPct: number;
      maxAdverseExcursionPct: number;
      liquidityChangePct: number;
      holderChangePct: number;
    };

export interface RobinhoodPaperAnalysis {
  completedTrades: number;
  minimumSample: number;
  liveEligible: boolean;
  liveEligibilityReason: string;
  winRate: number;
  averagePnlPct: number;
  averageMaxFavorableExcursionPct: number;
  averageMaxAdverseExcursionPct: number;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function analyzeRobinhoodPaperTrades(
  events: RobinhoodPaperEvent[],
  minimumSample = 30,
): RobinhoodPaperAnalysis {
  const closed = events.filter((event): event is Extract<RobinhoodPaperEvent, { type: "closed" }> => event.type === "closed");
  const completedTrades = closed.length;
  const liveEligible = completedTrades >= minimumSample;

  return {
    completedTrades,
    minimumSample,
    liveEligible,
    liveEligibilityReason: liveEligible
      ? `minimum sample met (${completedTrades}/${minimumSample})`
      : `minimum sample not met (${completedTrades}/${minimumSample})`,
    winRate: completedTrades === 0 ? 0 : closed.filter((event) => event.pnlPct > 0).length / completedTrades,
    averagePnlPct: mean(closed.map((event) => event.pnlPct)),
    averageMaxFavorableExcursionPct: mean(closed.map((event) => event.maxFavorableExcursionPct)),
    averageMaxAdverseExcursionPct: mean(closed.map((event) => event.maxAdverseExcursionPct)),
  };
}

async function main(): Promise<void> {
  const inputPath = process.argv[2] ?? "state/robinhood-paper-events.jsonl";
  const minimumSample = Number(process.argv[3] ?? "30");
  const raw = await readFile(inputPath, "utf8");
  const events = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RobinhoodPaperEvent);
  process.stdout.write(`${JSON.stringify(analyzeRobinhoodPaperTrades(events, minimumSample), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
