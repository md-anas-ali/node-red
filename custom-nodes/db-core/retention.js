'use strict';

/**
 * retention.js
 *
 * Auto-cleanup for jobs, executions, and audit_logs so the table
 * sizes (and therefore Postgres's own disk/RAM use) don't grow
 * unbounded on a free-tier database. Deletes in small batches to
 * avoid holding long locks — relevant even at low volume, since this
 * runs on a shared 0.1 CPU instance.
 *
 * Defaults are conservative and overridable via env vars:
 *   RETENTION_JOBS_DAYS        (default 14)  - finished (success/failed) jobs
 *   RETENTION_EXECUTIONS_DAYS  (default 30)  - execution history
 *   RETENTION_AUDIT_DAYS       (default 90)  - audit log entries
 */

const { getPool } = require('./pool');

const BATCH_SIZE = 500;

async function deleteInBatches(pool, sql, params) {
    let totalDeleted = 0;
    // Loop deleting up to BATCH_SIZE rows at a time until nothing's left
    // matching the predicate, rather than one huge DELETE.
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await pool.query(sql, params);
        totalDeleted += res.rowCount;
        if (res.rowCount < BATCH_SIZE) break;
    }
    return totalDeleted;
}

async function cleanupOldRecords({
    jobsDays = parseInt(process.env.RETENTION_JOBS_DAYS || '14', 10),
    executionsDays = parseInt(process.env.RETENTION_EXECUTIONS_DAYS || '30', 10),
    auditDays = parseInt(process.env.RETENTION_AUDIT_DAYS || '90', 10),
} = {}) {
    const pool = getPool();

    const jobsDeleted = await deleteInBatches(
        pool,
        `DELETE FROM jobs WHERE id IN (
            SELECT id FROM jobs
            WHERE status IN ('success', 'failed')
              AND updated_at < now() - ($1 || ' days')::interval
            LIMIT ${BATCH_SIZE}
         )`,
        [jobsDays]
    );

    const executionsDeleted = await deleteInBatches(
        pool,
        `DELETE FROM executions WHERE id IN (
            SELECT id FROM executions
            WHERE created_at < now() - ($1 || ' days')::interval
            LIMIT ${BATCH_SIZE}
         )`,
        [executionsDays]
    );

    const auditDeleted = await deleteInBatches(
        pool,
        `DELETE FROM audit_logs WHERE id IN (
            SELECT id FROM audit_logs
            WHERE created_at < now() - ($1 || ' days')::interval
            LIMIT ${BATCH_SIZE}
         )`,
        [auditDays]
    );

    return { jobsDeleted, executionsDeleted, auditDeleted };
}

module.exports = { cleanupOldRecords };
