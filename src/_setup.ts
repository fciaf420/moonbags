/**
 * MoonBags — interactive first-time setup wizard.
 *
 * Usage:   npm run setup
 *
 * Walks through every required credential (Jupiter, Helius, wallet, Telegram)
 * with links to where to get each, validates as it goes, auto-detects the
 * Telegram chat_id, and writes the resulting .env file.
 *
 * Uses only Node's stdlib — no prompt libraries — to keep the bootstrap
 * friction to zero.
 */

import { readFile, writeFile, copyFile, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import path from "node:path";
import readline from "node:readline";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Terminal styling (ANSI escape codes, no deps)
// ---------------------------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[38;5;113m",      // pepe green
  blue: "\x1b[38;5;75m",        // earth blue
  coral: "\x1b[38;5;209m",      // pepe lip coral
  yellow: "\x1b[38;5;221m",
  gray: "\x1b[38;5;244m",
  white: "\x1b[38;5;255m",
};

const P = (s: string, c: string) => `${c}${s}${C.reset}`;
const bold = (s: string) => P(s, C.bold);
const dim = (s: string) => P(s, C.dim);
const green = (s: string) => P(s, C.green);
const blue = (s: string) => P(s, C.blue);
const coral = (s: string) => P(s, C.coral);
const gray = (s: string) => P(s, C.gray);
const yellow = (s: string) => P(s, C.yellow);

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

async function askWithDefault(q: string, def: string): Promise<string> {
  const a = await ask(`${q} ${dim(`[${def}]`)} `);
  return a || def;
}

async function askYesNo(q: string, defYes = true): Promise<boolean> {
  const hint = defYes ? "[Y/n]" : "[y/N]";
  const a = (await ask(`${q} ${dim(hint)} `)).toLowerCase();
  if (a === "") return defYes;
  return a.startsWith("y");
}

function section(title: string, num?: number): void {
  const prefix = num !== undefined ? `${green(`[${num}]`)} ` : "";
  console.log("");
  console.log(green("━".repeat(72)));
  console.log(` ${prefix}${bold(title)}`);
  console.log(green("━".repeat(72)));
}

function banner(): void {
  console.clear();
  console.log("");
  console.log(green("   🌙  MoonBags — first-time setup wizard"));
  console.log(gray("   Solana meme-token auto-trading bot"));
  console.log(gray("   " + "─".repeat(56)));
  console.log("");
  console.log(gray("   This will walk you through every credential you need"));
  console.log(gray("   and write a .env file when you're done."));
  console.log("");
  console.log(dim("   Press Ctrl+C at any time to abort. No .env is written"));
  console.log(dim("   until the final step."));
  console.log("");
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Validators & test calls
// ---------------------------------------------------------------------------
async function testJupiterKey(key: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.jup.ag/ultra/v1/balances?wallet=So11111111111111111111111111111111111111112", {
      headers: { "x-api-key": key },
    });
    return res.status !== 401 && res.status !== 403;
  } catch { return false; }
}

async function testHeliusKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(`https://beta.helius-rpc.com?api-key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    return res.ok;
  } catch { return false; }
}

type TelegramMe = { ok: boolean; result?: { id: number; username: string; first_name: string } };
async function testTelegramToken(token: string): Promise<TelegramMe["result"] | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (!res.ok) return null;
    const json = (await res.json()) as TelegramMe;
    return json.ok ? (json.result ?? null) : null;
  } catch { return null; }
}

async function detectTelegramChatId(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1&limit=1`);
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; result?: Array<{ message?: { chat: { id: number } } }> };
    if (!json.ok || !json.result?.length) return null;
    const chatId = json.result[0]?.message?.chat.id;
    return chatId ? String(chatId) : null;
  } catch { return null; }
}

async function checkOnchainosCli(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("onchainos", ["--version"], { timeout: 5000 });
    return /\d/.test(stdout);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// .env writer (preserves existing entries, updates the ones we manage)
// ---------------------------------------------------------------------------
async function writeEnvFile(values: Record<string, string>, existing: string): Promise<void> {
  let content = existing;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    if (re.test(content)) {
      content = content.replace(re, line);
    } else {
      content = (content.endsWith("\n") || content === "" ? content : content + "\n") + line + "\n";
    }
  }
  await writeFile(".env", content);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  banner();
  await ask(dim("   Press Enter to begin... "));

  // 0. Check for existing .env and back up
  section("Checking for existing .env", 0);
  const envExists = await fileExists(".env");
  let existingEnv = "";
  if (envExists) {
    existingEnv = await readFile(".env", "utf8");
    const backupPath = `.env.backup.${Date.now()}`;
    await copyFile(".env", backupPath);
    console.log(`${green("✓")} Found existing .env. Backed up to ${yellow(backupPath)}`);
    console.log(gray("   Existing values will be preserved unless you overwrite them."));
  } else {
    console.log(`${gray("·")} No existing .env — starting fresh.`);
  }

  const collected: Record<string, string> = {};

  // 1. onchainos CLI check (bail early if missing — trading won't work without it)
  section("Checking onchainos CLI", 1);
  const hasCli = await checkOnchainosCli();
  if (hasCli) {
    console.log(`${green("✓")} onchainos CLI is installed.`);
  } else {
    console.log(`${coral("✗")} onchainos CLI not found on PATH.`);
    console.log(gray("   It's required for price feeds + LLM advisor on-chain data."));
    console.log(`   Install with:  ${yellow("npm install -g onchainos")}`);
    const cont = await askYesNo("   Continue anyway?", false);
    if (!cont) { rl.close(); process.exit(1); }
  }

  // 2. OKX OnchainOS API credentials
  section("OKX OnchainOS API credentials", 2);
  console.log(gray("   OnchainOS powers token trades, smart-money flow, holder data,"));
  console.log(gray("   risk data, and klines for the LLM advisor."));
  console.log(`   Get keys at:  ${blue("https://web3.okx.com/onchain-os/dev-portal")}`);
  console.log(gray("   Create a read-only API key and keep the passphrase you set."));
  console.log("");
  const okxKeyFromEnv = existingEnv.match(/^OKX_API_KEY=(.*)$/m)?.[1];
  const okxSecretFromEnv = existingEnv.match(/^OKX_SECRET_KEY=(.*)$/m)?.[1];
  const okxPassphraseFromEnv =
    existingEnv.match(/^OKX_PASSPHRASE=(.*)$/m)?.[1] ??
    existingEnv.match(/^OKX_API_PASSPHRASE=(.*)$/m)?.[1];
  if (okxKeyFromEnv) console.log(`   ${dim(`current OKX_API_KEY: ${okxKeyFromEnv.slice(0, 10)}...`)}`);
  if (okxSecretFromEnv) console.log(`   ${dim("current OKX_SECRET_KEY: set")}`);
  if (okxPassphraseFromEnv) console.log(`   ${dim("current OKX_PASSPHRASE: set")}`);
  const okxKey = await ask(`   ${bold("OKX_API_KEY")} ${dim("(blank to keep/skip)")}: `);
  const okxSecret = await ask(`   ${bold("OKX_SECRET_KEY")} ${dim("(blank to keep/skip)")}: `);
  const okxPassphrase = await ask(`   ${bold("OKX_PASSPHRASE")} ${dim("(blank to keep/skip)")}: `);
  if (okxKey) collected.OKX_API_KEY = okxKey;
  else if (!okxKeyFromEnv) collected.OKX_API_KEY = "";
  if (okxSecret) collected.OKX_SECRET_KEY = okxSecret;
  else if (!okxSecretFromEnv) collected.OKX_SECRET_KEY = "";
  if (okxPassphrase) collected.OKX_PASSPHRASE = okxPassphrase;
  else if (!okxPassphraseFromEnv) collected.OKX_PASSPHRASE = "";

  // 3. Jupiter API key
  section("Jupiter API key", 3);
  console.log(gray("   Jupiter Ultra provides swap routing (buy/sell execution)."));
  console.log(`   Get one at:  ${blue("https://developers.jup.ag/portal")}`);
  console.log("");
  const jupFromEnv = existingEnv.match(/^JUP_API_KEY=(.*)$/m)?.[1];
  if (jupFromEnv) console.log(`   ${dim(`current: ${jupFromEnv.slice(0, 12)}...`)}`);
  const jupKey = await ask(`   ${bold("JUP_API_KEY")}: `);
  if (jupKey) {
    process.stdout.write(`   ${dim("Testing...")}  `);
    const ok = await testJupiterKey(jupKey);
    console.log(ok ? green("✓ valid") : coral("✗ rejected or unreachable"));
    if (!ok) {
      const keep = await askYesNo("   Keep this value anyway?", false);
      if (!keep) { rl.close(); return; }
    }
    collected.JUP_API_KEY = jupKey;
  } else if (jupFromEnv) {
    console.log(`   ${gray("·")} keeping existing value`);
  }

  // 4. Helius RPC
  section("Helius RPC key", 4);
  console.log(gray("   Private Solana RPC. Free tier works. Public RPC is rate-limited."));
  console.log(`   Sign up at:  ${blue("https://dashboard.helius.dev")}`);
  console.log("");
  const heliusFromEnv = existingEnv.match(/^HELIUS_API_KEY=(.*)$/m)?.[1];
  if (heliusFromEnv) console.log(`   ${dim(`current: ${heliusFromEnv.slice(0, 12)}...`)}`);
  const heliusKey = await ask(`   ${bold("HELIUS_API_KEY")}: `);
  if (heliusKey) {
    process.stdout.write(`   ${dim("Testing...")}  `);
    const ok = await testHeliusKey(heliusKey);
    console.log(ok ? green("✓ valid") : coral("✗ rejected or unreachable"));
    if (!ok) {
      const keep = await askYesNo("   Keep this value anyway?", false);
      if (!keep) { rl.close(); return; }
    }
    collected.HELIUS_API_KEY = heliusKey;
  } else if (heliusFromEnv) {
    console.log(`   ${gray("·")} keeping existing value`);
  }

  // 5. Solana wallet
  section("Solana wallet", 5);
  console.log(gray("   The bot signs swap transactions with this wallet."));
  console.log(coral("   ⚠  Use a DEDICATED wallet — not one that holds anything important."));
  console.log("");
  const hasExistingKey = Boolean(existingEnv.match(/^PRIV_B58=(.+)$/m));
  if (hasExistingKey) {
    console.log(`   ${green("✓")} Existing PRIV_B58 found in .env.`);
    const reuse = await askYesNo("   Reuse existing wallet?", true);
    if (!reuse) {
      await promptWalletSetup(collected);
    }
  } else {
    await promptWalletSetup(collected);
  }

  // 6. Telegram bot
  section("Telegram bot (required for control + alerts)", 6);
  console.log(gray("   You'll control the bot via Telegram: /start, /positions, /settings, etc."));
  console.log("");
  console.log(bold("   Step 6a — create the bot:"));
  console.log(`     1. Open Telegram, message ${blue("@BotFather")}`);
  console.log(`     2. Send  ${yellow("/newbot")}  and follow the prompts`);
  console.log(`     3. Copy the bot token (looks like ${gray("8775xxxx:AAG...")})`);
  console.log("");
  const tgFromEnv = existingEnv.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1];
  if (tgFromEnv) console.log(`   ${dim(`current token: ${tgFromEnv.slice(0, 16)}...`)}`);
  const tgToken = await ask(`   ${bold("TELEGRAM_BOT_TOKEN")}: `);

  let tgTokenToUse = tgToken || tgFromEnv;
  if (tgToken) {
    process.stdout.write(`   ${dim("Verifying...")}  `);
    const me = await testTelegramToken(tgToken);
    if (me) {
      console.log(green(`✓ connected as @${me.username}`));
      collected.TELEGRAM_BOT_TOKEN = tgToken;
    } else {
      console.log(coral("✗ rejected"));
      const keep = await askYesNo("   Keep this value anyway?", false);
      if (!keep) { rl.close(); return; }
      collected.TELEGRAM_BOT_TOKEN = tgToken;
    }
  }

  // Chat ID auto-detection
  if (tgTokenToUse) {
    console.log("");
    console.log(bold("   Step 6b — grant yourself access:"));
    const me = await testTelegramToken(tgTokenToUse);
    const botName = me?.username ? `@${me.username}` : "your bot";
    console.log(`     1. Open Telegram and message ${blue(botName)} (any text, e.g. ${yellow('"hello"')}).`);
    console.log(`     2. Press Enter here once sent — I'll auto-detect your chat ID.`);
    await ask(`   ${dim("Press Enter after messaging the bot...")} `);
    process.stdout.write(`   ${dim("Detecting chat ID...")}  `);
    const chatId = await detectTelegramChatId(tgTokenToUse);
    if (chatId) {
      console.log(green(`✓ detected chat ID: ${chatId}`));
      collected.TELEGRAM_CHAT_ID = chatId;
    } else {
      console.log(coral("✗ no message seen"));
      console.log(gray("   Make sure you messaged the bot AFTER creating it, then try again."));
      const manual = await ask(`   Or enter chat ID manually (blank to skip): `);
      if (manual) collected.TELEGRAM_CHAT_ID = manual;
    }
  }

  // 7. MiniMax (optional)
  section("MiniMax API key — LLM exit advisor (optional)", 7);
  console.log(gray("   Off by default. If enabled, MiniMax M2.7 manages exits for"));
  console.log(gray("   armed positions using live on-chain data. You can flip it on"));
  console.log(gray("   later via /llm in Telegram."));
  console.log(`   Referral link (10% off):  ${blue("https://platform.minimax.io/subscribe/token-plan?code=K0Q2oDUiwK&source=link")}`);
  console.log("");
  const mmFromEnv = existingEnv.match(/^MINIMAX_API_KEY=(.*)$/m)?.[1];
  if (mmFromEnv) console.log(`   ${dim(`current: ${mmFromEnv.slice(0, 12)}...`)}`);
  const mmKey = await ask(`   ${bold("MINIMAX_API_KEY")} ${dim("(blank to skip)")}: `);
  if (mmKey) {
    collected.MINIMAX_API_KEY = mmKey;
    const enable = await askYesNo("   Enable LLM advisor now?", false);
    collected.LLM_EXIT_ENABLED = enable ? "true" : "false";
  }

  // 8. Trading params
  section("Trading parameters", 8);
  console.log(gray("   Defaults are backtest-optimized against 100 trending Solana tokens."));
  console.log(gray("   Press Enter to accept each, or type a new value."));
  console.log(gray("   You can change any of these live via /settings in Telegram."));
  console.log("");
  collected.BUY_SIZE_SOL = await askWithDefault(
    `   SOL per trade (${bold("BUY_SIZE_SOL")}):`,
    existingEnv.match(/^BUY_SIZE_SOL=(.+)$/m)?.[1] ?? "0.02",
  );
  collected.MAX_CONCURRENT_POSITIONS = await askWithDefault(
    `   Max open positions (${bold("MAX_CONCURRENT_POSITIONS")}):`,
    existingEnv.match(/^MAX_CONCURRENT_POSITIONS=(.+)$/m)?.[1] ?? "10",
  );
  collected.ARM_PCT = await askWithDefault(
    `   Trail arms at +${yellow("50%")} profit (${bold("ARM_PCT")} decimal):`,
    existingEnv.match(/^ARM_PCT=(.+)$/m)?.[1] ?? "0.5",
  );
  collected.TRAIL_PCT = await askWithDefault(
    `   Trail exit on ${yellow("55%")} drawdown from peak (${bold("TRAIL_PCT")} decimal):`,
    existingEnv.match(/^TRAIL_PCT=(.+)$/m)?.[1] ?? "0.55",
  );
  collected.STOP_PCT = await askWithDefault(
    `   Hard stop at -${yellow("40%")} from entry (${bold("STOP_PCT")} decimal):`,
    existingEnv.match(/^STOP_PCT=(.+)$/m)?.[1] ?? "0.4",
  );
  const dry = await askYesNo(`   Start in ${green("DRY_RUN")} (safe — no real trades)?`, true);
  collected.DRY_RUN = dry ? "true" : "false";

  // Ensure all required defaults exist even if the user skipped
  if (!collected.MINIMAX_API_KEY && !mmFromEnv) collected.MINIMAX_API_KEY = "";
  if (!collected.LLM_EXIT_ENABLED) collected.LLM_EXIT_ENABLED = "false";
  if (!existingEnv.match(/^RPC_URL=/m)) {
    collected.RPC_URL = "https://beta.helius-rpc.com?api-key=${HELIUS_API_KEY}";
  }
  if (!existingEnv.match(/^DASHBOARD_PORT=/m)) {
    collected.DASHBOARD_PORT = "8787";
  }
  if (!existingEnv.match(/^SCG_POLL_MS=/m)) collected.SCG_POLL_MS = "3000";
  if (!existingEnv.match(/^PRICE_POLL_MS=/m)) collected.PRICE_POLL_MS = "3000";
  if (!existingEnv.match(/^SLIPPAGE_BPS=/m)) collected.SLIPPAGE_BPS = "2500";
  if (!existingEnv.match(/^MAX_HOLD_SECS=/m)) collected.MAX_HOLD_SECS = "99999999999999999";

  // 9. Write .env
  section("Writing .env", 9);
  console.log(gray("   Summary of changes:"));
  for (const [k, v] of Object.entries(collected)) {
    const shown = /KEY|TOKEN|PRIV|SECRET|PASSPHRASE/.test(k) && v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
    console.log(`     ${green(k)}=${yellow(shown)}`);
  }
  console.log("");
  const write = await askYesNo("   Write these to .env?", true);
  if (!write) {
    console.log(gray("   Aborted. No changes written."));
    rl.close();
    return;
  }
  await writeEnvFile(collected, existingEnv);
  console.log(`   ${green("✓")} .env written.`);

  // 10. Next steps
  section("Next steps", 10);
  console.log(gray("   Your bot is configured. Recommended next steps:"));
  console.log("");
  console.log(`     ${green("npx tsx src/main.ts")}     ${gray("# start the bot")}`);
  console.log(`     ${blue("http://localhost:8787")}    ${gray("# web dashboard")}`);
  console.log(`     ${yellow("/start")}                     ${gray("# in your Telegram bot")}`);
  console.log("");
  if (collected.DRY_RUN === "true") {
    console.log(coral("   ⚠  DRY_RUN is enabled — bot will NOT submit real trades."));
    console.log(coral("      Set DRY_RUN=false in .env or via /settings once you're confident."));
  } else {
    console.log(coral("   ⚠  LIVE trading is enabled — real swaps will happen."));
    console.log(coral("      Start with a small wallet balance first."));
  }
  console.log("");

  rl.close();
}

async function promptWalletSetup(collected: Record<string, string>): Promise<void> {
  console.log("");
  console.log(`   ${bold("How do you want to provide the wallet?")}`);
  console.log(`     1) ${green("Generate a fresh keypair")} (recommended)`);
  console.log(`     2) ${blue("Paste an existing base58 secret")}`);
  console.log(`     3) ${gray("Skip for now")} (DRY_RUN will still work)`);
  const choice = await ask(`   Choice [1/2/3]: `);

  if (choice === "1" || choice === "") {
    const kp = Keypair.generate();
    const secretB58 = bs58.encode(kp.secretKey);
    collected.PRIV_B58 = secretB58;

    const keypairPath = path.resolve("moonbags-keypair.json");
    await writeFile(keypairPath, JSON.stringify(Array.from(kp.secretKey)));
    console.log("");
    console.log(`   ${green("✓")} New keypair generated.`);
    console.log(`     ${bold("Public address:")}  ${yellow(kp.publicKey.toBase58())}`);
    console.log(`     ${dim(`Backup saved to: ${keypairPath}`)}`);
    console.log("");
    console.log(coral("   ⚠  Fund this address with SOL BEFORE going live."));
    console.log(coral(`      For ${bold("10 trades at 0.02 SOL")} → at least ${bold("0.25 SOL")} for trades + fees.`));
  } else if (choice === "2") {
    console.log("");
    console.log(gray("   Paste the base58-encoded secret key. It's NOT the public address."));
    console.log(gray("   From Phantom: Settings → Manage Accounts → Show Private Key."));
    const key = await ask(`   ${bold("PRIV_B58")}: `);
    if (!key) {
      console.log(coral("   No key provided — skipping."));
      return;
    }
    try {
      const bytes = bs58.decode(key);
      const kp = Keypair.fromSecretKey(bytes);
      console.log(`   ${green("✓")} Valid keypair. Address: ${yellow(kp.publicKey.toBase58())}`);
      collected.PRIV_B58 = key;
    } catch {
      console.log(coral("   ✗ Invalid base58 secret key."));
      const retry = await askYesNo("   Try again?", true);
      if (retry) return promptWalletSetup(collected);
    }
  } else {
    console.log(gray("   Skipped. Bot will run in DRY_RUN only until you set PRIV_B58."));
  }
}

main().catch((e) => {
  console.error("");
  console.error(coral(`Setup failed: ${e instanceof Error ? e.message : String(e)}`));
  rl.close();
  process.exit(1);
});
