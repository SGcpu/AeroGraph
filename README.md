# AeroGraph

An open-source flight recorder for AI agent workflows: local-first, append-only, and replay-safe.

[![CI](https://img.shields.io/github/actions/workflow/status/SGcpu/AeroGraph/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/SGcpu/AeroGraph/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/SGcpu/AeroGraph?style=for-the-badge)](https://github.com/SGcpu/AeroGraph/blob/main/LICENSE.md)
[![Repo Stars](https://img.shields.io/github/stars/SGcpu/AeroGraph?style=for-the-badge)](https://github.com/SGcpu/AeroGraph/stargazers)
[![npm: @aerograph/contracts](https://img.shields.io/npm/v/@aerograph/contracts?style=for-the-badge&label=%40aerograph%2Fcontracts)](https://www.npmjs.com/package/@aerograph/contracts)
[![npm: @aerograph/sdk](https://img.shields.io/npm/v/@aerograph/sdk?style=for-the-badge&label=%40aerograph%2Fsdk)](https://www.npmjs.com/package/@aerograph/sdk)
[![npm: @aerograph/adapter-langchain](https://img.shields.io/npm/v/@aerograph/adapter-langchain?style=for-the-badge&label=%40aerograph%2Fadapter-langchain)](https://www.npmjs.com/package/@aerograph/adapter-langchain)

## What it does

**Phase 1 — Core Tracing**
- Captures **prompts**, **responses**, **tool calls**, **agent handoffs**, and **errors** as normalized trace events
- Stores traces in a replay-safe, append-only SQLite store
- Visualizes traces as an interactive **trace graph** with payload inspection, failure highlighting, and playback timeline

**Phase 2 — Branching, Diff, and Loop Detection**
- **Fork traces**: create derived traces from any span (append-only, parent immutable)
- **Lineage navigation**: breadcrumb, sibling list, derivedFrom — navigate the branch tree in the UI
- **Deterministic diff**: compare two lineage-related traces with Myers diff; divergence highlighted on the graph
- **Loop detection**: automatically detects repeated sequences, recursive tool usage, and multi-agent handoff cycles

**Phase 2.5 — Advanced Observability**
- **LangGraph State Tracking**: Capture full LangGraph state snapshots at node transitions, track state evolution.
- **LCEL Streaming Telemetry**: Telemetry overlays for stream completion times, Time-to-First-Token (TTFT), and tokens-per-second metrics.
- **RAG Payload Inspection**: Explicit first-class support for viewing retrieval queries, source documents, and metadata scoring.
- **Human Checkpoints**: First-class handling of `interrupt` states and human-in-the-loop approvals.
- All outputs validated through shared contracts (`@aerograph/contracts`); no schema bypasses

## Repository structure

- `packages/contracts`: event schema + shared contracts (source of truth)
- `packages/sdk`: reference SDK for emitting normalized trace events (Node.js)
- `packages/adapter-langchain`: MVP adapter for LangChain workflows (Node.js)
- `python/aerograph-sdk`: reference SDK for emitting normalized trace events (Python)
- `python/aerograph-langchain`: MVP adapter for LangChain workflows (Python)
- `apps/collector`: trace ingest + SQLite storage + lineage/diff/analysis endpoints
- `apps/web`: interactive trace graph UI with lineage panel, diff overlay, and loop warnings
- `apps/demo`: demo emitter + Phase 2 smoke demo

## Development

Requirements: Node.js (LTS)

```sh
npm install

# Start collector (http://localhost:4317):
npm run dev -w apps/collector

# Start web UI (http://localhost:5173):
npm run dev -w apps/web

# Run tests:
npm test

# Build:
npm run build
```

### Updating Cross-Language Artifacts

If you modify contracts in `packages/contracts`, you must update the derived JSON schemas and Python models:

```sh
# 1. Export JSON Schemas
npm run schema:export -w packages/schema-exporter

# 2. Regenerate Python models
uv run python/aerograph-sdk/tools/generate_contracts.py
```

## Phase 2 Quick Start

```sh
# 1. Start collector
npm run dev -w apps/collector

# 2. Emit a demo trace
npx tsx apps/demo/src/demo.ts

# 3. Run the full Phase 2 smoke demo (fork → diff → analysis)
npx tsx apps/demo/src/phase2-demo.ts

# 4. Open UI
open http://localhost:5173
```

## Phase 2 API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `POST /v1/events` | POST | Ingest trace events |
| `GET /v1/traces` | GET | List traces |
| `GET /v1/traces/:id` | GET | Get trace + meta |
| `POST /v1/traces/:id/fork` | POST | Fork a trace at a span |
| `GET /v1/traces/:id/lineage` | GET | Lineage graph |
| `GET /v1/traces/:aId/diff/:bId` | GET | Lineage-aware deterministic diff |
| `GET /v1/traces/:id/analysis` | GET | Loop warnings + failure analysis |

## Architecture

- **No distributed infrastructure**: no queues, no collectors, no Kubernetes — all local SQLite
- **Contract-first**: all API shapes defined in `@aerograph/contracts` (Zod); validated on every ingress/egress
- **Append-only**: events and lineage edges are never mutated; forking copies prefix events
- **Deterministic**: ordering, diff, and loop analysis produce the same result for the same input

## How Aerograph compares

Aerograph is a cognitive observability and debugging layer for autonomous AI workflows, not an execution or orchestration engine.

### The core difference

| Tool | The core question it answers | The developer's UX |
|---|---|---|
| `trigger.dev` / `inngest.com` | How do we reliably execute and orchestrate this workflow at scale? | Infrastructure logs, queue states, retry schedules, and execution backbones. |
| `LangSmith` / `LangChain` | How is my LLM app performing, and what did this specific prompt cost/trace to? | Structured telemetry, prompt logs, token counts, and LLM evaluation datasets. |
| `Aerograph` | Why did my autonomous agents just make that decision? | A visual, replayable graph of reasoning paths, context drift, and emergent agent behavior. |

### Detailed breakdown

| Tool | Primary focus | Where Aerograph differs |
|---|---|---|
| `trigger.dev` | Reliable background job execution, durable task infrastructure, and operational recovery. | Aerograph does zero execution. While Trigger ensures the system runs, Aerograph traces why it ran that way — detecting loops and hallucinated agent handoffs. |
| `inngest.com` | Event-driven workflow engines, long-running functions, and event coordination. | Aerograph is a flight recorder, not an engine. Inngest acts as the execution backbone; Aerograph acts as the DevTools layer to inspect internal behavioral failure points. |
| `LangSmith` | LLM app tracing, prompt evaluation datasets, and production telemetry. | Aerograph is framework-agnostic cognitive debugging. Instead of linear log traces, Aerograph reconstructs multi-agent reasoning graphs, memory interactions, and decision paths in a replayable UI. |

## How This Project Is Split

This repository serves two different audiences:

- Contributors work in the monorepo and run the collector, web UI, demos, and tests locally.
- End users consume the reusable packages, usually `@aerograph/sdk`, `@aerograph/adapter-langchain`, `aerograph-sdk`, and `aerograph-langchain`, from their own application.

That split is intentional. The repo contains the product, but the public integration surface is the SDK and adapters. The collector and web UI are the viewing and storage layer that can be run locally or hosted separately.

## Deployment Model

There are two supported ways to ship AFR:

- **Self-hosted**: users run the collector and web UI themselves, then point their app at the collector endpoint.
- **Hosted**: you run the collector and web UI as a service, and users only install the SDK or adapter in their own project.