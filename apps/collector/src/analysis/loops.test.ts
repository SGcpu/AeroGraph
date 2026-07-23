import { describe, expect, it } from "vitest";
import { detectRepeatedSequences } from "../analysis/repeatedSequence";
import { detectRecursiveTools } from "../analysis/recursiveTool";
import { detectHandoffCycles } from "../analysis/handoffCycle";
import type { TraceEvent } from "@aerograph/contracts";

const BASE = {
  schemaVersion: "1.0.0" as const,
  traceId: "t-test",
  parentSpanId: null,
  status: "ok" as const,
  links: []
};

function mkPrompt(spanId: string, occurredAt: string): TraceEvent {
  return {
    ...BASE,
    spanId,
    occurredAt,
    actor: { kind: "agent", id: "agent-a" },
    kind: "prompt",
    payload: { text: "hello" }
  };
}

function mkToolCall(spanId: string, occurredAt: string, toolId: string, input: Record<string, unknown>): TraceEvent {
  return {
    ...BASE,
    spanId,
    occurredAt,
    actor: { kind: "tool", id: toolId },
    kind: "tool_call",
    payload: { input }
  };
}

function mkHandoff(spanId: string, occurredAt: string, from: string, to: string): TraceEvent {
  return {
    ...BASE,
    spanId,
    occurredAt,
    actor: { kind: "system", id: "system" },
    kind: "handoff",
    payload: { fromAgentId: from, toAgentId: to }
  };
}

describe("analysis: detectRepeatedSequences", () => {
  it("detects a 2-event window repeated consecutively", () => {
    // patternKey = kind:actorId. 6 prompt events from agent-a → window[0..2] = window[2..4] = window[4..6] (3 occurrences)
    const events: TraceEvent[] = [
      mkPrompt("s1", "2026-05-20T00:00:00.000Z"),
      mkPrompt("s2", "2026-05-20T00:00:01.000Z"),
      mkPrompt("s3", "2026-05-20T00:00:02.000Z"),
      mkPrompt("s4", "2026-05-20T00:00:03.000Z"),
      mkPrompt("s5", "2026-05-20T00:00:04.000Z"),
      mkPrompt("s6", "2026-05-20T00:00:05.000Z")
    ];
    const warnings = detectRepeatedSequences(events);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].kind).toBe("repeated_sequence");
  });

  it("does not flag non-repeating sequences", () => {
    // s1/s3 = prompt:agent-a, s2/s4 differ by toolId (tool-x vs tool-y)
    // window[0..2] = ["prompt:agent-a","tool_call:tool-x"] != ["prompt:agent-a","tool_call:tool-y"]
    const events: TraceEvent[] = [
      mkPrompt("s1", "2026-05-20T00:00:00.000Z"),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "tool-x", { q: "a" }),
      mkPrompt("s3", "2026-05-20T00:00:02.000Z"),
      mkToolCall("s4", "2026-05-20T00:00:03.000Z", "tool-y", { q: "b" })
    ];
    const warnings = detectRepeatedSequences(events);
    // Should NOT flag since the tool calls have different actor IDs
    expect(warnings.length).toBe(0);
  });

  it("returns deterministic results for same input", () => {
    const events: TraceEvent[] = [
      mkPrompt("s1", "2026-05-20T00:00:00.000Z"),
      mkPrompt("s2", "2026-05-20T00:00:01.000Z"),
      mkPrompt("s3", "2026-05-20T00:00:02.000Z"),
      mkPrompt("s4", "2026-05-20T00:00:03.000Z")
    ];
    const r1 = detectRepeatedSequences(events);
    const r2 = detectRepeatedSequences(events);
    expect(r1).toEqual(r2);
  });
});

describe("analysis: detectRecursiveTools", () => {
  it("flags a tool called 3+ times with equivalent input", () => {
    const events: TraceEvent[] = [
      mkToolCall("s1", "2026-05-20T00:00:00.000Z", "tool-retry", { query: "search" }),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "tool-retry", { query: "search" }),
      mkToolCall("s3", "2026-05-20T00:00:02.000Z", "tool-retry", { query: "search" })
    ];
    const warnings = detectRecursiveTools(events);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].kind).toBe("recursive_tool");
    expect(warnings[0].spanIds).toContain("s1");
  });

  it("ignores attempt/iteration counter fields in normalization", () => {
    const events: TraceEvent[] = [
      mkToolCall("s1", "2026-05-20T00:00:00.000Z", "tool-retry", { query: "x", attempt: 1 }),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "tool-retry", { query: "x", attempt: 2 }),
      mkToolCall("s3", "2026-05-20T00:00:02.000Z", "tool-retry", { query: "x", attempt: 3 })
    ];
    const warnings = detectRecursiveTools(events);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("does not flag distinct tool inputs", () => {
    const events: TraceEvent[] = [
      mkToolCall("s1", "2026-05-20T00:00:00.000Z", "tool-search", { query: "a" }),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "tool-search", { query: "b" }),
      mkToolCall("s3", "2026-05-20T00:00:02.000Z", "tool-search", { query: "c" })
    ];
    const warnings = detectRecursiveTools(events);
    expect(warnings.length).toBe(0);
  });
});

describe("analysis: detectHandoffCycles", () => {
  it("detects a repeated handoff edge (A->B appearing twice)", () => {
    const events: TraceEvent[] = [
      mkHandoff("h1", "2026-05-20T00:00:00.000Z", "agent-a", "agent-b"),
      mkHandoff("h2", "2026-05-20T00:00:01.000Z", "agent-a", "agent-b")
    ];
    const warnings = detectHandoffCycles(events);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].kind).toBe("handoff_cycle");
  });

  it("detects a graph cycle A->B->A", () => {
    const events: TraceEvent[] = [
      mkHandoff("h1", "2026-05-20T00:00:00.000Z", "agent-a", "agent-b"),
      mkHandoff("h2", "2026-05-20T00:00:01.000Z", "agent-b", "agent-a")
    ];
    const warnings = detectHandoffCycles(events);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("returns empty for a single handoff with no cycle", () => {
    const events: TraceEvent[] = [
      mkHandoff("h1", "2026-05-20T00:00:00.000Z", "agent-a", "agent-b")
    ];
    const warnings = detectHandoffCycles(events);
    expect(warnings.length).toBe(0);
  });

  it("is deterministic for same input", () => {
    const events: TraceEvent[] = [
      mkHandoff("h1", "2026-05-20T00:00:00.000Z", "agent-a", "agent-b"),
      mkHandoff("h2", "2026-05-20T00:00:01.000Z", "agent-b", "agent-c"),
      mkHandoff("h3", "2026-05-20T00:00:02.000Z", "agent-c", "agent-a")
    ];
    const r1 = detectHandoffCycles(events);
    const r2 = detectHandoffCycles(events);
    expect(r1).toEqual(r2);
  });
});

// T051: loop edge-case tests
describe("analysis: edge cases (T051)", () => {
  it("bounded retries (<=2) are NOT flagged as recursive tool", () => {
    const events: TraceEvent[] = [
      mkToolCall("s1", "2026-05-20T00:00:00.000Z", "tool-retry", { query: "x" }),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "tool-retry", { query: "x" })
    ];
    const warnings = detectRecursiveTools(events);
    expect(warnings.length).toBe(0);
  });

  it("runaway tool calls (>=3 with same input) ARE flagged", () => {
    const events: TraceEvent[] = [
      mkToolCall("s1", "2026-05-20T00:00:00.000Z", "tool-retry", { query: "x" }),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "tool-retry", { query: "x" }),
      mkToolCall("s3", "2026-05-20T00:00:02.000Z", "tool-retry", { query: "x" })
    ];
    const warnings = detectRecursiveTools(events);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("multi-agent cycle (A->B->C->A) is detected", () => {
    const events: TraceEvent[] = [
      mkHandoff("h1", "2026-05-20T00:00:00.000Z", "agent-a", "agent-b"),
      mkHandoff("h2", "2026-05-20T00:00:01.000Z", "agent-b", "agent-c"),
      mkHandoff("h3", "2026-05-20T00:00:02.000Z", "agent-c", "agent-a")
    ];
    const warnings = detectHandoffCycles(events);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].kind).toBe("handoff_cycle");
  });

  it("repeated payload for different tools is NOT flagged as single recursive tool warning", () => {
    const events: TraceEvent[] = [
      mkToolCall("s1", "2026-05-20T00:00:00.000Z", "tool-a", { query: "x" }),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "tool-b", { query: "x" }),
      mkToolCall("s3", "2026-05-20T00:00:02.000Z", "tool-c", { query: "x" })
    ];
    const warnings = detectRecursiveTools(events);
    expect(warnings.length).toBe(0);
  });
});
