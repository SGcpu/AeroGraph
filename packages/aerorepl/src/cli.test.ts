import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AereplClient, AereplError } from "./client.js";
import { createProgram, handleSessionCommand } from "./cli.js";

describe("aerorepl CLI (T073)", () => {
  let mockClient: AereplClient;

  beforeEach(() => {
    mockClient = new AereplClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("record subcommand calls startRun with mode: record and command array", async () => {
    const startRunSpy = vi.spyOn(mockClient, "startRun").mockResolvedValue({
      runId: "run-rec-1",
      traceId: "t-rec-1",
      status: "running"
    });

    const program = createProgram(mockClient);
    await program.parseAsync(["node", "aerorepl", "record", "python", "agent.py"]);

    expect(startRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "record",
        command: ["python", "agent.py"]
      })
    );
  });

  it("replay subcommand calls startRun with mode: replay and cassetteRunId", async () => {
    const startRunSpy = vi.spyOn(mockClient, "startRun").mockResolvedValue({
      runId: "run-rep-2",
      traceId: "t-rep-2",
      status: "running"
    });

    const program = createProgram(mockClient);
    await program.parseAsync(["node", "aerorepl", "replay", "run-rec-1"]);

    expect(startRunSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "replay",
        cassetteRunId: "run-rec-1"
      })
    );
  });

  it("list subcommand calls listRuns and formats output", async () => {
    const listRunsSpy = vi.spyOn(mockClient, "listRuns").mockResolvedValue([
      {
        runId: "run-1",
        traceId: "trace-1",
        status: "completed",
        mode: "record",
        parentTraceId: null,
        cassetteRunId: null,
        startedAt: "2026-09-05T00:00:00.000Z",
        completedAt: "2026-09-05T00:01:00.000Z",
        exitCode: 0,
        errorMessage: null
      }
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram(mockClient);
    await program.parseAsync(["node", "aerorepl", "list"]);

    expect(listRunsSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalled();
  });

  it("exits with non-zero on Orchestrator 5xx", async () => {
    vi.spyOn(mockClient, "startRun").mockRejectedValue(
      new AereplError(500, { error: "Internal Server Error" })
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as any);

    const program = createProgram(mockClient);
    await expect(
      program.parseAsync(["node", "aerorepl", "record", "python", "agent.py"])
    ).rejects.toThrow("process.exit called");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("renders landing screen when invoked with no arguments", async () => {
    vi.spyOn(mockClient, "listRuns").mockResolvedValue([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = createProgram(mockClient);
    await program.parseAsync(["node", "aerorepl"]);

    expect(logSpy).toHaveBeenCalled();
    const calls = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toContain("Flight Recorder for Autonomous AI Workflows");
    expect(calls).toContain("System Health:");
    expect(calls).toContain("Quick Commands:");
  });
});

describe("aerorepl REPL session subcommands (T074)", () => {
  let mockClient: AereplClient;
  let session: any;

  beforeEach(() => {
    mockClient = new AereplClient();
    session = {
      sessionId: "sess-123",
      runId: "run-1",
      traceId: "trace-abc",
      currentStep: 2,
      overrides: {}
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/step maps to stepSession(sessionId)", async () => {
    const stepSpy = vi.spyOn(mockClient, "stepSession").mockResolvedValue({
      step: 3,
      spanSummary: { spanId: "s3", kind: "tool_call", status: "ok" }
    });

    const res = await handleSessionCommand("/step", session, mockClient);
    expect(stepSpy).toHaveBeenCalledWith("sess-123");
    expect(res).toContain("Step 3");
  });

  it("/inspect <spanId> maps to inspectSpan(traceId, spanId)", async () => {
    const inspectSpy = vi.spyOn(mockClient, "inspectSpan").mockResolvedValue({
      schemaVersion: "1.1.0",
      eventId: "e1",
      traceId: "trace-abc",
      spanId: "s-test",
      timestamp: "2026-09-05T00:00:00.000Z",
      kind: "prompt",
      status: "ok",
      actor: { kind: "agent", id: "a1" }
    } as any);

    const res = await handleSessionCommand("/inspect s-test", session, mockClient);
    expect(inspectSpy).toHaveBeenCalledWith("trace-abc", "s-test");
    expect(res).toContain("s-test");
  });

  it("/override <spanId> <json> maps to overrideSpan(sessionId, spanId, parsedValue)", async () => {
    const overrideSpy = vi.spyOn(mockClient, "overrideSpan").mockResolvedValue({
      ok: true,
      spanId: "s-test",
      overridden: true
    });

    const res = await handleSessionCommand(
      '/override s-test {"promptText":"new text"}',
      session,
      mockClient
    );
    expect(overrideSpy).toHaveBeenCalledWith("sess-123", "s-test", {
      promptText: "new text"
    });
    expect(res).toContain("Overridden");
  });

  it("/rewind <N> maps to rewindSession(sessionId, N)", async () => {
    const rewindSpy = vi.spyOn(mockClient, "rewindSession").mockResolvedValue({
      newTraceId: "trace-forked",
      sessionId: "sess-123",
      currentStep: 1
    });

    const res = await handleSessionCommand("/rewind 1", session, mockClient);
    expect(rewindSpy).toHaveBeenCalledWith("sess-123", 1);
    expect(session.traceId).toBe("trace-forked");
    expect(session.currentStep).toBe(1);
    expect(res).toContain("Rewound");
  });

  it("/override extracts payload.text when full event JSON is provided", async () => {
    const overrideSpy = vi.spyOn(mockClient, "overrideSpan").mockResolvedValue({
      ok: true,
      spanId: "s-test",
      overridden: true
    });

    const fullEventJson = JSON.stringify({
      schemaVersion: "1.1.0",
      traceId: "t-1",
      spanId: "s-test",
      payload: {
        text: "custom prompt from event payload"
      }
    });

    const res = await handleSessionCommand(
      `/override s-test ${fullEventJson}`,
      session,
      mockClient
    );
    expect(overrideSpy).toHaveBeenCalledWith("sess-123", "s-test", {
      promptText: "custom prompt from event payload"
    });
    expect(res).toContain("custom prompt from event payload");
  });

  it("/inspect reflects active session overrides", async () => {
    vi.spyOn(mockClient, "inspectSpan").mockResolvedValue({
      spanId: "s-test",
      kind: "prompt",
      status: "ok",
      payload: { text: "original prompt" }
    } as any);

    // Set override in session
    (session as any).overrides = {
      "s-test": { promptText: "updated prompt text" }
    };

    const res = await handleSessionCommand("/inspect s-test", session, mockClient);
    const parsed = JSON.parse(res);
    expect(parsed.payload.text).toBe("updated prompt text");
    expect(parsed.override.active).toBe(true);
    expect(parsed.override.promptText).toBe("updated prompt text");
  });
});
