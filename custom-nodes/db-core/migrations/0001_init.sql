-- 0001_init.sql
-- Baseline schema for PostgreSQL-only persistence (users, workflows,
-- jobs/executions, system settings, audit logs).
--
-- Conventions:
--   * UUID primary keys (gen_random_uuid(), from pgcrypto) for
--     user-facing/externally-referenced rows.
--   * BIGSERIAL for high-volume append-only rows (audit_logs) where
--     ordering + cheap sequential IDs matter more than opacity.
--   * All timestamps are TIMESTAMPTZ, defaulting to now().
--   * No secrets/tokens are stored in any table here. Credentials stay
--     encrypted inside Node-RED's own credential store (see
--     custom-nodes/credential-manager); this schema only ever
--     references them by opaque ID.
--   * Kept intentionally light on triggers/procedures — this runs on a
--     512MB/0.1CPU instance, migrations should apply fast and cheaply.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    password_hash   TEXT NOT NULL, -- bcrypt/argon2 hash only, never plaintext
    display_name    TEXT,
    preferences     JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (lower(email));

-- ---------------------------------------------------------------------
-- workflows
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflows (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    name                TEXT NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'disabled', 'archived')),
    current_version_id  UUID, -- FK added below, after workflow_versions exists
    -- Credentials are referenced by opaque ID only (Node-RED credential
    -- node IDs) — never a secret value.
    credential_ids      JSONB NOT NULL DEFAULT '[]'::jsonb,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflows_owner_idx ON workflows (owner_id);
CREATE INDEX IF NOT EXISTS workflows_status_idx ON workflows (status);

-- ---------------------------------------------------------------------
-- workflow_versions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,
    -- Lightweight snapshot only (structure/metadata), not intended for
    -- large binary payloads — see rule against storing large binaries.
    definition      JSONB NOT NULL DEFAULT '{}'::jsonb,
    change_note     TEXT,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workflow_id, version_number)
);

CREATE INDEX IF NOT EXISTS workflow_versions_workflow_idx ON workflow_versions (workflow_id);

ALTER TABLE workflows
    DROP CONSTRAINT IF EXISTS workflows_current_version_fk;
ALTER TABLE workflows
    ADD CONSTRAINT workflows_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES workflow_versions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- jobs (PostgreSQL-only queue)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID REFERENCES workflows(id) ON DELETE CASCADE,
    job_type        TEXT NOT NULL,
    -- Optional idempotency/dedup key. Two jobs with the same key can't
    -- both be pending/running at once (see partial unique index below).
    dedupe_key      TEXT,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'success', 'failed')),
    priority        INTEGER NOT NULL DEFAULT 0,
    attempts        INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    available_at    TIMESTAMPTZ NOT NULL DEFAULT now(), -- backoff scheduling
    locked_by       TEXT,
    locked_at       TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Claiming index: workers scan pending/available jobs ordered by
-- priority then age. Low concurrency (single small worker pool) is
-- expected on a 0.1 CPU instance, so this stays a simple btree.
CREATE INDEX IF NOT EXISTS jobs_claim_idx
    ON jobs (status, available_at, priority DESC, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS jobs_workflow_idx ON jobs (workflow_id);
CREATE INDEX IF NOT EXISTS jobs_created_idx ON jobs (created_at);

-- Dedup: only enforced while a dedupe_key is actually pending/running,
-- so completed/failed jobs don't block a later legitimate re-run with
-- the same key.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_active_uidx
    ON jobs (dedupe_key)
    WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'running');

-- ---------------------------------------------------------------------
-- executions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS executions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id          UUID REFERENCES jobs(id) ON DELETE SET NULL,
    workflow_id     UUID REFERENCES workflows(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'success', 'failed')),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    duration_ms     INTEGER,
    error           TEXT,
    -- Small structured metadata only — no large binaries (rendered
    -- video/audio/images stay on ephemeral /tmp, never in Postgres).
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS executions_workflow_idx ON executions (workflow_id);
CREATE INDEX IF NOT EXISTS executions_job_idx ON executions (job_id);
CREATE INDEX IF NOT EXISTS executions_status_idx ON executions (status);
CREATE INDEX IF NOT EXISTS executions_created_idx ON executions (created_at);

-- ---------------------------------------------------------------------
-- system_settings (non-sensitive config/flags only)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- audit_logs (append-only, lightweight, retention-enforced)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     TEXT,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb, -- no secrets/tokens
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);
