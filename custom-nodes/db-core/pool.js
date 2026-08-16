'use strict';

/**
 * pool.js
 *
 * Single shared PostgreSQL connection pool for the whole app —
 * PostgreSQL is the ONLY persistent storage (no Redis, no local
 * filesystem, no other database). Kept deliberately small: Render
 * Free is 0.1 CPU / 512MB, so a handful of connections is plenty and
 * a big pool would just waste RAM.
 *
 * Security notes:
 *   - The connection string (DB_POSTGRESDB_CONNECTION_URL) is parsed
 *     with the built-in `URL` class and NEVER logged in full — only
 *     host/port/database name, which are not secrets.
 *   - SSL is on by default (Render-managed Postgres requires it); set
 *     DB_SSL_REJECT_UNAUTHORIZED=true if your provider's cert chain
 *     validates cleanly, or DB_SSL_DISABLE=true for a local
 *     docker-compose Postgres with no TLS at all.
 */

const { Pool } = require('pg');

let pool = null;

function safeDescribeConnection(connectionString) {
    try {
        const u = new URL(connectionString);
        return `${u.hostname}:${u.port || 5432}${u.pathname}`;
    } catch (_e) {
        return '(unparseable connection string)';
    }
}

function buildSslConfig() {
    if (process.env.DB_SSL_DISABLE === 'true') {
        return false;
    }
    // Default: SSL on, but don't reject Render/managed providers' cert
    // chains unless the operator explicitly opts into strict
    // verification. This matches the common "sslmode=require" (not
    // "verify-full") posture used by most managed Postgres offerings.
    return {
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true',
    };
}

/**
 * Lazily creates (once) and returns the shared pool. Throws if
 * DB_POSTGRESDB_CONNECTION_URL is not set — callers are expected to
 * treat that as a fatal startup condition, not fall back to any other
 * storage.
 */
function getPool() {
    if (pool) return pool;

    const connectionString = process.env.DB_POSTGRESDB_CONNECTION_URL;
    if (!connectionString) {
        throw new Error(
            'DB_POSTGRESDB_CONNECTION_URL is not set. PostgreSQL is the only ' +
                'supported persistent storage — there is no local-filesystem or ' +
                'in-memory fallback.'
        );
    }

    pool = new Pool({
        connectionString,
        ssl: buildSslConfig(),
        // Small, RAM-conscious pool. Render Free's single 0.1 CPU
        // instance has no real concurrency to speak of, so 3
        // connections is comfortably enough headroom.
        max: parseInt(process.env.DB_POOL_MAX || '3', 10),
        idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS || '30000', 10),
        connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONN_TIMEOUT_MS || '5000', 10),
    });

    pool.on('error', (err) => {
        // Idle-client background errors (e.g. connection dropped by the
        // server) — log without leaking the connection string, and
        // never crash the process here; queries in flight will surface
        // their own errors to their callers.
        console.error(
            `[db] Unexpected idle client error on ${safeDescribeConnection(connectionString)}: ${err.message}`
        );
    });

    console.log(`[db] Pool created for ${safeDescribeConnection(connectionString)} (max=${pool.options.max})`);
    return pool;
}

/** Parameterized query helper — never build SQL by string concatenation. */
async function query(text, params) {
    const p = getPool();
    return p.query(text, params);
}

/** Runs `fn(client)` inside a transaction, committing/rolling back automatically. */
async function withTransaction(fn) {
    const p = getPool();
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = {
    getPool,
    query,
    withTransaction,
    closePool,
    safeDescribeConnection,
};
