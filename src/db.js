"use strict";

const config = require("./config");
const logger = require("./logger");

let impl = null;
let initPromise = null;

/**
 * Async DB facade. In production (DATABASE_URL set) it uses managed Postgres;
 * in local development it falls back to a SQLite file. All methods return
 * Promises and use SQLite-style `?` placeholders everywhere.
 */
function init() {
  if (!initPromise) {
    initPromise = (async () => {
      if (config.databaseUrl) {
        const { createPostgresDb } = require("./db/postgres");
        const ssl = process.env.PGSSLMODE === "false" ? undefined : { rejectUnauthorized: false };
        impl = createPostgresDb(config.databaseUrl, { ssl });
        logger.info("database: managed Postgres (DATABASE_URL)");
      } else {
        const { createSqliteDb } = require("./db/sqlite");
        impl = createSqliteDb(config.dbPath);
        logger.info(`database: SQLite (${config.dbPath}) — local dev only`);
      }
      try {
        await impl.init();
        return impl;
      } catch (err) {
        // Do not cache a failed init: a later request retries from scratch
        // (Postgres may still be provisioning on first boot).
        impl = null;
        initPromise = null;
        throw err;
      }
    })();
  }
  return initPromise;
}

async function ready() {
  return init();
}

async function get(sql, ...params) {
  await init();
  return impl.get(sql, ...params);
}

async function all(sql, ...params) {
  await init();
  return impl.all(sql, ...params);
}

async function run(sql, ...params) {
  await init();
  return impl.run(sql, ...params);
}

/** Cross-dialect upsert keyed by `conflictKeys` (column names). */
async function upsert(table, row, conflictKeys) {
  await init();
  const keys = Object.keys(row);
  const values = keys.map((k) => row[k]);
  if (impl.isPostgres) {
    const cols = keys.map((k) => `"${k}"`).join(", ");
    const ph = keys.map((_, i) => `$${i + 1}`).join(", ");
    const conflict = conflictKeys.map((k) => `"${k}"`).join(", ");
    const updates = keys
      .filter((k) => !conflictKeys.includes(k))
      .map((k) => `"${k}" = EXCLUDED."${k}"`)
      .join(", ");
    return impl.run(
      `INSERT INTO ${table} (${cols}) VALUES (${ph}) ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`,
      ...values
    );
  }
  const cols = keys.join(", ");
  const ph = keys.map(() => "?").join(", ");
  return impl.run(`INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${ph})`, ...values);
}

async function close() {
  if (impl) await impl.close();
  impl = null;
  initPromise = null;
}

function describe() {
  return impl ? (impl.isPostgres ? "postgres" : "sqlite") : "not-initialized";
}

module.exports = { init, ready, get, all, run, upsert, close, describe };
