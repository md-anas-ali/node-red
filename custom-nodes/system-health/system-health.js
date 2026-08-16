'use strict';

/**
 * system-health.js
 *
 * Deliberately NOT wired through flows-seed.json. Node-RED calls
 * `module.exports(RED)` exactly once when this package is registered
 * at startup (regardless of whether any node instance of this type
 * exists in a flow), which is where the actual work happens:
 *
 *   1. Registers GET /healthz/deep — a deeper health check than the
 *      flow-based GET /healthz in flows-seed.json (which stays
 *      untouched). This one pings PostgreSQL with a bounded timeout
 *      and reports latency, without ever exposing the connection
 *      string or any credential.
 *   2. Starts a low-frequency interval that runs the retention
 *      cleanup (old jobs/executions/audit_logs) and recovers any jobs
 *      stuck in 'running' from a crashed prior process.
 *
 * A minimal config-node type ("system-health-status") is also
 * registered so the package has a valid node-red node — it does
 * nothing on its own and doesn't need to be dragged into any flow.
 */

let dbCore;
try {
    dbCore = require('node-red-render-db-core');
} catch (err) {
    // If db-core isn't installed/resolvable, degrade to a no-op rather
    // than crashing the whole Node-RED boot — /healthz (shallow, flow
    // based) still works either way.
    console.error('[system-health] node-red-render-db-core not available:', err.message);
}

const RETENTION_INTERVAL_MS = parseInt(process.env.RETENTION_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10); // 6h default
const STALE_JOB_MINUTES = parseInt(process.env.STALE_JOB_MINUTES || '15', 10);

let retentionTimer = null;

function runRetentionCycle() {
    if (!dbCore) return;
    Promise.resolve()
        .then(() => dbCore.jobs.recoverStaleJobs(STALE_JOB_MINUTES))
        .then((recovered) => {
            if (recovered > 0) {
                console.log(`[system-health] Recovered ${recovered} stale 'running' job(s) back to 'pending'`);
            }
            return dbCore.retention.cleanupOldRecords();
        })
        .then(({ jobsDeleted, executionsDeleted, auditDeleted }) => {
            if (jobsDeleted || executionsDeleted || auditDeleted) {
                console.log(
                    `[system-health] Retention cleanup: jobs=${jobsDeleted} executions=${executionsDeleted} audit_logs=${auditDeleted}`
                );
            }
        })
        .catch((err) => {
            console.error('[system-health] Retention cycle failed:', err.message);
        });
}

module.exports = function (RED) {
    // --- Minimal node type so this package registers cleanly ------------
    function SystemHealthStatusNode(config) {
        RED.nodes.createNode(this, config);
    }
    RED.nodes.registerType('system-health-status', SystemHealthStatusNode);

    // --- GET /healthz/deep ------------------------------------------------
    // Registered on RED.httpNode (same HTTP surface as flow http-in
    // nodes, i.e. httpNodeRoot = "/" per settings.js) so it's reachable
    // at exactly /healthz/deep with no extra Render config.
    RED.httpNode.get('/healthz/deep', function (req, res) {
        if (!dbCore) {
            res.status(503).json({ status: 'error', reason: 'db-core module unavailable' });
            return;
        }
        dbCore.health
            .checkDb()
            .then((dbResult) => {
                const status = dbResult.ok ? 'ok' : 'error';
                res.status(dbResult.ok ? 200 : 503).json({
                    status,
                    db: {
                        ok: dbResult.ok,
                        latencyMs: dbResult.latencyMs,
                    },
                    // Deliberately no error detail, host, or connection
                    // info in the response body — that goes to server
                    // logs only, never to an unauthenticated caller.
                });
            })
            .catch(() => {
                res.status(503).json({ status: 'error' });
            });
    });

    // --- Retention / crash-recovery timer ----------------------------------
    if (dbCore && !retentionTimer) {
        // Run once shortly after boot, then on the configured interval.
        setTimeout(runRetentionCycle, 30 * 1000);
        retentionTimer = setInterval(runRetentionCycle, RETENTION_INTERVAL_MS);
        if (typeof retentionTimer.unref === 'function') retentionTimer.unref();
    }
};
