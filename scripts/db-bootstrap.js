#!/usr/bin/env node
'use strict';

/**
 * scripts/db-bootstrap.js
 *
 * Runs before Node-RED starts (see entrypoint.sh):
 *   1. Connect to PostgreSQL, retrying with exponential backoff.
 *   2. Apply any pending migrations.
 *   3. Verify every required table exists.
 *   4. Recover jobs left stuck 'running' by a previous process that
 *      crashed/OOM'd mid-execution.
 *
 * On any failure this exits non-zero and prints only a safe,
 * non-sensitive error message (never the connection string). There is
 * intentionally NO fallback storage — per the "PostgreSQL is the only
 * persistent storage" requirement, the container must not start if the
 * database isn't in a valid, reachable state.
 *
 * NOTE: this deliberately requires the package by NAME
 * ('node-red-render-db-core'), not by a relative path into
 * custom-nodes/db-core. The final Docker image only contains
 * node_modules (copied from the node-builder stage) plus scripts/ —
 * the custom-nodes/ source tree itself is not present at runtime, so
 * standard node_modules resolution is what actually works in
 * production. This is verified by an `npm ci --install-links` +
 * `node scripts/db-bootstrap.js` smoke test.
 */

let db;
try {
    db = require('node-red-render-db-core');
} catch (err) {
    console.error('[db-bootstrap] Could not load db-core module:', err.message);
    process.exit(1);
}

(async () => {
    if (!process.env.DB_POSTGRESDB_CONNECTION_URL) {
        console.error(
            '[db-bootstrap] FATAL: DB_POSTGRESDB_CONNECTION_URL is not set. ' +
                'PostgreSQL is required — there is no fallback storage.'
        );
        process.exit(1);
    }

    try {
        console.log('[db-bootstrap] Connecting to PostgreSQL...');
        await db.connectWithRetry({ maxAttempts: 5, baseDelayMs: 1000 });

        console.log('[db-bootstrap] Running migrations...');
        const applied = await db.migrate();
        console.log(
            applied.length
                ? `[db-bootstrap] Applied ${applied.length} migration(s): ${applied.join(', ')}`
                : '[db-bootstrap] Schema already up to date'
        );

        console.log('[db-bootstrap] Verifying schema...');
        await db.verifySchema();
        console.log('[db-bootstrap] Schema OK (users, workflows, workflow_versions, jobs, executions, system_settings, audit_logs)');

        console.log('[db-bootstrap] Recovering any jobs stuck from a previous crash...');
        const recovered = await db.jobs.recoverStaleJobs(parseInt(process.env.STALE_JOB_MINUTES || '15', 10));
        console.log(`[db-bootstrap] Recovered ${recovered} stale job(s)`);

        await db.closePool();
        console.log('[db-bootstrap] Startup checks passed.');
        process.exit(0);
    } catch (err) {
        console.error('[db-bootstrap] FATAL:', err.message);
        console.error('[db-bootstrap] Refusing to start Node-RED without a valid database.');
        process.exit(1);
    }
})();
