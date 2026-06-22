import express from "express";
import cors from "cors";
import { validateTraceEvent, validateTraceForkRequest, validateTraceForkResponse, validateTraceLineageGraph, validateTraceDiffResult, validateTraceAnalysis, validateTraceStats } from "@aerograph/contracts";
import { getDatabase } from "./sqlite/db";
import { runMigrations } from "./sqlite/migrate";
import { SqliteTraceStore } from "./sqliteStore";
import { createOtlpIngestHandler } from "./otel/ingest";

export type CreateAppOptions = {
  dbPath?: string;
};

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  const dbPath = options.dbPath ?? process.env.AFR_DB_PATH ?? "data/afr.sqlite";
  const db = getDatabase(dbPath);
  runMigrations(db);
  const store = new SqliteTraceStore(db);

  app.locals.db = db;
  app.locals.store = store;

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/v1/events", (req, res) => {
    try {
      const body = req.body;
      const events = Array.isArray(body) ? body : [body];
      const parsed = events.map((e) => validateTraceEvent(e));
      for (const event of parsed) {
        store.appendEvent(event);
      }
      res.status(201).send();
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  app.post("/v1/otlp/traces", createOtlpIngestHandler(store));

  app.get("/v1/traces", (req, res) => {
    const projectId = req.query.projectId as string | undefined;
    const environment = req.query.environment as string | undefined;
    res.json(store.listTraces({ projectId, environment }));
  });

  app.get("/v1/traces/:traceId", (req, res) => {
    const traceId = req.params.traceId;
    const trace = store.getTrace(traceId);
    if (!trace) {
      res.status(404).json({ error: "Trace not found" });
      return;
    }
    res.json(trace);
  });

  app.post("/v1/traces/:traceId/fork", (req, res) => {
    const baseTraceId = req.params.traceId;

    try {
      const parsed = validateTraceForkRequest(req.body);
      const childTraceId = store.forkTrace({
        baseTraceId,
        forkFromSpanId: parsed.forkFromSpanId,
        overrides: parsed.overrides ?? {}
      });

      const body = validateTraceForkResponse({ traceId: childTraceId });
      res.status(201).json(body);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      // Only 404 when the base trace itself doesn't exist
      if (message.startsWith("Base trace not found:")) {
        res.status(404).json({ error: message });
        return;
      }
      // Span not found in trace, invalid request body, etc. → 400
      res.status(400).json({ error: message });
    }
  });

  app.get("/v1/traces/:traceId/lineage", (req, res) => {
    const traceId = req.params.traceId;
    try {
      const graph = store.getLineageGraph(traceId);
      const body = validateTraceLineageGraph(graph);
      res.json(body);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  });

  app.get("/v1/traces/:aId/diff/:bId", (req, res) => {
    const { aId, bId } = req.params;
    try {
      const result = store.diffTraces(aId, bId);
      const body = validateTraceDiffResult(result);
      res.json(body);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  });

  app.get("/v1/traces/:traceId/analysis", (req, res) => {
    const traceId = req.params.traceId;
    try {
      const result = store.analyzeTrace(traceId);
      const body = validateTraceAnalysis(result);
      res.json(body);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  });

  /**
   * GET /v1/traces/:traceId/stats
   *
   * Stable analytics API contract (T014).
   *
   * Returns aggregated telemetry statistics for a trace: total token usage,
   * execution duration, actor count, per-model breakdown, and trace timing.
   * Computed from indexed columns — does NOT parse event_data JSON.
   *
   * Contract stability guarantee:
   *   - All fields present in this response are ADDITIVE-ONLY.
   *   - Null values indicate the field has no data (v1.0.0 legacy traces).
   *   - modelBreakdown is always an array (may be empty).
   *   - This endpoint is safe to integrate into: dashboards, evaluation
   *     pipelines, regression detectors, and future Feature 006/007 analytics.
   */
  app.get("/v1/traces/:traceId/stats", (req, res) => {
    const traceId = req.params.traceId;
    try {
      const result = store.getTraceStats(traceId);
      const body = validateTraceStats(result);
      res.json(body);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (message.includes("not found")) {
        res.status(404).json({ error: message });
        return;
      }
      res.status(400).json({ error: message });
    }
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  const PORT = Number(process.env.PORT ?? 4317);
  const app = createApp();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`collector listening on http://localhost:${PORT}`);
  });
}
