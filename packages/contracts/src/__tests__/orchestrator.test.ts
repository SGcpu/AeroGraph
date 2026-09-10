import { describe, expect, it } from "vitest";
import {
  forkAndResumeRequestSchema,
  forkAndResumeResponseSchema,
  getRunResponseSchema,
  replayTraceRequestSchema,
  runModeSchema,
  runStatusSchema,
  startRunRequestSchema,
  startRunResponseSchema,
  runtimeMetadataSchema
} from "../orchestrator";

describe("contracts: orchestrator schemas", () => {
  it("validates runMode and runStatus enums", () => {
    expect(runModeSchema.parse("record")).toBe("record");
    expect(runModeSchema.parse("replay")).toBe("replay");
    expect(runModeSchema.parse("fork")).toBe("fork");
    expect(() => runModeSchema.parse("invalid_mode")).toThrow();

    expect(runStatusSchema.parse("pending")).toBe("pending");
    expect(runStatusSchema.parse("running")).toBe("running");
    expect(runStatusSchema.parse("completed")).toBe("completed");
    expect(runStatusSchema.parse("failed")).toBe("failed");
    expect(runStatusSchema.parse("crashed")).toBe("crashed");
    expect(() => runStatusSchema.parse("unknown_status")).toThrow();
  });

  it("validates startRunRequest for record mode", () => {
    const req = {
      mode: "record",
      command: ["python", "agent.py"],
      projectRoot: "/path/to/project"
    };
    const parsed = startRunRequestSchema.parse(req);
    expect(parsed.mode).toBe("record");
    expect(parsed.command).toEqual(["python", "agent.py"]);
  });

  it("validates startRunRequest for replay mode", () => {
    const req = {
      mode: "replay",
      cassetteRunId: "run-original-1"
    };
    const parsed = startRunRequestSchema.parse(req);
    expect(parsed.mode).toBe("replay");
    expect(parsed.cassetteRunId).toBe("run-original-1");
  });

  it("validates startRunRequest for fork mode", () => {
    const req = {
      mode: "fork",
      cassetteRunId: "run-original-1",
      forkFromSpanId: "s-123",
      forkOverrides: { promptText: "New instruction" }
    };
    const parsed = startRunRequestSchema.parse(req);
    expect(parsed.mode).toBe("fork");
    expect(parsed.forkFromSpanId).toBe("s-123");
    expect(parsed.forkOverrides?.promptText).toBe("New instruction");
  });

  it("validates startRunResponse", () => {
    const res = {
      runId: "run-new-1",
      traceId: "trace-new-1",
      status: "pending"
    };
    const parsed = startRunResponseSchema.parse(res);
    expect(parsed.runId).toBe("run-new-1");
    expect(parsed.status).toBe("pending");
  });

  it("validates getRunResponse", () => {
    const res = {
      runId: "run-1",
      traceId: "t-1",
      parentTraceId: null,
      cassetteRunId: "run-0",
      status: "completed",
      mode: "replay",
      startedAt: "2026-09-01T12:00:00.000Z",
      completedAt: "2026-09-01T12:00:05.000Z",
      exitCode: 0,
      errorMessage: null
    };
    const parsed = getRunResponseSchema.parse(res);
    expect(parsed.status).toBe("completed");
    expect(parsed.exitCode).toBe(0);
  });

  it("validates replayTraceRequest and forkAndResumeRequest/Response", () => {
    const replayReq = { cassetteRunId: "cas-1" };
    expect(replayTraceRequestSchema.parse(replayReq).cassetteRunId).toBe("cas-1");

    const forkReq = {
      forkFromSpanId: "span-abc",
      overrides: { promptText: "changed prompt" },
      virtualEnv: "/home/user/.venv",
      executablePath: "/home/user/.venv/bin/python",
      entrypoint: "/home/user/agent.py"
    };
    const parsedFork = forkAndResumeRequestSchema.parse(forkReq);
    expect(parsedFork.forkFromSpanId).toBe("span-abc");
    expect(parsedFork.virtualEnv).toBe("/home/user/.venv");
    expect(parsedFork.executablePath).toBe("/home/user/.venv/bin/python");

    const forkRes = {
      childTraceId: "child-t-1",
      runId: "run-f-1",
      status: "running"
    };
    const parsedForkRes = forkAndResumeResponseSchema.parse(forkRes);
    expect(parsedForkRes.childTraceId).toBe("child-t-1");
  });

  it("validates runtimeMetadataSchema", () => {
    const meta = {
      projectRoot: "/path/to/my-agent",
      virtualEnv: "/path/to/my-agent/.venv",
      executablePath: "/path/to/my-agent/.venv/bin/python",
      entrypoint: "/path/to/my-agent/agent.py",
      command: ["python", "agent.py"]
    };
    const parsed = runtimeMetadataSchema.parse(meta);
    expect(parsed.projectRoot).toBe("/path/to/my-agent");
    expect(parsed.virtualEnv).toBe("/path/to/my-agent/.venv");
    expect(parsed.command).toEqual(["python", "agent.py"]);
  });
});
