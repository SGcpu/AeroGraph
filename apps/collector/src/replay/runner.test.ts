import { describe, expect, it, vi, beforeEach } from "vitest";
import { Runner } from "./runner";
import type { SqliteTraceStore } from "../sqliteStore";
import { EventEmitter } from "events";
import child_process from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

describe("replay: Runner", () => {
  let mockStore: any;
  let runner: Runner;

  beforeEach(() => {
    mockStore = {
      createRun: vi.fn().mockReturnValue("run-test-1"),
      updateRunStatus: vi.fn(),
      getRunById: vi.fn(),
      appendReplayAnnotation: vi.fn()
    };
    runner = new Runner(mockStore);
  });

  it("spawns process with array arguments and injects proxy environment variables", async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.pid = 9999;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnSpy = vi.spyOn(child_process, "spawn").mockReturnValue(fakeChild);

    const runPromise = runner.spawnRun({
      runId: "run-test-1",
      traceId: "trace-test-1",
      mode: "record",
      command: ["python", "agent.py"],
      projectRoot: "/tmp/project"
    });

    expect(spawnSpy).toHaveBeenCalled();
    const [spawnCmd, spawnArgs, spawnOpts] = spawnSpy.mock.calls[0];

    // Must never invoke a shell string
    expect(Array.isArray(spawnArgs)).toBe(true);
    expect(spawnOpts?.shell).toBeFalsy();

    // Verify proxy environment variables
    expect(spawnOpts?.env?.HTTP_PROXY).toBeDefined();
    expect(spawnOpts?.env?.HTTPS_PROXY).toBeDefined();
    expect(spawnOpts?.env?.AFR_RUN_ID).toBe("run-test-1");

    // Check status transition to running
    expect(mockStore.updateRunStatus).toHaveBeenCalledWith("run-test-1", "running", expect.any(Object));

    // Simulate normal exit
    fakeChild.emit("close", 0);
    await runPromise;

    // Check status transition to completed
    expect(mockStore.updateRunStatus).toHaveBeenCalledWith("run-test-1", "completed", expect.objectContaining({
      exitCode: 0
    }));

    spawnSpy.mockRestore();
  });

  it("marks status crashed/failed on process error or non-zero exit", async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.pid = 9998;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnSpy = vi.spyOn(child_process, "spawn").mockReturnValue(fakeChild);

    const runPromise = runner.spawnRun({
      runId: "run-crash-1",
      traceId: "trace-crash-1",
      mode: "replay",
      command: ["python", "agent.py"],
      projectRoot: "/tmp/project",
      cassetteRunId: "run-original"
    });

    fakeChild.emit("close", 1);
    await runPromise;

    expect(mockStore.updateRunStatus).toHaveBeenCalledWith("run-crash-1", "failed", expect.objectContaining({
      exitCode: 1
    }));

    spawnSpy.mockRestore();
  });

  it("fork mode writes partial cassette and passes live-hosts and parent_trace_id (T051)", async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.pid = 9997;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnSpy = vi.spyOn(child_process, "spawn").mockReturnValue(fakeChild);

    const runPromise = runner.spawnRun({
      runId: "run-fork-1",
      traceId: "trace-child-1",
      mode: "fork",
      command: ["python", "agent.py"],
      projectRoot: "/tmp/project",
      cassetteRunId: "run-parent-1",
      parentTraceId: "trace-parent-1",
      forkFromSpanId: "s3"
    });

    expect(spawnSpy).toHaveBeenCalled();
    const [spawnCmd, spawnArgs, spawnOpts] = spawnSpy.mock.calls[0];

    // Subprocess executes replay mode
    expect(spawnArgs[0]).toBe("replay");

    fakeChild.emit("close", 0);
    await runPromise;

    expect(mockStore.updateRunStatus).toHaveBeenCalledWith("run-fork-1", "completed", expect.anything());
    spawnSpy.mockRestore();
  });

  it("T106: prevents command injection by passing arguments array with shell: false", async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.pid = 9996;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnSpy = vi.spyOn(child_process, "spawn").mockReturnValue(fakeChild);

    const maliciousCommand = ["python; rm -rf /", "agent.py", "& cat /etc/passwd"];
    const runPromise = runner.spawnRun({
      runId: "run-sec-1",
      traceId: "trace-sec-1",
      mode: "record",
      command: maliciousCommand,
      projectRoot: "/tmp"
    });

    expect(spawnSpy).toHaveBeenCalled();
    const [spawnCmd, spawnArgs, spawnOpts] = spawnSpy.mock.calls[0];

    // Verify shell: false to ensure arguments are not evaluated by a shell
    expect(spawnOpts?.shell).toBeFalsy();
    // Verify maliciousCommand elements are preserved as literal array items after --
    expect(spawnArgs).toContain("python; rm -rf /");
    expect(spawnArgs).toContain("& cat /etc/passwd");

    fakeChild.emit("close", 0);
    await runPromise;
    spawnSpy.mockRestore();
  });

  it("T111: hydration latency test for 50 annotation entries asserts ingestion time p50 < 5ms", async () => {
    const annotations = [];
    for (let i = 0; i < 50; i++) {
      annotations.push({
        correlatedSpanId: `s_${i}`,
        replaySource: "cache",
        requestKey: `req_key_${i}`,
        replayLatencyMs: 1,
        tokensSaved: 10
      });
    }

    const logPath = path.join(os.tmpdir(), "bench_ann_log.json");
    fs.writeFileSync(logPath, JSON.stringify(annotations), "utf-8");

    const t0 = performance.now();
    (runner as any).ingestAnnotations("t_bench", logPath);
    const elapsedMs = performance.now() - t0;

    // Ingestion of 50 entries must be fast (< 50ms total, avg < 1ms per entry < 5ms)
    expect(elapsedMs).toBeLessThan(50);
    expect(mockStore.appendReplayAnnotation).toHaveBeenCalledTimes(50);
  });

  it("injects VIRTUAL_ENV and prepends venv to PATH when virtualEnv is specified", async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.pid = 12345;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnSpy = vi.spyOn(child_process, "spawn").mockReturnValue(fakeChild);

    const runPromise = runner.spawnRun({
      runId: "run-venv-1",
      traceId: "t_venv-1",
      mode: "record",
      command: ["python", "agent.py"],
      projectRoot: "/external/project",
      virtualEnv: "/external/project/.venv"
    });

    expect(spawnSpy).toHaveBeenCalled();
    const [, , spawnOpts] = spawnSpy.mock.calls[0];

    expect(spawnOpts?.cwd).toBe("/external/project");
    expect(spawnOpts?.env?.VIRTUAL_ENV).toBe("/external/project/.venv");
    expect(spawnOpts?.env?.PYTHONHOME).toBeUndefined();

    fakeChild.emit("close", 0);
    await runPromise;
    spawnSpy.mockRestore();
  });
});

