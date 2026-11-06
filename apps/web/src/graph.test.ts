import { describe, expect, it } from "vitest";
import { buildGraph, computePlaybackState } from "./graph";

describe("web: graph utilities", () => {
  it("buildGraph maps trace events to nodes and edges", () => {
    const events = [
      {
        traceId: "t-1",
        spanId: "s-1",
        parentSpanId: null,
        occurredAt: "2026-05-20T00:00:00.000Z",
        kind: "prompt",
        actor: { kind: "agent", id: "agent-1" },
        status: "ok",
        payload: { text: "Hello" }
      },
      {
        traceId: "t-1",
        spanId: "s-2",
        parentSpanId: "s-1",
        occurredAt: "2026-05-20T00:00:01.000Z",
        kind: "response",
        actor: { kind: "agent", id: "agent-1" },
        status: "ok",
        payload: { text: "Hi" }
      }
    ] as any;

    const graph = buildGraph(events);
    expect(graph.nodes.length).toBe(2);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0].source).toBe("s-1");
    expect(graph.edges[0].target).toBe("s-2");
  });

  it("computePlaybackState limits visible events by cursor index", () => {
    const events = [
      { occurredAt: "2026-05-20T00:00:00.000Z", spanId: "s1", kind: "note" },
      { occurredAt: "2026-05-20T00:00:01.000Z", spanId: "s2", kind: "note" },
      { occurredAt: "2026-05-20T00:00:02.000Z", spanId: "s3", kind: "note" }
    ] as any;

    const visible = computePlaybackState(events, 1);
    expect(visible.length).toBe(2);
    expect(visible[1].spanId).toBe("s2");
  });

  it("computePlaybackState is deterministic when timestamps collide", () => {
    const occurredAt = "2026-05-20T00:00:00.000Z";
    const events = [
      { occurredAt, spanId: "s2", kind: "response" },
      { occurredAt, spanId: "s1", kind: "response" },
      { occurredAt, spanId: "s1", kind: "prompt" }
    ] as any;

    const visible = computePlaybackState(events, 2);
    expect(visible.map((e: any) => `${e.spanId}:${e.kind}`)).toEqual([
      "s1:prompt",
      "s1:response",
      "s2:response"
    ]);
  });

  // T046: regression — ordering uses @aerograph/contracts helper (sortTraceEventsDeterministic)
  it("computePlaybackState produces same result regardless of input order", () => {
    const events = [
      { occurredAt: "2026-05-20T00:00:02.000Z", spanId: "s3", kind: "note" },
      { occurredAt: "2026-05-20T00:00:00.000Z", spanId: "s1", kind: "note" },
      { occurredAt: "2026-05-20T00:00:01.000Z", spanId: "s2", kind: "note" }
    ] as any;

    const shuffled = [
      { occurredAt: "2026-05-20T00:00:01.000Z", spanId: "s2", kind: "note" },
      { occurredAt: "2026-05-20T00:00:02.000Z", spanId: "s3", kind: "note" },
      { occurredAt: "2026-05-20T00:00:00.000Z", spanId: "s1", kind: "note" }
    ] as any;

    const r1 = computePlaybackState(events, 2);
    const r2 = computePlaybackState(shuffled, 2);

    expect(r1.map((e: any) => e.spanId)).toEqual(r2.map((e: any) => e.spanId));
  });

  it("buildGraph connects trace_fork event to post-fork root spans", () => {
    const events = [
      {
        traceId: "t-1",
        spanId: "s-root-1",
        parentSpanId: null,
        occurredAt: "2026-05-20T00:00:00.000Z",
        kind: "note",
        payload: { kind: "langchain_chain" }
      },
      {
        traceId: "t-1",
        spanId: "s-prompt-1",
        parentSpanId: "s-root-1",
        occurredAt: "2026-05-20T00:00:01.000Z",
        kind: "prompt",
        payload: { text: "Original prompt" }
      },
      {
        traceId: "t-1",
        spanId: "n-fork-1",
        parentSpanId: "s-prompt-1",
        occurredAt: "2026-05-20T00:00:02.000Z",
        kind: "note",
        payload: { event: "trace_fork" }
      },
      {
        traceId: "t-1",
        spanId: "s-root-2",
        parentSpanId: null,
        occurredAt: "2026-05-20T00:00:03.000Z",
        kind: "note",
        payload: { kind: "langchain_chain" }
      },
      {
        traceId: "t-1",
        spanId: "s-prompt-2",
        parentSpanId: "s-root-2",
        occurredAt: "2026-05-20T00:00:04.000Z",
        kind: "prompt",
        payload: { text: "Resumed prompt" }
      }
    ] as any;

    const graph = buildGraph(events);
    const forkEdge = graph.edges.find((e) => e.source === "n-fork-1" && e.target === "s-root-2");
    expect(forkEdge).toBeDefined();
    expect(forkEdge?.label).toBe("⑂ fork resume");
  });
});
