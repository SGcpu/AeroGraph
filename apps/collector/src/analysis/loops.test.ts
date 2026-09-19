import { describe, expect, it } from "vitest";
import { detectRepeatedSequences } from "../analysis/repeatedSequence";
import { detectRecursiveTools } from "../analysis/recursiveTool";
import { detectHandoffCycles } from "../analysis/handoffCycle";
import { analyzeTrace } from "../analysis/index";
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

// Tests for Intelligent Loop & Failure Detection Upgrades
describe("analysis: smart loop & failure detection upgrades", () => {
  it("detects oscillatory multi-step motif (LLM -> search -> scrape repeating 3 times)", () => {
    const events: TraceEvent[] = [
      // Iteration 1
      mkPrompt("s1", "2026-05-20T00:00:00.000Z"),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "search", { q: "query" }),
      mkToolCall("s3", "2026-05-20T00:00:02.000Z", "scrape", { url: "http://example.com" }),
      // Iteration 2
      mkPrompt("s4", "2026-05-20T00:00:03.000Z"),
      mkToolCall("s5", "2026-05-20T00:00:04.000Z", "search", { q: "query" }),
      mkToolCall("s6", "2026-05-20T00:00:05.000Z", "scrape", { url: "http://example.com" }),
      // Iteration 3
      mkPrompt("s7", "2026-05-20T00:00:06.000Z"),
      mkToolCall("s8", "2026-05-20T00:00:07.000Z", "search", { q: "query" }),
      mkToolCall("s9", "2026-05-20T00:00:08.000Z", "scrape", { url: "http://example.com" })
    ];

    const warnings = detectRepeatedSequences(events);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].kind).toBe("repeated_sequence");
    expect(warnings[0].spanIds.length).toBe(9);
    expect(warnings[0].reason).toContain("search");
    expect(warnings[0].reason).toContain("scrape");
  });

  it("detects repeated sequence across interleaved passive telemetry notes", () => {
    const mkNote = (spanId: string, occurredAt: string): TraceEvent => ({
      ...BASE,
      spanId,
      occurredAt,
      actor: { kind: "system", id: "system" },
      kind: "note",
      payload: { message: "state checkpoint" }
    });

    const events: TraceEvent[] = [
      mkPrompt("s1", "2026-05-20T00:00:00.000Z"),
      mkToolCall("s2", "2026-05-20T00:00:01.000Z", "search", { q: "a" }),
      mkNote("n1", "2026-05-20T00:00:01.500Z"),
      mkPrompt("s3", "2026-05-20T00:00:02.000Z"),
      mkToolCall("s4", "2026-05-20T00:00:03.000Z", "search", { q: "a" }),
      mkNote("n2", "2026-05-20T00:00:03.500Z"),
      mkPrompt("s5", "2026-05-20T00:00:04.000Z"),
      mkToolCall("s6", "2026-05-20T00:00:05.000Z", "search", { q: "a" })
    ];

    const warnings = detectRepeatedSequences(events);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.reason.includes("telemetry") || w.reason.includes("sequence"))).toBe(true);
  });

  it("detects fuzzy recursive tool when queries are rephrased and produce empty results", () => {
    const events: TraceEvent[] = [
      {
        ...BASE,
        spanId: "s1",
        occurredAt: "2026-05-20T00:00:00.000Z",
        actor: { kind: "tool", id: "web_search" },
        kind: "tool_call",
        payload: {
          name: "web_search",
          input: { query: "weather forecast in Seattle today" },
          output: []
        }
      },
      {
        ...BASE,
        spanId: "s2",
        occurredAt: "2026-05-20T00:00:01.000Z",
        actor: { kind: "tool", id: "web_search" },
        kind: "tool_call",
        payload: {
          name: "web_search",
          input: { query: "weather forecast Seattle today" },
          output: []
        }
      },
      {
        ...BASE,
        spanId: "s3",
        occurredAt: "2026-05-20T00:00:02.000Z",
        actor: { kind: "tool", id: "web_search" },
        kind: "tool_call",
        payload: {
          name: "web_search",
          input: { query: "Seattle weather forecast today" },
          output: []
        }
      }
    ];

    const warnings = detectRecursiveTools(events);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].kind).toBe("recursive_tool");
    expect(warnings[0].reason).toContain("without progress");
    expect(warnings[0].reason).toContain("empty/null result");
  });

  it("detects multi-agent ping-pong via framework actor shifts (no explicit handoff event)", () => {
    const events: TraceEvent[] = [
      {
        ...BASE,
        spanId: "s1",
        occurredAt: "2026-05-20T00:00:00.000Z",
        actor: { kind: "agent", id: "researcher" },
        kind: "prompt",
        payload: { text: "Investigate query" }
      },
      {
        ...BASE,
        spanId: "s2",
        occurredAt: "2026-05-20T00:00:01.000Z",
        actor: { kind: "agent", id: "critic" },
        kind: "prompt",
        payload: { text: "Review investigation" }
      },
      {
        ...BASE,
        spanId: "s3",
        occurredAt: "2026-05-20T00:00:02.000Z",
        actor: { kind: "agent", id: "researcher" },
        kind: "prompt",
        payload: { text: "Re-investigate" }
      },
      {
        ...BASE,
        spanId: "s4",
        occurredAt: "2026-05-20T00:00:03.000Z",
        actor: { kind: "agent", id: "critic" },
        kind: "prompt",
        payload: { text: "Review again" }
      }
    ];

    const warnings = detectHandoffCycles(events);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].kind).toBe("handoff_cycle");
    expect(warnings[0].reason).toContain("ping-pong");
    expect(warnings[0].reason).toContain("researcher");
    expect(warnings[0].reason).toContain("critic");
  });

  it("classifies error taxonomies and identifies root cause span", () => {
    const events: TraceEvent[] = [
      {
        ...BASE,
        spanId: "s1",
        occurredAt: "2026-05-20T00:00:00.000Z",
        actor: { kind: "tool", id: "fetch_api" },
        kind: "tool_call",
        status: "error",
        payload: { error: "HTTP 429 Too Many Requests: Rate limit exceeded" }
      },
      {
        ...BASE,
        spanId: "s2",
        occurredAt: "2026-05-20T00:00:01.000Z",
        actor: { kind: "agent", id: "supervisor" },
        kind: "prompt",
        status: "error",
        payload: { error: "ValidationError: missing required response field" }
      }
    ];

    const analysis = analyzeTrace(events);
    expect(analysis.failures.length).toBe(2);
    // Root cause is the first error (rate limit)
    expect(analysis.failures[0].spanId).toBe("s1");
    expect(analysis.failures[0].title).toContain("[RATE_LIMIT_OR_TIMEOUT]");
    expect(analysis.failures[0].title).toContain("[Root Cause]");

    // Cascaded secondary error
    expect(analysis.failures[1].spanId).toBe("s2");
    expect(analysis.failures[1].title).toContain("[SCHEMA_VALIDATION]");
    expect(analysis.failures[1].title).toContain("[Cascaded]");
  });
});
