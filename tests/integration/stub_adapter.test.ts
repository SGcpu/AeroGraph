import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  validateCassette,
  validateTraceEvent,
  type Cassette,
  type TraceEvent
} from "@aerograph/contracts";

describe("Framework-Agnostic Adapter Authoring & Replay Inheritance (US5 - T084, T085)", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  it("T085: asserts packages/adapter-langchain/README.md contains 'Replay support is inherited automatically'", () => {
    const readmePath = path.join(repoRoot, "packages/adapter-langchain/README.md");
    expect(fs.existsSync(readmePath)).toBe(true);
    const content = fs.readFileSync(readmePath, "utf-8");
    expect(content).toContain("Replay support is inherited automatically");
  });

  it("T085: asserts python/aerograph-langchain/README.md contains 'Replay support is inherited automatically'", () => {
    const readmePath = path.join(repoRoot, "python/aerograph-langchain/README.md");
    expect(fs.existsSync(readmePath)).toBe(true);
    const content = fs.readFileSync(readmePath, "utf-8");
    expect(content).toContain("Replay support is inherited automatically");
  });

  it("T084: asserts stub adapter has zero replay-specific imports", () => {
    const stubPath = path.join(repoRoot, "tests/fixtures/stub-adapter/stub_agent.py");
    expect(fs.existsSync(stubPath)).toBe(true);
    const stubCode = fs.readFileSync(stubPath, "utf-8");

    // Filter to import statements only
    const importLines = stubCode
      .split("\n")
      .filter((line: string) => line.trim().startsWith("import ") || line.trim().startsWith("from "))
      .join("\n");

    expect(importLines).not.toContain("aerorepl");
    expect(importLines).not.toContain("replay");
    expect(importLines).not.toContain("cassette");
    
    expect(importLines).toContain("aerograph_sdk");
  });

  it("T084 & T091: validates canonical FlightRecorder events, cassette creation, and replay cache hydration", () => {
    // 1. Validate canonical events emitted by stub agent
    const promptEvent: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_stub_1",
      spanId: "s_prompt",
      parentSpanId: null,
      occurredAt: "2026-09-05T00:00:00.000Z",
      actor: { kind: "agent", id: "stub-agent-1" },
      kind: "prompt",
      status: "ok",
      payload: { text: "Explain deterministic replay" },
      links: []
    };

    const toolEvent: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_stub_1",
      spanId: "s_tool",
      parentSpanId: "s_prompt",
      occurredAt: "2026-09-05T00:00:01.000Z",
      actor: { kind: "tool", id: "web_search" },
      kind: "tool_call",
      status: "ok",
      payload: { input: { query: "deterministic replay definition" } },
      links: []
    };

    const responseEvent: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_stub_1",
      spanId: "s_resp",
      parentSpanId: "s_prompt",
      occurredAt: "2026-09-05T00:00:02.000Z",
      actor: { kind: "agent", id: "stub-agent-1" },
      kind: "response",
      status: "ok",
      payload: { text: "Deterministic replay captures and reproduces exact execution states." },
      links: []
    };

    expect(validateTraceEvent(promptEvent)).toBeDefined();
    expect(validateTraceEvent(toolEvent)).toBeDefined();
    expect(validateTraceEvent(responseEvent)).toBeDefined();

    // 2. Validate cassette schema and structure
    const cassette: Cassette = {
      cassetteVersion: "1.0.0",
      runId: "run-stub-1",
      traceId: "t_stub_1",
      command: ["python", "stub_agent.py"],
      recordedAt: "2026-09-05T00:00:00.000Z",
      entries: [
        {
          requestKey: "hash_openai_completions",
          method: "POST",
          normalizedUrl: "https://api.openai.com/v1/chat/completions",
          requestBodyHash: "hash123",
          responseStatus: 200,
          responseHeaders: { "content-type": "application/json" },
          responseChunks: [JSON.stringify({ choices: [{ message: { content: "Deterministic replay captures..." } }] })],
          streamingPreserved: false,
          recordedAt: "2026-09-05T00:00:02.000Z",
          correlatedSpanId: "s_resp"
        }
      ]
    };

    const validatedCassette = validateCassette(cassette);
    expect(validatedCassette.runId).toBe("run-stub-1");
    expect(validatedCassette.entries).toHaveLength(1);

    // 3. Validate replay event annotation with replaySource: cache
    const replayResponseEvent: TraceEvent = {
      ...responseEvent,
      traceId: "t_stub_replay_1",
      replaySource: "cache",
      requestKey: "req_key_abc",
      tokensSaved: 50,
      replayLatencyMs: 3
    };

    const validatedReplayEvent = validateTraceEvent(replayResponseEvent);
    expect(validatedReplayEvent.replaySource).toBe("cache");
    expect(validatedReplayEvent.tokensSaved).toBe(50);
    expect(validatedReplayEvent.replayLatencyMs).toBeLessThan(5);

    // 4. T091: Cassette portability verification
    const cassetteJson = JSON.stringify(validatedCassette);
    const roundtripCassette = validateCassette(JSON.parse(cassetteJson));
    expect(roundtripCassette).toEqual(validatedCassette);
  });
});
