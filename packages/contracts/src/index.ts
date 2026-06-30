import { z } from "zod";

export const traceEventKindSchema = z.enum([
  "prompt",
  "response",
  "tool_call",
  "tool_result",
  "handoff",
  "error",
  "note",
  "state_snapshot",
  "retriever",
  "checkpoint"
]);
export type TraceEventKind = z.infer<typeof traceEventKindSchema>;

export const traceEventStatusSchema = z.enum(["ok", "error"]);
export type TraceEventStatus = z.infer<typeof traceEventStatusSchema>;

export const traceEventSchemaVersion = "1.1.0" as const;
export const traceEventSchemaVersionLegacy = "1.0.0" as const;

// ─── Canonical Telemetry Model (v1.1.0) ──────────────────────────────────────

/** Model identity metadata (name, provider, version). Cost is NOT stored — derived at analytics time. */
export const telemetryModelInfoSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1).optional(),
  version: z.string().min(1).optional()
});
export type TelemetryModelInfo = z.infer<typeof telemetryModelInfoSchema>;

/** Token usage breakdown. cachedTokens is optional for frameworks that don't expose it. */
export const telemetryUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional()
});
export type TelemetryUsage = z.infer<typeof telemetryUsageSchema>;

// ─────────────────────────────────────────────────────────────────────────────

export const actorKindSchema = z.enum(["agent", "tool", "system"]);
export type ActorKind = z.infer<typeof actorKindSchema>;

export const actorSchema = z.object({
  kind: actorKindSchema,
  id: z.string().min(1),
  name: z.string().min(1).optional()
});

export const agentActorSchema = actorSchema.extend({ kind: z.literal("agent") });
export const toolActorSchema = actorSchema.extend({ kind: z.literal("tool") });
export const systemActorSchema = actorSchema.extend({ kind: z.literal("system") });

export const linkRelSchema = z.enum(["follows", "caused_by", "handoff_to"]);
export type LinkRel = z.infer<typeof linkRelSchema>;

export const traceLinkSchema = z.object({
  rel: linkRelSchema,
  spanId: z.string().min(1)
});

const baseEventSchema = z.object({
  schemaVersion: z.union([
    z.literal(traceEventSchemaVersion),
    z.literal(traceEventSchemaVersionLegacy)
  ]),
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).nullable(),
  occurredAt: z.string().datetime(),
  actor: actorSchema,
  status: traceEventStatusSchema,
  title: z.string().min(1).optional(),
  links: z.array(traceLinkSchema).default([]),
  // ── Canonical Telemetry Fields (v1.1.0, all optional for backward compatibility) ──
  /** Span execution duration in milliseconds. */
  durationMs: z.number().int().nonnegative().optional(),
  /** Project identifier for multi-tenant isolation. */
  projectId: z.string().min(1).optional(),
  /** Deployment environment (e.g. development, staging, production). */
  environment: z.string().min(1).optional(),
  /** Arbitrary key-value telemetry tags. */
  tags: z.record(z.string(), z.string()).optional()
});

export const promptPayloadSchema = z.object({ 
  text: z.string(),
  model: telemetryModelInfoSchema.optional()
});

export const promptEventSchema = baseEventSchema.extend({
  kind: z.literal("prompt"),
  actor: agentActorSchema,
  payload: promptPayloadSchema
});

export const streamingTelemetrySchema = z.object({
  timeToFirstTokenMs: z.number(),
  totalDurationMs: z.number(),
  tokensPerSecond: z.number(),
  tokenCount: z.number()
});

export const responsePayloadSchema = z.object({ 
  text: z.string(),
  streamingTelemetry: streamingTelemetrySchema.optional(),
  model: telemetryModelInfoSchema.optional(),
  usage: telemetryUsageSchema.optional()
});

export const responseEventSchema = baseEventSchema.extend({
  kind: z.literal("response"),
  actor: agentActorSchema,
  payload: responsePayloadSchema
});

export const toolCallPayloadSchema = z.object({ input: z.record(z.string(), z.unknown()) });

export const toolCallEventSchema = baseEventSchema.extend({
  kind: z.literal("tool_call"),
  actor: toolActorSchema,
  payload: toolCallPayloadSchema
});

export const toolResultPayloadSchema = z.object({ output: z.record(z.string(), z.unknown()) });

export const toolResultEventSchema = baseEventSchema.extend({
  kind: z.literal("tool_result"),
  actor: toolActorSchema,
  payload: toolResultPayloadSchema
});

export const handoffPayloadSchema = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().min(1),
  reason: z.string().optional()
});

export const handoffEventSchema = baseEventSchema.extend({
  kind: z.literal("handoff"),
  actor: systemActorSchema,
  payload: handoffPayloadSchema
});

export const errorPayloadSchema = z.object({
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({})
});

export const errorEventSchema = baseEventSchema.extend({
  kind: z.literal("error"),
  payload: errorPayloadSchema
});

export const noteEventSchema = baseEventSchema.extend({
  kind: z.literal("note"),
  payload: z.record(z.string(), z.unknown())
});

export const stateSnapshotPayloadSchema = z.object({
  nodeName: z.string(),
  stateHash: z.string(),
  stateDiff: z.record(z.string(), z.unknown()),
  removedKeys: z.array(z.string()).optional(),
  fullState: z.record(z.string(), z.unknown())
});

export const stateSnapshotEventSchema = baseEventSchema.extend({
  kind: z.literal("state_snapshot"),
  actor: systemActorSchema,
  payload: stateSnapshotPayloadSchema
});

export const retrieverDocumentSchema = z.object({
  pageContent: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  score: z.number().optional()
});

export const retrieverPayloadSchema = z.object({
  query: z.string(),
  documents: z.array(retrieverDocumentSchema)
});

export const retrieverEventSchema = baseEventSchema.extend({
  kind: z.literal("retriever"),
  actor: toolActorSchema,
  payload: retrieverPayloadSchema
});

export const checkpointPayloadSchema = z.object({
  checkpointId: z.string(),
  reason: z.string(),
  state: z.record(z.string(), z.unknown())
});

export const checkpointEventSchema = baseEventSchema.extend({
  kind: z.literal("checkpoint"),
  actor: systemActorSchema,
  payload: checkpointPayloadSchema
});

export const traceEventSchema = z.discriminatedUnion("kind", [
  promptEventSchema,
  responseEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  handoffEventSchema,
  errorEventSchema,
  noteEventSchema,
  stateSnapshotEventSchema,
  retrieverEventSchema,
  checkpointEventSchema
]);

export type TraceEvent = z.infer<typeof traceEventSchema>;

export const traceSchema = z.object({
  traceId: z.string().min(1),
  createdAt: z.string().datetime(),
  rootSpanId: z.string().min(1).nullable(),
  events: z.array(traceEventSchema)
});

export type Trace = z.infer<typeof traceSchema>;

export const traceMetaSchema = z.object({
  traceId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  eventCount: z.number().int().nonnegative(),
  rootSpanId: z.string().min(1).nullable(),
  derivedFrom: z
    .object({
      baseTraceId: z.string().min(1),
      forkedFromSpanId: z.string().min(1)
    })
    .optional(),
  projectId: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
  isDeleted: z.boolean().optional()
});
export type TraceMeta = z.infer<typeof traceMetaSchema>;

export const traceWithMetaSchema = z.object({
  meta: traceMetaSchema,
  events: z.array(traceEventSchema)
});
export type TraceWithMeta = z.infer<typeof traceWithMetaSchema>;

export const traceListResponseSchema = z.object({
  traces: z.array(traceMetaSchema)
});
export type TraceListResponse = z.infer<typeof traceListResponseSchema>;

export const traceAnalysisSchema = z.object({
  loops: z.array(
    z.object({
      kind: z.enum(["repeated_sequence", "recursive_tool", "handoff_cycle"]).optional(),
      severity: z.enum(["low", "medium", "high"]).optional(),
      reason: z.string().min(1),
      spanIds: z.array(z.string().min(1))
    })
  ),
  failures: z.array(
    z.object({
      spanId: z.string().min(1),
      title: z.string().min(1).optional()
    })
  ),
  stats: z.object({
    eventCount: z.number().int().nonnegative(),
    actorCount: z.number().int().nonnegative(),
    // v1.1.0 telemetry fields — null when no telemetry data present
    totalInputTokens: z.number().int().nonnegative().nullable().optional(),
    totalOutputTokens: z.number().int().nonnegative().nullable().optional(),
    totalTokens: z.number().int().nonnegative().nullable().optional(),
    totalDurationMs: z.number().int().nonnegative().nullable().optional(),
    modelNamesUsed: z.array(z.string()).optional()
  })
});
export type TraceAnalysis = z.infer<typeof traceAnalysisSchema>;

/**
 * TraceStats — stable contract for GET /v1/traces/:id/stats
 *
 * Designed as a durable, version-safe API contract. Fields are intentionally
 * additive; no field will be removed without a major version bump. Consumers
 * (dashboards, evaluation pipelines, regression detectors) MUST treat all
 * optional fields as potentially absent for v1.0.0 legacy traces.
 *
 * modelBreakdown groups by model name across all spans so downstream
 * analytics can compute per-model cost, latency, and token budgets without
 * fetching full event payloads.
 */
export const modelBreakdownEntrySchema = z.object({
  modelName: z.string().min(1),
  provider: z.string().min(1).optional(),
  spanCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional()
});
export type ModelBreakdownEntry = z.infer<typeof modelBreakdownEntrySchema>;

export const traceStatsSchema = z.object({
  /** The trace this stats payload is for. */
  traceId: z.string().min(1),
  /** ISO-8601 datetime of the first event in the trace. */
  traceStartedAt: z.string().datetime().nullable(),
  /** ISO-8601 datetime of the last event in the trace. */
  traceEndedAt: z.string().datetime().nullable(),
  /** Total number of events in this trace. */
  eventCount: z.number().int().nonnegative(),
  /** Distinct actor IDs that appear in the trace. */
  actorCount: z.number().int().nonnegative(),
  // ── Token usage ─────────────────────────────────────────────────────────
  /** Sum of inputTokens across all response spans with usage data. */
  totalInputTokens: z.number().int().nonnegative().nullable(),
  /** Sum of outputTokens across all response spans with usage data. */
  totalOutputTokens: z.number().int().nonnegative().nullable(),
  /** Sum of totalTokens across all response spans with usage data. */
  totalTokens: z.number().int().nonnegative().nullable(),
  // ── Duration ────────────────────────────────────────────────────────────
  /** Sum of durationMs across all spans that carry that field. */
  totalDurationMs: z.number().int().nonnegative().nullable(),
  /** durationMs of the first event in the trace (wall-clock entry cost). */
  rootSpanDurationMs: z.number().int().nonnegative().nullable(),
  // ── Model breakdown ──────────────────────────────────────────────────────
  /** Per-model token and span breakdown. Empty array when no model data exists. */
  modelBreakdown: z.array(modelBreakdownEntrySchema)
});
export type TraceStats = z.infer<typeof traceStatsSchema>;

export const traceForkRequestSchema = z.object({
  forkFromSpanId: z.string().min(1),
  overrides: z
    .object({
      promptText: z.string().min(1).optional()
    })
    .optional()
});
export type TraceForkRequest = z.infer<typeof traceForkRequestSchema>;

export const traceForkResponseSchema = z.object({
  traceId: z.string().min(1)
});
export type TraceForkResponse = z.infer<typeof traceForkResponseSchema>;

export const traceLineageEdgeSchema = z.object({
  parentTraceId: z.string().min(1),
  childTraceId: z.string().min(1),
  forkedFromSpanId: z.string().min(1),
  createdAt: z.string().datetime(),
  overrides: z
    .object({
      promptText: z.string().min(1).optional()
    })
    .optional()
});
export type TraceLineageEdge = z.infer<typeof traceLineageEdgeSchema>;

export const traceLineageGraphSchema = z.object({
  rootTraceId: z.string().min(1),
  nodes: z.array(traceMetaSchema),
  edges: z.array(traceLineageEdgeSchema)
});
export type TraceLineageGraph = z.infer<typeof traceLineageGraphSchema>;

export const traceDiffResultSchema = z.object({
  a: traceMetaSchema,
  b: traceMetaSchema,
  divergence: z
    .object({
      forkPointSpanId: z.string().min(1).optional(),
      aIndex: z.number().int().nonnegative().optional(),
      bIndex: z.number().int().nonnegative().optional(),
      reason: z.string().min(1).optional()
    })
    .optional(),
  changed: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      aSpanId: z.string().min(1).optional(),
      bSpanId: z.string().min(1).optional(),
      reason: z.string().min(1)
    })
  )
});
export type TraceDiffResult = z.infer<typeof traceDiffResultSchema>;

export function compareTraceEvents(
  a: Pick<TraceEvent, "occurredAt" | "spanId" | "kind">,
  b: Pick<TraceEvent, "occurredAt" | "spanId" | "kind">
): number {
  const t = a.occurredAt.localeCompare(b.occurredAt);
  if (t !== 0) return t;
  const s = a.spanId.localeCompare(b.spanId);
  if (s !== 0) return s;
  return a.kind.localeCompare(b.kind);
}

export function sortTraceEventsDeterministic<T extends Pick<TraceEvent, "occurredAt" | "spanId" | "kind">>(
  events: readonly T[]
): T[] {
  return [...events].sort(compareTraceEvents);
}

export function validateTraceEvent(input: unknown): TraceEvent {
  return traceEventSchema.parse(input);
}

export function validateTrace(input: unknown): Trace {
  return traceSchema.parse(input);
}

export function validateTraceWithMeta(input: unknown): TraceWithMeta {
  return traceWithMetaSchema.parse(input);
}

export function validateTraceForkRequest(input: unknown): TraceForkRequest {
  return traceForkRequestSchema.parse(input);
}

export function validateTraceForkResponse(input: unknown): TraceForkResponse {
  return traceForkResponseSchema.parse(input);
}

export function validateTraceLineageGraph(input: unknown): TraceLineageGraph {
  return traceLineageGraphSchema.parse(input);
}

export function validateTraceDiffResult(input: unknown): TraceDiffResult {
  return traceDiffResultSchema.parse(input);
}

export function validateTraceAnalysis(input: unknown): TraceAnalysis {
  return traceAnalysisSchema.parse(input);
}

export function validateTraceStats(input: unknown): TraceStats {
  return traceStatsSchema.parse(input);
}

export * from "./utils/hash.js";
