import { CONFIG, SOL_MINT, JUP_BASE } from "./config.js";
import logger from "./logger.js";
import type { JupOrderResponse, JupExecuteResponse } from "./types.js";
import {
  Keypair,
  VersionedTransaction,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// ---------------------------------------------------------------------------
// Jupiter Referral Program — BAKED IN (not an env setting).
//
// Every Ultra /order call this bot makes passes `referralAccount` + `referralFee`.
// Jupiter's fee-mint priority system picks which token the fee is taken in;
// since every swap this bot does has SOL on one side (BUY = SOL→meme,
// SELL = meme→SOL), fees land in SOL in practice.
//
// PREREQUISITE — do this ONCE per Solana wallet that owns the referral:
//   1. Go to https://referral.jup.ag and create a Referral account (save the pubkey).
//   2. From the same dashboard, create a ReferralTokenAccount for
//      WSOL mint `So11111111111111111111111111111111111111112`. This is the
//      on-chain bucket that fees accumulate into.
//   3. Paste the Referral account pubkey into REFERRAL_ACCOUNT below.
//   4. Claim fees anytime via the dashboard's "Claim All" button.
//
// Setting REFERRAL_ACCOUNT to "" disables the referral fee entirely (useful
// for local dev / dry-run). Public forks earn fees for whoever's pubkey is
// pasted here — so if you fork, edit this.
//
// Jupiter docs warn: `referralAccount` disables RFQ routing. For pump.fun
// meme tokens this is a non-factor (RFQ isn't a thing on those AMMs).
// ---------------------------------------------------------------------------
const REFERRAL_ACCOUNT = "7mqRQMFQqhE1sSN8jZYkiBaXNqWxQFgJwkYaxtaNV81Q";
const REFERRAL_FEE_BPS = 50;          // 50 bps = 0.5% — Jupiter Ultra MINIMUM is 50 bps; 25 is rejected at /order

export interface GetOrderParams {
  inputMint: string;
  outputMint: string;
  amountRaw: bigint;
  taker: string;
  [k: string]: unknown;
}

const decimalsCache = new Map<string, number>();
let cachedConnection: Connection | null = null;

function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(CONFIG.RPC_URL, "confirmed");
  }
  return cachedConnection;
}

export async function unwrapResidualWsol(): Promise<number | null> {
  if (!CONFIG.PRIV_B58) return null;
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIV_B58));
    const conn = getConnection();
    const res = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM_ID_PK });
    let closedCount = 0;
    let reclaimedSol = 0;
    for (const { pubkey, account } of res.value) {
      const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; uiAmount?: number } } } }).parsed?.info;
      if (info?.mint !== WSOL_MINT) continue;
      const balance = BigInt(info.tokenAmount?.amount ?? "0");
      const tx = new Transaction().add(
        new TransactionInstruction({
          keys: [
            { pubkey, isSigner: false, isWritable: true },
            { pubkey: kp.publicKey, isSigner: false, isWritable: true },
            { pubkey: kp.publicKey, isSigner: true, isWritable: false },
          ],
          programId: TOKEN_PROGRAM_ID_PK,
          data: Buffer.from([9]),
        }),
      );
      try {
        const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
        const reclaimed = Number(balance) / 1e9;
        reclaimedSol += reclaimed;
        closedCount++;
        logger.info({ wsolAccount: pubkey.toBase58(), signature: sig, reclaimedSol: reclaimed }, "[wsol] closed residual WSOL account");
      } catch (err) {
        logger.warn({ wsolAccount: pubkey.toBase58(), err: (err as Error).message }, "[wsol] close failed");
      }
    }
    if (closedCount > 0) {
      logger.info({ closedCount, reclaimedSol }, "[wsol] unwrap sweep complete");
    }
    return reclaimedSol;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "[wsol] unwrap sweep failed");
    return null;
  }
}

const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// ---------------------------------------------------------------------------
// Rent reclaim — close zero-balance SPL token accounts to recover locked SOL.
// ---------------------------------------------------------------------------

export type ReclaimResult = {
  scanned: number;
  empty: number;
  closed: number;
  failed: number;
  reclaimedLamports: number;
};

async function closeAccountsBatch(
  conn: Connection,
  kp: Keypair,
  accounts: Array<{ pubkey: PublicKey; lamports: number }>,
  programId: PublicKey,
): Promise<{ closed: number; failed: number; reclaimedLamports: number }> {
  let closed = 0, failed = 0, reclaimedLamports = 0;
  const BATCH = 20;
  for (let i = 0; i < accounts.length; i += BATCH) {
    const batch = accounts.slice(i, i + BATCH);
    const tx = new Transaction();
    for (const { pubkey } of batch) {
      tx.add(
        new TransactionInstruction({
          keys: [
            { pubkey, isSigner: false, isWritable: true },
            { pubkey: kp.publicKey, isSigner: false, isWritable: true },
            { pubkey: kp.publicKey, isSigner: true, isWritable: false },
          ],
          programId,
          data: Buffer.from([9]),
        }),
      );
    }
    try {
      await sendAndConfirmTransaction(conn, tx, [kp], { commitment: "confirmed" });
      for (const { lamports } of batch) reclaimedLamports += lamports;
      closed += batch.length;
      logger.info({ batchIndex: Math.floor(i / BATCH) + 1, count: batch.length }, "[reclaim] batch closed");
    } catch (batchErr) {
      logger.warn({ err: String(batchErr), batchStart: i }, "[reclaim] batch failed, retrying one-by-one");
      for (const { pubkey, lamports } of batch) {
        const single = new Transaction().add(
          new TransactionInstruction({
            keys: [
              { pubkey, isSigner: false, isWritable: true },
              { pubkey: kp.publicKey, isSigner: false, isWritable: true },
              { pubkey: kp.publicKey, isSigner: true, isWritable: false },
            ],
            programId,
            data: Buffer.from([9]),
          }),
        );
        try {
          await sendAndConfirmTransaction(conn, single, [kp], { commitment: "confirmed" });
          reclaimedLamports += lamports;
          closed++;
        } catch (err) {
          logger.warn({ account: pubkey.toBase58(), err: String(err) }, "[reclaim] single close failed");
          failed++;
        }
      }
    }
  }
  return { closed, failed, reclaimedLamports };
}

export async function reclaimEmptyTokenAccounts(): Promise<ReclaimResult> {
  const result: ReclaimResult = { scanned: 0, empty: 0, closed: 0, failed: 0, reclaimedLamports: 0 };
  if (!CONFIG.PRIV_B58) return result;
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIV_B58));
    const conn = getConnection();
    const [standard, ext] = await Promise.all([
      conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM_ID_PK }),
      conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);
    result.scanned = standard.value.length + ext.value.length;

    type ParsedInfo = { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
    const filterEmpty = (accounts: typeof standard.value) =>
      accounts
        .filter(({ account }) => (account.data as ParsedInfo).parsed?.info?.tokenAmount?.amount === "0")
        .map(({ pubkey, account }) => ({ pubkey, lamports: account.lamports }));

    const emptyStd = filterEmpty(standard.value);
    const emptyExt = filterEmpty(ext.value);
    result.empty = emptyStd.length + emptyExt.length;

    if (result.empty === 0) return result;

    const r1 = await closeAccountsBatch(conn, kp, emptyStd, TOKEN_PROGRAM_ID_PK);
    const r2 = await closeAccountsBatch(conn, kp, emptyExt, TOKEN_2022_PROGRAM_ID);
    result.closed = r1.closed + r2.closed;
    result.failed = r1.failed + r2.failed;
    result.reclaimedLamports = r1.reclaimedLamports + r2.reclaimedLamports;

    logger.info(
      { scanned: result.scanned, empty: result.empty, closed: result.closed, failed: result.failed, reclaimedSol: (result.reclaimedLamports / 1e9).toFixed(4) },
      "[reclaim] sweep complete",
    );
    return result;
  } catch (err) {
    logger.warn({ err: String(err) }, "[reclaim] sweep failed");
    throw err;
  }
}

export async function getWalletSolBalance(): Promise<number | null> {
  if (!CONFIG.PRIV_B58) return null;
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIV_B58));
    const conn = getConnection();
    const lamports = await conn.getBalance(kp.publicKey, "confirmed");
    return lamports / 1e9;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "getWalletSolBalance: RPC failed");
    return null;
  }
}

export function getWalletAddress(): string | null {
  if (!CONFIG.PRIV_B58) return null;
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIV_B58));
    return kp.publicKey.toBase58();
  } catch {
    return null;
  }
}

export async function getWalletTokenBalance(mint: string): Promise<bigint | null> {
  if (!CONFIG.PRIV_B58) return null;
  try {
    const kp = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIV_B58));
    const conn = getConnection();
    let total = 0n;
    for (const programId of [TOKEN_PROGRAM_ID_PK, TOKEN_2022_PROGRAM_ID]) {
      const res = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId });
      for (const { account } of res.value) {
        const info = (account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } }).parsed?.info;
        if (info?.mint === mint && info.tokenAmount?.amount) {
          total += BigInt(info.tokenAmount.amount);
        }
      }
    }
    return total;
  } catch (err) {
    logger.warn({ mint, err: (err as Error).message }, "getWalletTokenBalance: RPC failed");
    return null;
  }
}

export async function getTokenDecimals(mint: string): Promise<number> {
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;
  try {
    const info = await getConnection().getParsedAccountInfo(new PublicKey(mint));
    const value = info.value;
    if (value && "parsed" in value.data) {
      const parsed = (value.data as { parsed: { info: { decimals: number } } }).parsed;
      const d = Number(parsed.info.decimals);
      if (Number.isFinite(d)) {
        decimalsCache.set(mint, d);
        return d;
      }
    }
    logger.warn({ mint }, "getTokenDecimals: unparsed account, defaulting to 6");
  } catch (err) {
    logger.warn({ mint, err: (err as Error).message }, "getTokenDecimals: RPC failed, defaulting to 6");
  }
  decimalsCache.set(mint, 6);
  return 6;
}

export async function getOrder(params: GetOrderParams): Promise<JupOrderResponse> {
  const q = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amountRaw.toString(),
    taker: params.taker,
  });
  // Attach Jupiter referral fee (baked-in constants above). Fee lands in SOL
  // because every swap this bot makes has SOL on one side. Skip when the
  // pubkey constant is empty.
  if (REFERRAL_ACCOUNT && REFERRAL_FEE_BPS > 0) {
    q.set("referralAccount", REFERRAL_ACCOUNT);
    q.set("referralFee", String(REFERRAL_FEE_BPS));
  }
  const url = `${JUP_BASE}/order?${q.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": CONFIG.JUP_API_KEY,
      "accept": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`jup getOrder ${res.status}: ${body}`);
  }
  const json = (await res.json()) as JupOrderResponse;
  if (!json.transaction || typeof json.transaction !== "string" || json.transaction.length < 20) {
    throw new Error(`jup getOrder returned empty/invalid transaction field: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

export async function executeOrder(
  requestId: string,
  signedTxBase64: string,
): Promise<JupExecuteResponse> {
  const res = await fetch(`${JUP_BASE}/execute`, {
    method: "POST",
    headers: {
      "x-api-key": CONFIG.JUP_API_KEY,
      "content-type": "application/json",
      "accept": "application/json",
    },
    body: JSON.stringify({ requestId, signedTransaction: signedTxBase64 }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`jup executeOrder ${res.status}: ${body}`);
  }
  return (await res.json()) as JupExecuteResponse;
}

export async function quoteTokenToSol(
  mint: string,
  tokenAmountRaw: bigint,
): Promise<{ outSolLamports: bigint; priceImpactPct: number } | null> {
  try {
    const q = new URLSearchParams({
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: tokenAmountRaw.toString(),
    });
    const res = await fetch(`${JUP_BASE}/order?${q.toString()}`, {
      method: "GET",
      headers: {
        "x-api-key": CONFIG.JUP_API_KEY,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      logger.debug({ mint, status: res.status, body }, "quoteTokenToSol non-200");
      return null;
    }
    const json = (await res.json()) as { outAmount?: string; priceImpactPct?: string };
    if (!json.outAmount) return null;
    return {
      outSolLamports: BigInt(json.outAmount),
      priceImpactPct: Number(json.priceImpactPct ?? 0),
    };
  } catch (err) {
    logger.debug({ mint, err: (err as Error).message }, "quoteTokenToSol error");
    return null;
  }
}

const BUY_MAX_ATTEMPTS = 20;
const BUY_RETRY_MS = 1000;

async function buyOnce(
  mint: string,
  solLamports: bigint,
): Promise<{ signature: string; tokensReceivedRaw: bigint; tokenDecimals: number } | null> {
  if (CONFIG.DRY_RUN) {
    const order = await getOrder({
      inputMint: SOL_MINT,
      outputMint: mint,
      amountRaw: solLamports,
      taker: "11111111111111111111111111111111",
    });
    const tokenDecimals = await getTokenDecimals(mint);
    logger.info({ mint, solLamports: solLamports.toString(), outAmount: order.outAmount }, "[DRY_RUN] buy");
    return {
      signature: `DRY_RUN_BUY_${mint.slice(0, 8)}`,
      tokensReceivedRaw: BigInt(order.outAmount),
      tokenDecimals,
    };
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIV_B58));
  const order = await getOrder({
    inputMint: SOL_MINT,
    outputMint: mint,
    amountRaw: solLamports,
    taker: keypair.publicKey.toBase58(),
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([keypair]);
  const signedB64 = Buffer.from(tx.serialize()).toString("base64");
  const exec = await executeOrder(order.requestId, signedB64);
  if (exec.status !== "Success") {
    throw new Error(`execute non-success: ${JSON.stringify(exec).slice(0, 200)}`);
  }
  const tokenDecimals = await getTokenDecimals(mint);
  return {
    signature: exec.signature ?? "",
    tokensReceivedRaw: BigInt(order.outAmount),
    tokenDecimals,
  };
}

export async function buyTokenWithSol(
  mint: string,
  solLamports: bigint,
): Promise<{ signature: string; tokensReceivedRaw: bigint; tokenDecimals: number } | null> {
  for (let attempt = 1; attempt <= BUY_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await buyOnce(mint, solLamports);
      if (result) {
        if (attempt > 1) logger.info({ mint, attempt }, "buyTokenWithSol succeeded after retries");
        return result;
      }
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn({ mint, attempt, maxAttempts: BUY_MAX_ATTEMPTS, err: msg }, "buyTokenWithSol attempt failed, retrying");
    }
    if (attempt < BUY_MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, BUY_RETRY_MS));
    }
  }
  logger.error({ mint, attempts: BUY_MAX_ATTEMPTS }, "buyTokenWithSol failed permanently after all retries");
  return null;
}

export async function sellTokenForSol(
  mint: string,
  tokenAmountRaw: bigint,
): Promise<{ signature: string; solReceivedLamports: bigint } | null> {
  try {
    if (CONFIG.DRY_RUN) {
      const order = await getOrder({
        inputMint: mint,
        outputMint: SOL_MINT,
        amountRaw: tokenAmountRaw,
        taker: "11111111111111111111111111111111",
      });
      logger.info(
        { mint, tokenAmountRaw: tokenAmountRaw.toString(), outAmount: order.outAmount },
        "[DRY_RUN] sell",
      );
      return {
        signature: `DRY_RUN_SELL_${mint.slice(0, 8)}`,
        solReceivedLamports: BigInt(order.outAmount),
      };
    }

    const keypair = Keypair.fromSecretKey(bs58.decode(CONFIG.PRIV_B58));
    const order = await getOrder({
      inputMint: mint,
      outputMint: SOL_MINT,
      amountRaw: tokenAmountRaw,
      taker: keypair.publicKey.toBase58(),
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    tx.sign([keypair]);
    const signedB64 = Buffer.from(tx.serialize()).toString("base64");
    const exec = await executeOrder(order.requestId, signedB64);
    if (exec.status !== "Success") {
      logger.error({ mint, exec }, "sellTokenForSol execute non-success");
      return null;
    }
    return {
      signature: exec.signature ?? "",
      solReceivedLamports: BigInt(order.outAmount),
    };
  } catch (err) {
    logger.error({ mint, err: (err as Error).message }, "sellTokenForSol failed");
    return null;
  }
}
