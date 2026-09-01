# Data Model: Deterministic Replay for AeroGraph via agrepl Integration

**Feature 006 — Phase 1 Design Artifact**
**Date**: 2026-09-01

---

## 1. Schema Extensions (Canonical Contracts — `packages/contracts/src/index.ts`)

All new fields are optional/nullable to preserve backward compatibility per Constitution Principle I.

### 1.1 New Discriminated Union Member: `replaySourceSchema`

```typescript
export const replaySourceSchema = z.enum(["cache", "live"]);
export type ReplaySource = z.infer<typeof replaySourceSchema>;
```

### 1.2 New Base Event Extension: `replayMetaSchema`

Applied to `baseEventSchema` as all-optional fields:

```typescript
export const replayMetaSchema = z.object({
  /** "cache" = served from cassette, "live" = real network call. Null if not a replay run. */
  replaySource: replaySourceSchema.nullable().optional(),
  /** SHA-256 content key K(method ‖ normalizedUrl ‖ bodyHash) used for cassette lookup. */
  requestKey: z.string().nullable().optional(),
  /** Estimated tokens saved vs. a live call. Null for live calls or non-LLM spans. */
  tokensSaved: z.number().int().nonnegative().nullable().optional(),
  /** Wall-clock time in ms to hydrate this span from cassette. Null for live calls. */
  replayLatencyMs: z.number().nonnegative().nullable().optional(),
  /** False if streaming chunks could not be preserved individually in the cassette. */
  streamingPreserved: z.boolean().nullable().optional(),
  /** True if this span's response was manually overridden by aerorepl /override. */
  overridden: z.boolean().nullable().optional()
});
```

> **NOTE**: These fields are added to `baseEventSchema` via `.extend()`. The schema version remains `"1.1.0"` — these additions are backward-compatible (all optional). A new migration `006_replay` adds corresponding SQLite columns.

### 1.3 Updated `TraceMeta`

No changes needed. `derivedFrom` already exists and is sufficient for lineage.

---

## 2. New Schemas: Cassette

Cassette schemas live in a new `packages/contracts/src/cassette.ts` file, exported from `index.ts`.

### 2.1 `CassetteEntrySchema`

```typescript
export const cassetteEntrySchema = z.object({
  /** Content-derived key: SHA256(method + normalizedUrl + SHA256(body)) */
  requestKey: z.string().min(1),
  method: z.string().min(1),
  normalizedUrl: z.string().min(1),
  /** SHA256 of the request body. Empty string for GET/HEAD. */
  requestBodyHash: z.string(),
  responseStatus: z.number().int(),
  responseHeaders: z.record(z.string(), z.string()),
  /**
   * If streamingPreserved=true: array of SSE/chunk strings in order.
   * If streamingPreserved=false: single-element array containing full concatenated body.
   */
  responseChunks: z.array(z.string()),
  streamingPreserved: z.boolean(),
  recordedAt: z.string().datetime(),
  /** AeroGraph span ID that triggered this request. Null if correlation failed. */
  correlatedSpanId: z.string().nullable()
});
export type CassetteEntry = z.infer<typeof cassetteEntrySchema>;
```

### 2.2 `CassetteSchema`

```typescript
export const cassetteSchema = z.object({
  /** Schema version for the cassette format itself. */
  cassetteVersion: z.literal("1.0.0"),
  /** The AeroGraph run ID (also the cassette file name base). */
  runId: z.string().min(1),
  /** The AeroGraph trace ID produced during the record run. */
  traceId: z.string().min(1),
  /** The shell command that was wrapped. */
  command: z.array(z.string()),
  recordedAt: z.string().datetime(),
  entries: z.array(cassetteEntrySchema)
});
export type Cassette = z.infer<typeof cassetteSchema>;
```

**Storage**: `.aerograph/cassettes/<runId>.json`

---

## 3. New Schemas: Tool Safety Policy (`aerograph.replay.yaml`)

```typescript
export const safetyClassSchema = z.enum(["replay_safe", "must_execute"]);
export type SafetyClass = z.infer<typeof safetyClassSchema>;

export const safetyRuleSchema = z.object({
  /** Glob pattern matched against the full URL (protocol included). */
  match: z.string().min(1),
  /** Optional additional tool name matcher. */
  toolName: z.string().optional(),
  class: safetyClassSchema
});
export type SafetyRule = z.infer<typeof safetyRuleSchema>;

export const toolSafetyPolicySchema = z.object({
  tools: z.array(safetyRuleSchema)
});
export type ToolSafetyPolicy = z.infer<typeof toolSafetyPolicySchema>;
```

---

## 4. New Schemas: Orchestrator API

Schemas for the Replay Orchestrator's HTTP API (consumed by web UI and aerorepl). These live in `packages/contracts/src/orchestrator.ts`.

### 4.1 `StartRunRequest` / `StartRunResponse`

```typescript
export const runModeSchema = z.enum(["record", "replay", "fork"]);
export type RunMode = z.infer<typeof runModeSchema>;

export const runStatusSchema = z.enum(["pending", "running", "completed", "failed", "crashed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const startRunRequestSchema = z.object({
  mode: runModeSchema,
  /** Required for record: command to run (e.g. ["python", "agent.py"]) */
  command: z.array(z.string()).optional(),
  /** Required for replay and fork: existing cassette run ID */
  cassetteRunId: z.string().optional(),
  /** Required for fork: span ID at which to fork */
  forkFromSpanId: z.string().optional(),
  /** Optional for fork: prompt override at fork span */
  forkOverrides: z.object({ promptText: z.string().optional() }).optional(),
  /** Optional: override default project root */
  projectRoot: z.string().optional()
});

export const startRunResponseSchema = z.object({
  runId: z.string().min(1),
  traceId: z.string().min(1),
  status: runStatusSchema
});
```

### 4.2 `GetRunResponse`

```typescript
export const getRunResponseSchema = z.object({
  runId: z.string().min(1),
  traceId: z.string().min(1),
  parentTraceId: z.string().nullable(),
  cassetteRunId: z.string().nullable(),
  status: runStatusSchema,
  mode: runModeSchema,
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  errorMessage: z.string().nullable()
});
```

### 4.3 `ReplayTraceRequest` / `ForkAndResumeRequest`

```typescript
/** POST /v1/traces/:traceId/replay — triggers replay of an existing recorded trace. */
export const replayTraceRequestSchema = z.object({
  /** If omitted, replay uses the cassette linked to this trace (from run record). */
  cassetteRunId: z.string().optional()
});

/** POST /v1/traces/:traceId/fork-and-resume — extends existing fork logic with auto-resume. */
export const forkAndResumeRequestSchema = z.object({
  forkFromSpanId: z.string().min(1),
  overrides: z.object({ promptText: z.string().optional() }).optional()
});

export const forkAndResumeResponseSchema = z.object({
  childTraceId: z.string().min(1),
  runId: z.string().min(1),
  status: runStatusSchema
});
```

---

## 5. SQLite Schema Changes (Migration 006_replay)

New columns on the `events` table:

```sql
ALTER TABLE events ADD COLUMN replay_source     TEXT    DEFAULT NULL; -- "cache" | "live"
ALTER TABLE events ADD COLUMN request_key       TEXT    DEFAULT NULL;
ALTER TABLE events ADD COLUMN tokens_saved      INTEGER DEFAULT NULL;
ALTER TABLE events ADD COLUMN replay_latency_ms REAL    DEFAULT NULL;
ALTER TABLE events ADD COLUMN streaming_preserved INTEGER DEFAULT NULL; -- 0/1 boolean
ALTER TABLE events ADD COLUMN overridden        INTEGER DEFAULT NULL; -- 0/1 boolean
```

New tables:

```sql
-- Links a record/replay run to its cassette and output trace.
CREATE TABLE IF NOT EXISTS replay_runs (
  run_id          TEXT PRIMARY KEY,
  trace_id        TEXT NOT NULL,
  parent_trace_id TEXT,           -- set for fork runs
  cassette_run_id TEXT,           -- null for record runs before cassette exists
  mode            TEXT NOT NULL,  -- record | replay | fork
  status          TEXT NOT NULL,  -- pending | running | completed | failed | crashed
  command_json    TEXT NOT NULL,  -- JSON array
  project_root    TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  exit_code       INTEGER,
  error_message   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_replay_runs_trace_id ON replay_runs(trace_id);
CREATE INDEX IF NOT EXISTS idx_replay_runs_status ON replay_runs(status);
```

---

## 6. Project Configuration: `aerograph.project.yaml`

Stored at the developer's project root. Not in the AeroGraph monorepo itself.

```yaml
# aerograph.project.yaml — AeroGraph project configuration
# JSON Schema: https://schema.aerograph.dev/project/v1.json

version: "1"

# The shell command to invoke your agent. Required for replay and fork-and-resume.
# Use array form for safety (no shell interpolation).
command:
  - python
  - agent.py

# Path to the collector (defaults to http://localhost:4317)
collector: "http://localhost:4317"

# Path to the Replay Orchestrator (defaults to http://localhost:4318)
orchestrator: "http://localhost:4318"
```

---

## 7. Entity State Transitions

### Run Session State Machine

```
pending → running → completed
         ↘         
          → failed
          → crashed
```

- **pending**: `POST /v1/runs` accepted, process not yet started
- **running**: `child_process.spawn()` called, PID assigned
- **completed**: process exited with code 0
- **failed**: process exited with non-zero code
- **crashed**: process killed by signal or Orchestrator-detected error (e.g. missing cassette)

### Replay Routing Decision (per request, not persisted separately)

Computed at request time and written as a span annotation:
- `cache` — cassette hit, `replay_safe` (or unclassified replayed in fallback mode)
- `live` — real network call (not in cassette, in fallback mode)
- `must_execute_override` — cassette hit exists but policy requires live execution
- `fallback` — cache miss, forwarded live because `--fallback` is active
