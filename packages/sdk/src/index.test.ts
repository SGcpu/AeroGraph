import { describe, expect, it } from "vitest";
import { FlightRecorder } from "./index";

function createMockFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      text: async () => ""
    };
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
}

describe("sdk: FlightRecorder", () => {
  it("emits schema-valid events", async () => {
    const { fetchFn, calls } = createMockFetch();
    const fr = new FlightRecorder({
      endpoint: "http://localhost:4317",
      actor: { id: "agent-a", name: "Planner" },
      fetchFn
    });

    await fr.prompt({ parentSpanId: null, text: "Hello" });

    expect(calls.length).toBe(1);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.schemaVersion).toBe("1.1.0");
    expect(body.kind).toBe("prompt");
    expect(body.traceId).toBeTruthy();
  });

  it("normalizes all event types correctly", async () => {
    const { fetchFn, calls } = createMockFetch();
    const fr = new FlightRecorder({
      endpoint: "http://localhost:4317",
      actor: { id: "agent-b" },
      fetchFn
    });

    await fr.response({ parentSpanId: "s-1", text: "OK" });
    await fr.toolCall({ parentSpanId: "s-1", toolId: "t1", input: { x: 1 } });
    await fr.toolResult({ parentSpanId: "s-1", toolId: "t1", output: { y: 2 } });
    await fr.error({ parentSpanId: "s-1", message: "Failed" });

    expect(calls.length).toBe(4);
    const kinds = calls.map(c => JSON.parse(String(c.init?.body)).kind);
    expect(kinds).toEqual(["response", "tool_call", "tool_result", "error"]);
    
    // Check tool_call actor normalization
    const toolCallBody = JSON.parse(String(calls[1].init?.body));
    expect(toolCallBody.actor.kind).toBe("tool");
    expect(toolCallBody.actor.id).toBe("t1");
  });
});
