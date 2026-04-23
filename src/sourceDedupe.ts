import fs from "fs";
import path from "path";

const STATE_PATH = path.resolve("state/dedupeState.json");
// Prune entries older than 24h on load — no cooldown is that long.
const MAX_AGE_MS = 24 * 60 * 60_000;

type Entry = { at: number; source: string };
const acceptedByMint = new Map<string, Entry>();

function loadFromDisk(): void {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const obj = JSON.parse(raw) as Record<string, Entry>;
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [mint, entry] of Object.entries(obj)) {
      if (entry.at > cutoff) acceptedByMint.set(mint, entry);
    }
  } catch {
    // File missing or corrupt — start fresh.
  }
}

function saveToDisk(): void {
  try {
    const obj: Record<string, Entry> = {};
    for (const [mint, entry] of acceptedByMint) obj[mint] = entry;
    fs.writeFileSync(STATE_PATH, JSON.stringify(obj, null, 2));
  } catch {
    // Non-fatal — worst case cooldown is lost on next restart.
  }
}

loadFromDisk();

export function markSignalMintAccepted(mint: string, source: string, at = Date.now()): void {
  acceptedByMint.set(mint, { at, source });
  saveToDisk();
}

export function checkSignalMintCooldown(
  mint: string,
  cooldownMins: number,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (cooldownMins <= 0) return { ok: true };
  const seen = acceptedByMint.get(mint);
  if (!seen) return { ok: true };
  const ageMs = now - seen.at;
  if (ageMs >= cooldownMins * 60_000) return { ok: true };
  return {
    ok: false,
    reason: `mint cooldown ${Math.ceil((cooldownMins * 60_000 - ageMs) / 60_000)}m remaining from ${seen.source}`,
  };
}
