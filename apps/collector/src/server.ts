import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import yaml from "js-yaml";
import { nanoid } from "nanoid";
import {
  validateTraceEvent,
  validateTraceForkRequest,
  validateTraceForkResponse,
  validateTraceLineageGraph,
  validateTraceDiffResult,
  validateTraceAnalysis,
  validateTraceStats,
  replayTraceRequestSchema,
  forkAndResumeRequestSchema,
  validateRuntimeMetadata,
  type RunMode
} from "@aerograph/contracts";
import { getDatabase } from "./sqlite/db";
import { runMigrations } from "./sqlite/migrate";
import { SqliteTraceStore } from "./sqliteStore";
import { createOtlpIngestHandler } from "./otel/ingest";
import { Runner } from "./replay/runner.js";
import { createOrchestratorApp, loadProjectConfig } from "./replay/orchestrator.js";
import { commandHasExistingScript, resolveCommandScriptPaths } from "./replay/commandResolver.js";
import { cassetteExists } from "./replay/cassette.js";

export type CreateAppOptions = {
  dbPath?: string;
  enableOrchestrator?: boolean;
};

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  const dbPath = options.dbPath ?? process.env.AFR_DB_PATH ?? "data/afr.sqlite";
  const db = getDatabase(dbPath);
  runMigrations(db);
  const store = new SqliteTraceStore(db);
  const runner = new Runner(store);

  app.locals.db = db;
  app.locals.store = store;
  app.locals.runner = runner;

  const isTestEnv = process.env.NODE_ENV === "test";
  const shouldEnableOrchestrator =
    options.enableOrchestrator ??
    (isTestEnv ? process.env.ENABLE_ORCHESTRATOR === "true" : process.env.ENABLE_ORCHESTRATOR !== "false");

  if (shouldEnableOrchestrator) {
    const orchestrator = createOrchestratorApp(store, runner);
    app.locals.orchestrator = orchestrator;
    const ORCH_PORT = Number(process.env.ORCHESTRATOR_PORT ?? 4318);
    orchestrator.listen(ORCH_PORT, "127.0.0.1", () => {
      // eslint-disable-next-line no-console
      console.log(`replay orchestrator listening on http://127.0.0.1:${ORCH_PORT}`);
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/v1/project/config", (req, res) => {
    const projectRoot = (req.query.projectRoot as string) || process.cwd();
    const config = loadProjectConfig(projectRoot);
    res.json({ config: config || null });
  });

  app.post("/v1/project/config", (req, res) => {
    const projectRoot = (req.body.projectRoot as string) || process.cwd();
    const { yamlContent, command } = req.body;
    try {
      const dotAerograph = path.join(projectRoot, ".aerograph");
      if (!fs.existsSync(dotAerograph)) {
        fs.mkdirSync(dotAerograph, { recursive: true });
      }
      const targetPath = path.join(dotAerograph, "aerograph.project.yaml");
      let content = "";
      if (yamlContent && yamlContent.trim()) {
        content = yamlContent.trim();
      } else if (command) {
        const cmdArr = Array.isArray(command) ? command : String(command).trim().split(/\s+/);
        content = yaml.dump({ version: "1", command: cmdArr });
      }
      if (content) {
        fs.writeFileSync(targetPath, content, "utf-8");
      }
      res.json({ ok: true, path: targetPath });
    } catch (err: any) {
      res.status(400).json({ error: err.message || String(err) });
    }
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

  app.post("/v1/traces/:traceId/runtime-metadata", (req, res) => {
    const traceId = req.params.traceId;
    try {
      const data = validateRuntimeMetadata(req.body);
      store.saveTraceRuntimeMetadata({
        traceId,
        projectRoot: data.projectRoot,
        virtualEnv: data.virtualEnv,
        executablePath: data.executablePath,
        entrypoint: data.entrypoint,
        command: data.command
      });
      res.status(201).json({ ok: true, traceId });
    } catch (err: any) {
      res.status(400).json({ error: err?.message ?? String(err) });
    }
  });

  app.get("/v1/traces/:traceId/runtime-metadata", (req, res) => {
    const traceId = req.params.traceId;
    const meta = store.getTraceRuntimeMetadata(traceId);
    const run = store.getRunByTraceId(traceId);
    const projectRoot = meta?.projectRoot || run?.projectRoot || process.cwd();
    const candidateCassetteId = (run?.mode === "record" ? run.runId : (run?.cassetteRunId || run?.runId));
    const hasCassette = candidateCassetteId ? cassetteExists(candidateCassetteId, projectRoot) : false;

    if (!meta) {
      if (run) {
        return res.json({
          traceId,
          projectRoot: run.projectRoot,
          virtualEnv: run.virtualEnv,
          executablePath: run.executablePath,
          entrypoint: run.entrypoint,
          command: run.command,
          cassetteRunId: candidateCassetteId || null,
          hasCassette
        });
      }
      return res.status(404).json({ error: `No runtime metadata for trace ${traceId}` });
    }
    res.json({
      ...meta,
      cassetteRunId: candidateCassetteId || null,
      hasCassette
    });
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

  app.get("/v1/traces/:traceId/events/:spanId", (req, res) => {
    const { traceId, spanId } = req.params;
    const trace = store.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({ error: `Trace ${traceId} not found` });
    }
    const event = trace.events.find((e) => e.spanId === spanId);
    if (!event) {
      return res.status(404).json({ error: `Span ${spanId} not found in trace ${traceId}` });
    }
    res.json(event);
  });

  app.delete("/v1/traces/:traceId", (req, res) => {
    const traceId = req.params.traceId;
    try {
      store.deleteTrace(traceId);
      res.status(200).json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
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

  app.post("/v1/traces/:traceId/replay", async (req, res) => {
    const traceId = req.params.traceId;
    const trace = store.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({ error: `Trace ${traceId} not found` });
    }

    const linkedRun = store.getRunByTraceId(traceId);
    let cassetteRunId = req.body.cassetteRunId as string | undefined;
    if (!cassetteRunId && linkedRun) {
      cassetteRunId = linkedRun.cassetteRunId || linkedRun.runId;
    }

    const projectRoot = (req.body.projectRoot as string) || linkedRun?.projectRoot || process.cwd();
    const virtualEnv = (req.body.virtualEnv as string) ?? linkedRun?.virtualEnv ?? null;
    const executablePath = (req.body.executablePath as string) ?? linkedRun?.executablePath ?? null;
    const entrypoint = (req.body.entrypoint as string) ?? linkedRun?.entrypoint ?? null;

    if (!cassetteRunId || !cassetteExists(cassetteRunId, projectRoot)) {
      return res.status(409).json({ error: "No cassette linked. Re-record this run" });
    }

    const config = loadProjectConfig(projectRoot);
    const command = (req.body.command as string[]) || linkedRun?.command || config?.command || ["python", "agent.py"];

    const newTraceId = `t_${nanoid(12)}`;
    const runId = store.createRun({
      traceId: newTraceId,
      mode: "replay",
      command,
      projectRoot,
      cassetteRunId,
      parentTraceId: traceId,
      virtualEnv,
      executablePath,
      entrypoint
    });

    runner.spawnRun({
      runId,
      traceId: newTraceId,
      mode: "replay",
      command,
      projectRoot,
      cassetteRunId,
      virtualEnv,
      executablePath
    }).catch((err) => {
      console.error(`[Server] Background replay run ${runId} failed:`, err);
    });

    res.status(201).json({
      runId,
      traceId: newTraceId,
      status: "pending"
    });
  });

  app.post("/v1/traces/:traceId/fork-and-resume", async (req, res) => {
    const traceId = req.params.traceId;
    const trace = store.getTrace(traceId);
    if (!trace) {
      return res.status(404).json({ error: "Trace not found" });
    }

    const parseResult = forkAndResumeRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: parseResult.error.message });
    }

    const { forkFromSpanId, overrides, projectConfigYaml } = parseResult.data;
    const linkedRun = store.getRunByTraceId(traceId);
    let projectRoot =
      parseResult.data.projectRoot ||
      (req.body.projectRoot as string) ||
      linkedRun?.projectRoot ||
      process.cwd();

    // 1. If YAML was provided in the request/UI, parse it
    let parsedConfigFromYaml: any = null;
    if (projectConfigYaml && projectConfigYaml.trim()) {
      try {
        parsedConfigFromYaml = yaml.load(projectConfigYaml);
      } catch (err: any) {
        return res.status(400).json({ error: `Invalid YAML configuration: ${err.message}` });
      }
    }

    // 2. Discover existing config from projectRoot (traversing parent directories)
    const config = loadProjectConfig(projectRoot);
    if (config?.configDir) {
      projectRoot = config.configDir;
    }

    // 3. Resolve command with intuitive precedence
    let command: string[] | undefined;
    if (parseResult.data.command) {
      command = Array.isArray(parseResult.data.command)
        ? parseResult.data.command
        : parseResult.data.command.trim().split(/\s+/);
    } else if (parsedConfigFromYaml?.command && Array.isArray(parsedConfigFromYaml.command)) {
      command = parsedConfigFromYaml.command;
    } else if (linkedRun?.command && linkedRun.command.length > 0 && commandHasExistingScript(linkedRun.command, projectRoot)) {
      command = linkedRun.command;
    } else if (config?.command && config.command.length > 0 && commandHasExistingScript(config.command, projectRoot)) {
      command = config.command;
    } else if (linkedRun?.command && linkedRun.command.length > 0) {
      command = linkedRun.command;
    } else if (config?.command && config.command.length > 0) {
      command = config.command;
    }

    if (command && command.length > 0) {
      command = resolveCommandScriptPaths(command, projectRoot);
    }

    if (!command || command.length === 0) {
      return res.status(409).json({
        error: "No project configuration found. You can enter or paste your command (or aerograph.project.yaml) directly in the Fork dialog."
      });
    }

    // 4. Automatically persist config to .aerograph/aerograph.project.yaml so user never has to paste it again
    try {
      const dotAerograph = path.join(projectRoot, ".aerograph");
      if (!fs.existsSync(dotAerograph)) {
        fs.mkdirSync(dotAerograph, { recursive: true });
      }
      const targetYaml = path.join(dotAerograph, "aerograph.project.yaml");
      if (projectConfigYaml && projectConfigYaml.trim()) {
        fs.writeFileSync(targetYaml, projectConfigYaml.trim(), "utf-8");
      } else if (!fs.existsSync(targetYaml) && (!config || !config.command) && commandHasExistingScript(command, projectRoot)) {
        fs.writeFileSync(targetYaml, yaml.dump({ version: "1", command }), "utf-8");
      }
    } catch {
      // Non-blocking auto-persist
    }

    const executionMode: RunMode = parseResult.data.mode === "record" ? "record" : "fork";

    let cassetteRunId = parseResult.data.cassetteRunId || (req.body.cassetteRunId as string | undefined);
    if (executionMode === "record") {
      cassetteRunId = undefined;
    } else if (!cassetteRunId && linkedRun) {
      cassetteRunId = (linkedRun.mode === "record" ? linkedRun.runId : linkedRun.cassetteRunId) || linkedRun.runId;
    }

    const virtualEnv = parseResult.data.virtualEnv ?? linkedRun?.virtualEnv ?? null;
    const executablePath = parseResult.data.executablePath ?? linkedRun?.executablePath ?? null;
    const entrypoint = parseResult.data.entrypoint ?? linkedRun?.entrypoint ?? null;

    let childTraceId: string;
    try {
      childTraceId = store.forkTrace({
        baseTraceId: traceId,
        forkFromSpanId,
        overrides
      });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message ?? String(err) });
    }

    const runId = store.createRun({
      traceId: childTraceId,
      mode: executionMode,
      command,
      projectRoot,
      cassetteRunId,
      parentTraceId: traceId,
      virtualEnv,
      executablePath,
      entrypoint
    });

    runner.spawnRun({
      runId,
      traceId: childTraceId,
      mode: executionMode,
      command,
      projectRoot,
      cassetteRunId,
      parentTraceId: traceId,
      forkFromSpanId,
      forkOverrides: overrides,
      virtualEnv,
      executablePath
    }).catch((err) => {
      console.error(`[Server] Background ${executionMode} run ${runId} failed:`, err);
    });

    res.status(201).json({
      childTraceId,
      runId,
      status: "pending"
    });
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
