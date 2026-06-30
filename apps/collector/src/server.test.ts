import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./server";
import type { Database } from "better-sqlite3";
import { validateTraceForkResponse, validateTraceLineageGraph, validateTraceDiffResult, validateTraceAnalysis, validateTraceStats } from "@aerograph/contracts";
import { loadPhase2FixtureTrace } from "./testUtils";

describe("collector: API", () => {
  it("POST /v1/events accepts valid events", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const randomStr = Math.random().toString(36).substring(7);
    const event = {
      schemaVersion: "1.0.0",
      traceId: `test-t-${randomStr}`,
      spanId: `test-s-${randomStr}`,
      parentSpanId: null,
      occurredAt: new Date().toISOString(),
      actor: { kind: "agent", id: "agent-1" },
      kind: "prompt",
      status: "ok",
      payload: { text: "Hello" },
      links: []
    };

    const res = await request(app).post("/v1/events").send(event);
    expect(res.status).toBe(201);

    db.close();
  });

  it("POST /v1/events rejects invalid events", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const res = await request(app).post("/v1/events").send({});
    expect(res.status).toBe(400);

    db.close();
  });

  it("GET /v1/traces returns a list of traces", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const res = await request(app).get("/v1/traces");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.traces)).toBe(true);

    db.close();
  });

  it("GET /v1/traces/:id returns a trace with meta", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const event = {
      schemaVersion: "1.0.0",
      traceId: "test-t-1",
      spanId: "test-s-1",
      parentSpanId: null,
      occurredAt: new Date().toISOString(),
      actor: { kind: "agent", id: "agent-1" },
      kind: "prompt",
      status: "ok",
      payload: { text: "Hello" },
      links: []
    };

    await request(app).post("/v1/events").send(event).expect(201);

    const res = await request(app).get("/v1/traces/test-t-1");
    expect(res.status).toBe(200);
    expect(res.body.meta.traceId).toBe("test-t-1");
    expect(Array.isArray(res.body.events)).toBe(true);

    db.close();
  });

  it("POST /v1/traces/:traceId/fork creates a derived trace", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const baseEvents = loadPhase2FixtureTrace("base");
    await request(app).post("/v1/events").send(baseEvents).expect(201);

    const forkRes = await request(app)
      .post("/v1/traces/t_base/fork")
      .send({ forkFromSpanId: "s6", overrides: { promptText: "Fork override A" } });

    expect(forkRes.status).toBe(201);
    const forkBody = validateTraceForkResponse(forkRes.body);
    expect(forkBody.traceId).toBeTruthy();
    expect(forkBody.traceId).not.toBe("t_base");

    await request(app).get(`/v1/traces/${forkBody.traceId}`).expect(200);

    db.close();
  });

  it("GET /v1/traces/:traceId/lineage returns a deterministic lineage graph", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const baseEvents = loadPhase2FixtureTrace("base");
    await request(app).post("/v1/events").send(baseEvents).expect(201);

    const forkRes = await request(app)
      .post("/v1/traces/t_base/fork")
      .send({ forkFromSpanId: "s6", overrides: { promptText: "Fork override A" } })
      .expect(201);

    const { traceId: childTraceId } = validateTraceForkResponse(forkRes.body);

    const lineageRes = await request(app).get("/v1/traces/t_base/lineage").expect(200);
    const graph = validateTraceLineageGraph(lineageRes.body);

    expect(graph.rootTraceId).toBe("t_base");
    expect(graph.nodes.map((n) => n.traceId)).toContain("t_base");
    expect(graph.nodes.map((n) => n.traceId)).toContain(childTraceId);
    expect(graph.edges.some((e) => e.parentTraceId === "t_base" && e.childTraceId === childTraceId)).toBe(true);

    db.close();
  });

  // T023: diff API contract tests
  it("GET /v1/traces/:aId/diff/:bId returns a deterministic diff result", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const baseEvents = loadPhase2FixtureTrace("base");
    await request(app).post("/v1/events").send(baseEvents).expect(201);

    const forkRes = await request(app)
      .post("/v1/traces/t_base/fork")
      .send({ forkFromSpanId: "s6", overrides: { promptText: "Fork override" } })
      .expect(201);
    const { traceId: childId } = validateTraceForkResponse(forkRes.body);

    const diffRes = await request(app).get(`/v1/traces/t_base/diff/${childId}`).expect(200);
    const diff = validateTraceDiffResult(diffRes.body);

    expect(diff.a.traceId).toBe("t_base");
    expect(diff.b.traceId).toBe(childId);
    expect(Array.isArray(diff.changed)).toBe(true);

    // Determinism: calling twice returns equal result
    const diffRes2 = await request(app).get(`/v1/traces/t_base/diff/${childId}`).expect(200);
    expect(diffRes2.body).toEqual(diffRes.body);

    db.close();
  });

  it("GET /v1/traces/:aId/diff/:bId returns 404 for missing trace", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const res = await request(app).get("/v1/traces/missing-a/diff/missing-b");
    expect(res.status).toBe(404);

    db.close();
  });

  // T035: analysis API contract tests
  it("GET /v1/traces/:traceId/analysis returns a valid analysis result", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const baseEvents = loadPhase2FixtureTrace("base");
    await request(app).post("/v1/events").send(baseEvents).expect(201);

    const res = await request(app).get("/v1/traces/t_base/analysis").expect(200);
    const analysis = validateTraceAnalysis(res.body);

    expect(Array.isArray(analysis.loops)).toBe(true);
    expect(Array.isArray(analysis.failures)).toBe(true);
    expect(typeof analysis.stats.eventCount).toBe("number");
    expect(typeof analysis.stats.actorCount).toBe("number");

    db.close();
  });

  it("GET /v1/traces/:traceId/analysis returns 404 for missing trace", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const res = await request(app).get("/v1/traces/nonexistent/analysis");
    expect(res.status).toBe(404);

    db.close();
  });

  // T048: fork error-path tests
  it("POST /v1/traces/:traceId/fork returns 404 for missing base trace", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const res = await request(app)
      .post("/v1/traces/nonexistent-trace/fork")
      .send({ forkFromSpanId: "s1" });

    expect(res.status).toBe(404);
    db.close();
  });

  it("POST /v1/traces/:traceId/fork returns 400 for missing forkFromSpanId", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const baseEvents = loadPhase2FixtureTrace("base");
    await request(app).post("/v1/events").send(baseEvents).expect(201);

    const res = await request(app)
      .post("/v1/traces/t_base/fork")
      .send({ forkFromSpanId: "nonexistent-span" });

    expect(res.status).toBe(400);
    db.close();
  });

  it("POST /v1/traces/:traceId/fork returns 400 for invalid request body", async () => {
    const app = createApp({ dbPath: ":memory:" });
    const db = app.locals.db as Database;

    const res = await request(app)
      .post("/v1/traces/t_base/fork")
      .send({ invalid: true });

    expect(res.status).toBe(400);
    db.close();
  });

  // T014: /stats endpoint contract tests
  describe("GET /v1/traces/:traceId/stats", () => {
    it("returns stable TraceStats shape for a trace with legacy v1.0.0 events", async () => {
      const app = createApp({ dbPath: ":memory:" });
      const db = app.locals.db as Database;

      const baseEvents = loadPhase2FixtureTrace("base");
      await request(app).post("/v1/events").send(baseEvents).expect(201);

      const res = await request(app).get("/v1/traces/t_base/stats").expect(200);
      const stats = validateTraceStats(res.body);

      expect(stats.traceId).toBe("t_base");
      expect(stats.eventCount).toBeGreaterThan(0);
      expect(stats.actorCount).toBeGreaterThan(0);
      // v1.0.0 traces have no telemetry columns → nulls are valid
      expect(stats.totalTokens === null || typeof stats.totalTokens === "number").toBe(true);
      expect(Array.isArray(stats.modelBreakdown)).toBe(true);
      // Determinism: identical response on repeated calls
      const res2 = await request(app).get("/v1/traces/t_base/stats").expect(200);
      expect(res2.body).toEqual(res.body);

      db.close();
    });

    it("returns 404 for missing trace", async () => {
      const app = createApp({ dbPath: ":memory:" });
      const db = app.locals.db as Database;

      const res = await request(app).get("/v1/traces/nonexistent/stats");
      expect(res.status).toBe(404);
      db.close();
    });

    it("returns token and model data for v1.1.0 telemetry-enriched events", async () => {
      const app = createApp({ dbPath: ":memory:" });
      const db = app.locals.db as Database;

      // Ingest a v1.1.0 event with model + usage in payload
      const event = {
        schemaVersion: "1.1.0",
        traceId: "t_v11",
        spanId: "s1",
        parentSpanId: null,
        occurredAt: new Date().toISOString(),
        actor: { kind: "agent", id: "agent-1" },
        kind: "response",
        status: "ok",
        payload: {
          text: "Hello",
          model: { name: "gpt-4o", provider: "openai" },
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
        },
        durationMs: 1200,
        links: []
      };

      await request(app).post("/v1/events").send(event).expect(201);

      const res = await request(app).get("/v1/traces/t_v11/stats").expect(200);
      const stats = validateTraceStats(res.body);

      expect(stats.traceId).toBe("t_v11");
      expect(stats.totalInputTokens).toBe(100);
      expect(stats.totalOutputTokens).toBe(50);
      expect(stats.totalTokens).toBe(150);
      expect(stats.totalDurationMs).toBe(1200);
      expect(stats.modelBreakdown).toHaveLength(1);
      expect(stats.modelBreakdown[0].modelName).toBe("gpt-4o");
      expect(stats.modelBreakdown[0].provider).toBe("openai");
      expect(stats.modelBreakdown[0].totalTokens).toBe(150);

      db.close();
    });
  });
});
