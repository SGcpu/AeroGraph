import { describe, it, expect } from "vitest";
import { validateTraceEvent, sortTraceEventsDeterministic, type TraceEvent } from "@aerograph/contracts";
import { mapCanonicalTelemetry, mapModelTelemetry, mapUsageTelemetry } from "@aerograph/otel";

describe("Schema v1.1.0 Backward Compatibility", () => {
  // A standard v1.0.0 event without any v1.1.0 fields
  const legacyPromptEvent: any = {
    schemaVersion: "1.0.0",
    traceId: "trace-legacy-1",
    spanId: "span-legacy-1",
    parentSpanId: null,
    occurredAt: "2023-01-01T12:00:00Z",
    actor: {
      kind: "agent",
      id: "legacy-agent"
    },
    status: "ok",
    kind: "prompt",
    payload: {
      text: "Hello world"
    }
  };

  const legacyResponseEvent: any = {
    schemaVersion: "1.0.0",
    traceId: "trace-legacy-1",
    spanId: "span-legacy-2",
    parentSpanId: "span-legacy-1",
    occurredAt: "2023-01-01T12:00:01Z",
    actor: {
      kind: "agent",
      id: "legacy-agent"
    },
    status: "ok",
    kind: "response",
    payload: {
      text: "Hello to you too"
    }
  };

  it("validates 1.0.0 payloads without errors under 1.1.0 contracts", () => {
    // Should parse without throwing Zod errors
    const parsedPrompt = validateTraceEvent(legacyPromptEvent);
    expect(parsedPrompt.schemaVersion).toBe("1.0.0");
    expect(parsedPrompt.durationMs).toBeUndefined();
    expect(parsedPrompt.projectId).toBeUndefined();

    const parsedResponse = validateTraceEvent(legacyResponseEvent);
    expect(parsedResponse.schemaVersion).toBe("1.0.0");
    if (parsedResponse.kind === "response") {
      expect(parsedResponse.payload.model).toBeUndefined();
      expect(parsedResponse.payload.usage).toBeUndefined();
    }
  });

  it("handles missing telemetry gracefully in OTEL export semantic mappers", () => {
    const parsedPrompt = validateTraceEvent(legacyPromptEvent);
    const parsedResponse = validateTraceEvent(legacyResponseEvent);

    // mapCanonicalTelemetry should return an empty array if no canonical fields exist
    expect(mapCanonicalTelemetry(parsedPrompt)).toEqual([]);

    // mapModelTelemetry should return empty if no model info exists
    expect(mapModelTelemetry(parsedPrompt)).toEqual([]);
    expect(mapModelTelemetry(parsedResponse)).toEqual([]);

    // mapUsageTelemetry should return empty if no usage exists
    expect(mapUsageTelemetry(parsedResponse)).toEqual([]);
  });

  it("maintains replay determinism sorting for legacy traces", () => {
    const events = [legacyResponseEvent, legacyPromptEvent] as TraceEvent[];
    
    // Sort should successfully sort 1.0.0 events based on occurredAt and spanId
    const sorted = sortTraceEventsDeterministic(events);
    expect(sorted[0].spanId).toBe("span-legacy-1");
    expect(sorted[1].spanId).toBe("span-legacy-2");
  });

  it("handles mixed 1.0.0 and 1.1.0 traces cleanly", () => {
    const v11Event: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "trace-legacy-1",
      spanId: "span-v11-1",
      parentSpanId: "span-legacy-2",
      occurredAt: "2023-01-01T12:00:02Z",
      actor: {
        kind: "agent",
        id: "legacy-agent"
      },
      status: "ok",
      kind: "prompt",
      projectId: "proj-1",
      durationMs: 50,
      payload: {
        text: "Are you still there?",
        model: {
          name: "gpt-4",
          provider: "openai"
        }
      }
    };

    const parsed = validateTraceEvent(v11Event);
    expect(parsed.schemaVersion).toBe("1.1.0");

    // OTEL Semantic Mappings should extract data from v1.1.0
    const canonicalAttrs = mapCanonicalTelemetry(parsed);
    expect(canonicalAttrs).toEqual([
      { key: "project.id", value: { stringValue: "proj-1" } }
    ]);

    const modelAttrs = mapModelTelemetry(parsed);
    expect(modelAttrs).toEqual([
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4" } },
      { key: "gen_ai.system", value: { stringValue: "openai" } }
    ]);
  });
});
