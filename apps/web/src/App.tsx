import { useEffect, useMemo, useState, useCallback } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Handle,
  Position,
  useReactFlow,
  type NodeTypes,
  type Node,
  type Edge,
} from "reactflow";
import {
  sortTraceEventsDeterministic,
  type TraceEvent,
  type TraceLineageGraph,
  type TraceMeta,
  type TraceDiffResult,
  type TraceAnalysis,
} from "@aerograph/contracts";
import { createApi } from "./api";
import {
  buildGraph,
  computePlaybackState,
  applyDiffHighlighting,
  applyLoopHighlighting,
} from "./graph";
import {
  buildLineageBreadcrumb,
  getForkPointSpanId,
  listSiblingTraceIds,
} from "./lineage";
import { getDiffChangedSpanIds } from "./diff";
import { getLoopWarningSpanIds, getFirstLoopSpanId } from "./loops";
import { StateInspector } from "./StateInspector";
import { StreamingMetrics } from "./StreamingMetrics";
import { RetrieverInspector } from "./RetrieverInspector";
import { CheckpointView } from "./CheckpointView";
import { JsonView } from "./JsonView";

// ─── Kind icons + colors ───────────────────────────────────────────────────────
const KIND_META: Record<string, { icon: string; label: string }> = {
  prompt: { icon: "💬", label: "Prompt" },
  response: { icon: "✨", label: "Response" },
  tool_call: { icon: "🔧", label: "Tool Call" },
  tool_result: { icon: "📦", label: "Tool Result" },
  error: { icon: "⚠️", label: "Error" },
  handoff: { icon: "🔀", label: "Handoff" },
  note: { icon: "📝", label: "Note" },
  state_snapshot: { icon: "💾", label: "State" },
  retriever: { icon: "🔎", label: "Retriever" },
  checkpoint: { icon: "⏸️", label: "Checkpoint" },
};

// ─── Custom Node Component ─────────────────────────────────────────────────────
function TraceNode({
  data,
}: {
  data: { event: TraceEvent; selected?: boolean };
}) {
  const { event } = data;
  const meta = KIND_META[event.kind] ?? { icon: "◉", label: event.kind };
  const isError = event.status === "error";

  // Pull a short preview text from the payload
  let preview = "";
  const p = (event as any).payload;
  if (p?.text) preview = String(p.text).slice(0, 60);
  else if (p?.message) preview = String(p.message).slice(0, 60);
  else if (p?.event) preview = String(p.event).slice(0, 60);

  return (
    <div
      style={{
        background: isError ? "rgba(239,68,68,0.06)" : "rgba(17,24,53,0.95)",
        border: `1px solid ${isError ? "rgba(239,68,68,0.5)" : "rgba(99,130,255,0.18)"}`,
        borderRadius: 10,
        padding: "10px 14px",
        minWidth: 190,
        maxWidth: 240,
        cursor: "pointer",
        fontFamily: "'Inter', sans-serif",
        boxShadow: isError
          ? "0 0 12px rgba(239,68,68,0.15)"
          : "0 4px 16px rgba(0,0,0,0.35)",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: "rgba(129,140,248,0.85)",
          border: "none",
          width: 6,
          height: 6,
        }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: "rgba(129,140,248,0.85)",
          border: "none",
          width: 6,
          height: 6,
        }}
      />

      {/* Kind badge row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 13 }}>{meta.icon}</span>
        <span
          className={`kind-badge kind-${event.kind}`}
          style={{ fontSize: 9 }}
        >
          {meta.label}
        </span>
        <span
          className={`status-badge status-${event.status}`}
          style={{ fontSize: 9, marginLeft: "auto" }}
        >
          {event.status === "ok" ? "●" : "✕"} {event.status}
        </span>
      </div>

      {/* Actor */}
      <div
        style={{
          fontSize: 10,
          color: "rgba(148,163,184,0.7)",
          fontFamily: "'JetBrains Mono', monospace",
          marginBottom: 4,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {(event as any).actor?.name ?? (event as any).actor?.id ?? ""}
      </div>

      {/* Preview text */}
      {preview && (
        <div
          style={{
            fontSize: 11,
            color: "#cbd5e1",
            lineHeight: 1.45,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            wordBreak: "break-word",
          }}
        >
          {preview}
          {preview.length >= 60 ? "…" : ""}
        </div>
      )}

      {/* Timestamp */}
      <div
        style={{
          marginTop: 7,
          fontSize: 9,
          color: "rgba(99,130,255,0.5)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {new Date(event.occurredAt).toLocaleTimeString()}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = { afrNode: TraceNode };

// ─── Graph builder override (uses custom node type) ───────────────────────────
function buildPremiumGraph(
  events: TraceEvent[],
  selectedSpanId: string | null,
  diffSpanIds?: Set<string>,
  loopSpanIds?: Set<string>,
): { nodes: Node[]; edges: Edge[] } {
  const base = buildGraph(events);
  const spacing = { x: 270, y: 140 };

  // Layout: place nodes in a top-down tree using BFS from roots
  const childrenOf: Record<string, string[]> = {};
  const parentOf: Record<string, string | null> = {};
  events.forEach((e) => {
    parentOf[e.spanId] = e.parentSpanId ?? null;
    if (e.parentSpanId) {
      childrenOf[e.parentSpanId] = childrenOf[e.parentSpanId] ?? [];
      childrenOf[e.parentSpanId].push(e.spanId);
    }
  });

  const roots = events.filter((e) => !e.parentSpanId).map((e) => e.spanId);
  const positions: Record<string, { x: number; y: number }> = {};
  let col = 0;

  function placeSubtree(
    spanId: string,
    depth: number,
    colOffset: number,
  ): number {
    const children = childrenOf[spanId] ?? [];
    if (children.length === 0) {
      positions[spanId] = { x: colOffset * spacing.x, y: depth * spacing.y };
      return colOffset + 1;
    }
    let nextCol = colOffset;
    children.forEach((child) => {
      nextCol = placeSubtree(child, depth + 1, nextCol);
    });
    const firstChildX = positions[children[0]].x;
    const lastChildX = positions[children[children.length - 1]].x;
    positions[spanId] = {
      x: (firstChildX + lastChildX) / 2,
      y: depth * spacing.y,
    };
    return nextCol;
  }

  roots.forEach((r) => {
    col = placeSubtree(r, 0, col);
  });

  // Fall back to linear for any event not placed (e.g., orphan spans)
  events.forEach((e, i) => {
    if (!positions[e.spanId]) {
      positions[e.spanId] = { x: 0, y: i * spacing.y };
    }
  });

  let finalNodes: Node[] = events.map((event) => ({
    id: event.spanId,
    position: positions[event.spanId] ?? { x: 0, y: 0 },
    type: "afrNode",
    data: { event, selected: event.spanId === selectedSpanId },
  }));

  // Apply diff and loop highlighting (deterministic: based on set membership)
  if (diffSpanIds && diffSpanIds.size > 0) {
    finalNodes = applyDiffHighlighting(finalNodes, diffSpanIds);
  }
  if (loopSpanIds && loopSpanIds.size > 0) {
    finalNodes = applyLoopHighlighting(finalNodes, loopSpanIds);
  }

  const edges: Edge[] = base.edges.map((e) => ({
    ...e,
    animated: true,
    style: {
      stroke: "rgba(129,140,248,0.85)",
      strokeWidth: 2.5,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "rgba(129,140,248,0.9)",
      width: 16,
      height: 16,
    },
  }));

  return { nodes: finalNodes, edges };
}

// ─── Main App ─────────────────────────────────────────────────────────────────
type Selected = { event: TraceEvent };

function FitViewOnUpdate({ nodesCount }: { nodesCount: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (nodesCount > 0) {
      const timeoutId = setTimeout(() => {
        fitView({ padding: 0.15, maxZoom: 1 });
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [nodesCount, fitView]);
  return null;
}

export default function App() {
  const api = useMemo(() => createApi(), []);

  const [traces, setTraces] = useState<TraceMeta[]>([]);
  const [traceId, setTraceId] = useState<string>("");
  const [activeMeta, setActiveMeta] = useState<TraceMeta | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [lineage, setLineage] = useState<TraceLineageGraph | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [error, setError] = useState<string>("");
  const [liveUpdating, setLiveUpdating] = useState(true);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [traceSearch, setTraceSearch] = useState("");
  const [isDark, setIsDark] = useState(true); 
  const [lineageOpen, setLineageOpen] = useState(false);

  useEffect(() => {
    if (isDark) document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  }, [isDark]);

  const [playbackCursor, setPlaybackCursor] = useState<number>(-1);
  const [diffResult, setDiffResult] = useState<TraceDiffResult | null>(null);
  const [compareTargetId, setCompareTargetId] = useState<string>("");
  const [analysis, setAnalysis] = useState<TraceAnalysis | null>(null);
  const [forkInProgress, setForkInProgress] = useState(false);

  const diffSpanIds = useMemo(
    () => (diffResult ? getDiffChangedSpanIds(diffResult) : new Set<string>()),
    [diffResult],
  );
  const loopSpanIds = useMemo(
    () => (analysis ? getLoopWarningSpanIds(analysis) : new Set<string>()),
    [analysis],
  );

  const visibleEvents = useMemo(() => {
    if (playbackCursor === -1 || playbackCursor >= events.length) return events;
    return computePlaybackState(events, playbackCursor);
  }, [events, playbackCursor]);

  const graph = useMemo(
    () =>
      buildPremiumGraph(
        visibleEvents,
        selected?.event.spanId ?? null,
        diffSpanIds,
        loopSpanIds,
      ),
    [visibleEvents, selected, diffSpanIds, loopSpanIds],
  );

  const refreshTraces = useCallback(async () => {
    try {
      setError("");
      const res = await api.listTraces();
      setTraces(res.traces);
      if (!traceId && res.traces[0]) {
        setTraceId(res.traces[0].traceId);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [api, traceId]);

  const loadTrace = useCallback(
    async (id: string) => {
      if (!id) return;
      try {
        setError("");
        setDiffResult(null);
        setCompareTargetId("");
        const [trace, lineageGraph, analysisResult] = await Promise.all([
          api.getTrace(id),
          api.getLineage(id).catch(() => null),
          api.getAnalysis(id).catch(() => null),
        ]);
        setActiveMeta(trace.meta);
        setLineage(lineageGraph);
        setEvents(trace.events);
        setAnalysis(analysisResult);
        setPlaybackCursor((prev) => {
          if (prev === -1) return -1;
          const maxIndex = trace.events.length - 1;
          if (maxIndex < 0) return -1;
          return Math.min(prev, maxIndex);
        });
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    },
    [api],
  );

  useEffect(() => {
    refreshTraces();
  }, []);
  useEffect(() => {
    loadTrace(traceId);
    setSelected(null);
  }, [traceId]);

  // Polling
  useEffect(() => {
    if (!liveUpdating) return;
    const id = setInterval(() => {
      refreshTraces();
      if (traceId) loadTrace(traceId);
    }, 2000);
    return () => clearInterval(id);
  }, [liveUpdating, traceId, refreshTraces, loadTrace]);

  const currentStep =
    playbackCursor === -1 ? events.length : playbackCursor + 1;
  const totalSteps = events.length;

  const forkPointSpanId = useMemo(() => {
    if (activeMeta?.derivedFrom?.forkedFromSpanId)
      return activeMeta.derivedFrom.forkedFromSpanId;
    if (lineage && traceId) return getForkPointSpanId(lineage, traceId);
    return null;
  }, [activeMeta, lineage, traceId]);

  const jumpToForkPoint = useCallback(() => {
    if (!forkPointSpanId) return;
    const sorted = sortTraceEventsDeterministic(events);
    const idx = sorted.findIndex((e) => e.spanId === forkPointSpanId);
    if (idx >= 0) setPlaybackCursor(idx);
  }, [events, forkPointSpanId]);

  const loadDiff = useCallback(
    async (compareId: string) => {
      if (!traceId || !compareId) return;
      try {
        setError("");
        const result = await api.getDiff(traceId, compareId);
        setDiffResult(result);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    },
    [api, traceId],
  );

  const jumpToFirstLoop = useCallback(() => {
    if (!analysis) return;
    const firstSpanId = getFirstLoopSpanId(analysis);
    if (!firstSpanId) return;
    const sorted = sortTraceEventsDeterministic(events);
    const idx = sorted.findIndex((e) => e.spanId === firstSpanId);
    if (idx >= 0) setPlaybackCursor(idx);
  }, [analysis, events]);

  // ── Fork from a specific span ─────────────────────────────────────────────
  const doForkFromSpan = useCallback(
    async (spanId: string) => {
      if (!traceId || forkInProgress) return;
      setForkInProgress(true);
      try {
        setError("");
        const res = await api.forkTrace(traceId, { forkFromSpanId: spanId });
        // Refresh trace list then switch to new child trace
        await refreshTraces();
        setTraceId(res.traceId);
      } catch (e: any) {
        setError(`Fork failed: ${e?.message ?? String(e)}`);
      } finally {
        setForkInProgress(false);
      }
    },
    [api, traceId, forkInProgress, refreshTraces],
  );

  // ── Sidebar detail renderer ────────────────────────────────────────────────
  const renderDetail = () => {
    if (!selected) {
      return (
        <div className="side-empty">
          <span className="side-empty-icon"></span>
          <div>
            Click a node in the graph
            <br />
            to inspect its payload
          </div>
        </div>
      );
    }
    const e = selected.event;
    const p = (e as any).payload ?? {};
    return (
      <>
        {/* Meta strip */}
        <div className="trace-meta-strip">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`kind-badge kind-${e.kind}`}>
              {KIND_META[e.kind]?.icon} {KIND_META[e.kind]?.label ?? e.kind}
            </span>
            <span className={`status-badge status-${e.status}`}>
              {e.status}
            </span>
          </div>
          <div className="trace-meta-id">{e.spanId}</div>
        </div>

        <div className="detail-body">
          {/* Metadata */}
          <div className="detail-section">
            <div className="detail-section-label">Span Info</div>
            <div className="kv-grid">
              {[
                ["trace", e.traceId],
                ["parent", e.parentSpanId ?? "— root"],
                [
                  "actor",
                  `${(e as any).actor?.kind} · ${(e as any).actor?.name ?? (e as any).actor?.id}`,
                ],
                [
                  "time",
                  new Date(e.occurredAt).toLocaleTimeString([], {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    fractionalSecondDigits: 3,
                  }),
                ],
              ].map(([k, v]) => (
                <div className="kv-row" key={k}>
                  <span className="kv-key">{k}</span>
                  <span className="kv-val">{v}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Text content if present */}
          {p.text && (
            <div className="detail-section">
              <div className="detail-section-label">Content</div>
              <div className="kv-val-text">{p.text}</div>
            </div>
          )}
          {p.message && (
            <div className="detail-section">
              <div className="detail-section-label">Message</div>
              <div className="kv-val-text" style={{ color: "var(--red)" }}>
                {p.message}
              </div>
            </div>
          )}

          <div className="divider" />

          {/* Fork from this span */}
          <div className="detail-section">
            <div className="detail-section-label">Actions</div>
            <button
              className="btn btn-fork"
              disabled={forkInProgress}
              onClick={() => doForkFromSpan(e.spanId)}
              title={`Fork trace from span ${e.spanId}`}
            >
              {forkInProgress ? "Forking…" : "⑂ Fork from here"}
            </button>
          </div>

          <div className="divider" />

          {e.kind === "state_snapshot" ? (
            <StateInspector event={e} />
          ) : e.kind === "retriever" ? (
            <RetrieverInspector event={e} />
          ) : e.kind === "checkpoint" ? (
            <CheckpointView event={e} />
          ) : (
            <>
              {e.kind === "response" && p?.streamingTelemetry && (
                <StreamingMetrics event={e} />
              )}
              <div className="detail-section">
                <div className="detail-section-label">Raw Payload</div>
                <JsonView data={p} />
              </div>
            </>
          )}
        </div>
      </>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="layout">
      {/* Header */}
      <header className="header">
        <div className="header-brand">
          <div className="header-logo" style={{ overflow: "hidden", border: "none", background: "transparent" }}>
            <img src="https://res.cloudinary.com/decbdlnqg/image/upload/v1781969113/Logo_8_1_axs9mt.png" alt="Logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          </div>
          <span className="title">AeroGraph</span>
          <span className="title-badge">Phase 2</span>
        </div>

        <div className="controls">
          {/* Live toggle */}
          <label className="live-toggle">
            <input
              type="checkbox"
              checked={liveUpdating}
              onChange={(e) => setLiveUpdating(e.target.checked)}
            />
            <span className={`live-dot ${liveUpdating ? "active" : ""}`} />
            {liveUpdating ? "Live" : "Paused"}
          </label>

          {/* Dark Mode butoon */}
          <button
            className="btn"
            onClick={() => setIsDark(!isDark)}
            title="Toggle Dark Mode"
          >
            {isDark ? "☀️ Light" : "🌙 Dark"}
          </button>

          {/* Refresh */}
          <button
            className="btn btn-accent"
            onClick={() => {
              refreshTraces();
              if (traceId) loadTrace(traceId);
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </header>

      {/* Error bar */}
      {error && <div className="error">⚠ {error}</div>}

      {/* Body */}
      <main className="main" style={{ gridTemplateColumns: `${leftSidebarOpen ? '280px' : '0px'} 1fr ${rightSidebarOpen ? '380px' : '0px'}`, transition: 'grid-template-columns 0.3s ease' }}>
        {/* Left Sidebar: Traces */}
        <aside className="side side-left">
          <div className="side-header" style={{ padding: "16px" }}>
            <span className="side-title">Traces</span>
          </div>
          <div style={{ padding: "12px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-surface)" }}>
            <input 
              type="text" 
              placeholder="Search traces..." 
              value={traceSearch}
              onChange={(e) => setTraceSearch(e.target.value)}
              style={{
                width: "100%", padding: "6px 10px", borderRadius: "4px", 
                border: "1px solid var(--border-subtle)", background: "var(--bg-base)",
                color: "var(--text-primary)", fontSize: "12px", fontFamily: "var(--font-sans)",
                outline: "none"
              }}
            />
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {traces.filter(t => t.traceId.toLowerCase().includes(traceSearch.toLowerCase())).map(t => (
              <div 
                key={t.traceId} 
                className={`trace-list-item ${t.traceId === traceId ? "active" : ""}`}
                onClick={() => setTraceId(t.traceId)}
              >
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-primary)" }}>
                  {t.traceId.slice(0, 22)}...
                </div>
                <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                  {t.eventCount} events
                </div>
              </div>
            ))}
          </div>
        </aside>
        {/* Graph canvas */}
        <section className="graph">
          <button 
            className={`sidebar-toggle-btn sidebar-toggle-left ${!leftSidebarOpen ? 'closed' : ''}`}
            onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
            title="Toggle Traces Sidebar"
          >
            {leftSidebarOpen ? '◀' : '▶'}
          </button>
          
          <button 
            className={`sidebar-toggle-btn sidebar-toggle-right ${!rightSidebarOpen ? 'closed' : ''}`}
            onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
            title="Toggle Inspector Sidebar"
          >
            {rightSidebarOpen ? '▶' : '◀'}
          </button>

          {/* Playback controls */}
          <div className="playback-controls">
            <button
              className="playback-btn"
              disabled={currentStep <= 1}
              onClick={() =>
                setPlaybackCursor((p) => (p === -1 ? events.length - 2 : p - 1))
              }
              title="Step backward"
            >
              ‹
            </button>
            <div className="playback-counter">
              <span>{currentStep}</span> / {totalSteps}
            </div>
            <button
              className="playback-btn"
              disabled={
                playbackCursor === -1 || playbackCursor >= events.length - 1
              }
              onClick={() =>
                setPlaybackCursor((p) => (p >= events.length - 1 ? -1 : p + 1))
              }
              title="Step forward"
            >
              ›
            </button>
            <button
              className="playback-live"
              onClick={() => setPlaybackCursor(-1)}
            >
              LIVE
            </button>
          </div>

          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => {
              const event = events.find((e) => e.spanId === node.id);
              if (event) setSelected({ event });
            }}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <FitViewOnUpdate nodesCount={graph.nodes.length} />
            <Background
              variant={BackgroundVariant.Dots}
              gap={28}
              size={1}
              color="rgba(99,130,255,0.06)"
            />
            <Controls showInteractive={false} />
          </ReactFlow>
        </section>

        {/* Sidebar */}
        <aside className="side side-right">
          <div 
            className="side-header hover:bg-bg-hover transition-colors" 
            style={{ cursor: "pointer", userSelect: "none" }} 
            onClick={() => setLineageOpen(!lineageOpen)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="side-title">Lineage</span>
              <span style={{ fontSize: "10px", color: "var(--text-muted)", transition: "transform 0.3s", transform: lineageOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
            </div>
            {forkPointSpanId && (
              <button 
                className="btn" 
                onClick={(e) => { e.stopPropagation(); jumpToForkPoint(); }}
              >
                Jump to fork
              </button>
            )}
          </div>
          <div
            className={`accordion-content ${lineageOpen ? "open" : ""}`}
            style={{ borderBottom: lineageOpen ? "1px solid var(--border-subtle)" : "none" }}
          >
            <div className="accordion-inner">
              <div
                style={{
                  padding: "14px 16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                <div>
              <div className="detail-section-label">Breadcrumb</div>
              {!lineage || !traceId ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  —
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {buildLineageBreadcrumb(lineage, traceId).map((id) => (
                    <button
                      key={id}
                      className="btn"
                      disabled={id === traceId}
                      onClick={() => setTraceId(id)}
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        maxWidth: 150,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={id}
                    >
                      {id.slice(0, 14)}…
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="detail-section-label">Siblings</div>
              {!lineage || !traceId ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  —
                </div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {listSiblingTraceIds(lineage, traceId).length === 0 ? (
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      None
                    </div>
                  ) : (
                    listSiblingTraceIds(lineage, traceId).map((id) => (
                      <button
                        key={id}
                        className="btn"
                        onClick={() => setTraceId(id)}
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                        title={id}
                      >
                        {id}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <div>
              <div className="detail-section-label">Derived From</div>
              {!activeMeta?.derivedFrom ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  —
                </div>
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    fontFamily: "'JetBrains Mono', monospace",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div>base: {activeMeta.derivedFrom.baseTraceId}</div>
                  <div>forkSpan: {activeMeta.derivedFrom.forkedFromSpanId}</div>
                </div>
              )}
            </div>

            {/* T032: Diff compare UI */}
            <div>
              <div className="detail-section-label">Compare with</div>
              {!traceId ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  —
                </div>
              ) : (
                (() => {
                  // Show lineage siblings first; fall back to all other traces
                  const lineageOptions = lineage
                    ? lineage.nodes.filter((n) => n.traceId !== traceId)
                    : [];
                  const allOtherOptions = traces.filter(
                    (t) => t.traceId !== traceId,
                  );
                  const useOptions =
                    lineageOptions.length > 0
                      ? lineageOptions.map((n) => ({ traceId: n.traceId }))
                      : allOtherOptions;
                  return (
                    <>
                      {lineageOptions.length === 0 &&
                        allOtherOptions.length > 0 && (
                          <div
                            style={{
                              fontSize: 10,
                              color: "var(--text-muted)",
                              marginBottom: 6,
                              fontStyle: "italic",
                            }}
                          >
                            No forks yet — comparing against any trace
                          </div>
                        )}
                      {useOptions.length === 0 ? (
                        <div
                          style={{ fontSize: 12, color: "var(--text-muted)" }}
                        >
                          No other traces. Run demo first.
                        </div>
                      ) : (
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <select
                            id="diff-compare-select"
                            className="trace-select"
                            value={compareTargetId}
                            onChange={(e) => setCompareTargetId(e.target.value)}
                            style={{ fontSize: 11 }}
                          >
                            <option value="">— pick a branch —</option>
                            {useOptions.map((n) => (
                              <option key={n.traceId} value={n.traceId}>
                                {n.traceId.slice(0, 18)}…
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn btn-accent"
                            disabled={!compareTargetId}
                            onClick={() => loadDiff(compareTargetId)}
                            style={{ fontSize: 11, padding: "4px 10px" }}
                          >
                            Diff
                          </button>
                          {diffResult && (
                            <button
                              className="btn"
                              onClick={() => setDiffResult(null)}
                              style={{ fontSize: 11 }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()
              )}
              {diffResult && (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  {diffResult.changed.length === 0
                    ? "✓ No differences"
                    : `${diffResult.changed.length} change${diffResult.changed.length !== 1 ? "s" : ""}`}
                  {diffResult.divergence?.forkPointSpanId && (
                    <div style={{ marginTop: 4 }}>
                      Diverges at:{" "}
                      <code style={{ fontSize: 10 }}>
                        {diffResult.divergence.forkPointSpanId}
                      </code>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          </div>
          </div>

          {/* T044: Loop warnings panel */}
          <div className="side-header">
            <span className="side-title">Loop Warnings</span>
            {analysis && analysis.loops.length > 0 && (
              <button
                className="btn"
                onClick={jumpToFirstLoop}
                style={{ fontSize: 11 }}
              >
                Jump to first
              </button>
            )}
          </div>
          <div
            style={{
              padding: "14px 16px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            {!analysis || analysis.loops.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                No loop warnings detected
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {analysis.loops.map((w, i) => (
                  <div
                    key={i}
                    style={{
                      background: "rgba(139,92,246,0.08)",
                      border: "1px solid rgba(139,92,246,0.25)",
                      borderRadius: 6,
                      padding: "8px 10px",
                      fontSize: 11,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "center",
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 9,
                          padding: "2px 6px",
                          borderRadius: 3,
                          background:
                            w.severity === "high"
                              ? "rgba(239,68,68,0.2)"
                              : w.severity === "medium"
                                ? "rgba(245,158,11,0.2)"
                                : "rgba(139,92,246,0.2)",
                          color:
                            w.severity === "high"
                              ? "#ef4444"
                              : w.severity === "medium"
                                ? "#f59e0b"
                                : "#8b5cf6",
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                        }}
                      >
                        {w.severity}
                      </span>
                      <span
                        style={{ color: "rgba(148,163,184,0.7)", fontSize: 9 }}
                      >
                        {w.kind}
                      </span>
                    </div>
                    <div
                      style={{
                        color: "var(--text-secondary)",
                        lineHeight: 1.4,
                      }}
                    >
                      {w.reason}
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        color: "rgba(148,163,184,0.5)",
                        fontSize: 9,
                      }}
                    >
                      {w.spanIds.length} span{w.spanIds.length !== 1 ? "s" : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="side-header">
            <span className="side-title">Inspector</span>
            {activeMeta && (
              <div className="trace-meta-row">
                <span className="trace-stat">
                  <span className="trace-stat-num">
                    {activeMeta.eventCount}
                  </span>{" "}
                  events
                </span>
              </div>
            )}
          </div>
          {renderDetail()}
        </aside>
      </main>
    </div>
  );
}
