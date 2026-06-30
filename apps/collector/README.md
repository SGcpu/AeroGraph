# AeroGraph Collector

The collector is responsible for ingesting, validating, and persisting trace events.

## Configuration

You can configure the collector by creating a `.env` file in this directory based on `.env.example`:

- `PORT`: The port the server listens on (default: 4317)
- `AFR_DB_PATH`: The path to the SQLite database (default: data/afr.sqlite)

## SQLite Storage

The collector uses SQLite for storage to provide zero-configuration local persistence while guaranteeing atomic unique constraints (`UNIQUE(trace_id, span_id)`) to handle concurrent trace event ingestion safely.

## Analytics & Telemetry (v1.1.0)

With schema v1.1.0, the collector supports advanced telemetry indexing:
- **Project & Environment Filtering**: `projectId` and `environment` properties on events are natively indexed. You can filter traces via `GET /v1/traces?projectId=xyz&environment=prod`.
- **Trace Statistics**: The `GET /v1/traces/:id/stats` endpoint provides fast, index-driven aggregations on trace duration, unique actors, total tokens, and a per-model breakdown of GenAI token usage.
