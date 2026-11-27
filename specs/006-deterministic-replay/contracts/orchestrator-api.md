# Orchestrator API Contract

**Feature 006 — Phase 1 Contracts**
**Port**: `4318` (default)
**Base URL**: `http://localhost:4318`

---

## Overview

The Replay Orchestrator exposes a REST API over localhost for:
1. Starting / monitoring record and replay runs
2. Querying run status and history
3. Being called by the Web UI and `aerorepl` CLI

All endpoints return `application/json`. Authentication is not required (localhost-only).

---

## Endpoints

### `GET /health`

Health check.

**Response 200**
```json
{ "ok": true }
```

---

### `POST /v1/runs`

Start a new record, replay, or fork run.

**Request Body** (see `startRunRequestSchema` in `data-model.md`)
```json
{
  "mode": "record" | "replay" | "fork",
  "command": ["python", "agent.py"],          // required for record
  "cassetteRunId": "run-abc123",              // required for replay and fork
  "forkFromSpanId": "s_xyz",                 // required for fork
  "forkOverrides": { "promptText": "..." },  // optional for fork
  "projectRoot": "/path/to/project"          // defaults to cwd of Orchestrator
}
```

**Response 201**
```json
{
  "runId": "run-01j9z3...",
  "traceId": "t_nid83...",
  "status": "pending"
}
```

**Response 400** — missing required fields, invalid mode
```json
{ "error": "mode 'fork' requires cassetteRunId and forkFromSpanId" }
```

---

### `GET /v1/runs`

List all runs in reverse chronological order.

**Response 200**
```json
{
  "runs": [
    {
      "runId": "run-01j9z3...",
      "traceId": "t_nid83...",
      "parentTraceId": null,
      "cassetteRunId": null,
      "status": "completed",
      "mode": "record",
      "startedAt": "2026-09-01T00:00:00Z",
      "completedAt": "2026-09-01T00:00:42Z",
      "exitCode": 0,
      "errorMessage": null
    }
  ]
}
```

---

### `GET /v1/runs/:runId`

Get a single run by ID.

**Response 200** — same shape as run entry in list

**Response 404**
```json
{ "error": "Run not found: run-abc123" }
```

---

### `POST /v1/runs/:runId/cancel`

Cancel a running process (sends SIGTERM).

**Response 200**
```json
{ "ok": true }
```

**Response 400**
```json
{ "error": "Run is not in running state" }
```

---

## Collector Extensions

The following endpoints are added to the **Collector** (port 4317), **not** the Orchestrator:

### `POST /v1/traces/:traceId/replay`

Trigger replay of a trace that was produced by a record run.

**Request Body**
```json
{
  "cassetteRunId": "run-abc123"   // optional: override linked cassette
}
```

**Response 201**
```json
{
  "runId": "run-zzz...",
  "traceId": "t_new...",
  "status": "pending"
}
```

**Response 404** — trace not found
**Response 409** — trace has no linked cassette and `cassetteRunId` not provided

---

### `POST /v1/traces/:traceId/fork-and-resume`

Fork an existing trace at a given span and auto-resume the agent.
**Extends** the existing `POST /v1/traces/:traceId/fork` behavior — after creating the child trace record, the Orchestrator is called to start the agent.

**Request Body** (see `forkAndResumeRequestSchema`)
```json
{
  "forkFromSpanId": "s_xyz",
  "overrides": { "promptText": "Alternative prompt" }
}
```

**Response 201**
```json
{
  "childTraceId": "t_fork...",
  "runId": "run-yyy...",
  "status": "running"
}
```

**Response 400** — span not found, invalid request
**Response 404** — base trace not found
**Response 409** — no agent command configured (missing `aerograph.project.yaml`)

---

## `aerorepl` CLI → Orchestrator Mapping

| `aerorepl` Command | Orchestrator Call |
|-------------------|------------------|
| `aerorepl record <cmd...>` | `POST /v1/runs { mode: "record", command: [...] }` |
| `aerorepl replay <runId>` | `POST /v1/runs { mode: "replay", cassetteRunId: runId }` |
| `aerorepl list` | `GET /v1/runs` |
| `aerorepl status <runId>` | `GET /v1/runs/<runId>` |
| `aerorepl cancel <runId>` | `POST /v1/runs/<runId>/cancel` |

---

## Web UI → API Mapping

| UI Action | API Call |
|-----------|---------|
| Click "⑂ Fork and Resume" | `POST /v1/traces/:id/fork-and-resume` |
| Click "▶ Replay Trace" | `POST /v1/traces/:id/replay` |
| Replay status badge | Polled from `GET /v1/runs/:runId` every 2s |
| Run history list (new panel) | `GET /v1/runs` |
