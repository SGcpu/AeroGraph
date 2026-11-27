import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import yaml from "js-yaml";
import { nanoid } from "nanoid";
import {
  startRunRequestSchema,
  startRunResponseSchema,
  type StartRunRequest,
  type StartRunResponse,
  type GetRunResponse
} from "@aerograph/contracts";
import type { SqliteTraceStore } from "../sqliteStore.js";
import type { Runner } from "./runner.js";
import { loadPolicy, computeLiveHosts } from "./policy.js";
import { commandHasExistingScript, resolveCommandScriptPaths } from "./commandResolver.js";

/**
 * Resolves the default project root. When Collector runs via `npm run dev` inside
 * `apps/collector`, `process.cwd()` is `.../apps/collector`; walk up to the
 * monorepo root so `examples/*` and `.aerograph/` resolve correctly.
 */
export function resolveDefaultProjectRoot(cwd: string = process.cwd()): string {
  if (process.env.AEROGRAPH_PROJECT_ROOT) {
    return path.resolve(process.env.AEROGRAPH_PROJECT_ROOT);
  }
  const resolved = path.resolve(cwd);
  if (
    path.basename(resolved) === "collector" &&
    path.basename(path.dirname(resolved)) === "apps" &&
    fs.existsSync(path.resolve(resolved, "..", "..", "package.json"))
  ) {
    return path.resolve(resolved, "..", "..");
  }
  return resolved;
}

/**
 * Loads and parses aerograph.project.yaml from projectRoot if it exists,
 * traversing up parent directories until found or reaching filesystem root.
 */
export function loadProjectConfig(projectRoot: string): {
  command?: string[];
  collector?: string;
  orchestrator?: string;
  configDir?: string;
} | null {
  let currentDir = path.resolve(projectRoot);
  while (true) {
    const dotPath = path.join(currentDir, ".aerograph", "aerograph.project.yaml");
    const rootPath = path.join(currentDir, "aerograph.project.yaml");

    let configPath: string | null = null;
    if (fs.existsSync(dotPath) && fs.existsSync(rootPath)) {
      try {
        const dotParsed = yaml.load(fs.readFileSync(dotPath, "utf-8")) as any;
        const rootParsed = yaml.load(fs.readFileSync(rootPath, "utf-8")) as any;
        const dotHasScript = dotParsed?.command && commandHasExistingScript(dotParsed.command, currentDir);
        const rootHasScript = rootParsed?.command && commandHasExistingScript(rootParsed.command, currentDir);
        if (rootHasScript && !dotHasScript) {
          configPath = rootPath;
        } else {
          configPath = dotPath;
        }
      } catch {
        configPath = dotPath;
      }
    } else if (fs.existsSync(dotPath)) {
      configPath = dotPath;
    } else if (fs.existsSync(rootPath)) {
      configPath = rootPath;
    }

    if (configPath) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const parsed = yaml.load(raw) as any;
        return { ...parsed, configDir: currentDir };
      } catch (err) {
        throw new Error(`Invalid aerograph.project.yaml at ${configPath}: ${err}`);
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return null;
}

export function createOrchestratorApp(store: SqliteTraceStore, runner: Runner): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "aerograph-orchestrator" });
  });

  // List runs
  app.get("/v1/runs", (_req: Request, res: Response) => {
    const runs = store.listRuns();
    res.json(runs);
  });

  // Get run by ID
  app.get("/v1/runs/:id", (req: Request, res: Response) => {
    const run = store.getRunById(req.params.id);
    if (!run) {
      return res.status(404).json({ error: `Run with ID ${req.params.id} not found` });
    }
    res.json(run);
  });

  // Start a new run
  app.post("/v1/runs", async (req: Request, res: Response) => {
    let parsedReq: StartRunRequest;
    try {
      parsedReq = startRunRequestSchema.parse(req.body);
    } catch (err: any) {
      return res.status(400).json({ error: `Invalid StartRunRequest: ${err.message}` });
    }

    // If command or projectRoot not supplied, attempt to resolve from source run or aerograph.project.yaml
    let sourceRun: any = null;
    if (parsedReq.cassetteRunId) {
      sourceRun = store.getRunById(parsedReq.cassetteRunId);
    }

    let projectRoot = parsedReq.projectRoot || sourceRun?.projectRoot || resolveDefaultProjectRoot();
    const virtualEnv = parsedReq.virtualEnv ?? sourceRun?.virtualEnv ?? null;
    const executablePath = parsedReq.executablePath ?? sourceRun?.executablePath ?? null;
    const entrypoint = parsedReq.entrypoint ?? sourceRun?.entrypoint ?? null;
    let command = parsedReq.command;

    if (!command || command.length === 0) {
      const config = loadProjectConfig(projectRoot);
      if (!parsedReq.projectRoot && !sourceRun?.projectRoot && config?.configDir) {
        projectRoot = config.configDir;
      }
      if (sourceRun && sourceRun.command && commandHasExistingScript(sourceRun.command, projectRoot)) {
        command = sourceRun.command;
      } else if (config && config.command && commandHasExistingScript(config.command, projectRoot)) {
        command = config.command;
      } else if (config && config.command) {
        command = config.command;
      } else if (sourceRun && sourceRun.command) {
        command = sourceRun.command;
      }
    }

    if (command && command.length > 0) {
      // Split accidental multi-word first token like "uv run" into ["uv", "run"]
      if (command[0] && /\s/.test(command[0]) && !fs.existsSync(command[0])) {
        command = [...command[0].trim().split(/\s+/), ...command.slice(1)];
      }
      command = resolveCommandScriptPaths(command, projectRoot);
    }

    if (!command || command.length === 0) {
      return res.status(400).json({
        error: "Missing command: command must be provided in request body, in aerograph.project.yaml, or inherit from recorded cassetteRunId"
      });
    }

    const traceId = `t_${nanoid(12)}`;
    const parentTraceId = (parsedReq as any).parentTraceId ?? (sourceRun ? sourceRun.traceId : null);
    const runId = store.createRun({
      traceId,
      mode: parsedReq.mode,
      command,
      projectRoot,
      parentTraceId,
      cassetteRunId: parsedReq.cassetteRunId ?? null,
      virtualEnv,
      executablePath,
      entrypoint
    });

    const response: StartRunResponse = {
      runId,
      traceId,
      status: "pending"
    };

    // In replay/fork mode, compute liveHosts from policy
    let liveHosts: string[] | undefined;
    if (parsedReq.mode === "replay" || parsedReq.mode === "fork") {
      try {
        const policy = loadPolicy(projectRoot);
        liveHosts = computeLiveHosts(policy);
      } catch (err: any) {
        // Log or handle policy validation
      }
    }

    // Spawn run asynchronously in the background
    runner.spawnRun({
      runId,
      traceId,
      mode: parsedReq.mode,
      command,
      projectRoot,
      cassetteRunId: parsedReq.cassetteRunId,
      parentTraceId,
      liveHosts,
      virtualEnv,
      executablePath,
      stdinMode: parsedReq.stdinMode,
      inboundOverrides: parsedReq.inboundOverrides
    }).catch((err) => {
      console.error(`[Orchestrator] Run ${runId} encountered background error:`, err);
    });

    res.status(201).json(startRunResponseSchema.parse(response));
  });

  // Cancel a run
  app.post("/v1/runs/:id/cancel", (req: Request, res: Response) => {
    const run = store.getRunById(req.params.id);
    if (!run) {
      return res.status(404).json({ error: `Run with ID ${req.params.id} not found` });
    }

    store.updateRunStatus(req.params.id, "failed", {
      completedAt: new Date().toISOString(),
      errorMessage: "Run cancelled by user request"
    });

    res.json({ success: true, message: `Run ${req.params.id} cancelled` });
  });

  // ── WP-3 & WP-4: Human Input Long-Poll, Inbound Turns & Local Retrievals ────
  interface PendingInputState {
    waiting: boolean;
    turn: number | null;
    prompt: string | null;
    spanId?: string | null;
    payload?: string;
  }
  const inputWaitStates = new Map<string, PendingInputState>();

  app.post("/v1/runs/:id/input-wait", (req: Request, res: Response) => {
    const runId = req.params.id;
    const { turn, prompt, spanId } = req.body || {};
    inputWaitStates.set(runId, {
      waiting: true,
      turn: typeof turn === "number" ? turn : 0,
      prompt: typeof prompt === "string" ? prompt : "",
      spanId: spanId ?? null
    });
    res.json({ ok: true, waiting: true });
  });

  app.get("/v1/runs/:id/input-wait", (req: Request, res: Response) => {
    const state = inputWaitStates.get(req.params.id);
    if (!state) {
      return res.json({ waiting: false, turn: null, prompt: null });
    }
    res.json(state);
  });

  app.post("/v1/runs/:id/input-submit", (req: Request, res: Response) => {
    const runId = req.params.id;
    const { turn, payload } = req.body || {};
    const prev = inputWaitStates.get(runId);
    inputWaitStates.set(runId, {
      waiting: false,
      turn: typeof turn === "number" ? turn : (prev?.turn ?? 0),
      prompt: prev?.prompt ?? "",
      spanId: prev?.spanId ?? null,
      payload: String(payload ?? "")
    });
    res.json({ ok: true, waiting: false });
  });

  app.post("/v1/runs/:id/inbound", (req: Request, res: Response) => {
    const runId = req.params.id;
    runner.addInboundTurn(runId, req.body || {});
    res.status(201).json({ ok: true });
  });

  app.get("/v1/runs/:id/inbound", (req: Request, res: Response) => {
    const runId = req.params.id;
    const run = store.getRunById(runId);
    const inbound = runner.getInboundTurns(runId, run?.projectRoot);
    res.json({ inbound });
  });

  app.post("/v1/runs/:id/local-retrievals", (req: Request, res: Response) => {
    const runId = req.params.id;
    runner.addLocalRetrieval(runId, req.body || {});
    res.status(201).json({ ok: true });
  });

  app.get("/v1/runs/:id/local-retrievals", (req: Request, res: Response) => {
    const runId = req.params.id;
    const run = store.getRunById(runId);
    const localRetrievals = runner.getLocalRetrievals(runId, run?.projectRoot);
    res.json({ localRetrievals });
  });

  // ── Interactive Session API (T075) ──────────────────────────────────────────
  interface InteractiveSession {
    sessionId: string;
    runId: string;
    traceId: string;
    currentStep: number;
    overrides: Record<string, any>;
  }
  const sessions = new Map<string, InteractiveSession>();

  // POST /v1/sessions
  app.post("/v1/sessions", (req: Request, res: Response) => {
    const { runId } = req.body;
    const run = store.getRunById(runId);
    if (!run) {
      return res.status(404).json({ error: `Run ${runId} not found` });
    }
    const sessionId = `sess_${nanoid(10)}`;
    const session: InteractiveSession = {
      sessionId,
      runId,
      traceId: run.traceId || "",
      currentStep: 0,
      overrides: {}
    };
    sessions.set(sessionId, session);
    res.status(201).json({ sessionId, runId, status: "active" });
  });

  // GET /v1/sessions/:id
  app.get("/v1/sessions/:id", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: `Session ${req.params.id} not found` });
    }
    res.json(session);
  });

  // POST /v1/sessions/:id/step
  app.post("/v1/sessions/:id/step", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: `Session ${req.params.id} not found` });
    }
    session.currentStep++;
    const trace = store.getTrace(session.traceId);
    const event = trace?.events[session.currentStep - 1] || null;
    res.json({
      step: session.currentStep,
      spanSummary: event ? { spanId: event.spanId, kind: event.kind, status: event.status } : null
    });
  });

  // POST /v1/sessions/:id/override
  app.post("/v1/sessions/:id/override", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: `Session ${req.params.id} not found` });
    }
    const { spanId, value } = req.body;
    session.overrides[spanId] = value;
    runner.setOverride(session.runId, spanId, value);
    res.json({ ok: true, spanId, overridden: true });
  });

  // POST /v1/sessions/:id/rewind
  app.post("/v1/sessions/:id/rewind", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: `Session ${req.params.id} not found` });
    }
    const steps = Number(req.body.steps ?? 1);
    session.currentStep = Math.max(0, session.currentStep - steps);

    const trace = store.getTrace(session.traceId);
    const targetEvent = trace?.events[Math.max(0, session.currentStep - 1)];
    const forkFromSpanId = targetEvent?.spanId || "s1";

    const newTraceId = store.forkTrace({
      baseTraceId: session.traceId,
      forkFromSpanId
    });

    res.json({
      newTraceId,
      sessionId: session.sessionId,
      currentStep: session.currentStep
    });
  });

  return app;
}

