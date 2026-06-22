import { nanoid } from "nanoid";
import {
  traceEventSchemaVersion,
  type TraceEvent,
  type TelemetryModelInfo,
  type TelemetryUsage,
  validateTraceEvent
} from "@aerograph/contracts";

export { buildCanonicalTelemetry, type CanonicalTelemetry } from "./telemetry/mapper.js";

/** Canonical telemetry block — all fields optional, safe for v1.0.0 emitters. */
export type TelemetryBlock = {
  /** Model metadata (only emit for prompt/response events). */
  model?: TelemetryModelInfo;
  /** Token usage (only emit for response events). */
  usage?: TelemetryUsage;
  /** Wall-clock duration of this span in milliseconds. */
  durationMs?: number;
  /** Project identifier for multi-tenant isolation. */
  projectId?: string;
  /** Deployment environment (e.g. "development", "production"). */
  environment?: string;
  /** Arbitrary key-value telemetry tags. */
  tags?: Record<string, string>;
};

export type FlightRecorderOptions = {
  endpoint: string;
  traceId?: string;
  actor: { id: string; name?: string };
  fetchFn?: typeof fetch;
  projectId?: string;
  environment?: string;
};

export class FlightRecorder {
  readonly endpoint: string;
  readonly traceId: string;
  readonly actor: { id: string; name?: string };
  readonly projectId?: string;
  readonly environment?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: FlightRecorderOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.traceId = options.traceId ?? `t_${nanoid()}`;
    this.actor = options.actor;
    this.projectId = options.projectId;
    this.environment = options.environment;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  createSpanId(): string {
    return `s_${nanoid()}`;
  }

  async emit(event: Omit<TraceEvent, "schemaVersion">): Promise<TraceEvent> {
    const baseEvent: any = { ...event };
    if (this.projectId && !("projectId" in baseEvent)) baseEvent.projectId = this.projectId;
    if (this.environment && !("environment" in baseEvent)) baseEvent.environment = this.environment;

    const fullEvent: TraceEvent = validateTraceEvent({
      ...baseEvent,
      schemaVersion: traceEventSchemaVersion
    });

    const res = await this.fetchFn(`${this.endpoint}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fullEvent)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to emit event: ${res.status} ${text}`);
    }

    return fullEvent;
  }

  async prompt(params: {
    spanId?: string;
    parentSpanId: string | null;
    title?: string;
    text: string;
    telemetry?: TelemetryBlock;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    const { telemetry } = params;
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "agent", id: this.actor.id, name: this.actor.name },
      kind: "prompt",
      status: "ok",
      title: params.title,
      payload: {
        text: params.text,
        ...(telemetry?.model ? { model: telemetry.model } : {})
      },
      links: [],
      ...(telemetry?.durationMs !== undefined ? { durationMs: telemetry.durationMs } : {}),
      ...(telemetry?.projectId ? { projectId: telemetry.projectId } : {}),
      ...(telemetry?.environment ? { environment: telemetry.environment } : {}),
      ...(telemetry?.tags ? { tags: telemetry.tags } : {})
    } as any);
  }

  async response(params: {
    spanId?: string;
    parentSpanId: string | null;
    title?: string;
    text: string;
    payload?: {
      streamingTelemetry?: {
        timeToFirstTokenMs: number;
        totalDurationMs: number;
        tokensPerSecond: number;
        tokenCount: number;
      };
    };
    telemetry?: TelemetryBlock;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    const { telemetry } = params;
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "agent", id: this.actor.id, name: this.actor.name },
      kind: "response",
      status: "ok",
      title: params.title,
      payload: {
        text: params.text,
        ...(params.payload || {}),
        ...(telemetry?.model ? { model: telemetry.model } : {}),
        ...(telemetry?.usage ? { usage: telemetry.usage } : {})
      },
      links: [],
      ...(telemetry?.durationMs !== undefined ? { durationMs: telemetry.durationMs } : {}),
      ...(telemetry?.projectId ? { projectId: telemetry.projectId } : {}),
      ...(telemetry?.environment ? { environment: telemetry.environment } : {}),
      ...(telemetry?.tags ? { tags: telemetry.tags } : {})
    } as any);
  }

  async toolCall(params: {
    spanId?: string;
    parentSpanId: string | null;
    toolId: string;
    toolName?: string;
    input: Record<string, unknown>;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "tool", id: params.toolId, name: params.toolName },
      kind: "tool_call",
      status: "ok",
      title: params.toolName,
      payload: { input: params.input },
      links: []
    });
  }

  async toolResult(params: {
    spanId?: string;
    parentSpanId: string | null;
    toolId: string;
    toolName?: string;
    output: Record<string, unknown>;
    status?: "ok" | "error";
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "tool", id: params.toolId, name: params.toolName },
      kind: "tool_result",
      status: params.status ?? "ok",
      title: params.toolName,
      payload: { output: params.output },
      links: []
    });
  }

  async handoff(params: {
    spanId?: string;
    parentSpanId: string | null;
    fromAgentId: string;
    toAgentId: string;
    reason?: string;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "system", id: "handoff" },
      kind: "handoff",
      status: "ok",
      title: "handoff",
      payload: {
        fromAgentId: params.fromAgentId,
        toAgentId: params.toAgentId,
        reason: params.reason
      },
      links: []
    });
  }

  async error(params: {
    spanId?: string;
    parentSpanId: string | null;
    title?: string;
    message: string;
    details?: Record<string, unknown>;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "system", id: this.actor.id, name: this.actor.name },
      kind: "error",
      status: "error",
      title: params.title,
      payload: { message: params.message, details: params.details ?? {} },
      links: []
    });
  }

  async note(params: {
    spanId?: string;
    parentSpanId: string | null;
    title?: string;
    payload: Record<string, unknown>;
    [key: string]: unknown;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    // Pull only the known schema fields; extra keys like chainName are not emitted top-level
    const { spanId: _sid, parentSpanId, title, payload } = params;
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: parentSpanId as string | null,
      occurredAt: new Date().toISOString(),
      actor: { kind: "system", id: this.actor.id, name: this.actor.name },
      kind: "note",
      status: "ok",
      title,
      payload,
      links: []
    });
  }

  async stateSnapshot(params: {
    spanId?: string;
    parentSpanId: string | null;
    nodeName: string;
    stateHash: string;
    stateDiff: Record<string, unknown>;
    removedKeys?: string[];
    fullState: Record<string, unknown>;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "system", id: this.actor.id, name: this.actor.name },
      kind: "state_snapshot",
      status: "ok",
      title: `State: ${params.nodeName}`,
      payload: {
        nodeName: params.nodeName,
        stateHash: params.stateHash,
        stateDiff: params.stateDiff,
        removedKeys: params.removedKeys,
        fullState: params.fullState
      },
      links: []
    });
  }

  async retriever(params: {
    spanId?: string;
    parentSpanId: string | null;
    toolId: string;
    toolName?: string;
    query: string;
    documents: Array<{
      pageContent: string;
      metadata: Record<string, unknown>;
      score?: number;
    }>;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "tool", id: params.toolId, name: params.toolName },
      kind: "retriever",
      status: "ok",
      title: params.toolName || "retriever",
      payload: {
        query: params.query,
        documents: params.documents
      },
      links: []
    });
  }

  async checkpoint(params: {
    spanId?: string;
    parentSpanId: string | null;
    checkpointId: string;
    reason: string;
    state: Record<string, unknown>;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "system", id: this.actor.id, name: this.actor.name },
      kind: "checkpoint",
      status: "ok",
      title: `Checkpoint: ${params.checkpointId}`,
      payload: {
        checkpointId: params.checkpointId,
        reason: params.reason,
        state: params.state
      },
      links: []
    });
  }
}
