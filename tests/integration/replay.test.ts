import { describe, it, expect } from "vitest";
import { sortTraceEventsDeterministic, type TraceEvent } from "@aerograph/contracts";

describe("Replay Compatibility Validation", () => {
  it("verifies v1.0.0 and v1.1.0 traces replay successfully by maintaining sorted order", () => {
    const events: TraceEvent[] = [
      {
        schemaVersion: "1.1.0",
        traceId: "t1",
        spanId: "s2",
        parentSpanId: "s1",
        occurredAt: "2026-05-20T00:00:02.000Z",
        actor: { kind: "agent", id: "agent-1" },
        kind: "response",
        status: "ok",
        projectId: "proj-1",
        environment: "production",
        payload: { text: "response content" },
        links: []
      },
      {
        schemaVersion: "1.0.0",
        traceId: "t1",
        spanId: "s1",
        parentSpanId: null,
        occurredAt: "2026-05-20T00:00:01.000Z",
        actor: { kind: "agent", id: "agent-1" },
        kind: "prompt",
        status: "ok",
        payload: { text: "prompt content" },
        links: []
      }
    ];

    const sorted = sortTraceEventsDeterministic(events);
    expect(sorted[0].spanId).toBe("s1");
    expect(sorted[1].spanId).toBe("s2");
  });

  it("verifies telemetry enrichment (e.g. model, usage, durationMs) does not affect replay sorting", () => {
    const events: TraceEvent[] = [
      {
        schemaVersion: "1.1.0",
        traceId: "t1",
        spanId: "s2",
        parentSpanId: "s1",
        occurredAt: "2026-05-20T00:00:02.000Z",
        actor: { kind: "agent", id: "agent-1" },
        kind: "response",
        status: "ok",
        durationMs: 120,
        projectId: "proj-1",
        environment: "production",
        payload: {
          text: "response content",
          model: { name: "gpt-4" },
          usage: { totalTokens: 100 }
        },
        links: []
      },
      {
        schemaVersion: "1.1.0",
        traceId: "t1",
        spanId: "s1",
        parentSpanId: null,
        occurredAt: "2026-05-20T00:00:01.000Z",
        actor: { kind: "agent", id: "agent-1" },
        kind: "prompt",
        status: "ok",
        durationMs: 50,
        projectId: "proj-1",
        environment: "production",
        payload: {
          text: "prompt content",
          model: { name: "gpt-4" }
        },
        links: []
      }
    ];

    const sorted = sortTraceEventsDeterministic(events);
    expect(sorted[0].spanId).toBe("s1");
    expect(sorted[1].spanId).toBe("s2");
  });
});
