import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { ReplayControlPanel } from "../ReplayControlPanel";
import { RunStatusBadge } from "../RunStatusBadge";
import type { Api } from "../api";

describe("ReplayControlPanel component", () => {
  const mockApi: Api = {
    listTraces: vi.fn(),
    getTrace: vi.fn(),
    deleteTrace: vi.fn(),
    forkTrace: vi.fn(),
    getLineage: vi.fn(),
    getDiff: vi.fn(),
    getAnalysis: vi.fn(),
    getStats: vi.fn(),
    replayTrace: vi.fn().mockResolvedValue({ runId: "run-123", status: "pending" }),
    getRun: vi.fn().mockResolvedValue({
      runId: "run-123",
      status: "completed",
      mode: "replay",
      command: ["python", "agent.py"],
      projectRoot: "/app",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      traceId: "trace-replayed"
    }),
    cancelRun: vi.fn().mockResolvedValue({ success: true, message: "cancelled" }),
    forkAndResume: vi.fn(),
    getProjectConfig: vi.fn().mockResolvedValue({ config: null }),
    saveProjectConfig: vi.fn().mockResolvedValue({ ok: true, path: "/test" }),
    getRuntimeMetadata: vi.fn().mockResolvedValue(null)
  };

  it("renders empty when activeTraceId is null", () => {
    const html = renderToString(
      <ReplayControlPanel api={mockApi} activeTraceId={null} />
    );
    expect(html).toBe("");
  });

  it("renders replay button when activeTraceId is present", () => {
    const html = renderToString(
      <ReplayControlPanel api={mockApi} activeTraceId="trace-123" />
    );
    expect(html).toContain("Replay Trace");
    expect(html).toContain("▶");
  });

  it("renders disabled button when hasCassette is false", () => {
    const html = renderToString(
      <ReplayControlPanel api={mockApi} activeTraceId="trace-123" hasCassette={false} />
    );
    expect(html).toContain("disabled");
    expect(html).toContain("No cassette linked");
  });
});

describe("RunStatusBadge component", () => {
  const mockApi: Api = {
    listTraces: vi.fn(),
    getTrace: vi.fn(),
    deleteTrace: vi.fn(),
    forkTrace: vi.fn(),
    getLineage: vi.fn(),
    getDiff: vi.fn(),
    getAnalysis: vi.fn(),
    getStats: vi.fn(),
    replayTrace: vi.fn(),
    getRun: vi.fn(),
    cancelRun: vi.fn(),
    forkAndResume: vi.fn(),
    getProjectConfig: vi.fn().mockResolvedValue({ config: null }),
    saveProjectConfig: vi.fn().mockResolvedValue({ ok: true, path: "/test" }),
    getRuntimeMetadata: vi.fn().mockResolvedValue(null)
  };

  it("renders initial loading badge", () => {
    const html = renderToString(
      <RunStatusBadge api={mockApi} runId="run-test-abc" />
    );
    expect(html).toContain("Initializing...");
  });
});
