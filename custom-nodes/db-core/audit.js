'use strict';

/**
 * audit.js
 *
 * Thin helper for writing structured audit log rows. `details` is
 * expected to be small, non-sensitive JSON (no tokens, passwords, or
 * credential values) — this is an app-level convention this helper
 * doesn't enforce automatically, so callers are responsible for not
 * passing secrets in.
 */

const { getPool } = require('./pool');

async function recordAuditLog({ userId = null, action, resourceType = null, resourceId = null, details = {}, ipAddress = null }) {
    if (!action) throw new Error('recordAuditLog requires an action');
    const pool = getPool();
    await pool.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, details, ip_address)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [userId, action, resourceType, resourceId, JSON.stringify(details), ipAddress]
    );
}

module.exports = { recordAuditLog };
