import child_process, { ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import type { SqliteTraceStore } from "../sqliteStore.js";
import type { RunMode } from "@aerograph/contracts";
import { writeForkCassette } from "./cassette.js";
import { loadPolicy, computeLiveHosts } from "./policy.js";

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
}

export class Runner {
  constructor(private store: SqliteTraceStore) {}

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
    if (!effectiveOverrideFile && forkOverrides?.promptText) {
      const ovrPath = path.join(os.tmpdir(), `afr_ovr_${runId}.json`);
      fs.writeFileSync(
        ovrPath,
        JSON.stringify({
          forkFromSpanId,
          promptText: forkOverrides.promptText
        }),
        "utf-8"
      );
      effectiveOverrideFile = ovrPath;
    }

    // In fork mode, produce partial cassette if base cassette exists
    let targetCassetteId = cassetteRunId || runId;
    if (mode === "fork" && cassetteRunId && forkFromSpanId) {
      try {
        writeForkCassette(runId, cassetteRunId, forkFromSpanId, projectRoot);
        targetCassetteId = runId;
      } catch (err) {
        console.warn(`[Runner] Could not create partial fork cassette:`, err);
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

    // Create temp path for annotation log
    const annotationLogPath = path.join(os.tmpdir(), `afr_ann_${runId}.json`);

    // Prepare CLI arguments
    const args: string[] = [];

    if (mode === "record") {
      args.push("record");
      args.push("--annotation-log", annotationLogPath);
      args.push(...command);
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
      args.push(...command);
    }

    const env = {
      ...process.env,
      AFR_RUN_ID: runId,
      AFR_TRACE_ID: traceId,
      HTTP_PROXY: process.env.HTTP_PROXY || "http://127.0.0.1:8000",
      HTTPS_PROXY: process.env.HTTPS_PROXY || "http://127.0.0.1:8000",
      http_proxy: process.env.http_proxy || "http://127.0.0.1:8000",
      https_proxy: process.env.https_proxy || "http://127.0.0.1:8000"
    };

    const startedAt = new Date().toISOString();
    this.store.updateRunStatus(runId, "running", { startedAt });

    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = child_process.spawn(binary, args, {
          cwd: projectRoot,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false // CRITICAL: Security rule — no shell interpolation
        });
      } catch (err: any) {
        this.store.updateRunStatus(runId, "crashed", {
          completedAt: new Date().toISOString(),
          errorMessage: `Failed to spawn process: ${err.message}`
        });
        return reject(err);
      }

      let stderrOutput = "";
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          stderrOutput += chunk.toString();
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

        // Ingest annotation log if it was produced
        this.ingestAnnotations(traceId, annotationLogPath);

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
   * Ingests annotations from the replay-core annotation log.
   */
  private ingestAnnotations(traceId: string, logPath: string): void {
    if (!fs.existsSync(logPath)) {
      return;
    }

    try {
      const data = fs.readFileSync(logPath, "utf-8");
      const entries = JSON.parse(data);
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (entry.correlatedSpanId) {
            this.store.appendReplayAnnotation(traceId, entry.correlatedSpanId, {
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
          }
        }
      }
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

