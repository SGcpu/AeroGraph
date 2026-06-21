-- Migration 005: Canonical Telemetry Model Enrichment (schema v1.1.0)
--
-- Adds telemetry columns to the `events` table for:
--   model_name, model_provider, model_version  (model identity)
--   usage_input_tokens, usage_output_tokens,
--   usage_total_tokens, usage_cached_tokens    (token usage)
--   duration_ms                                (span execution duration)
--   project_id                                 (multi-tenant isolation)
--   environment                                (deployment context)
--   tags_json                                  (arbitrary kv telemetry tags, stored as JSON)
--
-- Backward compatibility:
--   All new columns default to NULL.
--   Existing v1.0.0 events remain fully readable and replayable.
--   NULL is serialized as missing/N-A in the API response.
--
-- Indexing strategy:
--   Composite index on (project_id, environment) for multi-tenant filtering.
--   Individual indexes on model_name, duration_ms, usage_total_tokens
--   to support sub-500ms analytics queries over 100k+ events.
--
-- NOTE: This migration is idempotent (uses IF NOT EXISTS for indexes).
--       Column additions use ALTER TABLE which is safe to re-run only once;
--       guard with the schema_migrations table (see below).

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema migrations tracking table (idempotent)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT    PRIMARY KEY,
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Model identity columns
-- ─────────────────────────────────────────────────────────────────────────────

-- Model name (e.g. "gpt-4o", "claude-3-sonnet-20240229")
ALTER TABLE events ADD COLUMN model_name     TEXT    DEFAULT NULL;

-- Model provider (e.g. "openai", "anthropic", "google")
ALTER TABLE events ADD COLUMN model_provider TEXT    DEFAULT NULL;

-- Model version string (e.g. "2024-05-13")
ALTER TABLE events ADD COLUMN model_version  TEXT    DEFAULT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Token usage columns
-- ─────────────────────────────────────────────────────────────────────────────

-- Number of input (prompt) tokens
ALTER TABLE events ADD COLUMN usage_input_tokens   INTEGER DEFAULT NULL;

-- Number of output (completion) tokens
ALTER TABLE events ADD COLUMN usage_output_tokens  INTEGER DEFAULT NULL;

-- Total tokens (input + output); pre-computed for efficient SUM() aggregations
ALTER TABLE events ADD COLUMN usage_total_tokens   INTEGER DEFAULT NULL;

-- Tokens served from cache (not available from all frameworks; NULL = unknown)
ALTER TABLE events ADD COLUMN usage_cached_tokens  INTEGER DEFAULT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Execution duration
-- ─────────────────────────────────────────────────────────────────────────────

-- Span wall-clock duration in milliseconds
ALTER TABLE events ADD COLUMN duration_ms          INTEGER DEFAULT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Project and environment context
-- ─────────────────────────────────────────────────────────────────────────────

-- Project identifier for multi-tenant isolation
ALTER TABLE events ADD COLUMN project_id           TEXT    DEFAULT NULL;

-- Deployment environment (e.g. "development", "staging", "production")
ALTER TABLE events ADD COLUMN environment          TEXT    DEFAULT NULL;

-- Arbitrary key-value telemetry tags stored as a JSON object string.
-- Example: '{"agent_version":"1.2","region":"us-east-1"}'
ALTER TABLE events ADD COLUMN tags_json            TEXT    DEFAULT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes for analytics performance (100k+ events @ sub-500ms target)
-- ─────────────────────────────────────────────────────────────────────────────

-- Composite index for multi-tenant project/environment filtering (most common query)
CREATE INDEX IF NOT EXISTS idx_events_project_env
    ON events (project_id, environment);

-- Index for model-level analytics and breakdown queries
CREATE INDEX IF NOT EXISTS idx_events_model_name
    ON events (model_name);

-- Index for duration-based sorting and percentile analytics
CREATE INDEX IF NOT EXISTS idx_events_duration_ms
    ON events (duration_ms);

-- Index for token-level aggregations (SUM, ORDER BY)
CREATE INDEX IF NOT EXISTS idx_events_total_tokens
    ON events (usage_total_tokens);

-- Composite covering index for full trace-level token rollup queries:
-- SELECT trace_id, SUM(usage_total_tokens) FROM events GROUP BY trace_id
CREATE INDEX IF NOT EXISTS idx_events_trace_tokens
    ON events (trace_id, usage_total_tokens);

-- ─────────────────────────────────────────────────────────────────────────────
-- Record migration applied
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO schema_migrations (version) VALUES ('005_telemetry');
