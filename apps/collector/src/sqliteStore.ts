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
  type ModelBreakdownEntry,
  type RunMode,
  type RunStatus,
  type GetRunResponse
} from "@aerograph/contracts";
import { nanoid } from "nanoid";
import { diffTraceEvents } from "./diff/index";
import { analyzeTrace as analyzeTraceEvents } from "./analysis/index";

export type CreateRunInput = {
  runId?: string;
  traceId: string;
  parentTraceId?: string | null;
  cassetteRunId?: string | null;
  mode: RunMode;
  command: string[];
  projectRoot: string;
  virtualEnv?: string | null;
  executablePath?: string | null;
  entrypoint?: string | null;
};

export type UpdateRunStatusExtras = {
  startedAt?: string | null;
  completedAt?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  cassetteRunId?: string | null;
};

export type ReplayAnnotationInput = {
  replaySource?: "cache" | "live" | null;
  requestKey?: string | null;
  tokensSaved?: number | null;
  replayLatencyMs?: number | null;
  streamingPreserved?: boolean | null;
  overridden?: boolean | null;
  decision?: string | null;
  matchedPattern?: string | null;
  effectiveClass?: string | null;
  payloadText?: string | null;
};

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
  constructor(private db: Database) {
    try {
      this.db.exec("UPDATE trace_derivations SET forked_from_span_id = 'root' WHERE forked_from_span_id = '' OR forked_from_span_id IS NULL");
    } catch {
      // Non-blocking if table not yet initialized
    }
  }

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

      const runRow = this.db
        .prepare(
          "SELECT run_id, mode, cassette_run_id, parent_trace_id FROM replay_runs WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(r.trace_id) as any;

      const parentTraceId = derivation?.parent_trace_id || runRow?.parent_trace_id || null;
      const forkedFromSpanId = (derivation?.forked_from_span_id && derivation.forked_from_span_id.length > 0)
        ? derivation.forked_from_span_id
        : (parentTraceId ? "root" : undefined);

      return {
        traceId: r.trace_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        eventCount: r.event_count,
        rootSpanId: rootRow ? rootRow.span_id : null,
        ...(parentTraceId
          ? {
              derivedFrom: {
                baseTraceId: parentTraceId,
                forkedFromSpanId
              }
            }
          : {}),
        ...(runRow
          ? {
              replayRun: {
                runId: runRow.run_id,
                mode: runRow.mode,
                cassetteRunId: runRow.cassette_run_id ?? undefined,
                sourceTraceId: runRow.parent_trace_id ?? undefined
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

    const runRow = this.db
      .prepare(
        "SELECT run_id, mode, cassette_run_id, parent_trace_id FROM replay_runs WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(traceId) as any;

    const parentTraceId = derivation?.parent_trace_id || runRow?.parent_trace_id || null;
    const forkedFromSpanId = (derivation?.forked_from_span_id && derivation.forked_from_span_id.length > 0)
      ? derivation.forked_from_span_id
      : (parentTraceId ? "root" : undefined);

    return {
      meta: {
        traceId,
        createdAt,
        updatedAt,
        eventCount: events.length,
        rootSpanId,
        ...(parentTraceId
          ? {
              derivedFrom: {
                baseTraceId: parentTraceId,
                forkedFromSpanId
              }
            }
          : {}),
        ...(runRow
          ? {
              replayRun: {
                runId: runRow.run_id,
                mode: runRow.mode,
                cassetteRunId: runRow.cassette_run_id ?? undefined,
                sourceTraceId: runRow.parent_trace_id ?? undefined
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

  clearTraceEvents(traceId: string): void {
    this.db.prepare("DELETE FROM events WHERE trace_id = ?").run(traceId);
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
      let pId = row?.parent_trace_id;
      if (!pId) {
        const runRow = this.db
          .prepare("SELECT parent_trace_id FROM replay_runs WHERE trace_id = ? AND parent_trace_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
          .get(rootTraceId) as any;
        pId = runRow?.parent_trace_id;
      }
      if (!pId || pId === rootTraceId) break;
      rootTraceId = pId;
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

      const replayChildren = this.db
        .prepare(
          `
          SELECT trace_id as child_trace_id, parent_trace_id, created_at
          FROM replay_runs
          WHERE parent_trace_id = ? AND trace_id NOT IN (SELECT child_trace_id FROM trace_derivations)
          ORDER BY created_at ASC, trace_id ASC
        `
        )
        .all(current) as any[];

      for (const r of replayChildren) {
        childRows.push({
          child_trace_id: r.child_trace_id,
          parent_trace_id: r.parent_trace_id,
          forked_from_span_id: "root",
          created_at: r.created_at,
          overrides_json: "{}"
        });
      }

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

    let statsDelta: any = undefined;
    let loopDelta: any = undefined;

    try {
      const aStats = this.getTraceStats(aId);
      const bStats = this.getTraceStats(bId);
      statsDelta = {
        totalTokensDelta: (bStats.totalTokens ?? 0) - (aStats.totalTokens ?? 0),
        inputTokensDelta: (bStats.totalInputTokens ?? 0) - (aStats.totalInputTokens ?? 0),
        outputTokensDelta: (bStats.totalOutputTokens ?? 0) - (aStats.totalOutputTokens ?? 0),
        durationDeltaMs: (bStats.totalDurationMs ?? 0) - (aStats.totalDurationMs ?? 0),
        ...(bStats.liveTotalTokens != null ? { liveTokensB: bStats.liveTotalTokens } : {}),
        ...(bStats.savingsPercentage != null ? { savingsPercentageB: bStats.savingsPercentage } : {})
      };
    } catch {
      // Non-blocking if stats unavailable
    }

    try {
      const aAnalysis = this.analyzeTrace(aId);
      const bAnalysis = this.analyzeTrace(bId);
      loopDelta = {
        aLoopCount: aAnalysis.loops.length,
        bLoopCount: bAnalysis.loops.length,
        resolved: aAnalysis.loops.length > 0 && bAnalysis.loops.length === 0
      };
    } catch {
      // Non-blocking if analysis unavailable
    }

    return validateTraceDiffResult({
      ...result,
      ...(statsDelta ? { statsDelta } : {}),
      ...(loopDelta ? { loopDelta } : {})
    });
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

    // Query routing decisions from event_data
    const events = this.db.prepare("SELECT event_data FROM events WHERE trace_id = ?").all(traceId) as any[];
    let cacheHits = 0;
    let liveCalls = 0;
    let unclassifiedWarnings = 0;

    for (const r of events) {
      try {
        const d = JSON.parse(r.event_data);
        if (d.decision === "cache_hit") cacheHits++;
        else if (d.decision === "must_execute" || d.decision === "live_fork" || d.decision === "live_record") liveCalls++;
        if (d.matchedPattern === null && d.decision === "must_execute") {
          unclassifiedWarnings++;
        }
      } catch {
        // ignore
      }
    }

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
      },
      routingSummary: {
        cacheHits,
        liveCalls,
        unclassifiedWarnings
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

    const runRow = this.db
      .prepare("SELECT mode, parent_trace_id FROM replay_runs WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(traceId) as any;

    const derivation = this.db
      .prepare("SELECT parent_trace_id, forked_from_span_id FROM trace_derivations WHERE child_trace_id = ?")
      .get(traceId) as any;

    const executionMode: "record" | "replay" | "fork" = runRow?.mode ?? (derivation ? "fork" : "record");

    // Per-model breakdown from indexed columns
    const modelRows = this.db.prepare(`
      SELECT
        model_name    AS modelName,
        model_provider AS provider,
        COUNT(*)      AS spanCount,
        SUM(usage_input_tokens)  AS inputTokens,
        SUM(usage_output_tokens) AS outputTokens,
        SUM(usage_total_tokens)  AS totalTokens,
        SUM(CASE WHEN replay_source = 'cache' THEN usage_total_tokens ELSE 0 END) AS explicitCachedTokens,
        SUM(CASE WHEN replay_source = 'live' THEN usage_total_tokens ELSE 0 END) AS explicitLiveTokens
      FROM events
      WHERE trace_id = ? AND model_name IS NOT NULL
      GROUP BY model_name, model_provider
      ORDER BY totalTokens DESC NULLS LAST
    `).all(traceId) as any[];

    const modelBreakdown: ModelBreakdownEntry[] = modelRows.map((r) => {
      let mCached: number = 0;
      let mLive: number = r.totalTokens ?? 0;

      if (executionMode === "record") {
        mCached = 0;
        mLive = r.totalTokens ?? 0;
      } else if (executionMode === "replay") {
        mLive = r.explicitLiveTokens ?? 0;
        mCached = Math.max(0, (r.totalTokens ?? 0) - mLive);
      } else if (executionMode === "fork") {
        if (r.explicitCachedTokens > 0) {
          mCached = r.explicitCachedTokens;
          mLive = Math.max(0, (r.totalTokens ?? 0) - mCached);
        } else if (r.explicitLiveTokens > 0) {
          mLive = r.explicitLiveTokens;
          mCached = Math.max(0, (r.totalTokens ?? 0) - mLive);
        } else {
          // Fallback: if no annotations, treat as cached if it matches parent's model
          mCached = r.totalTokens ?? 0;
          mLive = 0;
        }
      }

      return {
        modelName: r.modelName,
        ...(r.provider ? { provider: r.provider } : {}),
        spanCount: r.spanCount,
        ...(r.inputTokens != null ? { inputTokens: r.inputTokens } : {}),
        ...(r.outputTokens != null ? { outputTokens: r.outputTokens } : {}),
        ...(r.totalTokens != null ? { totalTokens: r.totalTokens } : {}),
        cachedTokens: mCached,
        liveTokens: mLive
      };
    });

    let liveInputTokens: number | null = null;
    let liveOutputTokens: number | null = null;
    let liveTotalTokens: number | null = null;
    let cachedInputTokens: number | null = null;
    let cachedOutputTokens: number | null = null;
    let cachedTotalTokens: number | null = null;
    let savingsPercentage: number | null = null;

    if (summary.totalTokens != null) {
      if (executionMode === "record") {
        liveInputTokens = summary.totalInputTokens ?? 0;
        liveOutputTokens = summary.totalOutputTokens ?? 0;
        liveTotalTokens = summary.totalTokens ?? 0;
        cachedInputTokens = 0;
        cachedOutputTokens = 0;
        cachedTotalTokens = 0;
        savingsPercentage = 0;
      } else if (executionMode === "replay") {
        const liveRows = this.db.prepare(`
          SELECT
            SUM(usage_input_tokens)  AS liveInput,
            SUM(usage_output_tokens) AS liveOutput,
            SUM(usage_total_tokens)  AS liveTotal
          FROM events
          WHERE trace_id = ? AND replay_source = 'live'
        `).get(traceId) as any;

        liveInputTokens = liveRows?.liveInput ?? 0;
        liveOutputTokens = liveRows?.liveOutput ?? 0;
        liveTotalTokens = liveRows?.liveTotal ?? 0;

        cachedInputTokens = Math.max(0, (summary.totalInputTokens ?? 0) - (liveInputTokens ?? 0));
        cachedOutputTokens = Math.max(0, (summary.totalOutputTokens ?? 0) - (liveOutputTokens ?? 0));
        cachedTotalTokens = Math.max(0, (summary.totalTokens ?? 0) - (liveTotalTokens ?? 0));

        savingsPercentage = summary.totalTokens > 0
          ? Math.round((cachedTotalTokens / summary.totalTokens) * 100)
          : 100;
      } else if (executionMode === "fork") {
        const cachedRows = this.db.prepare(`
          SELECT
            SUM(usage_input_tokens)  AS cachedInput,
            SUM(usage_output_tokens) AS cachedOutput,
            SUM(usage_total_tokens)  AS cachedTotal
          FROM events
          WHERE trace_id = ? AND replay_source = 'cache'
        `).get(traceId) as any;

        if (cachedRows?.cachedTotal != null && cachedRows.cachedTotal > 0) {
          cachedInputTokens = cachedRows.cachedInput ?? 0;
          cachedOutputTokens = cachedRows.cachedOutput ?? 0;
          cachedTotalTokens = cachedRows.cachedTotal ?? 0;
          liveInputTokens = Math.max(0, (summary.totalInputTokens ?? 0) - (cachedInputTokens ?? 0));
          liveOutputTokens = Math.max(0, (summary.totalOutputTokens ?? 0) - (cachedOutputTokens ?? 0));
          liveTotalTokens = Math.max(0, (summary.totalTokens ?? 0) - (cachedTotalTokens ?? 0));
        } else {
          // If no annotations, check if we have a forkPointSpanId from derivation
          const forkSpan = derivation?.forked_from_span_id;
          if (forkSpan && forkSpan !== "root") {
            const allEvts = this.getTrace(traceId)?.events ?? [];
            const sorted = sortTraceEventsDeterministic(allEvts);
            const forkIdx = sorted.findIndex((e) => e.spanId === forkSpan);
            let preInput = 0, preOutput = 0, preTotal = 0;
            let postInput = 0, postOutput = 0, postTotal = 0;
            sorted.forEach((e: any, idx) => {
              const u = e.payload?.usage;
              if (!u) return;
              if (idx <= forkIdx) {
                preInput += u.inputTokens ?? 0;
                preOutput += u.outputTokens ?? 0;
                preTotal += u.totalTokens ?? 0;
              } else {
                postInput += u.inputTokens ?? 0;
                postOutput += u.outputTokens ?? 0;
                postTotal += u.totalTokens ?? 0;
              }
            });
            cachedInputTokens = preInput;
            cachedOutputTokens = preOutput;
            cachedTotalTokens = preTotal;
            liveInputTokens = postInput;
            liveOutputTokens = postOutput;
            liveTotalTokens = postTotal;
          } else {
            cachedInputTokens = summary.totalInputTokens ?? 0;
            cachedOutputTokens = summary.totalOutputTokens ?? 0;
            cachedTotalTokens = summary.totalTokens ?? 0;
            liveInputTokens = 0;
            liveOutputTokens = 0;
            liveTotalTokens = 0;
          }
        }
        savingsPercentage = summary.totalTokens > 0
          ? Math.round(((cachedTotalTokens ?? 0) / summary.totalTokens) * 100)
          : 0;
      }
    }

    return validateTraceStats({
      traceId,
      traceStartedAt: summary.traceStartedAt ?? null,
      traceEndedAt: summary.traceEndedAt ?? null,
      eventCount: summary.eventCount,
      actorCount,
      totalInputTokens: summary.totalInputTokens ?? null,
      totalOutputTokens: summary.totalOutputTokens ?? null,
      totalTokens: summary.totalTokens ?? null,
      executionMode,
      liveInputTokens,
      liveOutputTokens,
      liveTotalTokens,
      cachedInputTokens,
      cachedOutputTokens,
      cachedTotalTokens,
      savingsPercentage,
      totalDurationMs: summary.totalDurationMs ?? null,
      rootSpanDurationMs: rootSpanRow?.duration_ms ?? null,
      modelBreakdown
    });
  }

  createRun(input: CreateRunInput): string {
    const runId = input.runId || `run_${nanoid(12)}`;
    const stmt = this.db.prepare(`
      INSERT INTO replay_runs (
        run_id, trace_id, parent_trace_id, cassette_run_id,
        mode, status, command_json, project_root,
        virtual_env, executable_path, entrypoint, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'))
    `);
    stmt.run(
      runId,
      input.traceId,
      input.parentTraceId ?? null,
      input.cassetteRunId ?? null,
      input.mode,
      JSON.stringify(input.command),
      input.projectRoot,
      input.virtualEnv ?? null,
      input.executablePath ?? null,
      input.entrypoint ?? null
    );

    if (input.parentTraceId && input.traceId && input.parentTraceId !== input.traceId) {
      try {
        const forkedSpan = (input as any).forkFromSpanId || "root";
        this.db.prepare(`
          INSERT OR IGNORE INTO trace_derivations (
            child_trace_id, parent_trace_id, forked_from_span_id, created_at, overrides_json
          ) VALUES (?, ?, ?, datetime('now'), ?)
        `).run(input.traceId, input.parentTraceId, forkedSpan, "{}");
      } catch {
        // Non-blocking
      }
    }

    return runId;
  }

  saveTraceRuntimeMetadata(input: {
    traceId: string;
    projectRoot: string;
    virtualEnv?: string | null;
    executablePath?: string | null;
    entrypoint?: string | null;
    command?: string[] | string;
  }): void {
    const cmdJson = input.command
      ? JSON.stringify(Array.isArray(input.command) ? input.command : [input.command])
      : null;
    const stmt = this.db.prepare(`
      INSERT INTO trace_runtime_metadata (
        trace_id, project_root, virtual_env, executable_path, entrypoint, command_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(trace_id) DO UPDATE SET
        project_root = excluded.project_root,
        virtual_env = coalesce(excluded.virtual_env, trace_runtime_metadata.virtual_env),
        executable_path = coalesce(excluded.executable_path, trace_runtime_metadata.executable_path),
        entrypoint = coalesce(excluded.entrypoint, trace_runtime_metadata.entrypoint),
        command_json = coalesce(excluded.command_json, trace_runtime_metadata.command_json)
    `);
    stmt.run(
      input.traceId,
      input.projectRoot,
      input.virtualEnv ?? null,
      input.executablePath ?? null,
      input.entrypoint ?? null,
      cmdJson
    );
  }

  getTraceRuntimeMetadata(traceId: string): {
    traceId: string;
    projectRoot: string;
    virtualEnv?: string | null;
    executablePath?: string | null;
    entrypoint?: string | null;
    command?: string[];
  } | null {
    const row = this.db.prepare("SELECT * FROM trace_runtime_metadata WHERE trace_id = ?").get(traceId) as any;
    if (!row) return null;
    let command: string[] | undefined;
    if (row.command_json) {
      try {
        command = JSON.parse(row.command_json);
      } catch {}
    }
    return {
      traceId: row.trace_id,
      projectRoot: row.project_root,
      virtualEnv: row.virtual_env ?? null,
      executablePath: row.executable_path ?? null,
      entrypoint: row.entrypoint ?? null,
      command
    };
  }

  updateRunStatus(runId: string, status: RunStatus, extras?: UpdateRunStatusExtras): void {
    const sets: string[] = ["status = ?"];
    const params: any[] = [status];

    if (extras?.startedAt !== undefined) {
      sets.push("started_at = ?");
      params.push(extras.startedAt);
    }
    if (extras?.completedAt !== undefined) {
      sets.push("completed_at = ?");
      params.push(extras.completedAt);
    }
    if (extras?.exitCode !== undefined) {
      sets.push("exit_code = ?");
      params.push(extras.exitCode);
    }
    if (extras?.errorMessage !== undefined) {
      sets.push("error_message = ?");
      params.push(extras.errorMessage);
    }
    if (extras?.cassetteRunId !== undefined) {
      sets.push("cassette_run_id = ?");
      params.push(extras.cassetteRunId);
    }

    params.push(runId);
    this.db.prepare(`UPDATE replay_runs SET ${sets.join(", ")} WHERE run_id = ?`).run(...params);
  }

  getRunById(runId: string): GetRunResponse | null {
    const row = this.db.prepare("SELECT * FROM replay_runs WHERE run_id = ?").get(runId) as any;
    if (!row) return null;
    return this.mapRunRow(row);
  }

  getRunByTraceId(traceId: string): GetRunResponse | null {
    const row = this.db.prepare("SELECT * FROM replay_runs WHERE trace_id = ? ORDER BY created_at DESC LIMIT 1").get(traceId) as any;
    if (row) return this.mapRunRow(row);

    const meta = this.getTraceRuntimeMetadata(traceId);
    if (meta) {
      return {
        runId: `run_direct_${traceId.replace(/^t_/, "")}`,
        traceId,
        parentTraceId: null,
        cassetteRunId: null,
        status: "completed",
        mode: "record",
        startedAt: null,
        completedAt: null,
        exitCode: 0,
        errorMessage: null,
        command: meta.command,
        projectRoot: meta.projectRoot,
        virtualEnv: meta.virtualEnv ?? null,
        executablePath: meta.executablePath ?? null,
        entrypoint: meta.entrypoint ?? null
      };
    }

    return null;
  }

  listRuns(): GetRunResponse[] {
    const rows = this.db.prepare("SELECT * FROM replay_runs ORDER BY created_at DESC").all() as any[];
    return rows.map((r) => this.mapRunRow(r));
  }

  private mapRunRow(row: any): GetRunResponse {
    let command: string[] | undefined;
    if (row.command_json) {
      try {
        command = JSON.parse(row.command_json);
      } catch {
        // ignore
      }
    }

    return {
      runId: row.run_id,
      traceId: row.trace_id,
      parentTraceId: row.parent_trace_id ?? null,
      cassetteRunId: row.cassette_run_id ?? null,
      status: row.status as RunStatus,
      mode: row.mode as RunMode,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
      exitCode: row.exit_code ?? null,
      errorMessage: row.error_message ?? null,
      command,
      projectRoot: row.project_root,
      virtualEnv: row.virtual_env ?? null,
      executablePath: row.executable_path ?? null,
      entrypoint: row.entrypoint ?? null
    };
  }

  appendReplayAnnotation(traceId: string, spanId: string, annotation: ReplayAnnotationInput): void {
    const row = this.db.prepare("SELECT event_data FROM events WHERE trace_id = ? AND span_id = ?").get(traceId, spanId) as any;
    if (!row) {
      console.warn(`[SqliteTraceStore] appendReplayAnnotation: span ${spanId} not found in trace ${traceId}`);
      return;
    }

    let event: any;
    try {
      event = JSON.parse(row.event_data);
    } catch {
      event = {};
    }

    if (annotation.replaySource !== undefined) event.replaySource = annotation.replaySource;
    if (annotation.requestKey !== undefined) event.requestKey = annotation.requestKey;
    if (annotation.tokensSaved !== undefined) event.tokensSaved = annotation.tokensSaved;
    if (annotation.replayLatencyMs !== undefined) event.replayLatencyMs = annotation.replayLatencyMs;
    if (annotation.streamingPreserved !== undefined) event.streamingPreserved = annotation.streamingPreserved;
    if (annotation.overridden !== undefined) event.overridden = annotation.overridden;
    if (annotation.decision !== undefined) event.decision = annotation.decision;
    if (annotation.matchedPattern !== undefined) event.matchedPattern = annotation.matchedPattern;
    if (annotation.effectiveClass !== undefined) event.effectiveClass = annotation.effectiveClass;
    if (annotation.payloadText !== undefined && annotation.payloadText !== null) {
      if (!event.payload) event.payload = {};
      event.payload.text = annotation.payloadText;
    }

    this.db.prepare(`
      UPDATE events SET
        replay_source = ?,
        replay_request_key = ?,
        replay_tokens_saved = ?,
        replay_latency_ms = ?,
        replay_streaming_preserved = ?,
        replay_overridden = ?,
        event_data = ?
      WHERE trace_id = ? AND span_id = ?
    `).run(
      annotation.replaySource ?? null,
      annotation.requestKey ?? null,
      annotation.tokensSaved ?? null,
      annotation.replayLatencyMs ?? null,
      annotation.streamingPreserved != null ? (annotation.streamingPreserved ? 1 : 0) : null,
      annotation.overridden != null ? (annotation.overridden ? 1 : 0) : null,
      JSON.stringify(event),
      traceId,
      spanId
    );
  }
}
