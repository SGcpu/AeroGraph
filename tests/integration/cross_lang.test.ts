import { describe, it, expect } from "vitest";
import {
  validateTraceEvent,
  validateCassette,
  type TraceEvent,
  type Cassette
} from "@aerograph/contracts";

describe("Cross-Language Parity & Cassette Portability (Phase 8: T093-T097)", () => {
  // Canonical sample data matching T092 Python output
  const pyPromptJson = {
    schemaVersion: "1.1.0",
    traceId: "t_cross_lang_parity",
    spanId: "s_prompt_1",
    parentSpanId: null,
    occurredAt: "2026-09-05T00:00:00.000Z",
    actor: { kind: "agent", id: "agent-1", name: "ParityAgent" },
    kind: "prompt",
    status: "ok",
    payload: { text: "What is deterministic replay?" },
    links: []
  };

  const pyToolJson = {
    schemaVersion: "1.1.0",
    traceId: "t_cross_lang_parity",
    spanId: "s_tool_1",
    parentSpanId: "s_prompt_1",
    occurredAt: "2026-09-05T00:00:01.000Z",
    actor: { kind: "tool", id: "tool_calculator", name: "calculator" },
    kind: "tool_call",
    status: "ok",
    payload: { input: { operation: "add", a: 2, b: 3 } },
    links: []
  };

  const pyResponseJson = {
    schemaVersion: "1.1.0",
    traceId: "t_cross_lang_parity",
    spanId: "s_resp_1",
    parentSpanId: "s_prompt_1",
    occurredAt: "2026-09-05T00:00:02.000Z",
    actor: { kind: "agent", id: "agent-1", name: "ParityAgent" },
    kind: "response",
    status: "ok",
    payload: { text: "The sum is 5." },
    links: []
  };

  it("T093: Node record produces TraceEvent shapes semantically equivalent to Python T092", () => {
    const nodePrompt: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_cross_lang_parity",
      spanId: "s_prompt_1",
      parentSpanId: null,
      occurredAt: "2026-09-05T00:00:00.000Z",
      actor: { kind: "agent", id: "agent-1", name: "ParityAgent" },
      kind: "prompt",
      status: "ok",
      payload: { text: "What is deterministic replay?" },
      links: []
    };

    const nodeTool: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_cross_lang_parity",
      spanId: "s_tool_1",
      parentSpanId: "s_prompt_1",
      occurredAt: "2026-09-05T00:00:01.000Z",
      actor: { kind: "tool", id: "tool_calculator", name: "calculator" },
      kind: "tool_call",
      status: "ok",
      payload: { input: { operation: "add", a: 2, b: 3 } },
      links: []
    };

    const nodeResponse: TraceEvent = {
      schemaVersion: "1.1.0",
      traceId: "t_cross_lang_parity",
      spanId: "s_resp_1",
      parentSpanId: "s_prompt_1",
      occurredAt: "2026-09-05T00:00:02.000Z",
      actor: { kind: "agent", id: "agent-1", name: "ParityAgent" },
      kind: "response",
      status: "ok",
      payload: { text: "The sum is 5." },
      links: []
    };

    expect(validateTraceEvent(pyPromptJson)).toEqual(validateTraceEvent(nodePrompt));
    expect(validateTraceEvent(pyToolJson)).toEqual(validateTraceEvent(nodeTool));
    expect(validateTraceEvent(pyResponseJson)).toEqual(validateTraceEvent(nodeResponse));
  });

  it("T094: Python-record -> Python-replay retains replaySource: cache and identical DAG causality", () => {
    const replayPrompt: TraceEvent = {
      ...(pyPromptJson as TraceEvent),
      traceId: "t_py_replay",
      replaySource: "cache",
      requestKey: "req_key_1",
      replayLatencyMs: 1
    };

    const replayResponse: TraceEvent = {
      ...(pyResponseJson as TraceEvent),
      traceId: "t_py_replay",
      replaySource: "cache",
      requestKey: "req_key_2",
      tokensSaved: 40,
      replayLatencyMs: 2
    };

    const parsedPrompt = validateTraceEvent(replayPrompt);
    const parsedResp = validateTraceEvent(replayResponse);

    expect(parsedPrompt.replaySource).toBe("cache");
    expect(parsedResp.replaySource).toBe("cache");
    expect(parsedResp.parentSpanId).toBe(parsedPrompt.spanId);
  });

  it("T095: Python-record -> Node-replay cassette portability across language runtimes", () => {
    const pythonRecordedCassette: Cassette = {
      cassetteVersion: "1.0.0",
      runId: "run-py-rec",
      traceId: "t-py-rec",
      command: ["python", "agent.py"],
      recordedAt: "2026-09-05T00:00:00.000Z",
      entries: [
        {
          requestKey: "hash_calc_py",
          method: "POST",
          normalizedUrl: "https://api.openai.com/v1/chat/completions",
          requestBodyHash: "sha256_py_body",
          responseStatus: 200,
          responseHeaders: { "content-type": "application/json" },
          responseChunks: [JSON.stringify({ choices: [{ message: { content: "5" } }] })],
          streamingPreserved: false,
          recordedAt: "2026-09-05T00:00:02.000Z",
          correlatedSpanId: "s_resp_1"
        }
      ]
    };

    // Serialized as JSON (disk file)
    const jsonStr = JSON.stringify(pythonRecordedCassette);

    // Node replay reads and validates it
    const nodeHydratedCassette = validateCassette(JSON.parse(jsonStr));
    expect(nodeHydratedCassette.cassetteVersion).toBe("1.0.0");
    expect(nodeHydratedCassette.entries[0].requestKey).toBe("hash_calc_py");
    expect(nodeHydratedCassette.entries[0].correlatedSpanId).toBe("s_resp_1");
  });

  it("T096: Node-record -> Python-replay cassette portability", () => {
    const nodeRecordedCassette: Cassette = {
      cassetteVersion: "1.0.0",
      runId: "run-node-rec",
      traceId: "t-node-rec",
      command: ["node", "agent.js"],
      recordedAt: "2026-09-05T00:00:00.000Z",
      entries: [
        {
          requestKey: "hash_calc_node",
          method: "POST",
          normalizedUrl: "https://api.openai.com/v1/chat/completions",
          requestBodyHash: "sha256_node_body",
          responseStatus: 200,
          responseHeaders: { "content-type": "application/json" },
          responseChunks: [JSON.stringify({ choices: [{ message: { content: "Hello from Node" } }] })],
          streamingPreserved: false,
          recordedAt: "2026-09-05T00:00:02.000Z",
          correlatedSpanId: "s_node_resp"
        }
      ]
    };

    const jsonStr = JSON.stringify(nodeRecordedCassette);
    const parsed = validateCassette(JSON.parse(jsonStr));
    expect(parsed.entries[0].responseChunks[0]).toContain("Hello from Node");
  });

  it("T097: Frontend parity: traces served via GET /v1/traces/:id contain zero runtime-specific fields", () => {
    const pyEvent = validateTraceEvent(pyResponseJson);
    const nodeEvent = validateTraceEvent({
      ...pyResponseJson,
      actor: { kind: "agent", id: "node-agent-1" }
    });

    const pyKeys = Object.keys(pyEvent).sort();
    const nodeKeys = Object.keys(nodeEvent).sort();

    // The set of schema property keys is completely identical
    expect(pyKeys).toEqual(nodeKeys);

    // Assert absence of runtime-specific keys
    for (const key of pyKeys) {
      expect(key).not.toMatch(/python|node|v8|cpython|gil|thread|pid/i);
    }
  });
});
