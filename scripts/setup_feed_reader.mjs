// Idempotent: ensures the source_signals table and the read-only feed_reader
// role exist on the relay's Postgres. Safe to re-run — rotates the password if
// the role already exists.
//
// Usage:
//   PG_WRITER_URL='postgresql://postgres:...@host:port/db' \
//   FEED_READER_PASS_FILE=/path/to/pass node scripts/setup_feed_reader.mjs

import { Client } from "pg";
import { readFileSync } from "node:fs";

const writerUrl = process.env.PG_WRITER_URL;
const passFile = process.env.FEED_READER_PASS_FILE ?? "/tmp/feed_reader_pass.txt";
const readerPass = readFileSync(passFile, "utf8").trim();
if (!writerUrl) throw new Error("PG_WRITER_URL not set");
if (!readerPass) throw new Error("reader password missing");

const client = new Client({
  connectionString: writerUrl,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log("connected to writer");

await client.query(`
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
console.log("schema ensured");

// CREATE/ALTER ROLE doesn't accept bind parameters and DO blocks don't either,
// so we have to build the SQL string. Reject anything outside base64url alphabet
// to make the literal-embed safe (no quotes/backslashes possible).
if (!/^[A-Za-z0-9_-]+$/.test(readerPass)) {
  throw new Error("reader password must be base64url (alnum, -, _) for safe SQL embedding");
}

const existing = await client.query(`select 1 from pg_roles where rolname = 'feed_reader'`);
if (existing.rowCount === 0) {
  await client.query(`create role feed_reader with login password '${readerPass}'`);
  console.log("created role feed_reader");
} else {
  await client.query(`alter role feed_reader with login password '${readerPass}'`);
  console.log("rotated password on existing feed_reader role");
}

await client.query(`grant connect on database railway to feed_reader`);
await client.query(`grant usage on schema public to feed_reader`);
await client.query(`grant select on source_signals to feed_reader`);
await client.query(`alter default privileges in schema public grant select on tables to feed_reader`);
console.log("grants applied");

const url = new URL(writerUrl);
url.username = "feed_reader";
url.password = readerPass;
const readerUrl = url.toString();

const reader = new Client({ connectionString: readerUrl, ssl: { rejectUnauthorized: false } });
await reader.connect();
const probe = await reader.query("select count(*)::int as n from source_signals");
console.log("reader SELECT ok, rows:", probe.rows[0].n);
let writeBlocked = false;
try {
  await reader.query(
    "insert into source_signals (mint, alert_time, payload) values ('TEST', 0, '{}'::jsonb)",
  );
} catch (err) {
  writeBlocked = /permission denied/i.test(err.message);
  console.log("reader INSERT correctly blocked:", err.message);
}
await reader.end();
await client.end();

if (!writeBlocked) {
  console.error("WARNING: read-only role can write — check grants");
  process.exit(1);
}

console.log("done");
