/**
 * packages/otel/src/semantic_mapping.ts
 *
 * Foundation for OpenTelemetry GenAI Semantic Conventions mapping.
 * This module defines the canonical mapping between AeroGraph v1.1.0 telemetry fields
 * and the official OpenTelemetry GenAI semantic attributes.
 *
 * Future adapters and exporters must use this single canonical source.
 */

import type { TraceEvent } from "@aerograph/contracts";
import type { OtlpAttribute } from "./otlp-schema.js";

/**
 * OpenTelemetry GenAI Semantic Convention Constants
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export const GEN_AI_ATTRS = {
  SYSTEM: "gen_ai.system",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  USAGE_TOTAL_TOKENS: "gen_ai.usage.total_tokens",
  OPERATION_NAME: "gen_ai.operation.name",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  AGENT_NAME: "gen_ai.agent.name",
} as const;

/**
 * Common OTEL Resource/Span Semantic Convention Constants
 */
export const COMMON_ATTRS = {
  PROJECT_ID: "project.id",
  ENVIRONMENT: "deployment.environment",
} as const;

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
 * Maps AeroGraph Canonical Telemetry Model (v1.1.0) fields to OTLP attributes.
 * Handles `durationMs` (usually span timing, but could be an attribute),
 * `projectId`, `environment`, and arbitrary `tags`.
 */
export function mapCanonicalTelemetry(event: TraceEvent): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [];
  
  // Cast to any to bypass TS union structural typing strictness
  const e = event as any;

  if (e.projectId) {
    attrs.push(strAttr(COMMON_ATTRS.PROJECT_ID, e.projectId));
  }
  
  if (e.environment) {
    attrs.push(strAttr(COMMON_ATTRS.ENVIRONMENT, e.environment));
  }

  // Tags are mapped as aerograph.tag.<key>
  if (e.tags) {
    for (const [key, value] of Object.entries(e.tags)) {
      attrs.push(strAttr(`aerograph.tag.${key}`, value as string));
    }
  }

  return attrs;
}

/**
 * Maps model metadata to GenAI semantic conventions.
 */
export function mapModelTelemetry(event: TraceEvent): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [];
  const e = event as any;

  if (e.kind === "prompt" && e.payload?.model) {
    const model = e.payload.model;
    attrs.push(strAttr(GEN_AI_ATTRS.REQUEST_MODEL, model.name));
    if (model.provider) {
      attrs.push(strAttr(GEN_AI_ATTRS.SYSTEM, model.provider));
    }
  }

  if (e.kind === "response" && e.payload?.model) {
    const model = e.payload.model;
    attrs.push(strAttr(GEN_AI_ATTRS.RESPONSE_MODEL, model.name));
    if (model.provider) {
      attrs.push(strAttr(GEN_AI_ATTRS.SYSTEM, model.provider));
    }
  }

  return attrs;
}

/**
 * Maps token usage metadata to GenAI semantic conventions.
 */
export function mapUsageTelemetry(event: TraceEvent): OtlpAttribute[] {
  const attrs: OtlpAttribute[] = [];
  const e = event as any;

  if (e.kind === "response" && e.payload?.usage) {
    const usage = e.payload.usage;
    
    if (usage.inputTokens !== undefined) {
      attrs.push(intAttr(GEN_AI_ATTRS.USAGE_INPUT_TOKENS, usage.inputTokens));
    }
    
    if (usage.outputTokens !== undefined) {
      attrs.push(intAttr(GEN_AI_ATTRS.USAGE_OUTPUT_TOKENS, usage.outputTokens));
    }
    
    if (usage.totalTokens !== undefined) {
      attrs.push(intAttr(GEN_AI_ATTRS.USAGE_TOTAL_TOKENS, usage.totalTokens));
    }
  }

  return attrs;
}
