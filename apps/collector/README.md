# AeroGraph Collector & Orchestrator

The collector is the central backend service for AeroGraph. It is responsible for ingesting, validating, and persisting trace events, computing lineage and diff graphs, and orchestrating deterministic replay runs and live fork-and-resume workflows.

---

## Dual Architecture

When started, `apps/collector` runs two distinct services concurrently:

1. **Collector Service (Port 4317)**:
   - Ingestion of normalized trace events via `POST /v1/events`.
   - OpenTelemetry OTLP span ingestion via `POST /v1/otlp/traces`.
   - Trace querying, lineage graph reconstruction, and token usage analytics.
   - Deterministic Myers diffing between ancestor and derived traces.
   - Loop detection and failure root-cause analysis.

2. **Deterministic Replay Orchestrator (Port 4318)**:
   - Spawns and supervises background agent runs using `aerograph-replay-core`.
   - Manages interactive stepping REPL sessions (`/v1/sessions`).
   - Slices network cassettes for 1-click **Fork-and-Resume** (`/v1/traces/:id/fork-and-resume`).
   - Slices pre-fork steps to serve from cache with zero token cost and resumes live execution for post-fork steps.

---

## Starting the Service

```bash
# Start both Collector (4317) and Orchestrator (4318):
npm run dev -w apps/collector

# Or build and run production bundle:
npm run build -w apps/collector
node apps/collector/dist/index.js
```

---

## Configuration

Configure the collector via environment variables or a `.env` file:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4317` | HTTP port for the Collector ingestion API |
| `ORCHESTRATOR_PORT` | `4318` | HTTP port for the Deterministic Replay Orchestrator |
| `AFR_DB_PATH` | `data/afr.sqlite` | Filepath to the SQLite database |
| `REPLAY_CORE_BIN` | auto-detected | Path to the compiled `aerograph-replay-core` binary |
| `NODE_ENV` | `development` | Runtime environment (`development`, `production`, `test`) |

---

## SQLite Storage & Migrations

AeroGraph uses local SQLite for zero-configuration persistence with strict atomic constraints (`UNIQUE(trace_id, span_id)`):

- **Additive Schema Migrations**:
  - `001_initial`: Base `events` table with normalized event types.
  - `002_lineage`: Lineage tracking and parent/child relationship edges.
  - `003_metadata`: Trace summary metadata and bookmarks.
  - `004_telemetry`: Project/environment indexing and token usage columns.
  - `005_otlp`: OpenTelemetry mapping indexes.
  - `006_replay`: Additive tables for replay runs, sessions, and cassette references.

---

## API Endpoints

### Collector Service (`http://localhost:4317`)

| Endpoint | Method | Description |
|---|---|---|
| `/v1/events` | `POST` | Ingest single or batch trace events |
| `/v1/traces` | `GET` | Query traces with `?projectId=` and `?environment=` filtering |
| `/v1/traces/:id` | `GET` | Get trace details and sorted events |
| `/v1/traces/:id/lineage` | `GET` | Retrieve complete lineage graph |
| `/v1/traces/:aId/diff/:bId` | `GET` | Compute deterministic Myers diff between two traces |
| `/v1/traces/:id/analysis` | `GET` | Analyze loops and execution failures |
| `/v1/traces/:id/stats` | `GET` | Trace analytics (duration, token usage, model breakdown) |
| `/v1/otlp/traces` | `POST` | Ingest OpenTelemetry OTLP JSON spans |
| `/health` | `GET` | Service health status |

### Orchestrator Engine (`http://localhost:4318`)

| Endpoint | Method | Description |
|---|---|---|
| `/v1/traces/:id/fork-and-resume` | `POST` | Execute 1-click fork: slice cassette, run replay, resume live, compute divergence diff |
| `/v1/traces/:id/fork` | `POST` | Create a child trace reference linked to a specific span |
| `/v1/traces/:id/replay` | `POST` | Replay an existing trace using its recorded cassette |
| `/v1/runs` | `POST` | Start a background agent run |
| `/v1/runs/:id` | `GET` | Get status, exit code, and trace reference of a run |
| `/v1/sessions` | `POST` | Create an interactive step session |
| `/v1/sessions/:id` | `GET` | Get current session state |
| `/v1/sessions/:id/action` | `POST` | Dispatch session action (`step`, `inspect`, `override`, `rewind`, `fork`) |
| `/v1/sessions/:id` | `DELETE` | Terminate session and cleanup processes |
| `/v1/cassettes/:id` | `GET` | Fetch recorded network cassette JSON |

---

## Related Documentation

- [Deterministic Replay Getting Started](../../docs/replay/getting-started.md)
- [Safety Policy Guide](../../docs/replay/safety-policy.md)
- [Web UI Dashboard](../web/README.md)
- [CLI (`aerorepl`)](../../packages/aerorepl/README.md)
