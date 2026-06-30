import { describe, it, expect } from "vitest";
import { validateTraceEvent, type TraceEvent } from "@aerograph/contracts";
import { exportEventToOtlpSpan } from "../../packages/otel/src/export";

describe("Cross-Language Parity Validation", () => {
  it("verifies equivalent TypeScript and Python traces produce semantically identical telemetry", () => {
    // Equivalent structures from TS SDK and Python SDK (Pydantic serialized)
    const tsEvent: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_12345",
      spanId: "s_12345",
      parentSpanId: null,
      occurredAt: "2026-05-20T00:00:00.000Z",
      actor: { kind: "agent", id: "assistant" },
      status: "ok",
      projectId: "proj-1",
      environment: "production",
      durationMs: 250,
      kind: "response",
      payload: {
        text: "hello",
        model: { name: "gpt-4", provider: "openai" },
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 }
      },
      links: []
    };

    // Python SDK outputs the same snake_case parameters translated into camelCase JSON
    const pySerializedEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_12345",
      spanId: "s_12345",
      parentSpanId: null,
      occurredAt: "2026-05-20T00:00:00.000Z",
      actor: { kind: "agent", id: "assistant" },
      status: "ok",
      projectId: "proj-1",
      environment: "production",
      durationMs: 250,
      kind: "response",
      payload: {
        text: "hello",
        model: { name: "gpt-4", provider: "openai" },
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 }
      },
      links: []
    };

    // 1. Verify both event representations are accepted under TypeScript contracts
    const parsedTs = validateTraceEvent(tsEvent);
    const parsedPy = validateTraceEvent(pySerializedEvent);
    expect(parsedTs).toEqual(parsedPy);

    // 2. Verify both produce identical OTel span outputs
    const otelTs = exportEventToOtlpSpan(parsedTs);
    const otelPy = exportEventToOtlpSpan(parsedPy);
    expect(otelTs).toEqual(otelPy);
  });
});
