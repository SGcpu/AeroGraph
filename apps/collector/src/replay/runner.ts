import child_process, { ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import type { SqliteTraceStore } from "../sqliteStore.js";
import type { RunMode } from "@aerograph/contracts";
import { writeForkCassette } from "./cassette.js";
import { loadPolicy, computeLiveHosts } from "./policy.js";
import { resolveCommandScriptPaths } from "./commandResolver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SpawnRunOptions {
  runId: string;
  traceId: string;
  mode: RunMode;
  command: string[];
  projectRoot: string;
  cassetteRunId?: string | null;
  parentTraceId?: string | null;
  forkFromSpanId?: string | null;
  forkOverrides?: { promptText?: string } | null;
  liveHosts?: string[];
  overrideFile?: string | null;
  virtualEnv?: string | null;
  executablePath?: string | null;
  stdinMode?: "inherit" | "pipe";
  inboundOverrides?: Record<string, string>;
}

export class Runner {
  private pendingInbound = new Map<string, any[]>();
  private pendingLocalRetrievals = new Map<string, any[]>();

  constructor(private store: SqliteTraceStore) {}

  addInboundTurn(runId: string, entry: any): void {
    const list = this.pendingInbound.get(runId) || [];
    list.push({ ...entry, recordedAt: new Date().toISOString() });
    this.pendingInbound.set(runId, list);
  }

  getInboundTurns(runId: string, projectRoot?: string): any[] {
    const mem = this.pendingInbound.get(runId);
    if (mem && mem.length > 0) return mem;
    if (projectRoot) {
      const p = path.join(projectRoot, ".aerograph", "cassettes", `${runId}.json`);
      if (fs.existsSync(p)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (Array.isArray(parsed?.inbound)) return parsed.inbound;
        } catch {
          // ignore
        }
      }
    }
    return [];
  }

  addLocalRetrieval(runId: string, entry: any): void {
    const list = this.pendingLocalRetrievals.get(runId) || [];
    list.push({ ...entry, recordedAt: new Date().toISOString() });
    this.pendingLocalRetrievals.set(runId, list);
  }

  getLocalRetrievals(runId: string, projectRoot?: string): any[] {
    const mem = this.pendingLocalRetrievals.get(runId);
    if (mem && mem.length > 0) return mem;
    if (projectRoot) {
      const p = path.join(projectRoot, ".aerograph", "cassettes", `${runId}.json`);
      if (fs.existsSync(p)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
          if (Array.isArray(parsed?.localRetrievals)) return parsed.localRetrievals;
        } catch {
          // ignore
        }
      }
    }
    return [];
  }

  private mergeSidecarDataIntoCassette(runId: string, projectRoot: string, cassetteRunId?: string | null): void {
    const inbound = this.pendingInbound.get(runId);
    const localRetrievals = this.pendingLocalRetrievals.get(runId);
    if ((!inbound || inbound.length === 0) && (!localRetrievals || localRetrievals.length === 0)) {
      return;
    }
    try {
      const cassetteDir = path.join(projectRoot, ".aerograph", "cassettes");
      fs.mkdirSync(cassetteDir, { recursive: true });
      const cassettePath = path.join(cassetteDir, `${runId}.json`);
      let data: any = { run_id: runId, steps: [] };
      if (fs.existsSync(cassettePath)) {
        data = JSON.parse(fs.readFileSync(cassettePath, "utf-8"));
      } else if (cassetteRunId) {
        const parentPath = path.join(cassetteDir, `${cassetteRunId}.json`);
        if (fs.existsSync(parentPath)) {
          data = JSON.parse(fs.readFileSync(parentPath, "utf-8"));
          data.run_id = runId;
        }
      }
      if (inbound && inbound.length > 0) {
        data.inbound = inbound;
      }
      if (localRetrievals && localRetrievals.length > 0) {
        data.localRetrievals = localRetrievals;
      }
      const tmpPath = `${cassettePath}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, cassettePath);
    } catch (err) {
      console.warn(`[Runner] Failed to merge inbound/localRetrievals into cassette for ${runId}:`, err);
    } finally {
      this.pendingInbound.delete(runId);
      this.pendingLocalRetrievals.delete(runId);
    }
  }

  /**
   * Resolves the path to the aerograph-replay-core binary.
   */
  resolveBinary(): string {
    if (process.env.AERO_REPLAY_CORE_BIN && fs.existsSync(process.env.AERO_REPLAY_CORE_BIN)) {
      return process.env.AERO_REPLAY_CORE_BIN;
    }

    const ext = process.platform === "win32" ? ".exe" : "";
    const repoBinary = path.resolve(
      process.cwd(),
      "packages",
      "replay-core",
      "bin",
      `aerograph-replay-core${ext}`
    );

    if (fs.existsSync(repoBinary)) {
      return repoBinary;
    }

    // Fallback if running from within apps/collector
    const relativeBinary = path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "packages",
      "replay-core",
      "bin",
      `aerograph-replay-core${ext}`
    );
    if (fs.existsSync(relativeBinary)) {
      return relativeBinary;
    }

    return `aerograph-replay-core${ext}`;
  }

  /**
   * Spawns an agent execution wrapped in aerograph-replay-core.
   * NEVER uses shell interpolation: arguments are strictly passed as an array.
   */
  async spawnRun(options: SpawnRunOptions): Promise<void> {
    const {
      runId,
      traceId,
      mode,
      command,
      projectRoot,
      cassetteRunId,
      parentTraceId,
      forkFromSpanId,
      forkOverrides,
      overrideFile
    } = options;
    let liveHosts = options.liveHosts;

    // Load policy live-hosts if not explicitly passed
    if (!liveHosts || liveHosts.length === 0) {
      try {
        const policy = loadPolicy(projectRoot);
        liveHosts = computeLiveHosts(policy);
      } catch {
        // Policy optional if not configured
      }
    }

    // Write prompt override JSON if provided
    let effectiveOverrideFile = overrideFile;
    let originalPromptText = "";
    let targetNodeName = "";

    const baseTraceId = parentTraceId || (cassetteRunId ? (this.store as any).getRunById?.(cassetteRunId)?.traceId : null);
    if (baseTraceId && forkFromSpanId) {
      try {
        let currTraceId: string | null = baseTraceId;
        while (currTraceId) {
          const t = (this.store as any).getTrace?.(currTraceId);
          const targetSpan = t?.events?.find((e: any) => e.spanId === forkFromSpanId);
          if (targetSpan) {
            if ((targetSpan.payload as any)?.text) {
              originalPromptText = (targetSpan.payload as any).text;
            }
            if (!targetNodeName) {
              if (targetSpan.parentSpanId) {
                const parentSpan = t.events.find((e: any) => e.spanId === targetSpan.parentSpanId);
                if (parentSpan?.title) {
                  targetNodeName = parentSpan.title.toLowerCase();
                }
              }
              if (!targetNodeName && targetSpan.title) {
                targetNodeName = targetSpan.title.toLowerCase();
              }
            }
          }
          // If this trace has a parent trace, traverse up to find the root original prompt text
          currTraceId = t?.parentTraceId || null;
        }
      } catch {
        // best effort lookup
      }
    }

    if (!effectiveOverrideFile) {
      const ovrPath = path.join(os.tmpdir(), `afr_ovr_${runId}.json`);
      if (forkOverrides?.promptText) {
        fs.writeFileSync(
          ovrPath,
          JSON.stringify({
            forkFromSpanId,
            promptText: forkOverrides.promptText,
            originalPromptText
          }),
          "utf-8"
        );
        effectiveOverrideFile = ovrPath;
      } else if (fs.existsSync(ovrPath)) {
        effectiveOverrideFile = ovrPath;
      }
    }

    // In fork mode, load the FULL parent cassette (hybrid replay-to-live via --fallback)
    // instead of truncating by index, so parallel fan-out branches resolve deterministically.
    let targetCassetteId = cassetteRunId || runId;
    if (mode === "fork" && cassetteRunId) {
      try {
        const parentCassette = path.join(projectRoot, ".aerograph", "cassettes", `${cassetteRunId}.json`);
        const runsDir = path.join(projectRoot, ".agent-replay", "runs");
        fs.mkdirSync(runsDir, { recursive: true });
        const forkRunFile = path.join(runsDir, `${runId}.json`);
        if (fs.existsSync(parentCassette) && !fs.existsSync(forkRunFile)) {
          const parsed = JSON.parse(fs.readFileSync(parentCassette, "utf-8"));
          parsed.run_id = runId;
          fs.writeFileSync(forkRunFile, JSON.stringify(parsed, null, 2), "utf-8");
          targetCassetteId = runId;
        }
      } catch (err) {
        console.warn(`[Runner] Could not stage full parent cassette for fork:`, err);
      }
    }

    // Ensure .agent-replay/runs file exists for replay-core
    if (mode === "replay" || mode === "fork") {
      try {
        const runsDir = path.join(projectRoot, ".agent-replay", "runs");
        if (!fs.existsSync(runsDir)) {
          fs.mkdirSync(runsDir, { recursive: true });
        }
        const runFilePath = path.join(runsDir, `${targetCassetteId}.json`);
        if (!fs.existsSync(runFilePath)) {
          fs.writeFileSync(
            runFilePath,
            JSON.stringify(
              {
                run_id: targetCassetteId,
                original_command: command.join(" "),
                steps: []
              },
              null,
              2
            ),
            "utf-8"
          );
        }
      } catch (err) {
        console.warn(`[Runner] Could not ensure fallback run file:`, err);
      }
    }

    const binary = this.resolveBinary();
    let resolvedCommand = resolveCommandScriptPaths(command, projectRoot);

    const virtualEnv = options.virtualEnv;
    const executablePath = options.executablePath;

    // Resolve interpreter to virtual environment binary if available
    if (virtualEnv) {
      const venvBin = process.platform === "win32"
        ? path.join(virtualEnv, "Scripts")
        : path.join(virtualEnv, "bin");

      if (resolvedCommand[0] === "python" || resolvedCommand[0] === "python3") {
        const venvPython = process.platform === "win32"
          ? path.join(venvBin, "python.exe")
          : path.join(venvBin, "python");
        if (fs.existsSync(venvPython)) {
          resolvedCommand = [venvPython, ...resolvedCommand.slice(1)];
        } else if (executablePath && fs.existsSync(executablePath)) {
          resolvedCommand = [executablePath, ...resolvedCommand.slice(1)];
        }
      }
    } else if (executablePath && (resolvedCommand[0] === "python" || resolvedCommand[0] === "python3")) {
      if (fs.existsSync(executablePath)) {
        resolvedCommand = [executablePath, ...resolvedCommand.slice(1)];
      }
    }

    // Create temp path for annotation log
    const annotationLogPath = path.join(os.tmpdir(), `afr_ann_${runId}.json`);

    // Prepare CLI arguments
    const args: string[] = [];

    if (mode === "record") {
      args.push("record");
      args.push("--run-id", runId);
      args.push("--annotation-log", annotationLogPath);
      if (effectiveOverrideFile) {
        args.push("--override-file", effectiveOverrideFile);
      }
      args.push(...resolvedCommand);
    } else {
      // replay or fork mode
      args.push("replay");
      args.push("--annotation-log", annotationLogPath);

      if (mode === "fork") {
        args.push("--fallback");
      }

      if (liveHosts && liveHosts.length > 0) {
        args.push("--live-hosts", liveHosts.join(","));
      }

      if (effectiveOverrideFile) {
        args.push("--override-file", effectiveOverrideFile);
      }

      args.push(targetCassetteId);
      args.push(...resolvedCommand);
    }

    // Build environment with virtual environment on PATH
    const currentPath = process.env.PATH || process.env.Path || "";
    let effectivePath = currentPath;
    if (virtualEnv) {
      const venvBin = process.platform === "win32"
        ? path.join(virtualEnv, "Scripts")
        : path.join(virtualEnv, "bin");
      if (fs.existsSync(venvBin)) {
        effectivePath = `${venvBin}${path.delimiter}${currentPath}`;
      }
    }

    // Resolve zero-refactor Python & Node shims
    const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
    const pySdkSrc = path.join(repoRoot, "python", "aerograph-sdk", "src");
    const pyShimDir = path.join(pySdkSrc, "aerograph_sdk", "shim");
    const existingPyPath = process.env.PYTHONPATH || "";
    const pyPaths = [pyShimDir, pySdkSrc, existingPyPath].filter(Boolean).join(path.delimiter);

    const nodeShimPath = path.join(repoRoot, "packages", "sdk", "dist", "shim.js");
    let effectiveNodeOptions = process.env.NODE_OPTIONS || "";
    if (fs.existsSync(nodeShimPath) && !effectiveNodeOptions.includes(nodeShimPath)) {
      effectiveNodeOptions = `${effectiveNodeOptions} --require "${nodeShimPath}"`.trim();
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AFR_RUN_ID: runId,
      AEROREPL_RUN_ID: runId,
      AFR_TRACE_ID: traceId,
      AEROGRAPH_MODE: mode,
      AEROGRAPH_ORCHESTRATOR_URL: process.env.AEROGRAPH_ORCHESTRATOR_URL || "http://127.0.0.1:4318",
      AEROGRAPH_ENDPOINT: process.env.AEROGRAPH_ENDPOINT || "http://127.0.0.1:4317",
      AEROGRAPH_CASSETTE_RUN_ID: cassetteRunId || runId,
      AEROGRAPH_THREAD_ID: runId,
      AEROGRAPH_INBOUND_OVERRIDES: options.inboundOverrides ? JSON.stringify(options.inboundOverrides) : "",
      AFR_PROMPT_OVERRIDE: "",
      AFR_TARGET_NODE: targetNodeName || "",
      AFR_FORK_FROM_SPAN_ID: forkFromSpanId || "",
      HTTP_PROXY: process.env.HTTP_PROXY || "",
      HTTPS_PROXY: process.env.HTTPS_PROXY || "",
      http_proxy: process.env.http_proxy || "",
      https_proxy: process.env.https_proxy || "",
      PATH: effectivePath,
      Path: effectivePath,
      PYTHONPATH: pyPaths,
      NODE_OPTIONS: effectiveNodeOptions,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1"
    };

    if (virtualEnv) {
      env.VIRTUAL_ENV = virtualEnv;
      delete env.PYTHONHOME;
    }

    const startedAt = new Date().toISOString();
    this.store.updateRunStatus(runId, "running", { startedAt });

    if (mode === "fork" || mode === "record") {
      try {
        (this.store as any).clearTraceEvents?.(traceId);
      } catch (err) {
        console.warn(`[Runner] Could not clear trace events for trace ${traceId}:`, err);
      }
    }

    const stdinMode = options.stdinMode === "inherit" ? "inherit" : "pipe";

    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = child_process.spawn(binary, args, {
          cwd: projectRoot,
          env,
          stdio: [stdinMode, "pipe", "pipe"],
          shell: false // CRITICAL: Security rule — no shell interpolation
        });
        if (stdinMode === "pipe") {
          child.stdin?.end();
        }
      } catch (err: any) {
        this.store.updateRunStatus(runId, "crashed", {
          completedAt: new Date().toISOString(),
          errorMessage: `Failed to spawn process: ${err.message}`
        });
        return reject(err);
      }

      let stdoutOutput = "";
      if (child.stdout) {
        child.stdout.on("data", (chunk) => {
          const str = chunk.toString();
          process.stdout.write(`[Run ${runId}] ${str}`);
          stdoutOutput += str;
        });
      }

      let stderrOutput = "";
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          const str = chunk.toString();
          process.stderr.write(`[Run ${runId} ERR] ${str}`);
          stderrOutput += str;
        });
      }

      child.on("error", (err: Error) => {
        this.store.updateRunStatus(runId, "crashed", {
          completedAt: new Date().toISOString(),
          errorMessage: `Process error: ${err.message}`
        });
        reject(err);
      });

      child.on("close", (exitCode: number | null) => {
        const completedAt = new Date().toISOString();

        // Merge any Orchestrator-captured inbound / localRetrievals after replay-core exits (zero race)
        this.mergeSidecarDataIntoCassette(runId, projectRoot, cassetteRunId);

        // Ingest annotation log if it was produced
        this.ingestAnnotations(traceId, annotationLogPath, options);

        if (exitCode === 0) {
          this.store.updateRunStatus(runId, "completed", {
            completedAt,
            exitCode: 0
          });
          resolve();
        } else {
          this.store.updateRunStatus(runId, "failed", {
            completedAt,
            exitCode: exitCode ?? 1,
            errorMessage: stderrOutput.slice(0, 1000) || `Process exited with code ${exitCode}`
          });
          resolve();
        }
      });
    });
  }

  /**
   * Ingests annotations from the replay-core annotation log and evaluates tool safety policies.
   */
  private ingestAnnotations(traceId: string, logPath: string, options?: SpawnRunOptions): void {
    let entries: any[] = [];
    if (fs.existsSync(logPath)) {
      try {
        const data = fs.readFileSync(logPath, "utf-8");
        entries = JSON.parse(data);
      } catch (err) {
        console.warn(`[Runner] Failed to parse annotation log at ${logPath}:`, err);
      } finally {
        try {
          fs.unlinkSync(logPath);
        } catch {
          // ignore cleanup error
        }
      }
    }

    const trace = typeof (this.store as any).getTrace === "function" ? (this.store as any).getTrace(traceId) : null;
    const events: any[] = trace?.events || [];
    const annotatedSpans = new Set<string>();

    // 1. Ingest entries that already have correlatedSpanId
    const unassignedEntries: any[] = [];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (entry.correlatedSpanId) {
          const isPrompt = events.find(e => e.spanId === entry.correlatedSpanId && e.kind === "prompt");
          this.store.appendReplayAnnotation(traceId, entry.correlatedSpanId, {
            replaySource: entry.replaySource,
            requestKey: entry.requestKey,
            replayLatencyMs: entry.replayLatencyMs,
            tokensSaved: entry.tokensSaved,
            streamingPreserved: entry.streamingPreserved,
            overridden: entry.overridden,
            decision: entry.decision,
            matchedPattern: entry.matchedPattern,
            effectiveClass: entry.effectiveClass,
            payloadText: isPrompt && entry.overridden && options?.forkOverrides?.promptText ? options.forkOverrides.promptText : undefined
          });
          annotatedSpans.add(entry.correlatedSpanId);

          // If the correlated span is a prompt, also annotate its child response span
          const childResponse = events.find(e => e.parentSpanId === entry.correlatedSpanId && e.kind === "response");
          if (childResponse && !annotatedSpans.has(childResponse.spanId)) {
            this.store.appendReplayAnnotation(traceId, childResponse.spanId, {
              replaySource: entry.replaySource,
              requestKey: entry.requestKey,
              replayLatencyMs: entry.replayLatencyMs,
              tokensSaved: entry.tokensSaved,
              streamingPreserved: entry.streamingPreserved,
              overridden: entry.overridden,
              decision: entry.decision,
              matchedPattern: entry.matchedPattern,
              effectiveClass: entry.effectiveClass
            });
            annotatedSpans.add(childResponse.spanId);
          }
        } else {
          unassignedEntries.push(entry);
        }
      }
    }

    // 2. Sequential fallback for unassigned entries against prompt & response events
    // Filter out non-LLM tool HTTP calls so they never overwrite LLM prompt/response spans.
    const isLikelyLlmEntry = (entry: any): boolean => {
      const u = String(entry.requestUrl || "").toLowerCase();
      if (!u) return true;
      return (
        u.includes("/chat/completions") ||
        u.includes("/completions") ||
        u.includes("/messages") ||
        u.includes("/responses") ||
        u.includes("generatecontent") ||
        u.includes("openrouter.ai") ||
        u.includes("api.openai.com") ||
        u.includes("api.anthropic.com") ||
        u.includes("generativelanguage.googleapis.com")
      );
    };
    const llmUnassigned = unassignedEntries.filter(isLikelyLlmEntry);
    const promptEvents = events.filter(e => e.kind === "prompt" && !annotatedSpans.has(e.spanId));
    const responseEvents = events.filter(e => e.kind === "response" && !annotatedSpans.has(e.spanId));

    for (let i = 0; i < llmUnassigned.length; i++) {
      const entry = llmUnassigned[i];
      if (promptEvents[i]) {
        this.store.appendReplayAnnotation(traceId, promptEvents[i].spanId, {
          replaySource: entry.replaySource,
          requestKey: entry.requestKey,
          replayLatencyMs: entry.replayLatencyMs,
          tokensSaved: entry.tokensSaved,
          streamingPreserved: entry.streamingPreserved,
          overridden: entry.overridden,
          decision: entry.decision,
          matchedPattern: entry.matchedPattern,
          effectiveClass: entry.effectiveClass,
          payloadText: (entry.overridden || (options?.mode === "fork" && entry.replaySource === "live")) && options?.forkOverrides?.promptText
            ? options.forkOverrides.promptText
            : undefined
        });
        annotatedSpans.add(promptEvents[i].spanId);
      }
      if (responseEvents[i]) {
        this.store.appendReplayAnnotation(traceId, responseEvents[i].spanId, {
          replaySource: entry.replaySource,
          requestKey: entry.requestKey,
          replayLatencyMs: entry.replayLatencyMs,
          tokensSaved: entry.tokensSaved,
          streamingPreserved: entry.streamingPreserved,
          overridden: entry.overridden,
          decision: entry.decision,
          matchedPattern: entry.matchedPattern,
          effectiveClass: entry.effectiveClass
        });
        annotatedSpans.add(responseEvents[i].spanId);
      }
    }

    // 3. Evaluate and annotate tool_call and tool_result spans against safety policy
    let policy: any = null;
    if (options?.projectRoot) {
      try {
        policy = loadPolicy(options.projectRoot);
      } catch {
        // Policy might not exist or be invalid
      }
    }

    for (const e of events) {
      if (e.kind === "tool_call" || e.kind === "tool_result") {
        const toolName =
          (e.actor && e.actor.kind === "tool" ? e.actor.id : null) ||
          (e.payload as any)?.name ||
          (e.payload as any)?.toolName ||
          e.title;

        let effectiveClass: string = "must_execute";
        let matchedPattern: string | null = null;

        if (policy && Array.isArray(policy.tools)) {
          for (const rule of policy.tools) {
            if (rule.toolName && toolName && rule.toolName.toLowerCase() === String(toolName).toLowerCase()) {
              effectiveClass = rule.class;
              matchedPattern = rule.match || rule.toolName;
              break;
            }
            if (rule.match && toolName && (rule.match.toLowerCase().includes(String(toolName).toLowerCase()) || String(toolName).toLowerCase().includes(rule.match.toLowerCase()))) {
              effectiveClass = rule.class;
              matchedPattern = rule.match;
              break;
            }
          }
        }

        const isRecordMode = options?.mode === "record";
        const replaySource = isRecordMode || effectiveClass === "must_execute" ? "live" : "cache";
        const decision = isRecordMode
          ? "live_record"
          : effectiveClass === "must_execute"
            ? "must_execute"
            : "cache_hit";

        this.store.appendReplayAnnotation(traceId, e.spanId, {
          replaySource,
          decision,
          effectiveClass,
          matchedPattern
        });
        annotatedSpans.add(e.spanId);
      }
    }

    // 4. Fallback for any unannotated prompt/response spans based on run mode
    const mode = options?.mode;
    if (mode === "replay" || mode === "fork") {
      let isPastForkPoint = false;
      for (const e of events) {
        if (options?.forkFromSpanId && e.spanId === options.forkFromSpanId) {
          isPastForkPoint = true;
        }
        if (!annotatedSpans.has(e.spanId) && (e.kind === "prompt" || e.kind === "response")) {
          const replaySource = isPastForkPoint ? "live" : "cache";
          const decision = isPastForkPoint ? "live_fork" : "cache_hit";
          const effectiveClass = isPastForkPoint ? "must_execute" : "replay_safe";
          this.store.appendReplayAnnotation(traceId, e.spanId, {
            replaySource,
            decision,
            effectiveClass
          });
          annotatedSpans.add(e.spanId);
        }
      }
    } else if (mode === "record") {
      for (const e of events) {
        if (!annotatedSpans.has(e.spanId) && (e.kind === "prompt" || e.kind === "response")) {
          this.store.appendReplayAnnotation(traceId, e.spanId, {
            replaySource: "live",
            decision: "live_record",
            effectiveClass: "replay_safe"
          });
          annotatedSpans.add(e.spanId);
        }
      }
    }
  }

  /**
   * Records a prompt/span override for an active run (T076).
   */
  setOverride(runId: string, spanId: string, value: any): void {
    const ovrPath = path.join(os.tmpdir(), `afr_ovr_${runId}.json`);
    const promptText = typeof value === "string" ? value : (value?.promptText || JSON.stringify(value));
    fs.writeFileSync(
      ovrPath,
      JSON.stringify({
        forkFromSpanId: spanId,
        promptText,
        overrides: { [spanId]: promptText }
      }),
      "utf-8"
    );
  }
}

