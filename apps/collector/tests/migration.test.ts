import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/sqlite/migrate";
import { SqliteTraceStore } from "../src/sqliteStore";

describe("Migration Validation Suite", () => {
  it("verifies older traces remain readable and default to NULL after schema migration", () => {
    const db = new Database(":memory:");

    // Create v1.0.0 events table structure manually matching the exact original schema
    db.exec(`
      CREATE TABLE events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id        TEXT    NOT NULL,
        span_id         TEXT    NOT NULL,
        parent_span_id  TEXT,
        occurred_at     TEXT    NOT NULL,
        kind            TEXT    NOT NULL,
        event_data      TEXT    NOT NULL,
        UNIQUE(trace_id, span_id)
      );
    `);

    // Seed v1.0.0 legacy event
    const legacyEvent = {
      schemaVersion: "1.0.0",
      traceId: "t_legacy_999",
      spanId: "s_legacy_999",
      parentSpanId: null,
      occurredAt: "2026-05-20T00:00:00.000Z",
      actor: { kind: "agent", id: "assistant" },
      status: "ok",
      kind: "prompt",
      payload: { text: "hello old world" },
      links: []
    };

    db.prepare(`
      INSERT INTO events (trace_id, span_id, parent_span_id, occurred_at, kind, event_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      legacyEvent.traceId,
      legacyEvent.spanId,
      legacyEvent.parentSpanId,
      legacyEvent.occurredAt,
      legacyEvent.kind,
      JSON.stringify(legacyEvent)
    );

    // Apply migrations (runs 005_telemetry.sql migration via migrate.ts)
    runMigrations(db);

    // Verify columns were added with NULL defaults
    const row = db.prepare("SELECT * FROM events WHERE trace_id = 't_legacy_999'").get() as any;
    expect(row.model_name).toBeNull();
    expect(row.project_id).toBeNull();
    expect(row.duration_ms).toBeNull();
    expect(row.usage_total_tokens).toBeNull();

    // Verify SqliteTraceStore can read the legacy event successfully
    const store = new SqliteTraceStore(db);
    const trace = store.getTrace("t_legacy_999");
    expect(trace).not.toBeNull();
    expect(trace!.events[0].traceId).toBe("t_legacy_999");
    expect((trace!.events[0] as any).projectId).toBeUndefined(); // defaults to undefined on contract parse

    // Verify SqliteTraceStore can write and read new v1.1.0 events in the migrated DB
    const newEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_new_111",
      spanId: "s_new_111",
      parentSpanId: null,
      occurredAt: "2026-05-20T00:01:00.000Z",
      actor: { kind: "agent", id: "assistant" },
      status: "ok",
      kind: "response",
      projectId: "proj-1",
      environment: "production",
      durationMs: 150,
      payload: {
        text: "hello new world",
        model: { name: "gpt-4" },
        usage: { totalTokens: 15 }
      },
      links: []
    };

    store.appendEvent(newEvent as any);
    const newTrace = store.getTrace("t_new_111");
    expect(newTrace).not.toBeNull();
    expect(newTrace!.meta.projectId).toBe("proj-1");
    expect(newTrace!.meta.environment).toBe("production");

    db.close();
  });
});
