import type { Database } from "better-sqlite3";
import {
  sortTraceEventsDeterministic,
  validateTraceDiffResult,
  validateTraceAnalysis,
  validateTraceStats,
  type TraceEvent,
  type TraceLineageGraph,
  type TraceLineageEdge,
  type TraceListResponse,
  type TraceMeta,
  type TraceWithMeta,
  type TraceDiffResult,
  type TraceAnalysis,
  type TraceStats,
  type ModelBreakdownEntry
} from "@aerograph/contracts";
import { nanoid } from "nanoid";
import { diffTraceEvents } from "./diff/index";
import { analyzeTrace as analyzeTraceEvents } from "./analysis/index";

export type ForkTraceInput = {
  baseTraceId: string;
  forkFromSpanId: string;
  overrides?: {
    promptText?: string;
  };
};

export type AppendDerivationInput = {
  childTraceId: string;
  parentTraceId: string;
  forkedFromSpanId: string;
  overrides?: {
    promptText?: string;
  };
};

export class SqliteTraceStore {
  constructor(private db: Database) {}

  appendEvent(event: TraceEvent): void {
    // Extract telemetry columns from the event for indexed storage.
    // These are projected from the payload for efficient analytics queries.
    // All columns default NULL for v1.0.0 legacy events.
    const e = event as any;
    const modelName: string | null = e.payload?.model?.name ?? null;
    const modelProvider: string | null = e.payload?.model?.provider ?? null;
    const modelVersion: string | null = e.payload?.model?.version ?? null;
    const usageInputTokens: number | null = e.payload?.usage?.inputTokens ?? null;
    const usageOutputTokens: number | null = e.payload?.usage?.outputTokens ?? null;
    const usageTotalTokens: number | null = e.payload?.usage?.totalTokens ?? null;
    const usageCachedTokens: number | null = e.payload?.usage?.cachedTokens ?? null;
    const durationMs: number | null = e.durationMs ?? null;
    const projectId: string | null = e.projectId ?? null;
    const environment: string | null = e.environment ?? null;
    const tagsJson: string | null = e.tags ? JSON.stringify(e.tags) : null;

    const stmt = this.db.prepare(`
      INSERT INTO events (
        trace_id, span_id, parent_span_id, occurred_at, kind, event_data,
        model_name, model_provider, model_version,
        usage_input_tokens, usage_output_tokens, usage_total_tokens, usage_cached_tokens,
        duration_ms, project_id, environment, tags_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.traceId,
      event.spanId,
      event.parentSpanId,
      event.occurredAt,
      event.kind,
      JSON.stringify(event),
      modelName,
      modelProvider,
      modelVersion,
      usageInputTokens,
      usageOutputTokens,
      usageTotalTokens,
      usageCachedTokens,
      durationMs,
      projectId,
      environment,
      tagsJson
    );
  }

  listTraces(filters?: { projectId?: string; environment?: string }): TraceListResponse {
    let query = `
      SELECT 
        trace_id, 
        MIN(occurred_at) as created_at, 
        MAX(occurred_at) as updated_at, 
        COUNT(*) as event_count,
        MAX(project_id) as project_id,
        MAX(environment) as environment
      FROM events
    `;

    const conditions: string[] = [];
    const params: any[] = [];
    if (filters?.projectId) {
      conditions.push("project_id = ?");
      params.push(filters.projectId);
    }
    if (filters?.environment) {
      conditions.push("environment = ?");
      params.push(filters.environment);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")} `;
    }

    query += `
      GROUP BY trace_id
      ORDER BY updated_at DESC
    `;

    const rows = this.db.prepare(query).all(...params) as any[];

    const traces: TraceMeta[] = rows.map((r) => {
      // Find the root span or check if it's a tombstone
      const rootRow = this.db.prepare(`
        SELECT span_id FROM events
        WHERE trace_id = ? AND (parent_span_id IS NULL OR span_id = 'tombstone')
        ORDER BY occurred_at ASC, id ASC
        LIMIT 1
      `).get(r.trace_id) as any;

      // Assign the root span ID to r.span_id to check if it's a tombstone later
      if (rootRow) r.span_id = rootRow.span_id;

      const derivation = this.db
        .prepare(
          "SELECT parent_trace_id, forked_from_span_id FROM trace_derivations WHERE child_trace_id = ?"
        )
        .get(r.trace_id) as any;

      return {
        traceId: r.trace_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        eventCount: r.event_count,
        rootSpanId: rootRow ? rootRow.span_id : null,
        ...(derivation
          ? {
              derivedFrom: {
                baseTraceId: derivation.parent_trace_id,
                forkedFromSpanId: derivation.forked_from_span_id
              }
            }
          : {}),
        ...(r.project_id ? { projectId: r.project_id } : {}),
        ...(r.environment ? { environment: r.environment } : {}),
        ...(r.span_id === 'tombstone' ? { isDeleted: true } : {})
      };
    });

    return { traces };
  }

  getTrace(traceId: string): TraceWithMeta | null {
    const rows = this.db.prepare(`
      SELECT event_data FROM events WHERE trace_id = ? ORDER BY id ASC
    `).all(traceId) as any[];

    if (rows.length === 0) {
      return null;
    }

    const events = rows.map((r) => JSON.parse(r.event_data) as TraceEvent);
    
    let createdAt = events[0].occurredAt;
    let updatedAt = events[0].occurredAt;
    let rootSpanId = null;
    let projectId = null;
    let environment = null;

    for (const e of events) {
      if (e.occurredAt < createdAt) createdAt = e.occurredAt;
      if (e.occurredAt > updatedAt) updatedAt = e.occurredAt;
      if (e.projectId) projectId = e.projectId;
      if (e.environment) environment = e.environment;
    }

    const roots = events
      .filter((e) => e.parentSpanId === null)
      .slice()
      .sort((a, b) => {
        const t = a.occurredAt.localeCompare(b.occurredAt);
        if (t !== 0) return t;
        return a.spanId.localeCompare(b.spanId);
      });
    rootSpanId = roots.length > 0 ? roots[0].spanId : null;

    const derivation = this.db
      .prepare(
        "SELECT parent_trace_id, forked_from_span_id FROM trace_derivations WHERE child_trace_id = ?"
      )
      .get(traceId) as any;

    return {
      meta: {
        traceId,
        createdAt,
        updatedAt,
        eventCount: events.length,
        rootSpanId,
        ...(derivation
          ? {
              derivedFrom: {
                baseTraceId: derivation.parent_trace_id,
                forkedFromSpanId: derivation.forked_from_span_id
              }
            }
          : {}),
        ...(projectId ? { projectId } : {}),
        ...(environment ? { environment } : {}),
        ...(rootSpanId === 'tombstone' ? { isDeleted: true } : {})
      },
      events
    };
  }

  deleteTrace(traceId: string): void {
    const rootRow = this.db.prepare("SELECT * FROM events WHERE trace_id = ? ORDER BY occurred_at ASC LIMIT 1").get(traceId) as any;
    if (!rootRow) return;

    // Delete all real events
    this.db.prepare("DELETE FROM events WHERE trace_id = ?").run(traceId);
    
    // Insert a tombstone event to preserve lineage graph and metadata
    const tombstoneEvent = {
      schemaVersion: "1.1.0",
      traceId,
      spanId: "tombstone",
      parentSpanId: null,
      occurredAt: rootRow.occurred_at,
      actor: { kind: "system", id: "collector" },
      kind: "note",
      status: "ok",
      title: "deleted",
      payload: { isDeleted: true },
      links: []
    };

    this.db.prepare(`
      INSERT INTO events (
        trace_id, span_id, parent_span_id, occurred_at, kind, event_data,
        project_id, environment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      traceId,
      "tombstone",
      null,
      rootRow.occurred_at,
      "note",
      JSON.stringify(tombstoneEvent),
      rootRow.project_id,
      rootRow.environment
    );
  }

  appendDerivation(input: AppendDerivationInput): void {
    const childTraceId = input.childTraceId;
    const parentTraceId = input.parentTraceId;
    const forkedFromSpanId = input.forkedFromSpanId;
    const overrides = input.overrides ?? {};

    if (childTraceId === parentTraceId) {
      throw new Error("Lineage must be acyclic: childTraceId cannot equal parentTraceId");
    }

    // Each derived trace can only have one parent.
    const existing = this.db
      .prepare("SELECT 1 FROM trace_derivations WHERE child_trace_id = ?")
      .get(childTraceId);
    if (existing) {
      throw new Error(`Trace already has a parent derivation: ${childTraceId}`);
    }

    // Cycle check: ensure parent is not already (transitively) derived from child.
    let cursor: string | null = parentTraceId;
    while (cursor) {
      if (cursor === childTraceId) {
        throw new Error("Lineage must be acyclic: would create a cycle");
      }
      const row = this.db
        .prepare("SELECT parent_trace_id FROM trace_derivations WHERE child_trace_id = ?")
        .get(cursor) as any;
      cursor = row?.parent_trace_id ?? null;
    }

    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO trace_derivations (
          child_trace_id,
          parent_trace_id,
          forked_from_span_id,
          created_at,
          overrides_json
        ) VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(childTraceId, parentTraceId, forkedFromSpanId, createdAt, JSON.stringify(overrides));
  }

  getLineageGraph(traceId: string): TraceLineageGraph {
    // Ensure trace exists.
    const exists = this.db
      .prepare("SELECT 1 FROM events WHERE trace_id = ? LIMIT 1")
      .get(traceId);
    if (!exists) {
      throw new Error(`Trace not found: ${traceId}`);
    }

    // Find root by walking parent pointers.
    let rootTraceId = traceId;
    while (true) {
      const row = this.db
        .prepare("SELECT parent_trace_id FROM trace_derivations WHERE child_trace_id = ?")
        .get(rootTraceId) as any;
      if (!row?.parent_trace_id) break;
      rootTraceId = row.parent_trace_id;
    }

    const edges: TraceLineageEdge[] = [];
    const nodes: TraceMeta[] = [];

    const seen = new Set<string>();
    const queue: string[] = [rootTraceId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);

      const meta = this.getTrace(current)?.meta;
      if (meta) nodes.push(meta);

      const childRows = this.db
        .prepare(
          `
          SELECT child_trace_id, parent_trace_id, forked_from_span_id, created_at, overrides_json
          FROM trace_derivations
          WHERE parent_trace_id = ?
          ORDER BY created_at ASC, child_trace_id ASC
        `
        )
        .all(current) as any[];

      for (const r of childRows) {
        const overrides = (() => {
          try {
            return JSON.parse(r.overrides_json ?? "{}") as any;
          } catch {
            return {};
          }
        })();

        edges.push({
          parentTraceId: r.parent_trace_id,
          childTraceId: r.child_trace_id,
          forkedFromSpanId: r.forked_from_span_id,
          createdAt: r.created_at,
          ...(Object.keys(overrides).length > 0 ? { overrides } : {})
        });

        queue.push(r.child_trace_id);
      }
    }

    return {
      rootTraceId,
      nodes,
      edges
    };
  }

  forkTrace(input: ForkTraceInput): string {
    const baseTrace = this.getTrace(input.baseTraceId);
    if (!baseTrace) {
      throw new Error(`Base trace not found: ${input.baseTraceId}`);
    }

    const overrides = input.overrides ?? {};

    const sorted = sortTraceEventsDeterministic(baseTrace.events);
    const forkIndex = sorted.findIndex((e) => e.spanId === input.forkFromSpanId);
    if (forkIndex < 0) {
      throw new Error(`Fork spanId not found in base trace: ${input.forkFromSpanId}`);
    }

    const childTraceId = `t_${nanoid(10)}`;

    const prefix = sorted.slice(0, forkIndex + 1).map((e) => {
      const copied: TraceEvent = { ...e, traceId: childTraceId };
      if (e.spanId === input.forkFromSpanId && overrides.promptText && e.kind === "prompt") {
        copied.payload = { ...(e as any).payload, text: overrides.promptText } as any;
      }
      return copied;
    });

    for (const e of prefix) {
      this.appendEvent(e);
    }

    const noteSpanId = `n_${nanoid(10)}`;
    const note: TraceEvent = {
      schemaVersion: baseTrace.events[0].schemaVersion,
      traceId: childTraceId,
      spanId: noteSpanId,
      parentSpanId: input.forkFromSpanId,
      occurredAt: new Date().toISOString(),
      actor: { kind: "system", id: "system" },
      kind: "note",
      status: "ok",
      payload: {
        event: "trace_fork",
        baseTraceId: input.baseTraceId,
        forkedFromSpanId: input.forkFromSpanId,
        overrides
      },
      links: []
    };
    this.appendEvent(note);

    this.appendDerivation({
      childTraceId,
      parentTraceId: input.baseTraceId,
      forkedFromSpanId: input.forkFromSpanId,
      overrides
    });

    return childTraceId;
  }

  diffTraces(aId: string, bId: string): TraceDiffResult {
    const aTrace = this.getTrace(aId);
    if (!aTrace) throw new Error(`Trace not found: ${aId}`);
    const bTrace = this.getTrace(bId);
    if (!bTrace) throw new Error(`Trace not found: ${bId}`);

    // Find shared fork point if traces are lineage-related.
    let forkPointSpanId: string | undefined;

    // Check if b is derived from a
    const bDerivation = this.db
      .prepare("SELECT parent_trace_id, forked_from_span_id FROM trace_derivations WHERE child_trace_id = ?")
      .get(bId) as any;
    if (bDerivation?.parent_trace_id === aId) {
      forkPointSpanId = bDerivation.forked_from_span_id;
    } else {
      // Check if a is derived from b
      const aDerivation = this.db
        .prepare("SELECT parent_trace_id, forked_from_span_id FROM trace_derivations WHERE child_trace_id = ?")
        .get(aId) as any;
      if (aDerivation?.parent_trace_id === bId) {
        forkPointSpanId = aDerivation.forked_from_span_id;
      } else {
        // Check for common ancestor (siblings): find common parent
        const bAncestor = bDerivation?.parent_trace_id;
        const aAncestor = aDerivation?.parent_trace_id;
        if (bAncestor && bAncestor === aAncestor) {
          // Both derived from same parent — use b's fork span (both should be equal)
          forkPointSpanId = bDerivation?.forked_from_span_id;
        }
      }
    }

    const result = diffTraceEvents(
      aTrace.events,
      bTrace.events,
      aTrace.meta,
      bTrace.meta,
      forkPointSpanId
    );

    return validateTraceDiffResult(result);
  }

  analyzeTrace(traceId: string): TraceAnalysis {
    const trace = this.getTrace(traceId);
    if (!trace) throw new Error(`Trace not found: ${traceId}`);
    const result = analyzeTraceEvents(trace.events);

    // T015A: enrich stats with token/duration aggregates from indexed columns
    const telemetry = this.db.prepare(`
      SELECT
        SUM(usage_input_tokens)  AS totalInputTokens,
        SUM(usage_output_tokens) AS totalOutputTokens,
        SUM(usage_total_tokens)  AS totalTokens,
        SUM(duration_ms)         AS totalDurationMs,
        GROUP_CONCAT(DISTINCT model_name) AS modelNames
      FROM events
      WHERE trace_id = ?
    `).get(traceId) as any;

    const enriched = {
      ...result,
      stats: {
        ...result.stats,
        totalInputTokens: telemetry?.totalInputTokens ?? null,
        totalOutputTokens: telemetry?.totalOutputTokens ?? null,
        totalTokens: telemetry?.totalTokens ?? null,
        totalDurationMs: telemetry?.totalDurationMs ?? null,
        modelNamesUsed: telemetry?.modelNames
          ? telemetry.modelNames.split(",").filter(Boolean)
          : []
      }
    };

    return validateTraceAnalysis(enriched);
  }

  /**
   * T014: Compute stable trace-level statistics from indexed telemetry columns.
   *
   * This is the foundation for GET /v1/traces/:id/stats. It is intentionally
   * a separate method from analyzeTrace to keep the API contract stable and
   * to allow future caching / materialized-view strategies.
   */
  getTraceStats(traceId: string): TraceStats {
    const exists = this.db
      .prepare("SELECT 1 FROM events WHERE trace_id = ? LIMIT 1")
      .get(traceId);
    if (!exists) throw new Error(`Trace not found: ${traceId}`);

    // Aggregate summary from indexed columns (fast, no JSON parsing)
    const summary = this.db.prepare(`
      SELECT
        COUNT(*)                 AS eventCount,
        COUNT(DISTINCT COALESCE(event_data, '')) AS actorCount_placeholder,
        MIN(occurred_at)         AS traceStartedAt,
        MAX(occurred_at)         AS traceEndedAt,
        SUM(usage_input_tokens)  AS totalInputTokens,
        SUM(usage_output_tokens) AS totalOutputTokens,
        SUM(usage_total_tokens)  AS totalTokens,
        SUM(duration_ms)         AS totalDurationMs
      FROM events
      WHERE trace_id = ?
    `).get(traceId) as any;

    // Actor count requires reading event_data.actor.id — do it efficiently
    const actorRows = this.db.prepare(`
      SELECT DISTINCT json_extract(event_data, '$.actor.id') AS actor_id
      FROM events
      WHERE trace_id = ?
    `).all(traceId) as any[];
    const actorCount = actorRows.filter((r) => r.actor_id).length;

    // Root span duration
    const rootSpanRow = this.db.prepare(`
      SELECT duration_ms
      FROM events
      WHERE trace_id = ? AND parent_span_id IS NULL AND duration_ms IS NOT NULL
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `).get(traceId) as any;

    // Per-model breakdown from indexed columns
    const modelRows = this.db.prepare(`
      SELECT
        model_name    AS modelName,
        model_provider AS provider,
        COUNT(*)      AS spanCount,
        SUM(usage_input_tokens)  AS inputTokens,
        SUM(usage_output_tokens) AS outputTokens,
        SUM(usage_total_tokens)  AS totalTokens
      FROM events
      WHERE trace_id = ? AND model_name IS NOT NULL
      GROUP BY model_name, model_provider
      ORDER BY totalTokens DESC NULLS LAST
    `).all(traceId) as any[];

    const modelBreakdown: ModelBreakdownEntry[] = modelRows.map((r) => ({
      modelName: r.modelName,
      ...(r.provider ? { provider: r.provider } : {}),
      spanCount: r.spanCount,
      ...(r.inputTokens != null ? { inputTokens: r.inputTokens } : {}),
      ...(r.outputTokens != null ? { outputTokens: r.outputTokens } : {}),
      ...(r.totalTokens != null ? { totalTokens: r.totalTokens } : {})
    }));

    return validateTraceStats({
      traceId,
      traceStartedAt: summary.traceStartedAt ?? null,
      traceEndedAt: summary.traceEndedAt ?? null,
      eventCount: summary.eventCount,
      actorCount,
      totalInputTokens: summary.totalInputTokens ?? null,
      totalOutputTokens: summary.totalOutputTokens ?? null,
      totalTokens: summary.totalTokens ?? null,
      totalDurationMs: summary.totalDurationMs ?? null,
      rootSpanDurationMs: rootSpanRow?.duration_ms ?? null,
      modelBreakdown
    });
  }
}
