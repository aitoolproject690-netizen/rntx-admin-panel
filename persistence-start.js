const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = __dirname;
const DB_FILE = path.join(ROOT, "rntx.db");
const SESSION_DB_FILE = path.join(ROOT, "rntx-sessions.db");
const DATABASE_URL = process.env.DATABASE_URL;
const SNAPSHOT_TABLE = "rntx_persistent_state";

function rebuildNative() {
  const result = spawnSync("npm", ["rebuild", "better-sqlite3"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

async function withClient(fn) {
  if (!DATABASE_URL) return null;
  const client = new Client({ connectionString: DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function restore() {
  if (!DATABASE_URL) {
    console.log("DATABASE_URL not set; starting with local SQLite persistence only.");
    return;
  }
  try {
    await withClient(async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (id INTEGER PRIMARY KEY, app_db BYTEA, session_db BYTEA, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      const row = (await client.query(`SELECT app_db, session_db FROM ${SNAPSHOT_TABLE} WHERE id=1`)).rows[0];
      if (row?.app_db) fs.writeFileSync(DB_FILE, zlib.gunzipSync(row.app_db));
      if (row?.session_db) fs.writeFileSync(SESSION_DB_FILE, zlib.gunzipSync(row.session_db));
      console.log(row?.app_db ? "Restored RNTX SQLite data from PostgreSQL." : "No previous RNTX snapshot found; a new database will be initialized.");
    });
  } catch (err) {
    console.error("PostgreSQL restore failed:", err.message);
    console.log("Continuing with local SQLite database; data will not be cloud-persistent until DATABASE_URL is fixed.");
  }
}

async function main() {
  rebuildNative();
  await restore();
  const child = require("child_process").spawn(process.execPath, [path.join(ROOT, "server-custom.js")], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit"
  });
  const shutdown = code => { if (!child.killed) child.kill("SIGTERM"); setTimeout(() => process.exit(code), 1000).unref(); };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

main().catch(err => { console.error(err); process.exit(1); });
