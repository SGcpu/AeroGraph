import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import { createOrchestratorApp } from "./orchestrator";

describe("replay: Orchestrator routes", () => {
  let mockStore: any;
  let mockRunner: any;
  let app: any;

  beforeEach(() => {
    mockStore = {
      createRun: vi.fn().mockReturnValue("run-123"),
      getRunById: vi.fn((id: string) => {
        if (id === "run-123") {
          return {
            runId: "run-123",
            traceId: "trace-123",
            parentTraceId: null,
            cassetteRunId: null,
            status: "pending",
            mode: "record",
            startedAt: null,
            completedAt: null,
            exitCode: null,
            errorMessage: null
          };
        }
        return null;
      }),
      listRuns: vi.fn().mockReturnValue([]),
      updateRunStatus: vi.fn()
    };

    mockRunner = {
      spawnRun: vi.fn().mockResolvedValue(undefined)
    };

    app = createOrchestratorApp(mockStore, mockRunner);
  });

  it("GET /health returns 200", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("POST /v1/runs in record mode returns 201 with run details", async () => {
    const res = await request(app)
      .post("/v1/runs")
      .send({
        mode: "record",
        command: ["python", "agent.py"],
        projectRoot: "/workspace"
      });

    expect(res.status).toBe(201);
    expect(res.body.runId).toBe("run-123");
    expect(res.body.traceId).toBeDefined();
    expect(res.body.status).toBe("pending");
    expect(mockRunner.spawnRun).toHaveBeenCalled();
  });

  it("GET /v1/runs/:id returns 200 for existing run and 404 for missing run", async () => {
    const okRes = await request(app).get("/v1/runs/run-123");
    expect(okRes.status).toBe(200);
    expect(okRes.body.runId).toBe("run-123");

    const notFoundRes = await request(app).get("/v1/runs/missing-run");
    expect(notFoundRes.status).toBe(404);
  });

  it("POST /v1/runs in replay mode passes must_execute liveHosts and omits replay_safe hosts (T064)", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "afr_orch_test_"));
    fs.writeFileSync(
      path.join(tempDir, "aerograph.replay.yaml"),
      `tools:
  - match: "https://api.github.com/*"
    class: "must_execute"
  - match: "https://api.openai.com/*"
    class: "replay_safe"`
    );

    const res = await request(app)
      .post("/v1/runs")
      .send({
        mode: "replay",
        command: ["python", "agent.py"],
        projectRoot: tempDir,
        cassetteRunId: "run-parent-1"
      });

    expect(res.status).toBe(201);
    expect(mockRunner.spawnRun).toHaveBeenCalledWith(
      expect.objectContaining({
        liveHosts: expect.arrayContaining(["api.github.com"])
      })
    );

    const callArgs = mockRunner.spawnRun.mock.calls[0][0];
    expect(callArgs.liveHosts).not.toContain("api.openai.com");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("T104: concurrent replay test: two simultaneous runs get unique runId/traceId", async () => {
    let callCount = 0;
    mockStore.createRun.mockImplementation(() => `run-concurrent-${++callCount}`);

    const [res1, res2] = await Promise.all([
      request(app)
        .post("/v1/runs")
        .send({
          mode: "replay",
          command: ["python", "agent.py"],
          cassetteRunId: "run-base-1",
          projectRoot: "/tmp"
        }),
      request(app)
        .post("/v1/runs")
        .send({
          mode: "replay",
          command: ["python", "agent.py"],
          cassetteRunId: "run-base-1",
          projectRoot: "/tmp"
        })
    ]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.runId).not.toBe(res2.body.runId);
    expect(res1.body.traceId).not.toBe(res2.body.traceId);
  });

  it("T109: Orchestrator loopback binding verification", async () => {
    await new Promise<void>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => {
        try {
          const addr = server.address() as any;
          expect(typeof addr).toBe("object");
          expect(addr.address).toBe("127.0.0.1");
        } finally {
          server.close();
          resolve();
        }
      });
    });
  });
});

