'use strict';

/**
 * jobs.js
 *
 * PostgreSQL-only job queue (no Redis / external broker). Designed
 * for low concurrency — a single Render Free instance with 0.1 CPU
 * has no meaningful parallelism, so this optimizes for correctness
 * (safe claiming, no double-processing) over throughput.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, the standard Postgres
 * pattern for a queue table: multiple workers/processes can call
 * claimNextJob() concurrently and each gets a different row, with no
 * risk of two workers claiming the same job.
 */

const { getPool, withTransaction } = require('./pool');

/** Enqueues a job. If dedupeKey matches an already pending/running job, this is a no-op. */
async function enqueueJob({
    workflowId = null,
    jobType,
    payload = {},
    dedupeKey = null,
    priority = 0,
    maxAttempts = 5,
    availableAt = null,
}) {
    if (!jobType) throw new Error('enqueueJob requires jobType');
    const pool = getPool();
    const res = await pool.query(
        `INSERT INTO jobs (workflow_id, job_type, payload, dedupe_key, priority, max_attempts, available_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, COALESCE($7, now()))
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running')
         DO NOTHING
         RETURNING id`,
        [workflowId, jobType, JSON.stringify(payload), dedupeKey, priority, maxAttempts, availableAt]
    );
    return res.rows[0] ? res.rows[0].id : null; // null => deduplicated (already queued)
}

/** Atomically claims the next available job for `workerId`, or null if none is ready. */
async function claimNextJob(workerId) {
    return withTransaction(async (client) => {
        const res = await client.query(
            `UPDATE jobs
             SET status = 'running',
                 locked_by = $1,
                 locked_at = now(),
                 attempts = attempts + 1,
                 updated_at = now()
             WHERE id = (
                 SELECT id FROM jobs
                 WHERE status = 'pending' AND available_at <= now()
                 ORDER BY priority DESC, created_at ASC
                 FOR UPDATE SKIP LOCKED
                 LIMIT 1
             )
             RETURNING *`,
            [workerId]
        );
        return res.rows[0] || null;
    });
}

function backoffDelaySeconds(attempts) {
    // Exponential backoff capped at ~15 minutes: 2^attempts seconds.
    return Math.min(2 ** attempts, 900);
}

/** Marks a claimed job as successfully completed. */
async function completeJob(jobId) {
    const pool = getPool();
    await pool.query(
        `UPDATE jobs SET status = 'success', locked_by = NULL, locked_at = NULL, updated_at = now()
         WHERE id = $1`,
        [jobId]
    );
}

/** Marks a claimed job as failed for this attempt — retries with backoff, or terminal failure past max_attempts. */
async function failJob(jobId, errorMessage) {
    const pool = getPool();
    const res = await pool.query('SELECT attempts, max_attempts FROM jobs WHERE id = $1', [jobId]);
    if (!res.rows[0]) return;
    const { attempts, max_attempts: maxAttempts } = res.rows[0];

    if (attempts < maxAttempts) {
        const delay = backoffDelaySeconds(attempts);
        await pool.query(
            `UPDATE jobs
             SET status = 'pending', locked_by = NULL, locked_at = NULL,
                 available_at = now() + ($2 || ' seconds')::interval,
                 last_error = $3, updated_at = now()
             WHERE id = $1`,
            [jobId, delay, String(errorMessage).slice(0, 2000)]
        );
    } else {
        await pool.query(
            `UPDATE jobs
             SET status = 'failed', locked_by = NULL, locked_at = NULL,
                 last_error = $2, updated_at = now()
             WHERE id = $1`,
            [jobId, String(errorMessage).slice(0, 2000)]
        );
    }
}

/**
 * Crash recovery: on startup, any job left stuck in 'running' from a
 * previous process that died mid-execution (container OOM/restart) is
 * put back to 'pending' so it gets retried instead of vanishing.
 */
async function recoverStaleJobs(staleMinutes = 15) {
    const pool = getPool();
    const res = await pool.query(
        `UPDATE jobs
         SET status = 'pending', locked_by = NULL, locked_at = NULL,
             last_error = COALESCE(last_error, 'Recovered after process restart'),
             updated_at = now()
         WHERE status = 'running' AND locked_at < now() - ($1 || ' minutes')::interval
         RETURNING id`,
        [staleMinutes]
    );
    return res.rows.length;
}

module.exports = { enqueueJob, claimNextJob, completeJob, failJob, recoverStaleJobs, backoffDelaySeconds };
