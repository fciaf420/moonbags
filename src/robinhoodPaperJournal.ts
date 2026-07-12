import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const ROBINHOOD_PAPER_EVENTS_FILE = path.resolve("state/robinhood-paper-events.jsonl");

let writeChain: Promise<void> = Promise.resolve();

export function appendRobinhoodPaperEvent(
  event: Record<string, unknown>,
  filePath = ROBINHOOD_PAPER_EVENTS_FILE,
): Promise<void> {
  writeChain = writeChain.then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
  });
  return writeChain;
}
