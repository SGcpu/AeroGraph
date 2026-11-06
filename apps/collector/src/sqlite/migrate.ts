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

  // Migration 006: deterministic replay columns & replay_runs table
  const existingCols = new Set((db.prepare("PRAGMA table_info(events)").all() as any[]).map(c => c.name));
  const replayCols: [string, string][] = [
    ["replay_source", "TEXT DEFAULT NULL"],
    ["replay_request_key", "TEXT DEFAULT NULL"],
    ["replay_tokens_saved", "INTEGER DEFAULT NULL"],
    ["replay_latency_ms", "REAL DEFAULT NULL"],
    ["replay_streaming_preserved", "INTEGER DEFAULT NULL"],
    ["replay_overridden", "INTEGER DEFAULT NULL"]
  ];

  for (const [col, def] of replayCols) {
    if (!existingCols.has(col)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${col} ${def};`);
    }
  }

  db.exec(`INSERT OR IGNORE INTO schema_migrations (version) VALUES ('006_replay');`);

  // Ensure replay_runs table always exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_runs (
      run_id          TEXT PRIMARY KEY,
      trace_id        TEXT NOT NULL,
      parent_trace_id TEXT,
      cassette_run_id TEXT,
      mode            TEXT NOT NULL,
      status          TEXT NOT NULL,
      command_json    TEXT NOT NULL,
      project_root    TEXT NOT NULL,
      started_at      TEXT,
      completed_at    TEXT,
      exit_code       INTEGER,
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_replay_runs_trace_id ON replay_runs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_replay_runs_status ON replay_runs(status);
  `);

  // Migration 007: Runtime environment (virtual_env, executable_path, entrypoint)
  const runTableInfo = db.prepare("PRAGMA table_info(replay_runs);").all() as { name: string }[];
  const existingRunCols = new Set(runTableInfo.map((c) => c.name));
  const runEnvCols: [string, string][] = [
    ["virtual_env", "TEXT DEFAULT NULL"],
    ["executable_path", "TEXT DEFAULT NULL"],
    ["entrypoint", "TEXT DEFAULT NULL"]
  ];
  for (const [col, def] of runEnvCols) {
    if (!existingRunCols.has(col)) {
      db.exec(`ALTER TABLE replay_runs ADD COLUMN ${col} ${def};`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_runtime_metadata (
      trace_id        TEXT PRIMARY KEY,
      project_root    TEXT NOT NULL,
      virtual_env     TEXT,
      executable_path TEXT,
      entrypoint      TEXT,
      command_json    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_trace_runtime_metadata_trace_id ON trace_runtime_metadata(trace_id);
  `);

  db.exec(`INSERT OR IGNORE INTO schema_migrations (version) VALUES ('007_runtime_environment');`);

  // Ensure any legacy or replay derivations have valid forked_from_span_id (min(1) in contracts)
  db.exec(`UPDATE trace_derivations SET forked_from_span_id = 'root' WHERE forked_from_span_id = '' OR forked_from_span_id IS NULL;`);
}


