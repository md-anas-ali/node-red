'use strict';

/**
 * health.js
 *
 * Cheap DB reachability check for /healthz/deep. Bounded by a short
 * timeout so a stalled database can't hang the health endpoint (and,
 * on Render, doesn't drag the whole service into a failed-healthcheck
 * restart loop when it's just a slow query).
 */

const { getPool } = require('./pool');

async function checkDb(timeoutMs = 2000) {
    const started = Date.now();
    try {
        const pool = getPool();
        await Promise.race([
            pool.query('SELECT 1'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('db health check timed out')), timeoutMs)),
        ]);
        return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
        // Message only — never the connection string or query params.
        return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
}

module.exports = { checkDb };
