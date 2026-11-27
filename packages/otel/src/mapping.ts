/**
 * packages/otel/src/mapping.ts
 *
 * Semantic mapping between AeroGraph event kinds and OTel span metadata.
 *
 * Functions:
 *   getSpanNameForKind(kind)         — AeroGraph kind → OTLP span name
 *   getSpanKindInt(kind)             — AeroGraph kind → OTLP span kind integer (0–5)
 *   buildAttributesFromEvent(event)  — AeroGraph TraceEvent → OTLP attributes array
 *   exportLinksToOtlp(links, traceId) — AeroGraph TraceLink[] → OtlpLink[]
 *
 * Mapping table (from research.md §5.1):
 *   prompt          → gen_ai.chat          CLIENT (3)
 *   response        → gen_ai.response      CLIENT (3)
 *   tool_call       → gen_ai.tool.call     CLIENT (3)
 *   tool_result     → gen_ai.tool.result   INTERNAL (1)
 *   handoff         → gen_ai.agent.handoff INTERNAL (1)
 *   error           → aerograph.error      INTERNAL (1)
 *   note            → aerograph.note       INTERNAL (1)
 *   retriever       → gen_ai.retrieve      CLIENT (3)
 *   checkpoint      → aerograph.checkpoint INTERNAL (1)
 *   state_snapshot  → aerograph.state_snapshot INTERNAL (1)
 *
 * Mirrors mapping.py in Python exactly.
 */

import type { TraceEvent, TraceEventKind, LinkRel } from "@aerograph/contracts";

/** AeroGraph trace link (mirrors traceLinkSchema in contracts) */
interface TraceLink {
  rel: LinkRel;
  spanId: string;
}
import { AEROGRAPH_ATTRS } from "./constants.js";
import type { OtlpAttribute, OtlpLink } from "./otlp-schema.js";

// OTel span kind enum values
export const SPAN_KIND = {
  UNSPECIFIED: 0,
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
} as const;

// OTel status code enum values
export const STATUS_CODE = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

/**
 * Map an AeroGraph event kind to the OTLP span name.
 */
export function getSpanNameForKind(kind: TraceEventKind): string {
  switch (kind) {
    case "prompt":         return "gen_ai.chat";
    case "response":       return "gen_ai.response";
    case "tool_call":      return "gen_ai.tool.call";
    case "tool_result":    return "gen_ai.tool.result";
    case "handoff":        return "gen_ai.agent.handoff";
    case "error":          return "aerograph.error";
    case "note":           return "aerograph.note";
    case "retriever":      return "gen_ai.retrieve";
    case "checkpoint":     return "aerograph.checkpoint";
    case "state_snapshot": return "aerograph.state_snapshot";
    case "human_input":    return "aerograph.human_input";
  }
}

/**
 * Map an AeroGraph event kind to the OTLP span kind integer.
 */
export function getSpanKindInt(kind: TraceEventKind): number {
  switch (kind) {
    case "prompt":
    case "response":
    case "tool_call":
    case "retriever":
      return SPAN_KIND.CLIENT;
    case "tool_result":
    case "handoff":
    case "error":
    case "note":
    case "checkpoint":
    case "state_snapshot":
    case "human_input":
      return SPAN_KIND.INTERNAL;
  }
}

/**
 * Build an OTLP attribute with a string value.
 */
function strAttr(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

/**
 * Build an OTLP attribute with an integer value.
 */
function intAttr(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: value } };
}

/**
 * Build an OTLP attribute with a double value.
 */
function doubleAttr(key: string, value: number): OtlpAttribute {
  return { key, value: { doubleValue: value } };
}

/**
 * Build the OTLP attributes array for a given AeroGraph TraceEvent.
 * Includes all universal attributes + kind-specific payload attributes.
 *
 * Attribute order is deterministic: universal first, kind-specific second.
 */
export function buildAttributesFromEvent(event: TraceEvent): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [];

  // Universal attributes — on every span
  attrs.push(strAttr(AEROGRAPH_ATTRS.SCHEMA_VERSION, event.schemaVersion));
  attrs.push(strAttr(AEROGRAPH_ATTRS.KIND, event.kind));
  attrs.push(strAttr(AEROGRAPH_ATTRS.ACTOR_ID, event.actor.id));
  attrs.push(strAttr(AEROGRAPH_ATTRS.ACTOR_KIND, event.actor.kind));
  if (event.actor.name) {
    attrs.push(strAttr(AEROGRAPH_ATTRS.ACTOR_NAME, event.actor.name));
  }
  attrs.push(strAttr(AEROGRAPH_ATTRS.STATUS, event.status));
  if (event.title) {
    attrs.push(strAttr(AEROGRAPH_ATTRS.TITLE, event.title));
  }

  // Kind-specific payload attributes
  switch (event.kind) {
    case "prompt":
      attrs.push(strAttr(AEROGRAPH_ATTRS.PROMPT_TEXT, event.payload.text));
      attrs.push(strAttr("gen_ai.operation.name", "chat"));
      break;

    case "response":
      attrs.push(strAttr(AEROGRAPH_ATTRS.RESPONSE_TEXT, event.payload.text));
      if (event.payload.streamingTelemetry) {
        const st = event.payload.streamingTelemetry;
        attrs.push(doubleAttr(AEROGRAPH_ATTRS.RESPONSE_TIME_TO_FIRST_TOKEN_MS, st.timeToFirstTokenMs));
        attrs.push(doubleAttr(AEROGRAPH_ATTRS.RESPONSE_TOTAL_DURATION_MS, st.totalDurationMs));
        attrs.push(doubleAttr(AEROGRAPH_ATTRS.RESPONSE_TOKENS_PER_SECOND, st.tokensPerSecond));
        attrs.push(intAttr(AEROGRAPH_ATTRS.RESPONSE_TOKEN_COUNT, st.tokenCount));
      }
      attrs.push(strAttr("gen_ai.operation.name", "chat"));
      break;

    case "tool_call":
      attrs.push(strAttr(AEROGRAPH_ATTRS.TOOL_CALL_INPUT, JSON.stringify(event.payload.input)));
      attrs.push(strAttr("gen_ai.tool.name", event.actor.id));
      break;

    case "tool_result":
      attrs.push(strAttr(AEROGRAPH_ATTRS.TOOL_RESULT_OUTPUT, JSON.stringify(event.payload.output)));
      attrs.push(strAttr("gen_ai.tool.name", event.actor.id));
      break;

    case "handoff":
      attrs.push(strAttr(AEROGRAPH_ATTRS.HANDOFF_FROM_AGENT_ID, event.payload.fromAgentId));
      attrs.push(strAttr(AEROGRAPH_ATTRS.HANDOFF_TO_AGENT_ID, event.payload.toAgentId));
      if (event.payload.reason) {
        attrs.push(strAttr(AEROGRAPH_ATTRS.HANDOFF_REASON, event.payload.reason));
      }
      attrs.push(strAttr("gen_ai.agent.name", event.payload.toAgentId));
      break;

    case "error":
      attrs.push(strAttr(AEROGRAPH_ATTRS.ERROR_MESSAGE, event.payload.message));
      attrs.push(strAttr(AEROGRAPH_ATTRS.ERROR_DETAILS, JSON.stringify(event.payload.details)));
      attrs.push(strAttr("error.type", "aerograph.error"));
      break;

    case "note":
      attrs.push(strAttr(AEROGRAPH_ATTRS.NOTE_PAYLOAD, JSON.stringify(event.payload)));
      break;

    case "retriever":
      attrs.push(strAttr(AEROGRAPH_ATTRS.RETRIEVER_QUERY, event.payload.query));
      attrs.push(intAttr(AEROGRAPH_ATTRS.RETRIEVER_DOCUMENT_COUNT, event.payload.documents.length));
      attrs.push(strAttr("gen_ai.operation.name", "retrieve"));
      break;

    case "checkpoint":
      attrs.push(strAttr(AEROGRAPH_ATTRS.CHECKPOINT_ID, event.payload.checkpointId));
      attrs.push(strAttr(AEROGRAPH_ATTRS.CHECKPOINT_REASON, event.payload.reason));
      break;

    case "state_snapshot":
      attrs.push(strAttr(AEROGRAPH_ATTRS.STATE_SNAPSHOT_NODE_NAME, event.payload.nodeName));
      attrs.push(strAttr(AEROGRAPH_ATTRS.STATE_SNAPSHOT_STATE_HASH, event.payload.stateHash));
      break;
  }

  return attrs;
}

/**
 * Extract a string representation of an attribute value by key.
 */
export function extractAttributeValue(attrs: OtlpAttribute[] | undefined, key: string): string | undefined {
  if (!attrs) return undefined;
  for (const attr of attrs) {
    if (attr.key === key) {
      const val = attr.value;
      if ('stringValue' in val) return val.stringValue;
      if ('intValue' in val) return String(val.intValue);
      if ('doubleValue' in val) return String(val.doubleValue);
      if ('boolValue' in val) return String(val.boolValue);
    }
  }
  return undefined;
}

/**
 * Resolve an AeroGraph TraceEventKind from an OTLP span using heuristics.
 */
export function resolveAeroGraphKindFromSpan(span: import('./otlp-schema.js').OtlpSpan): TraceEventKind {
  const aeroKind = extractAttributeValue(span.attributes, AEROGRAPH_ATTRS.KIND);
  if (aeroKind) {
    return aeroKind as TraceEventKind;
  }

  const opName = extractAttributeValue(span.attributes, "gen_ai.operation.name");
  if (span.name.includes("gen_ai.chat") || opName === "chat") {
    return "response";
  }

  const toolName = extractAttributeValue(span.attributes, "gen_ai.tool.name");
  const toolCallId = extractAttributeValue(span.attributes, "gen_ai.tool.call.id");
  if (toolName && toolCallId) {
    return "tool_call";
  }

  const errorType = extractAttributeValue(span.attributes, "error.type");
  if (errorType || span.status?.code === STATUS_CODE.ERROR) {
    return "error";
  }

  if (opName === "retrieve") {
    return "retriever";
  }

  return "note";
}

/**
 * Convert AeroGraph TraceLink[] to OTLP OtlpLink[].
 * Each link carries the aerograph.link.rel attribute.
 *
 * @param links - AeroGraph trace links
 * @param traceId - the traceId to use for the link (same trace)
 */
export function exportLinksToOtlp(links: TraceLink[], traceId: string): OtlpLink[] {
  return links.map((link) => ({
    traceId,
    spanId: link.spanId,
    attributes: [
      strAttr(AEROGRAPH_ATTRS.LINK_REL, link.rel),
    ],
  }));
}
