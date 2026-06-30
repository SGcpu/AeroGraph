import type { TraceEvent, TraceEventKind } from "@aerograph/contracts";
import type { OtlpSpan, OtlpExportRequest, OtlpAttribute, OtlpLink } from "./otlp-schema.js";
import { AEROGRAPH_ATTRS } from "./constants.js";
import { extractAttributeValue, resolveAeroGraphKindFromSpan, STATUS_CODE } from "./mapping.js";
import { GEN_AI_ATTRS, COMMON_ATTRS } from "./semantic_mapping.js";
import { unixNanoToIso } from "./timestamp.js";

export interface MappingContext {
  traceId: string;
  defaultActorId: string;
  preserveOriginalIds: boolean;
}

export function importOtlpSpanToEvent(span: OtlpSpan, ctx: MappingContext): TraceEvent {
  const kind = resolveAeroGraphKindFromSpan(span);
  
  // Extract common attributes
  const actorId = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.ACTOR_ID) || ctx.defaultActorId;
  const actorKind = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.ACTOR_KIND) || "system";
  const actorName = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.ACTOR_NAME);
  
  const status = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.STATUS) as "ok" | "error" | undefined 
                 ?? (span.status?.code === STATUS_CODE.ERROR ? "error" : "ok");
  const title = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.TITLE);
  
  const links = (span.links || []).map((link: OtlpLink) => {
    return {
      rel: (extractAttributeValue(link.attributes, AEROGRAPH_ATTRS.LINK_REL) as "follows" | "caused_by" | "handoff_to") || "follows",
      spanId: link.spanId
    };
  });

  const projectId = extractAttributeValue(span.attributes, COMMON_ATTRS.PROJECT_ID);
  const environment = extractAttributeValue(span.attributes, COMMON_ATTRS.ENVIRONMENT);

  let tags: Record<string, string> | undefined = undefined;
  if (span.attributes) {
    for (const attr of span.attributes) {
      if (attr.key.startsWith("aerograph.tag.")) {
        if (!tags) tags = {};
        const key = attr.key.slice("aerograph.tag.".length);
        const val = extractAttributeValue(span.attributes, attr.key);
        if (val !== undefined) tags[key] = val;
      }
    }
  }

  const durationMs = span.endTimeUnixNano && span.startTimeUnixNano 
    ? Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000
    : undefined;

  const baseEvent = {
    schemaVersion: "1.1.0",
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId || null,
    occurredAt: unixNanoToIso(span.startTimeUnixNano),
    actor: {
      kind: actorKind as "agent" | "tool" | "system",
      id: actorId,
      ...(actorName ? { name: actorName } : {})
    },
    status,
    ...(title ? { title } : {}),
    links,
    ...(projectId ? { projectId } : {}),
    ...(environment ? { environment } : {}),
    ...(tags ? { tags } : {}),
    ...(durationMs !== undefined && durationMs !== 1 ? { durationMs } : {}) // 1ms is default for older spans
  };

  // Build payload based on kind
  let payload: Record<string, any> = {};

  switch (kind) {
    case "prompt": {
      payload = {
        text: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.PROMPT_TEXT) || ""
      };
      const reqModel = extractAttributeValue(span.attributes, GEN_AI_ATTRS.REQUEST_MODEL);
      const reqProvider = extractAttributeValue(span.attributes, GEN_AI_ATTRS.SYSTEM);
      if (reqModel) {
        payload.model = {
          name: reqModel,
          ...(reqProvider ? { provider: reqProvider } : {})
        };
      }
      break;
    }
    case "response": {
      payload = {
        text: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.RESPONSE_TEXT) || ""
      };
      
      const resModel = extractAttributeValue(span.attributes, GEN_AI_ATTRS.RESPONSE_MODEL);
      const resProvider = extractAttributeValue(span.attributes, GEN_AI_ATTRS.SYSTEM);
      if (resModel) {
        payload.model = {
          name: resModel,
          ...(resProvider ? { provider: resProvider } : {})
        };
      }

      const inputTokens = extractAttributeValue(span.attributes, GEN_AI_ATTRS.USAGE_INPUT_TOKENS);
      const outputTokens = extractAttributeValue(span.attributes, GEN_AI_ATTRS.USAGE_OUTPUT_TOKENS);
      const totalTokens = extractAttributeValue(span.attributes, GEN_AI_ATTRS.USAGE_TOTAL_TOKENS);
      
      if (inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined) {
        payload.usage = {};
        if (inputTokens !== undefined) payload.usage.inputTokens = Number(inputTokens);
        if (outputTokens !== undefined) payload.usage.outputTokens = Number(outputTokens);
        if (totalTokens !== undefined) payload.usage.totalTokens = Number(totalTokens);
      }

      const ttf = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.RESPONSE_TIME_TO_FIRST_TOKEN_MS);
      const tdm = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.RESPONSE_TOTAL_DURATION_MS);
      const tps = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.RESPONSE_TOKENS_PER_SECOND);
      const tc = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.RESPONSE_TOKEN_COUNT);
      if (ttf !== undefined && tdm !== undefined && tps !== undefined && tc !== undefined) {
        payload.streamingTelemetry = {
          timeToFirstTokenMs: Number(ttf),
          totalDurationMs: Number(tdm),
          tokensPerSecond: Number(tps),
          tokenCount: Number(tc)
        };
      }
      break;
    }
    case "tool_call":
      const inputStr = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.TOOL_CALL_INPUT);
      payload = {
        input: inputStr ? JSON.parse(inputStr) : {}
      };
      break;
    case "tool_result":
      const outputStr = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.TOOL_RESULT_OUTPUT);
      payload = {
        output: outputStr ? JSON.parse(outputStr) : {}
      };
      break;
    case "handoff":
      payload = {
        fromAgentId: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.HANDOFF_FROM_AGENT_ID) || "",
        toAgentId: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.HANDOFF_TO_AGENT_ID) || "",
      };
      const reason = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.HANDOFF_REASON);
      if (reason) payload.reason = reason;
      break;
    case "error":
      payload = {
        message: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.ERROR_MESSAGE) || span.status?.message || "Unknown error",
        details: JSON.parse(extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.ERROR_DETAILS) || "{}")
      };
      break;
    case "retriever":
      payload = {
        query: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.RETRIEVER_QUERY) || "",
        documents: [] 
      };
      break;
    case "checkpoint":
      payload = {
        checkpointId: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.CHECKPOINT_ID) || "",
        reason: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.CHECKPOINT_REASON) || ""
      };
      break;
    case "state_snapshot":
      payload = {
        nodeName: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.STATE_SNAPSHOT_NODE_NAME) || "",
        stateHash: extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.STATE_SNAPSHOT_STATE_HASH) || ""
      };
      break;
    case "note":
    default:
      const notePayloadStr = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.NOTE_PAYLOAD);
      if (notePayloadStr) {
        payload = JSON.parse(notePayloadStr);
      } else {
        // Fallback for foreign spans
        payload = {
          otel_span_name: span.name,
          ...span.attributes?.reduce((acc: any, attr) => {
            const val = attr.value as any;
            acc[attr.key] = val.stringValue ?? val.intValue ?? val.doubleValue ?? val.boolValue;
            return acc;
          }, {})
        };
      }
      break;
  }

  return {
    ...baseEvent,
    kind,
    payload
  } as TraceEvent;
}

export function importOtlpToEvents(request: OtlpExportRequest, ctx?: Partial<MappingContext>): TraceEvent[] {
  const fullCtx: MappingContext = {
    traceId: ctx?.traceId || "", 
    defaultActorId: ctx?.defaultActorId || "unknown",
    preserveOriginalIds: ctx?.preserveOriginalIds || false
  };

  const events: TraceEvent[] = [];
  for (const resourceSpan of request.resourceSpans) {
    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        if (!fullCtx.traceId) {
            fullCtx.traceId = span.traceId;
        }
        events.push(importOtlpSpanToEvent(span, fullCtx));
      }
    }
  }

  return events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
