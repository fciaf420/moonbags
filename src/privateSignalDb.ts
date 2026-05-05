import { Pool } from "pg";
import { CONFIG } from "./config.js";
import type { SignalAlert } from "./types.js";

let pool: Pool | null = null;
let schemaReady = false;

function getPool(): Pool {
  if (!CONFIG.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for private signal Postgres mode");
  }
  if (!pool) {
    pool = new Pool({
      connectionString: CONFIG.DATABASE_URL,
      ssl: CONFIG.DATABASE_SSL ? { rejectUnauthorized: false } : false,
      max: 3,
    });
  }
  return pool;
}

export async function ensurePrivateSignalSchema(): Promise<void> {
  if (schemaReady) return;
  await getPool().query(`
    create table if not exists source_signals (
      id bigserial primary key,
      source text not null default 'private',
      mint text not null,
      alert_time bigint not null,
      name text,
      payload jsonb not null,
      inserted_at timestamptz not null default now(),
      unique (source, mint, alert_time)
    );
    create index if not exists source_signals_fresh_idx
      on source_signals (source, inserted_at desc);
  `);
  schemaReady = true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberField(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function insertPrivateSignalAlerts(rawAlerts: unknown[]): Promise<number> {
  await ensurePrivateSignalSchema();
  let inserted = 0;
  const client = await getPool().connect();
  try {
    for (const raw of rawAlerts) {
      const rec = asRecord(raw);
      if (!rec) continue;
      const mint = stringField(rec.mint);
      if (!mint) continue;
      const alertTime = Math.floor(numberField(rec.alert_time, Date.now() / 1000));
      const name = stringField(rec.name, mint.slice(0, 8));
      const result = await client.query(
        `insert into source_signals (source, mint, alert_time, name, payload)
         values ($1, $2, $3, $4, $5)
         on conflict (source, mint, alert_time) do nothing`,
        ["private", mint, alertTime, name, rec],
      );
      inserted += result.rowCount ?? 0;
    }
  } finally {
    client.release();
  }
  return inserted;
}

// Subscribers connect with a read-only Postgres role that cannot run CREATE
// TABLE. The relay (writer) is the only process that ensures schema; the
// reader path just queries.
export async function readPrivateSignalAlerts(limit = 200): Promise<unknown[]> {
  const result = await getPool().query<{ payload: unknown }>(
    `select payload
     from source_signals
     where source = 'private'
     order by alert_time desc, inserted_at desc
     limit $1`,
    [limit],
  );
  return result.rows.map((row) => row.payload);
}

export async function closePrivateSignalDb(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
  schemaReady = false;
}
