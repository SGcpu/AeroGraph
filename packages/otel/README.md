# @aerograph/otel

The bidirectional OpenTelemetry (OTLP) bridge for AeroGraph.

## Overview

AeroGraph stores cognitive observability traces using its own canonical append-only models. However, standard observability ecosystems (Jaeger, Datadog) expect W3C OpenTelemetry spans. This package seamlessly translates between the two paradigms with zero information loss.

## Installation

```bash
npm install @aerograph/otel
```

*(Requires Node.js >= 18.18.0)*

## Usage: Exporting AeroGraph to OTLP

Convert an AeroGraph `TraceEvent` natively to an OpenTelemetry `OtlpSpan` format:

```typescript
import { exportEventsToOtlp } from "@aerograph/otel";
import { FlightRecorder } from "@aerograph/sdk";

// 1. You have AeroGraph events
const event = await recorder.prompt({ text: "Hello OTel" });

// 2. Export to OTLP JSON Payload
const otlpPayload = exportEventsToOtlp([event], { serviceName: "my-service" });

// 3. You can now POST this JSON to Jaeger or the OTel Collector via HTTP
```

## Usage: Importing OTLP into AeroGraph

If you receive external OTLP spans, you can deterministically parse them back into `TraceEvent` objects.

```typescript
import { importOtlpToEvents, otlpExportRequestSchema } from "@aerograph/otel";

const payload = otlpExportRequestSchema.parse(incomingJson);

const traceEvents = importOtlpToEvents(payload, {
  defaultActorId: "otlp-ingest",
  preserveOriginalIds: true
});
```

## GenAI Semantic Conventions (v1.1.0)

When exporting AeroGraph canonical telemetry (introduced in schema v1.1.0) to OTLP, the bridge automatically translates the standard metrics to [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/):
- `model.name` $\rightarrow$ `gen_ai.request.model`
- `model.provider` $\rightarrow$ `gen_ai.system`
- `usage.inputTokens` $\rightarrow$ `gen_ai.usage.input_tokens`
- `usage.outputTokens` $\rightarrow$ `gen_ai.usage.output_tokens`

This guarantees deterministic, lossless mapping between canonical events and OTLP spans.

## License
Apache-2.0
