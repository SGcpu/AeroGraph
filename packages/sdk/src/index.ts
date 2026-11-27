import { gzipSync } from "node:zlib";
import { nanoid } from "nanoid";
import {
  traceEventSchemaVersion,
  type TraceEvent,
  type TelemetryModelInfo,
  type TelemetryUsage,
  validateTraceEvent
} from "@aerograph/contracts";
import { getCurrentBranchId } from "./context.js";

export { buildCanonicalTelemetry, type CanonicalTelemetry } from "./telemetry/mapper.js";
export {
  getCurrentSpanId,
  getCurrentBranchId,
  nextLocalSeq,
  resetBranchCounters,
  childBranchId,
  runWithSpanContext
} from "./context.js";

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
  strictTelemetry?: boolean;
  batching?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
};

export class FlightRecorder {
  readonly endpoint: string;
  readonly traceId: string;
  readonly actor: { id: string; name?: string };
  readonly projectId?: string;
  readonly environment?: string;
  readonly strictTelemetry: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly useBatcher: boolean;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly queue: TraceEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(options: FlightRecorderOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.traceId = options.traceId ?? `t_${nanoid()}`;
    this.actor = options.actor;
    this.projectId = options.projectId;
    this.environment = options.environment;
    this.fetchFn = options.fetchFn ?? fetch;
    this.strictTelemetry = options.strictTelemetry ?? process.env.AEROGRAPH_STRICT_TELEMETRY === "true";
    this.batchSize = Math.max(1, options.batchSize ?? 20);
    this.flushIntervalMs = Math.max(10, options.flushIntervalMs ?? 50);
    this.useBatcher =
      options.batching ?? (!options.fetchFn && !this.strictTelemetry && process.env.NODE_ENV !== "test");
  }

  createSpanId(): string {
    return `s_${nanoid()}`;
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.batchSize);
        await this.postBatchWithRetry(batch);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async postBatchWithRetry(batch: TraceEvent[]): Promise<void> {
    const gz = gzipSync(Buffer.from(JSON.stringify({ events: batch }), "utf-8"));
    const delays = [100, 200, 400];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const res = await this.fetchFn(`${this.endpoint}/v1/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip"
          },
          body: gz
        });
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          console.warn(`[AeroGraph] Dropping ${batch.length} telemetry event(s): HTTP ${res.status}`);
          return;
        }
      } catch (err) {
        if (attempt === delays.length) {
          console.warn(`[AeroGraph] Collector unreachable, dropping ${batch.length} event(s):`, err);
          return;
        }
      }
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  async emit(event: Omit<TraceEvent, "schemaVersion">): Promise<TraceEvent> {
    const baseEvent: any = { ...event };
    if (this.projectId && !("projectId" in baseEvent)) baseEvent.projectId = this.projectId;
    if (this.environment && !("environment" in baseEvent)) baseEvent.environment = this.environment;
    const branchId = getCurrentBranchId();
    if (branchId && branchId !== "root" && !("branchId" in baseEvent)) {
      baseEvent.branchId = branchId;
    }

    const fullEvent: TraceEvent = validateTraceEvent({
      ...baseEvent,
      schemaVersion: traceEventSchemaVersion
    });

    if (this.useBatcher) {
      if (this.queue.length >= 4096) {
        this.queue.shift();
      }
      this.queue.push(fullEvent);
      if (this.queue.length >= this.batchSize) {
        void this.flush();
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flush();
        }, this.flushIntervalMs);
        this.flushTimer.unref?.();
      }
      return fullEvent;
    }

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

  async humanInput(params: {
    spanId?: string;
    parentSpanId: string | null;
    turn: number;
    prompt: string;
    text: string;
    channel?: "stdin" | "http" | "hitl";
    edited?: boolean;
  }): Promise<TraceEvent> {
    const spanId = params.spanId ?? this.createSpanId();
    return this.emit({
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "system", id: this.actor.id, name: this.actor.name },
      kind: "human_input",
      status: "ok",
      title: `Human Input (Turn ${params.turn})`,
      payload: {
        channel: params.channel ?? "stdin",
        turn: params.turn,
        prompt: params.prompt,
        text: params.text,
        edited: params.edited
      },
      links: []
    });
  }
}
