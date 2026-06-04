import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  sortTraceEventsDeterministic,
  traceDiffResultSchema,
  traceEventSchema,
  traceEventSchemaVersion,
  traceForkRequestSchema,
  traceForkResponseSchema,
  traceLineageGraphSchema,
  validateTraceEvent,
  validateTraceWithMeta
} from "./index";

describe("contracts: traceEventSchema", () => {
  it("accepts a valid event", () => {
    const event = {
      schemaVersion: traceEventSchemaVersion,
      traceId: "t-1",
      spanId: "s-1",
      parentSpanId: null,
      occurredAt: new Date("2026-05-20T00:00:00.000Z").toISOString(),
      actor: { kind: "agent", id: "agent-a", name: "Planner" },
      kind: "prompt",
      status: "ok",
      title: "Plan",
      payload: { text: "Do the thing" },
      links: []
    } as const;

    const parsed = validateTraceEvent(event);
    expect(parsed.traceId).toBe("t-1");
  });

  it("rejects invalid events", () => {
    expect(() => traceEventSchema.parse({})).toThrow();
  });

  it("rejects mismatched actor kinds", () => {
    const event = {
      schemaVersion: traceEventSchemaVersion,
      traceId: "t-1",
      spanId: "s-1",
      parentSpanId: null,
      occurredAt: new Date().toISOString(),
      actor: { kind: "tool", id: "tool-a" }, // tool actor for prompt is invalid
      kind: "prompt",
      status: "ok",
      payload: { text: "Do the thing" },
      links: []
    } as any;

    expect(() => validateTraceEvent(event)).toThrow();
  });
});

describe("contracts: API shapes", () => {
  it("validates TraceMeta", () => {
    const meta = {
      traceId: "t-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      eventCount: 1,
      rootSpanId: "s-1"
    };
    expect(() => validateTraceWithMeta({ meta, events: [] })).not.toThrow();
  });
});

describe("contracts: deterministic ordering", () => {
  it("sortTraceEventsDeterministic is stable when timestamps collide", () => {
    const occurredAt = "2026-05-20T00:00:00.000Z";
    const events = [
      { occurredAt, spanId: "s2", kind: "response" },
      { occurredAt, spanId: "s1", kind: "response" },
      { occurredAt, spanId: "s1", kind: "prompt" }
    ] as any;

    const sorted = sortTraceEventsDeterministic(events);
    expect(sorted.map((e: any) => `${e.spanId}:${e.kind}`)).toEqual([
      "s1:prompt",
      "s1:response",
      "s2:response"
    ]);
  });
});

describe("contracts: Phase 2 shapes", () => {
  it("parses TraceForkRequest + TraceForkResponse", () => {
    expect(() =>
      traceForkRequestSchema.parse({ forkFromSpanId: "s-10", overrides: { promptText: "override" } })
    ).not.toThrow();
    expect(() => traceForkResponseSchema.parse({ traceId: "t_child" })).not.toThrow();
  });

  it("parses TraceLineageGraph", () => {
    const node = {
      traceId: "t-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      eventCount: 1,
      rootSpanId: "s-1"
    };

    expect(() =>
      traceLineageGraphSchema.parse({
        rootTraceId: "t-1",
        nodes: [node],
        edges: [
          {
            parentTraceId: "t-1",
            childTraceId: "t-2",
            forkedFromSpanId: "s-1",
            createdAt: new Date().toISOString(),
            overrides: { promptText: "x" }
          }
        ]
      })
    ).not.toThrow();
  });

  it("parses TraceDiffResult divergence metadata (additive)", () => {
    const meta = {
      traceId: "t-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      eventCount: 1,
      rootSpanId: "s-1"
    };

    expect(() =>
      traceDiffResultSchema.parse({
        a: meta,
        b: { ...meta, traceId: "t-2" },
        divergence: { forkPointSpanId: "s-1", aIndex: 0, bIndex: 0, reason: "first change" },
        changed: [{ index: 0, aSpanId: "s-1", bSpanId: "s-1", reason: "payload" }]
      })
    ).not.toThrow();
  });
});

describe("contracts: ordering parity fixtures", () => {
  interface OrderingFixture {
    id: string;
    description: string;
    input: Array<{ occurredAt: string; spanId: string; kind: string }>;
    expected: Array<{ occurredAt: string; spanId: string; kind: string }>;
  }

  const fixturesPath = path.join(
    __dirname,
    "__fixtures__/parity/event-ordering.json"
  );
  const fixturesData = JSON.parse(readFileSync(fixturesPath, "utf-8"));

  for (const fixture of fixturesData.fixtures as OrderingFixture[]) {
    it(`[${fixture.id}] ${fixture.description}`, () => {
      const sorted = sortTraceEventsDeterministic(fixture.input as any);
      const keys = sorted.map((e: any) => `${e.occurredAt}|${e.spanId}|${e.kind}`);
      const expectedKeys = fixture.expected.map(
        (e) => `${e.occurredAt}|${e.spanId}|${e.kind}`
      );
      expect(keys).toEqual(expectedKeys);
    });
  }
});

describe("contracts: trace-events parity fixtures", () => {
  const fixturesPath = path.join(
    __dirname,
    "__fixtures__/parity/trace-events.json"
  );
  const fixturesData = JSON.parse(readFileSync(fixturesPath, "utf-8"));

  for (const fixture of fixturesData.fixtures as { kind: string; description: string; event: unknown }[]) {
    it(`[${fixture.kind}] ${fixture.description}`, () => {
      expect(() => validateTraceEvent(fixture.event)).not.toThrow();
      const parsed = validateTraceEvent(fixture.event);
      expect(parsed.kind).toBe(fixture.kind);
    });
  }
});
