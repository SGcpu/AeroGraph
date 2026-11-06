import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SqliteTraceStore } from "./sqliteStore";
import Database from "better-sqlite3";
import { runMigrations } from "./sqlite/migrate";
import { loadPhase2FixtureTrace } from "./testUtils";
import type { TraceEvent } from "@aerograph/contracts";

describe("collector: SqliteTraceStore", () => {
  let db: any;
  let store: SqliteTraceStore;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    store = new SqliteTraceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  // T008: migration verification
  it("creates trace_derivations table and indexes", () => {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trace_derivations'")
      .get();
    expect(table?.name).toBe("trace_derivations");

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='trace_derivations'")
      .all()
      .map((r: any) => r.name);

    expect(indexes).toContain("idx_trace_derivations_parent_trace_id");
    expect(indexes).toContain("idx_trace_derivations_created_at");
  });

  it("appends and retrieves an event safely", () => {
    const event = {
      schemaVersion: "1.0.0",
      traceId: "t-1",
      spanId: "s-1",
      parentSpanId: null,
      occurredAt: new Date().toISOString(),
      actor: { kind: "agent", id: "agent-1" },
      kind: "prompt",
      status: "ok",
      payload: { text: "Hello" },
      links: []
    } as any;

    store.appendEvent(event);

    const trace = store.getTrace("t-1");
    expect(trace).toBeDefined();
    expect(trace?.meta.traceId).toBe("t-1");
    expect(trace?.events.length).toBe(1);
    expect(trace?.events[0].spanId).toBe("s-1");
  });

  it("enforces unique constraints on traceId + spanId", () => {
    const event = {
      schemaVersion: "1.0.0",
      traceId: "t-1",
      spanId: "s-1",
      parentSpanId: null,
      occurredAt: new Date().toISOString(),
      actor: { kind: "agent", id: "agent-1" },
      kind: "prompt",
      status: "ok",
      payload: { text: "Hello" },
      links: []
    } as any;

    store.appendEvent(event);
    expect(() => store.appendEvent(event)).toThrow();
  });

  it("lists traces", () => {
    const event1 = {
      schemaVersion: "1.0.0",
      traceId: "t-1",
      spanId: "s-1",
      parentSpanId: null,
      occurredAt: new Date().toISOString(),
      actor: { kind: "agent", id: "agent-1" },
      kind: "prompt",
      status: "ok",
      payload: {},
      links: []
    } as any;

    store.appendEvent(event1);

    const event2 = {
      ...event1,
      traceId: "t-2"
    };

    store.appendEvent(event2);

    const list = store.listTraces();
    expect(list.traces.length).toBe(2);
    expect(list.traces.map((t: any) => t.traceId)).toContain("t-1");
    expect(list.traces.map((t: any) => t.traceId)).toContain("t-2");
  });

  // T010: fork + lineage tests
  it("forks a trace append-only and keeps parent immutable", () => {
    const baseEvents = loadPhase2FixtureTrace("base");
    for (const e of baseEvents) store.appendEvent(e);

    const parentBefore = store.getTrace("t_base");
    expect(parentBefore?.events.length).toBe(baseEvents.length);

    const childTraceId = store.forkTrace({
      baseTraceId: "t_base",
      forkFromSpanId: "s6",
      overrides: { promptText: "Fork override A" }
    });

    const parentAfter = store.getTrace("t_base");
    expect(parentAfter?.events.length).toBe(baseEvents.length);

    const child = store.getTrace(childTraceId);
    expect(child?.meta.traceId).toBe(childTraceId);
    expect(child?.meta.derivedFrom).toMatchObject({ baseTraceId: "t_base", forkedFromSpanId: "s6" });

    const childSpanIds = (child?.events ?? []).map((e) => e.spanId);
    expect(childSpanIds).toContain("s1");
    expect(childSpanIds).toContain("s6");
    expect(childSpanIds).not.toContain("s7");

    const forkPoint = (child?.events ?? []).find((e) => e.spanId === "s6");
    expect(forkPoint?.kind).toBe("prompt");
    expect((forkPoint as any)?.payload?.text).toBe("Fork override A");
  });

  it("prevents lineage cycles", () => {
    const baseEvents = loadPhase2FixtureTrace("base");
    for (const e of baseEvents) store.appendEvent(e);

    const childTraceId = store.forkTrace({
      baseTraceId: "t_base",
      forkFromSpanId: "s6",
      overrides: { promptText: "Fork override A" }
    });

    expect(() =>
      store.appendDerivation({
        childTraceId: "t_base",
        parentTraceId: childTraceId,
        forkedFromSpanId: "s1",
        overrides: {}
      })
    ).toThrow();
  });

  it("reconstructs a deterministic lineage graph", () => {
    const baseEvents = loadPhase2FixtureTrace("base");
    for (const e of baseEvents) store.appendEvent(e);

    const a = store.forkTrace({ baseTraceId: "t_base", forkFromSpanId: "s6", overrides: { promptText: "A" } });
    const b = store.forkTrace({ baseTraceId: "t_base", forkFromSpanId: "s6", overrides: { promptText: "B" } });

    const g1 = store.getLineageGraph("t_base");
    const g2 = store.getLineageGraph("t_base");

    expect(g1.rootTraceId).toBe("t_base");
    expect(g1).toEqual(g2);

    const childIds = g1.edges
      .filter((e) => e.parentTraceId === "t_base")
      .map((e) => e.childTraceId);

    expect(childIds).toContain(a);
    expect(childIds).toContain(b);
  });

  // T024: lineage-aware diff unit tests
  it("diffTraces returns structured result for parent vs child", () => {
    const baseEvents = loadPhase2FixtureTrace("base");
    for (const e of baseEvents) store.appendEvent(e);

    const childId = store.forkTrace({
      baseTraceId: "t_base",
      forkFromSpanId: "s1",
      overrides: {}
    });

    const diff = store.diffTraces("t_base", childId);
    expect(diff.a.traceId).toBe("t_base");
    expect(diff.b.traceId).toBe(childId);
    expect(Array.isArray(diff.changed)).toBe(true);
  });

  it("diffTraces detects changes when sibling branches diverge", () => {
    const baseEvents = loadPhase2FixtureTrace("base");
    for (const e of baseEvents) store.appendEvent(e);

    const childA = store.forkTrace({ baseTraceId: "t_base", forkFromSpanId: "s6", overrides: { promptText: "A" } });
    const childB = store.forkTrace({ baseTraceId: "t_base", forkFromSpanId: "s6", overrides: { promptText: "B" } });

    const diff = store.diffTraces(childA, childB);
    expect(diff.a.traceId).toBe(childA);
    expect(diff.b.traceId).toBe(childB);
    expect(Array.isArray(diff.changed)).toBe(true);
  });

  it("diffTraces is deterministic for same inputs", () => {
    const baseEvents = loadPhase2FixtureTrace("base");
    for (const e of baseEvents) store.appendEvent(e);

    const childId = store.forkTrace({ baseTraceId: "t_base", forkFromSpanId: "s6", overrides: {} });

    const d1 = store.diffTraces("t_base", childId);
    const d2 = store.diffTraces("t_base", childId);
    expect(d1).toEqual(d2);
  });

  it("diffTraces throws for missing traces", () => {
    expect(() => store.diffTraces("missing-a", "missing-b")).toThrow();
  });

  // T047: fork prefix selection determinism regression
  it("forkTrace selects deterministic prefix with identical timestamps", () => {
    const sharedTime = "2026-05-20T00:00:00.000Z";
    const events: TraceEvent[] = [
      {
        schemaVersion: "1.0.0",
        traceId: "t_det",
        spanId: "s1",
        parentSpanId: null,
        occurredAt: sharedTime,
        actor: { kind: "agent", id: "agent-a" },
        kind: "prompt",
        status: "ok",
        payload: { text: "A" },
        links: []
      },
      {
        schemaVersion: "1.0.0",
        traceId: "t_det",
        spanId: "s2",
        parentSpanId: "s1",
        occurredAt: sharedTime,
        actor: { kind: "agent", id: "agent-a" },
        kind: "response",
        status: "ok",
        payload: { text: "B" },
        links: []
      },
      {
        schemaVersion: "1.0.0",
        traceId: "t_det",
        spanId: "s3",
        parentSpanId: "s2",
        occurredAt: "2026-05-20T00:00:01.000Z",
        actor: { kind: "agent", id: "agent-a" },
        kind: "prompt",
        status: "ok",
        payload: { text: "C" },
        links: []
      }
    ];

    for (const e of events) store.appendEvent(e);

    const c1 = store.forkTrace({ baseTraceId: "t_det", forkFromSpanId: "s2", overrides: {} });
    const c2 = store.forkTrace({ baseTraceId: "t_det", forkFromSpanId: "s2", overrides: {} });

    const child1 = store.getTrace(c1)!;
    const child2 = store.getTrace(c2)!;

    // Filter out note events (nanoid-generated spanIds), compare only prefix event spanIds
    const prefixIds1 = child1.events.filter((e) => e.kind !== "note").map((e) => e.spanId).sort();
    const prefixIds2 = child2.events.filter((e) => e.kind !== "note").map((e) => e.spanId).sort();
    expect(prefixIds1).toEqual(prefixIds2);
    expect(prefixIds1).toContain("s1");
    expect(prefixIds1).toContain("s2");
  });

  // T049: lineage stress tests
  it("handles many sibling branches with deterministic ordering", () => {
    const baseEvents = loadPhase2FixtureTrace("base");
    for (const e of baseEvents) store.appendEvent(e);

    const children: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = store.forkTrace({
        baseTraceId: "t_base",
        forkFromSpanId: "s6",
        overrides: { promptText: `Branch ${i}` }
      });
      children.push(id);
    }

    const graph1 = store.getLineageGraph("t_base");
    const graph2 = store.getLineageGraph("t_base");

    expect(graph1.edges.map((e) => e.childTraceId)).toEqual(graph2.edges.map((e) => e.childTraceId));
    for (const cid of children) {
      expect(graph1.edges.some((e) => e.childTraceId === cid)).toBe(true);
    }
  });

  // T050: diff edge-case tests
  it("diffTraces handles early-exit derived trace (prefix-only fork)", () => {
    const baseEvents = loadPhase2FixtureTrace("base");
    for (const e of baseEvents) store.appendEvent(e);

    const childId = store.forkTrace({ baseTraceId: "t_base", forkFromSpanId: "s1", overrides: {} });

    const diff = store.diffTraces("t_base", childId);
    expect(diff.a.traceId).toBe("t_base");
    expect(diff.b.traceId).toBe(childId);
    const deletedCount = diff.changed.filter((c) => c.aSpanId && !c.bSpanId).length;
    expect(deletedCount).toBeGreaterThan(0);
  });

  // T025: migration 006_replay test
  describe("migration 006_replay", () => {
    it("creates replay_runs table and indexes, and adds replay columns to events", () => {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='replay_runs'")
        .get();
      expect(table?.name).toBe("replay_runs");

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='replay_runs'")
        .all()
        .map((r: any) => r.name);
      expect(indexes).toContain("idx_replay_runs_trace_id");
      expect(indexes).toContain("idx_replay_runs_status");

      // Verify columns on events table
      const columns = db
        .prepare("PRAGMA table_info(events)")
        .all()
        .map((r: any) => r.name);
      expect(columns).toContain("replay_source");
      expect(columns).toContain("replay_request_key");
      expect(columns).toContain("replay_tokens_saved");
      expect(columns).toContain("replay_latency_ms");
      expect(columns).toContain("replay_streaming_preserved");
      expect(columns).toContain("replay_overridden");
    });
  });

  // T026: store run management tests
  describe("replay run store methods", () => {
    it("creates, updates, retrieves, and lists runs", () => {
      const runId = store.createRun({
        traceId: "trace-run-1",
        mode: "record",
        command: ["python", "agent.py"],
        projectRoot: "/workspace/project",
        parentTraceId: null,
        cassetteRunId: null
      });

      expect(runId).toBeDefined();

      const run = store.getRunById(runId);
      expect(run).not.toBeNull();
      expect(run?.runId).toBe(runId);
      expect(run?.traceId).toBe("trace-run-1");
      expect(run?.mode).toBe("record");
      expect(run?.status).toBe("pending");

      store.updateRunStatus(runId, "running", { startedAt: new Date().toISOString() });
      const running = store.getRunById(runId);
      expect(running?.status).toBe("running");
      expect(running?.startedAt).not.toBeNull();

      store.updateRunStatus(runId, "completed", {
        completedAt: new Date().toISOString(),
        exitCode: 0
      });
      const completed = store.getRunById(runId);
      expect(completed?.status).toBe("completed");
      expect(completed?.exitCode).toBe(0);

      const byTrace = store.getRunByTraceId("trace-run-1");
      expect(byTrace?.runId).toBe(runId);

      const allRuns = store.listRuns();
      expect(allRuns.some((r) => r.runId === runId)).toBe(true);
    });

    it("stores and retrieves runtime environment fields (virtualEnv, executablePath, entrypoint)", () => {
      const runId = store.createRun({
        traceId: "trace-env-1",
        mode: "record",
        command: ["python", "custom_agent.py"],
        projectRoot: "/external/project",
        virtualEnv: "/external/project/.venv",
        executablePath: "/external/project/.venv/bin/python",
        entrypoint: "/external/project/custom_agent.py"
      });

      const run = store.getRunById(runId);
      expect(run?.projectRoot).toBe("/external/project");
      expect(run?.virtualEnv).toBe("/external/project/.venv");
      expect(run?.executablePath).toBe("/external/project/.venv/bin/python");
      expect(run?.entrypoint).toBe("/external/project/custom_agent.py");
    });

    it("saves and retrieves trace_runtime_metadata and falls back in getRunByTraceId", () => {
      store.saveTraceRuntimeMetadata({
        traceId: "trace-direct-sdk-1",
        projectRoot: "/sdk/project",
        virtualEnv: "/sdk/project/.venv",
        executablePath: "/sdk/project/.venv/bin/python",
        entrypoint: "/sdk/project/agent.py",
        command: ["python", "agent.py"]
      });

      const meta = store.getTraceRuntimeMetadata("trace-direct-sdk-1");
      expect(meta).not.toBeNull();
      expect(meta?.projectRoot).toBe("/sdk/project");
      expect(meta?.virtualEnv).toBe("/sdk/project/.venv");

      // getRunByTraceId synthesizes run context from trace_runtime_metadata
      const synthesizedRun = store.getRunByTraceId("trace-direct-sdk-1");
      expect(synthesizedRun).not.toBeNull();
      expect(synthesizedRun?.projectRoot).toBe("/sdk/project");
      expect(synthesizedRun?.virtualEnv).toBe("/sdk/project/.venv");
      expect(synthesizedRun?.executablePath).toBe("/sdk/project/.venv/bin/python");
      expect(synthesizedRun?.command).toEqual(["python", "agent.py"]);
    });
  });

  // T050: forkTrace lineage and event prefix guarantees
  describe("T050 forkTrace lineage and event prefix guarantees", () => {
    it("creates child trace with derivedFrom lineage, parent events count unchanged, and prefix events match original spanIds", () => {
      const baseEvents = loadPhase2FixtureTrace("base");
      for (const e of baseEvents) store.appendEvent(e);

      const parentEventCountBefore = store.getTrace("t_base")!.events.length;
      expect(parentEventCountBefore).toBeGreaterThan(0);

      const childTraceId = store.forkTrace({
        baseTraceId: "t_base",
        forkFromSpanId: "s3"
      });

      // Child trace created with derivedFrom
      const childTrace = store.getTrace(childTraceId);
      expect(childTrace).not.toBeNull();
      expect(childTrace?.meta.derivedFrom?.baseTraceId).toBe("t_base");
      expect(childTrace?.meta.derivedFrom?.forkedFromSpanId).toBe("s3");

      // Parent events count unchanged
      const parentEventCountAfter = store.getTrace("t_base")!.events.length;
      expect(parentEventCountAfter).toBe(parentEventCountBefore);

      // Child prefix events match original spanIds up to fork point
      const childEvents = childTrace!.events;
      expect(childEvents.length).toBeGreaterThan(0);
      expect(childEvents.some((e) => e.spanId === "s3")).toBe(true);
    });
  });

  // T065: appendReplayAnnotation stores decision, matchedPattern, effectiveClass
  describe("T065 replay routing annotations", () => {
    it("stores decision, matchedPattern, effectiveClass and surfaces on getTrace", () => {
      const baseEvents = loadPhase2FixtureTrace("base");
      for (const e of baseEvents) store.appendEvent(e);

      store.appendReplayAnnotation("t_base", "s1", {
        replaySource: "live",
        decision: "must_execute",
        matchedPattern: "https://api.github.com/*",
        effectiveClass: "must_execute"
      });

      const trace = store.getTrace("t_base");
      expect(trace).not.toBeNull();
      const s1 = trace!.events.find((e) => e.spanId === "s1") as any;
      expect(s1).toBeDefined();
      expect(s1.replaySource).toBe("live");
      expect(s1.decision).toBe("must_execute");
      expect(s1.matchedPattern).toBe("https://api.github.com/*");
      expect(s1.effectiveClass).toBe("must_execute");
    });
  });

  // T100: immutable-parent test
  describe("T100 immutable-parent guarantee", () => {
    it("guarantees parent trace event count and content are byte-identical after forking", () => {
      const baseEvents = loadPhase2FixtureTrace("base");
      for (const e of baseEvents) store.appendEvent(e);

      const parentBefore = JSON.stringify(store.getTrace("t_base")!.events);

      const childTraceId = store.forkTrace({
        baseTraceId: "t_base",
        forkFromSpanId: "s2"
      });

      expect(childTraceId).toBeDefined();
      const parentAfter = JSON.stringify(store.getTrace("t_base")!.events);
      expect(parentAfter).toBe(parentBefore);
    });
  });

  // T105: replay does not mutate history test
  describe("T105 replay-does-not-mutate-history", () => {
    it("guarantees original trace events are untouched when replaying a trace", () => {
      const baseEvents = loadPhase2FixtureTrace("base");
      for (const e of baseEvents) store.appendEvent(e);

      const originalTraceBefore = JSON.stringify(store.getTrace("t_base")!.events);

      // Create new replay run pointing to a new traceId
      const replayTraceId = "t_base_replay";
      store.createRun({
        runId: "run-replay-1",
        traceId: replayTraceId,
        mode: "replay",
        command: ["python", "agent.py"],
        projectRoot: "/tmp"
      });

      // Annotate spans on the NEW replay trace
      store.appendEvent({
        schemaVersion: "1.1.0",
        traceId: replayTraceId,
        spanId: "s1",
        parentSpanId: null,
        occurredAt: new Date().toISOString(),
        actor: { kind: "agent", id: "agent-1" },
        kind: "prompt",
        status: "ok",
        payload: { text: "hello" },
        links: []
      });

      store.appendReplayAnnotation(replayTraceId, "s1", {
        replaySource: "cache",
        tokensSaved: 100
      });

      const originalTraceAfter = JSON.stringify(store.getTrace("t_base")!.events);
      expect(originalTraceAfter).toBe(originalTraceBefore);

      // Verify no replaySource on original trace spans
      const origTrace = store.getTrace("t_base")!;
      for (const ev of origTrace.events as any[]) {
        expect(ev.replaySource).toBeUndefined();
      }
    });

    it("computes scenario-aware token accounting for record, strict replay, and fork modes", () => {
      // 1. Record mode trace: 100% live tokens
      const recTraceId = "t_record_scenario";
      store.appendEvent({
        schemaVersion: "1.1.0",
        traceId: recTraceId,
        spanId: "s1",
        parentSpanId: null,
        occurredAt: "2026-06-01T12:00:00.000Z",
        actor: { kind: "agent", id: "agent" },
        kind: "response",
        status: "ok",
        payload: {
          model: { name: "gpt-4o", provider: "openai" },
          usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 }
        },
        links: []
      });

      const recStats = store.getTraceStats(recTraceId);
      expect(recStats.executionMode).toBe("record");
      expect(recStats.totalTokens).toBe(700);
      expect(recStats.liveTotalTokens).toBe(700);
      expect(recStats.cachedTotalTokens).toBe(0);
      expect(recStats.savingsPercentage).toBe(0);

      // 2. Strict Replay trace: 100% cached tokens ($0.00 live)
      const repTraceId = "t_replay_scenario";
      store.createRun({
        runId: "run_strict_rep",
        traceId: repTraceId,
        parentTraceId: recTraceId,
        mode: "replay",
        command: ["python", "agent.py"],
        projectRoot: "/tmp"
      });
      store.appendEvent({
        schemaVersion: "1.1.0",
        traceId: repTraceId,
        spanId: "s1",
        parentSpanId: null,
        occurredAt: "2026-06-01T12:05:00.000Z",
        actor: { kind: "agent", id: "agent" },
        kind: "response",
        status: "ok",
        payload: {
          model: { name: "gpt-4o", provider: "openai" },
          usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 }
        },
        links: []
      });
      store.appendReplayAnnotation(repTraceId, "s1", {
        replaySource: "cache",
        decision: "cache_hit",
        effectiveClass: "replay_safe"
      });

      const repStats = store.getTraceStats(repTraceId);
      expect(repStats.executionMode).toBe("replay");
      expect(repStats.totalTokens).toBe(700);
      expect(repStats.liveTotalTokens).toBe(0);
      expect(repStats.cachedTotalTokens).toBe(700);
      expect(repStats.savingsPercentage).toBe(100);

      // Verify routingSummary in analyzeTrace
      const repAnalysis = store.analyzeTrace(repTraceId);
      expect(repAnalysis.routingSummary).toEqual({
        cacheHits: 1,
        liveCalls: 0,
        unclassifiedWarnings: 0
      });

      // 3. Diffing record vs replay: returns statsDelta and loopDelta
      const diff = store.diffTraces(recTraceId, repTraceId);
      expect(diff.statsDelta).toBeDefined();
      expect(diff.statsDelta?.totalTokensDelta).toBe(0);
      expect(diff.statsDelta?.liveTokensB).toBe(0);
      expect(diff.statsDelta?.savingsPercentageB).toBe(100);
      expect(diff.loopDelta).toBeDefined();
    });
  });
});



