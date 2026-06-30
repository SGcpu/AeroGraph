import type { Database } from "better-sqlite3";

export function runMigrations(db: Database): void {
  // We use STRICT mode for better type safety if supported, but standard works too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      occurred_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      event_data TEXT NOT NULL,
      UNIQUE(trace_id, span_id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_trace_id ON events(trace_id);

    CREATE TABLE IF NOT EXISTS trace_derivations (
      child_trace_id TEXT PRIMARY KEY,
      parent_trace_id TEXT NOT NULL,
      forked_from_span_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      overrides_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trace_derivations_parent_trace_id ON trace_derivations(parent_trace_id);
    CREATE INDEX IF NOT EXISTS idx_trace_derivations_created_at ON trace_derivations(created_at);
  `);

  // Migration 005: canonical telemetry columns (schema v1.1.0)
  // Guarded by schema_migrations table — safe to re-run on existing databases.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT    PRIMARY KEY,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const already = db
    .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
    .get("005_telemetry");

  if (!already) {
    db.exec(`
      ALTER TABLE events ADD COLUMN model_name     TEXT    DEFAULT NULL;
      ALTER TABLE events ADD COLUMN model_provider TEXT    DEFAULT NULL;
      ALTER TABLE events ADD COLUMN model_version  TEXT    DEFAULT NULL;
      ALTER TABLE events ADD COLUMN usage_input_tokens   INTEGER DEFAULT NULL;
      ALTER TABLE events ADD COLUMN usage_output_tokens  INTEGER DEFAULT NULL;
      ALTER TABLE events ADD COLUMN usage_total_tokens   INTEGER DEFAULT NULL;
      ALTER TABLE events ADD COLUMN usage_cached_tokens  INTEGER DEFAULT NULL;
      ALTER TABLE events ADD COLUMN duration_ms          INTEGER DEFAULT NULL;
      ALTER TABLE events ADD COLUMN project_id           TEXT    DEFAULT NULL;
      ALTER TABLE events ADD COLUMN environment          TEXT    DEFAULT NULL;
      ALTER TABLE events ADD COLUMN tags_json            TEXT    DEFAULT NULL;

      CREATE INDEX IF NOT EXISTS idx_events_project_env
          ON events (project_id, environment);
      CREATE INDEX IF NOT EXISTS idx_events_model_name
          ON events (model_name);
      CREATE INDEX IF NOT EXISTS idx_events_duration_ms
          ON events (duration_ms);
      CREATE INDEX IF NOT EXISTS idx_events_total_tokens
          ON events (usage_total_tokens);
      CREATE INDEX IF NOT EXISTS idx_events_trace_tokens
          ON events (trace_id, usage_total_tokens);

      INSERT OR IGNORE INTO schema_migrations (version) VALUES ('005_telemetry');
    `);
  }
}
