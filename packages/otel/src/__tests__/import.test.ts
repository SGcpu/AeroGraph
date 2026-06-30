import { describe, it, expect } from "vitest";
import { importOtlpSpanToEvent } from "../import.js";
import { AEROGRAPH_ATTRS } from "../constants.js";
import type { OtlpSpan } from "../otlp-schema.js";
import { SPAN_KIND, STATUS_CODE } from "../mapping.js";

describe("importOtlpSpanToEvent", () => {
  const ctx = { traceId: "abc", defaultActorId: "def", preserveOriginalIds: false };

  it("lossless round-trip path uses aerograph.kind", () => {
    const span: OtlpSpan = {
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "eee19b7ec3c1b174",
      name: "some.name",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2000000000",
      kind: SPAN_KIND.INTERNAL,
      attributes: [
        { key: AEROGRAPH_ATTRS.KIND, value: { stringValue: "tool_result" } },
        { key: AEROGRAPH_ATTRS.ACTOR_ID, value: { stringValue: "my-tool" } },
        { key: AEROGRAPH_ATTRS.TOOL_RESULT_OUTPUT, value: { stringValue: '{"foo":"bar"}' } }
      ]
    };

    const event = importOtlpSpanToEvent(span, ctx);
    expect(event.kind).toBe("tool_result");
    expect(event.actor.id).toBe("my-tool");
    expect(event.payload).toEqual({ output: { foo: "bar" } });
  });

  it("heuristic path for gen_ai.chat", () => {
    const span: OtlpSpan = {
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "eee19b7ec3c1b174",
      name: "gen_ai.chat",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2000000000",
      kind: SPAN_KIND.CLIENT,
      attributes: []
    };

    const event = importOtlpSpanToEvent(span, ctx);
    expect(event.kind).toBe("response");
    expect(event.actor.id).toBe("def");
  });

  it("heuristic path for gen_ai.tool.call", () => {
    const span: OtlpSpan = {
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "eee19b7ec3c1b174",
      name: "some.name",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2000000000",
      kind: SPAN_KIND.CLIENT,
      attributes: [
        { key: "gen_ai.tool.name", value: { stringValue: "calc" } },
        { key: "gen_ai.tool.call.id", value: { stringValue: "123" } }
      ]
    };

    const event = importOtlpSpanToEvent(span, ctx);
    expect(event.kind).toBe("tool_call");
  });

  it("heuristic path for error spans", () => {
    const span: OtlpSpan = {
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "eee19b7ec3c1b174",
      name: "some.name",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2000000000",
      kind: SPAN_KIND.INTERNAL,
      status: { code: STATUS_CODE.ERROR, message: "failed" },
      attributes: []
    };

    const event = importOtlpSpanToEvent(span, ctx);
    expect(event.kind).toBe("error");
    expect(event.status).toBe("error");
  });

  it("heuristic path for unknown spans falling back to note", () => {
    const span: OtlpSpan = {
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "eee19b7ec3c1b174",
      name: "my.custom.span",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2000000000",
      kind: SPAN_KIND.INTERNAL,
      attributes: [
        { key: "my.attr", value: { stringValue: "val" } }
      ]
    };

    const event = importOtlpSpanToEvent(span, ctx);
    expect(event.kind).toBe("note");
    expect(event.payload).toEqual({
      otel_span_name: "my.custom.span",
      "my.attr": "val"
    });
  });

  it("reconstructs canonical telemetry from GenAI attributes", () => {
    const span: OtlpSpan = {
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "eee19b7ec3c1b174",
      name: "gen_ai.chat",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2000000000", // 1ms
      kind: SPAN_KIND.CLIENT,
      attributes: [
        { key: "project.id", value: { stringValue: "proj-abc" } },
        { key: "deployment.environment", value: { stringValue: "dev" } },
        { key: "gen_ai.response.model", value: { stringValue: "claude-3" } },
        { key: "gen_ai.system", value: { stringValue: "anthropic" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: 100 } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: 50 } },
        { key: "gen_ai.usage.total_tokens", value: { intValue: 150 } }
      ]
    };

    const event = importOtlpSpanToEvent(span, ctx);
    expect(event.kind).toBe("response");
    expect(event.projectId).toBe("proj-abc");
    expect(event.environment).toBe("dev");
    expect(event.durationMs).toBe(1000); // 2000000000 - 1000000000 = 1000000000 ns = 1000ms
    expect(event.payload.model).toEqual({ name: "claude-3", provider: "anthropic" });
    expect(event.payload.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  });
});
