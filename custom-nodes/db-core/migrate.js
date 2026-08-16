'use strict';

/**
 * migrate.js
 *
 * Minimal, dependency-free migration runner. Applies every *.sql file
 * in migrations/ (sorted by filename) that isn't already recorded in
 * schema_migrations, each inside its own transaction. Idempotent and
 * safe to run on every boot.
 */

const fs = require('fs');
const path = require('path');
const { getPool, safeDescribeConnection } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const REQUIRED_TABLES = [
    'users',
    'workflows',
    'workflow_versions',
    'jobs',
    'executions',
    'system_settings',
    'audit_logs',
];

async function ensureMigrationsTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

function listMigrationFiles() {
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
}

async function getAppliedMigrations(client) {
    const res = await client.query('SELECT name FROM schema_migrations');
    return new Set(res.rows.map((r) => r.name));
}

/** Applies all pending migrations. Returns the list of migration names applied. */
async function migrate() {
    const pool = getPool();
    const client = await pool.connect();
    const applied = [];
    try {
        await ensureMigrationsTable(client);
        const already = await getAppliedMigrations(client);
        const files = listMigrationFiles();

        for (const file of files) {
            if (already.has(file)) continue;
            const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
                await client.query('COMMIT');
                applied.push(file);
                console.log(`[db-migrate] Applied ${file}`);
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                throw new Error(`Migration ${file} failed: ${err.message}`);
            }
        }
        return applied;
    } finally {
        client.release();
    }
}

/** Verifies every table this app depends on actually exists after migrating. */
async function verifySchema() {
    const pool = getPool();
    const res = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const present = new Set(res.rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    if (missing.length) {
        throw new Error(`Schema verification failed — missing tables: ${missing.join(', ')}`);
    }
    return true;
}

/**
 * Connects with retry + exponential backoff. Used at startup so a
 * Postgres instance that's still spinning up (or a transient network
 * blip) doesn't immediately hard-fail the whole container.
 */
async function connectWithRetry({ maxAttempts = 5, baseDelayMs = 1000 } = {}) {
    const pool = getPool();
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const client = await pool.connect();
            client.release();
            return;
        } catch (err) {
            lastErr = err;
            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            console.error(
                `[db-migrate] Connection attempt ${attempt}/${maxAttempts} to ` +
                    `${safeDescribeConnection(process.env.DB_POSTGRESDB_CONNECTION_URL || '')} ` +
                    `failed: ${err.message}`
            );
            if (attempt < maxAttempts) {
                console.log(`[db-migrate] Retrying in ${delay}ms...`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    throw new Error(`Could not connect to PostgreSQL after ${maxAttempts} attempts: ${lastErr.message}`);
}

module.exports = { migrate, verifySchema, connectWithRetry, REQUIRED_TABLES };
