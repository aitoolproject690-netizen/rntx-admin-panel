const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn, spawnSync } = require("child_process");
const { Client } = require("pg");

const ROOT = __dirname;
const DB_FILE = path.join(ROOT, "rntx.db");
const SESSION_DB_FILE = path.join(ROOT, "rntx-sessions.db");
const DATABASE_URL = process.env.DATABASE_URL;
const SNAPSHOT_TABLE = "rntx_persistent_state";
const SNAPSHOT_INTERVAL_MS = 5000;

function rebuildNative() {
  const result = spawnSync("npm", ["rebuild", "better-sqlite3"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

function makeClient() {
  return new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

async function withClient(fn) {
  if (!DATABASE_URL) return null;
  const client = makeClient();
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function ensureSnapshotTable(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (id INTEGER PRIMARY KEY, app_db BYTEA, session_db BYTEA, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function restore() {
  if (!DATABASE_URL) {
    console.log("DATABASE_URL not set; starting with local SQLite persistence only.");
    return;
  }
  try {
    await withClient(async client => {
      await ensureSnapshotTable(client);
      const row = (await client.query(`SELECT app_db, session_db, updated_at FROM ${SNAPSHOT_TABLE} WHERE id=1`)).rows[0];
      if (row?.app_db) fs.writeFileSync(DB_FILE, zlib.gunzipSync(row.app_db));
      if (row?.session_db) fs.writeFileSync(SESSION_DB_FILE, zlib.gunzipSync(row.session_db));
      console.log(row?.app_db ? `Restored RNTX SQLite data from PostgreSQL (snapshot ${row.updated_at}).` : "No previous RNTX snapshot found; a new database will be initialized.");
    });
  } catch (err) {
    console.error("PostgreSQL restore failed:", err.message);
    console.log("Continuing with local SQLite database; data will not be cloud-persistent until DATABASE_URL is fixed.");
  }
}

let snapshotBusy = false;
let snapshotAgain = false;

async function snapshot(reason = "scheduled") {
  if (!DATABASE_URL) return;
  if (snapshotBusy) {
    snapshotAgain = true;
    return;
  }
  snapshotBusy = true;
  try {
    const appPath = DB_FILE;
    const sessionPath = SESSION_DB_FILE;
    const appDb = fs.existsSync(appPath) ? zlib.gzipSync(fs.readFileSync(appPath)) : null;
    const sessionDb = fs.existsSync(sessionPath) ? zlib.gzipSync(fs.readFileSync(sessionPath)) : null;
    if (!appDb && !sessionDb) return;

    await withClient(async client => {
      await ensureSnapshotTable(client);
      await client.query(
        `INSERT INTO ${SNAPSHOT_TABLE}(id,app_db,session_db,updated_at)
         VALUES(1,$1,$2,NOW())
         ON CONFLICT(id) DO UPDATE SET app_db=EXCLUDED.app_db, session_db=EXCLUDED.session_db, updated_at=NOW()`,
        [appDb, sessionDb]
      );
    });
    console.log(`RNTX PostgreSQL snapshot saved (${reason}).`);
  } catch (err) {
    console.error("PostgreSQL snapshot failed:", err.message);
  } finally {
    snapshotBusy = false;
    if (snapshotAgain) {
      snapshotAgain = false;
      setTimeout(() => snapshot("queued"), 100).unref();
    }
  }
}

async function main() {
  rebuildNative();
  await restore();

  const child = spawn(process.execPath, [path.join(ROOT, "server-custom.js")], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit"
  });

  // The parent process owns cloud persistence so every database change is
  // captured even when an API route does not finish through the wrapper.
  const snapshotTimer = DATABASE_URL
    ? setInterval(() => snapshot("5-second interval"), SNAPSHOT_INTERVAL_MS)
    : null;
  snapshotTimer?.unref();

  let shuttingDown = false;
  const shutdown = async code => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (snapshotTimer) clearInterval(snapshotTimer);
    // Give SQLite a moment to finish the last write, then save one final copy.
    await new Promise(resolve => setTimeout(resolve, 250));
    await snapshot("shutdown");
    if (!child.killed) child.kill("SIGTERM");
    setTimeout(() => process.exit(code), 1500).unref();
  };

  process.on("SIGTERM", () => { shutdown(0).catch(() => process.exit(0)); });
  process.on("SIGINT", () => { shutdown(0).catch(() => process.exit(0)); });

  child.on("exit", async (code, signal) => {
    if (shuttingDown) return;
    if (snapshotTimer) clearInterval(snapshotTimer);
    await snapshot("child-exit").catch(() => {});
    process.exit(code ?? (signal ? 1 : 0));
  });

  // Take an initial post-start snapshot so the cloud copy is immediately
  // refreshed with any schema migrations performed during server startup.
  setTimeout(() => snapshot("startup"), 2000).unref();
}

main().catch(err => { console.error(err); process.exit(1); });
