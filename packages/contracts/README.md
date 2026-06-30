# @aerograph/contracts

The single source of truth for all AeroGraph Event schemas using Zod.

## Overview

AeroGraph employs a strict contract-first architecture. This package defines the canonical `TraceEvent` schemas, lineage graph types, and topological structures using Zod. It ensures deterministic validation on both ingress and egress at the collector.

## Installation

```bash
npm install @aerograph/contracts
```

*(Requires Node.js >= 18.18.0)*

## Usage

Use this package if you are building custom ingestion tools, backend extensions, or parsing scripts that need to validate AeroGraph schemas natively in TypeScript.

```typescript
import { validateTraceEvent, TraceEvent } from "@aerograph/contracts";

const rawEvent = {
  schemaVersion: "1.0.0",
  traceId: "some-trace-id",
  spanId: "some-span-id",
  parentSpanId: null,
  occurredAt: "2026-06-10T12:00:00.000Z",
  actor: { kind: "system", id: "app" },
  kind: "note",
  status: "ok",
  links: [],
  payload: { key: "value" }
};

// Validates the shape and returns a typed TraceEvent, or throws a ZodError
const event: TraceEvent = validateTraceEvent(rawEvent);
```

## Available Schemas

- `traceEventSchema` (Supports v1.1.0 with canonical `model`, `usage`, `projectId`, and `environment`)
- `traceLineageGraphSchema`
- `traceForkRequestSchema`
- `traceAnalysisSchema`
- `traceDiffResultSchema`
- `traceStatsSchema`

## License
Apache-2.0
