'use strict';

/**
 * node-red-render-db-core
 *
 * Shared PostgreSQL persistence layer for this app — pool/query
 * helpers, migrations, job queue, retention, audit logging, and a
 * health check. Installed as a local `file:` dependency (same pattern
 * as custom-nodes/credential-manager) so it's usable both from
 * settings.js / scripts/*.js (plain `require('node-red-render-db-core')`)
 * and from custom Node-RED nodes.
 *
 * PostgreSQL (DB_POSTGRESDB_CONNECTION_URL) is the ONLY persistent
 * storage this module talks to. No Redis, no local filesystem state.
 */

const pool = require('./pool');
const migrate = require('./migrate');
const jobs = require('./jobs');
const retention = require('./retention');
const health = require('./health');
const audit = require('./audit');

module.exports = {
    ...pool,
    ...migrate,
    jobs,
    retention,
    health,
    audit,
};
