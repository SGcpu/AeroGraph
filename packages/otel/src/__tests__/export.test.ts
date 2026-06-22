/**
 * packages/otel/src/__tests__/export.test.ts
 *
 * Unit tests for exportEventToOtlpSpan for all 10 event kinds.
 * Asserts traceId, spanId, parentSpanId, name, kind integer, status code, and key attributes.
 * Mirrors test_export.py in Python.
 */

import { describe, it, expect } from "vitest";
import { validateTraceEvent } from "@aerograph/contracts";
import { exportEventToOtlpSpan, exportEventsToOtlp } from "../export.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
// packages/otel/src/__tests__/ → 4 levels up = monorepo root
const FIXTURE_DIR = join(__dir, "../../../../specs/004-otel-bridge/fixtures");

function loadEvent(name: string) {
  return validateTraceEvent(
    JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"))
  );
}

describe("exportEventToOtlpSpan", () => {
  it("prompt: correct traceId, spanId, name, kind, status", () => {
    const event = loadEvent("prompt_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.traceId).toBe("5b8efff798038103d269b633813fc60c");
    expect(span.spanId).toBe("eee19b7ec3c1b174");
    expect(span.parentSpanId).toBeUndefined(); // null → omitted
    expect(span.name).toBe("gen_ai.chat");
    expect(span.kind).toBe(3); // CLIENT
    expect(span.status?.code).toBe(1); // OK
    expect(span.startTimeUnixNano).toBe("1781028000000000000");
    expect(span.endTimeUnixNano).toBe("1781028000001000000");
  });

  it("response: includes parentSpanId and streaming telemetry", () => {
    const event = loadEvent("response_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.spanId).toBe("aae19b7ec3c1b175");
    expect(span.parentSpanId).toBe("eee19b7ec3c1b174");
    expect(span.name).toBe("gen_ai.response");
    expect(span.kind).toBe(3); // CLIENT
    expect(span.links).toHaveLength(1);
    expect(span.links![0].attributes?.[0].value).toEqual({ stringValue: "follows" });

    const tokenAttr = span.attributes.find((a) => a.key === "aerograph.response.token_count");
    expect(tokenAttr?.value).toEqual({ intValue: 10 });
  });

  it("tool_call: CLIENT kind with tool input", () => {
    const event = loadEvent("tool_call_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.name).toBe("gen_ai.tool.call");
    expect(span.kind).toBe(3); // CLIENT
    const inputAttr = span.attributes.find((a) => a.key === "aerograph.tool_call.input");
    expect(inputAttr?.value).toEqual({ stringValue: '{"query":"Paris France capital"}' });
  });

  it("tool_result: INTERNAL kind", () => {
    const event = loadEvent("tool_result_event.json");
    const span = exportEventToOtlpSpan(event);
    expect(span.name).toBe("gen_ai.tool.result");
    expect(span.kind).toBe(1); // INTERNAL
  });

  it("handoff: INTERNAL with from/to agent IDs", () => {
    const event = loadEvent("handoff_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.name).toBe("gen_ai.agent.handoff");
    expect(span.kind).toBe(1); // INTERNAL
    const fromAttr = span.attributes.find((a) => a.key === "aerograph.handoff.from_agent_id");
    expect(fromAttr?.value).toEqual({ stringValue: "agent-001" });
    const toAttr = span.attributes.find((a) => a.key === "aerograph.handoff.to_agent_id");
    expect(toAttr?.value).toEqual({ stringValue: "agent-002" });
  });

  it("error: status code ERROR (2) with error message", () => {
    const event = loadEvent("error_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.name).toBe("aerograph.error");
    expect(span.kind).toBe(1); // INTERNAL
    expect(span.status?.code).toBe(2); // ERROR
    expect(span.status?.message).toBe("Network timeout while calling external API");
  });

  it("note: INTERNAL with JSON payload", () => {
    const event = loadEvent("note_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.name).toBe("aerograph.note");
    expect(span.kind).toBe(1); // INTERNAL
    const payloadAttr = span.attributes.find((a) => a.key === "aerograph.note.payload");
    expect(payloadAttr).toBeDefined();
  });

  it("retriever: CLIENT with document count", () => {
    const event = loadEvent("retriever_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.name).toBe("gen_ai.retrieve");
    expect(span.kind).toBe(3); // CLIENT
    const countAttr = span.attributes.find((a) => a.key === "aerograph.retriever.document_count");
    expect(countAttr?.value).toEqual({ intValue: 2 });
  });

  it("checkpoint: INTERNAL with checkpoint id and reason", () => {
    const event = loadEvent("checkpoint_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.name).toBe("aerograph.checkpoint");
    expect(span.kind).toBe(1);
    const idAttr = span.attributes.find((a) => a.key === "aerograph.checkpoint.id");
    expect(idAttr?.value).toEqual({ stringValue: "chk-001" });
  });

  it("state_snapshot: INTERNAL with node name and hash", () => {
    const event = loadEvent("state_snapshot_event.json");
    const span = exportEventToOtlpSpan(event);

    expect(span.name).toBe("aerograph.state_snapshot");
    expect(span.kind).toBe(1);
    const nodeAttr = span.attributes.find((a) => a.key === "aerograph.state_snapshot.node_name");
    expect(nodeAttr?.value).toEqual({ stringValue: "respond" });
  });

  it("exports GenAI attributes for response with model and usage", () => {
    const fullEvent: any = {
      schemaVersion: "1.1.0",
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "aae19b7ec3c1b175",
      parentSpanId: null,
      occurredAt: "2026-04-15T10:00:00.000Z",
      kind: "response",
      actor: { kind: "agent", id: "assistant" },
      status: "ok",
      links: [],
      projectId: "proj-123",
      environment: "production",
      durationMs: 1542,
      payload: {
        text: "test",
        model: { name: "gpt-4", provider: "openai" },
        usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 }
      }
    };
    const span = exportEventToOtlpSpan(fullEvent);
    expect(span.attributes).toContainEqual({ key: "project.id", value: { stringValue: "proj-123" } });
    expect(span.attributes).toContainEqual({ key: "deployment.environment", value: { stringValue: "production" } });
    expect(span.attributes).toContainEqual({ key: "gen_ai.response.model", value: { stringValue: "gpt-4" } });
    expect(span.attributes).toContainEqual({ key: "gen_ai.system", value: { stringValue: "openai" } });
    expect(span.attributes).toContainEqual({ key: "gen_ai.usage.input_tokens", value: { intValue: 5 } });
    expect(span.attributes).toContainEqual({ key: "gen_ai.usage.output_tokens", value: { intValue: 10 } });
    expect(span.attributes).toContainEqual({ key: "gen_ai.usage.total_tokens", value: { intValue: 15 } });
  });
});

describe("exportEventsToOtlp", () => {
  it("wraps spans in resourceSpans envelope", () => {
    const event = loadEvent("prompt_event.json");
    const result = exportEventsToOtlp([event], { serviceName: "test-service" });

    expect(result.resourceSpans).toHaveLength(1);
    expect(result.resourceSpans[0].resource?.attributes[0]).toEqual({
      key: "service.name",
      value: { stringValue: "test-service" }
    });
    expect(result.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  });

  it("sorts events deterministically", () => {
    const event1 = loadEvent("prompt_event.json");
    const event2 = loadEvent("response_event.json");

    // Out of order
    const result = exportEventsToOtlp([event2, event1]);
    const spans = result.resourceSpans[0].scopeSpans[0].spans;

    // Should be ordered by occurredAt (prompt before response)
    expect(spans[0].spanId).toBe("eee19b7ec3c1b174"); // prompt
    expect(spans[1].spanId).toBe("aae19b7ec3c1b175"); // response
  });
});
