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
import { TraceAnalyticsPanel } from "./TraceAnalyticsPanel";
import { GlobalFilterBar } from "./GlobalFilterBar";
import { ProjectLineageView } from "./ProjectLineageView";
import type { TraceStats } from "@aerograph/contracts";

export function generateAlias(id: string, prefix = "ID") {
  if (!id) return `${prefix}-Unknown`;
  return `${prefix}-${id.replace(/[-_]/g, "").slice(-5).toUpperCase()}`;
}

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

// ─── LangGraph node kind classifiers ──────────────────────────────────────────
function getLangGraphKind(event: TraceEvent): string | null {
  if (event.kind !== "note") return null;
  return (event as any).payload?.kind ?? null;
}

const LG_KIND_META: Record<string, { icon: string; label: string; color: string; border: string; glow: string }> = {
  langgraph_node: {
    icon: "◈",
    label: "Graph Node",
    color: "rgba(20,184,166,0.08)",
    border: "rgba(20,184,166,0.5)",
    glow: "0 0 14px rgba(20,184,166,0.18)",
  },
  langgraph_internal: {
    icon: "⬡",
    label: "Internal",
    color: "rgba(100,116,139,0.06)",
    border: "rgba(100,116,139,0.25)",
    glow: "none",
  },
  langchain_chain: {
    icon: "⛓",
    label: "Chain",
    color: "rgba(99,130,255,0.05)",
    border: "rgba(99,130,255,0.18)",
    glow: "none",
  },
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
  const lgKind = getLangGraphKind(event);
  const lgMeta = lgKind ? LG_KIND_META[lgKind] : null;

  // Pull a short preview text from the payload
  let preview = "";
  const p = (event as any).payload;
  if (p?.text) preview = String(p.text).slice(0, 60);
  else if (p?.message) preview = String(p.message).slice(0, 60);
  else if (p?.event) preview = String(p.event).slice(0, 60);

  // For LangGraph nodes use the node name as the primary label
  const nodeTitle = lgKind === "langgraph_node" ? (p?.node ?? event.title) : event.title;
  const step = lgKind === "langgraph_node" ? p?.step : null;
  const triggers: string[] = lgKind === "langgraph_node" && Array.isArray(p?.triggers) ? p.triggers : [];

  const bg = isError
    ? "rgba(239,68,68,0.06)"
    : lgMeta
    ? lgMeta.color
    : "rgba(17,24,53,0.95)";

  const borderColor = isError
    ? "rgba(239,68,68,0.5)"
    : lgMeta
    ? lgMeta.border
    : "rgba(99,130,255,0.18)";

  const shadow = isError
    ? "0 0 12px rgba(239,68,68,0.15)"
    : lgMeta
    ? lgMeta.glow
    : "0 4px 16px rgba(0,0,0,0.35)";

  return (
    <div
      style={{
        background: bg,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 10,
        padding: "10px 14px",
        minWidth: 190,
        maxWidth: 240,
        cursor: "pointer",
        fontFamily: "'Inter', sans-serif",
        boxShadow: shadow,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{
          background: lgKind === "langgraph_node" ? "rgba(20,184,166,0.85)" : "rgba(129,140,248,0.85)",
          border: "none",
          width: 6,
          height: 6,
        }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{
          background: lgKind === "langgraph_node" ? "rgba(20,184,166,0.85)" : "rgba(129,140,248,0.85)",
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
          marginBottom: lgKind === "langgraph_node" ? 4 : 6,
        }}
      >
        <span style={{ fontSize: lgKind === "langgraph_node" ? 15 : 13 }}>
          {lgMeta ? lgMeta.icon : meta.icon}
        </span>
        <span
          className={`kind-badge kind-${event.kind}`}
          style={{
            fontSize: 9,
            ...(lgKind === "langgraph_node"
              ? { background: "rgba(20,184,166,0.15)", color: "rgb(20,184,166)", borderColor: "rgba(20,184,166,0.3)" }
              : lgKind === "langgraph_internal"
              ? { background: "rgba(100,116,139,0.15)", color: "rgb(148,163,184)", borderColor: "rgba(100,116,139,0.3)" }
              : {}),
          }}
        >
          {lgMeta ? lgMeta.label : meta.label}
        </span>
        {step != null && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 8,
              color: "rgba(20,184,166,0.7)",
              fontFamily: "'JetBrains Mono', monospace",
              background: "rgba(20,184,166,0.08)",
              padding: "1px 5px",
              borderRadius: 3,
            }}
          >
            step {step}
          </span>
        )}
        {step == null && (
          <span
            className={`status-badge status-${event.status}`}
            style={{ fontSize: 9, marginLeft: "auto" }}
          >
            {event.status === "ok" ? "●" : "✕"} {event.status}
          </span>
        )}
      </div>

      {/* Node name (for langgraph_node) or actor */}
      {lgKind === "langgraph_node" ? (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "rgba(20,184,166,0.9)",
            fontFamily: "'JetBrains Mono', monospace",
            marginBottom: 4,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {nodeTitle}
        </div>
      ) : (
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
      )}

      {/* Triggers chips for langgraph_node */}
      {triggers.length > 0 && (
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 4 }}>
          {triggers.slice(0, 2).map((t: string) => (
            <span
              key={t}
              style={{
                fontSize: 8,
                color: "rgba(148,163,184,0.7)",
                background: "rgba(148,163,184,0.08)",
                borderRadius: 3,
                padding: "1px 4px",
                fontFamily: "'JetBrains Mono', monospace",
                maxWidth: 90,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              ← {t}
            </span>
          ))}
        </div>
      )}

      {/* Preview text for non-langgraph nodes */}
      {!lgMeta && preview && (
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
          color: lgKind === "langgraph_node" ? "rgba(20,184,166,0.4)" : "rgba(99,130,255,0.5)",
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
  // Use the advanced dagre-based graph builder from graph.ts
  const base = buildGraph(events);

  // Map the base nodes (which already have correct dagre positions and filtering)
  let finalNodes: Node[] = base.nodes.map((node) => {
    // The base node data contains the event
    const event = node.data.event as TraceEvent;
    return {
      ...node,
      type: "afrNode",
      data: { event, selected: event.spanId === selectedSpanId },
    };
  });

  // Apply diff and loop highlighting (deterministic: based on set membership)
  if (diffSpanIds && diffSpanIds.size > 0) {
    finalNodes = applyDiffHighlighting(finalNodes, diffSpanIds);
  }
  if (loopSpanIds && loopSpanIds.size > 0) {
    finalNodes = applyLoopHighlighting(finalNodes, loopSpanIds);
  }

  // Preserve the edges exactly as returned by buildGraph to keep Dual-Edge layout styles
  const edges = base.edges;

  return { nodes: finalNodes, edges };
}

// ─── Main App ─────────────────────────────────────────────────────────────────
type Selected = { event: TraceEvent };

function FitViewOnUpdate({ traceId }: { traceId: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (traceId) {
      const timeoutId = setTimeout(() => {
        fitView({ padding: 0.15, maxZoom: 1 });
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [traceId, fitView]);
  return null;
}

function HumanReadableState({ data }: { data: any }) {
  if (!data || typeof data !== "object") return <JsonView data={data} />;
  
  const entries = Object.entries(data);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "8px" }}>
      {entries.map(([key, val]) => {
        // Special case for LangGraph/LangChain messages
        if ((key === "messages" || key === "history") && Array.isArray(val)) {
          return (
            <div key={key}>
              <div style={{ fontWeight: 600, fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", textTransform: "uppercase" }}>{key}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {val.map((msg: any, i: number) => {
                  let role = "Unknown";
                  let content = "";
                  if (typeof msg === "object" && msg !== null) {
                    if (msg.type === "constructor" && msg.id && Array.isArray(msg.id)) {
                      role = msg.id[msg.id.length - 1].replace("Message", "");
                      content = typeof msg.kwargs?.content === "string" ? msg.kwargs.content : JSON.stringify(msg.kwargs?.content || msg.kwargs, null, 2);
                    } else if (msg.type === "human" || msg.type === "ai" || msg.type === "system" || msg.type === "tool") {
                      role = msg.type.charAt(0).toUpperCase() + msg.type.slice(1);
                      content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || msg, null, 2);
                    } else {
                      role = msg.role || msg.type || "Message";
                      content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || msg, null, 2);
                    }
                  } else {
                    content = String(msg);
                  }
                  
                  const isHuman = role.toLowerCase() === "human" || role.toLowerCase() === "user";
                  const isAI = role.toLowerCase() === "ai" || role.toLowerCase() === "assistant";
                  
                  return (
                    <div key={i} style={{
                      padding: "8px 12px",
                      borderRadius: "6px",
                      background: isHuman ? "rgba(59,130,246,0.1)" : isAI ? "rgba(20,184,166,0.1)" : "rgba(100,116,139,0.1)",
                      border: `1px solid ${isHuman ? "rgba(59,130,246,0.2)" : isAI ? "rgba(20,184,166,0.2)" : "rgba(100,116,139,0.2)"}`,
                      fontSize: "12px",
                      lineHeight: "1.5"
                    }}>
                      <div style={{ fontWeight: 700, marginBottom: "4px", fontSize: "10px", color: isHuman ? "rgb(59,130,246)" : isAI ? "rgb(20,184,166)" : "rgb(148,163,184)", textTransform: "uppercase" }}>{role}</div>
                      <div style={{ whiteSpace: "pre-wrap", fontFamily: "var(--font-sans)", wordBreak: "break-word" }}>{content}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }
        
        // Default rendering for other keys
        return (
          <div key={key}>
            <div style={{ fontWeight: 600, fontSize: "11px", color: "var(--text-muted)", marginBottom: "4px", textTransform: "uppercase" }}>{key}</div>
            <div style={{ 
              padding: "8px 12px", 
              background: "rgba(0,0,0,0.2)", 
              border: "1px solid rgba(255,255,255,0.05)",
              borderRadius: "6px",
              fontSize: "11px",
              fontFamily: "var(--font-mono)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all"
            }}>
              {typeof val === "string" ? val : JSON.stringify(val, null, 2)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CollapsibleSection({ title, defaultOpen = true, children, titleColor = "var(--text-primary)" }: any) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="detail-section" style={{ border: "1px solid rgba(255,255,255,0.05)", borderRadius: "6px", overflow: "hidden", marginBottom: "8px" }}>
      <div 
        onClick={() => setIsOpen(!isOpen)}
        style={{ display: "flex", alignItems: "center", gap: "6px", padding: "8px 12px", background: "rgba(255,255,255,0.02)", cursor: "pointer", userSelect: "none" }}
      >
        <div style={{ fontSize: "10px", color: "var(--text-muted)", transition: "transform 0.2s", transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▼</div>
        <div className="detail-section-label" style={{ margin: 0, color: titleColor }}>{title}</div>
      </div>
      {isOpen && (
        <div style={{ padding: "12px", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          {children}
        </div>
      )}
    </div>
  );
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
  const [analyticsOpen, setAnalyticsOpen] = useState(true);
  const [loopWarningsOpen, setLoopWarningsOpen] = useState(true);
  const [filterProjectId, setFilterProjectId] = useState(() => localStorage.getItem("aero_filterProjectId") || "");
  const [filterEnvironment, setFilterEnvironment] = useState("");
  const [stateViewMode, setStateViewMode] = useState<"human" | "raw">("human");

  useEffect(() => {
    if (filterProjectId) localStorage.setItem("aero_filterProjectId", filterProjectId);
    else localStorage.removeItem("aero_filterProjectId");
  }, [filterProjectId]);
  const [viewMode, setViewMode] = useState<"projects" | "trace" | "lineage">("projects");

  useEffect(() => {
    if (filterProjectId) setViewMode("trace");
    else setViewMode("projects");
  }, [filterProjectId]);

  const uniqueProjects = useMemo(() => {
    const projs = new Set<string>();
    traces.forEach(t => { if (t.projectId) projs.add(t.projectId); });
    return Array.from(projs);
  }, [traces]);

  useEffect(() => {
    if (isDark) document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  }, [isDark]);

  const [playbackCursor, setPlaybackCursor] = useState<number>(-1);
  const [diffResult, setDiffResult] = useState<TraceDiffResult | null>(null);
  const [compareTargetId, setCompareTargetId] = useState<string>("");
  const [analysis, setAnalysis] = useState<TraceAnalysis | null>(null);
  const [traceStats, setTraceStats] = useState<TraceStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
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
      const res = await api.listTraces({
        projectId: filterProjectId || undefined,
        environment: filterEnvironment || undefined
      });
      setTraces(res.traces);
      if (!traceId && res.traces[0]) {
        setTraceId(res.traces[0].traceId);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [api, traceId, filterProjectId, filterEnvironment]);

  const loadTrace = useCallback(
    async (id: string, isBackgroundRefresh = false) => {
      if (!id) return;
      try {
        if (!isBackgroundRefresh) {
          setError("");
          setDiffResult(null);
          setCompareTargetId("");
          setTraceStats(null);
          setStatsLoading(true);
        }
        
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

        if (!isBackgroundRefresh) {
          setStatsLoading(true);
        }
        
        api.getStats(id)
          .then(setTraceStats)
          .catch(() => { if (!isBackgroundRefresh) setTraceStats(null); })
          .finally(() => { if (!isBackgroundRefresh) setStatsLoading(false); });
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    },
    [api],
  );

  useEffect(() => {
    refreshTraces();
  }, [refreshTraces]);
  useEffect(() => {
    loadTrace(traceId);
    setSelected(null);
  }, [traceId]);

  // Polling
  useEffect(() => {
    if (!liveUpdating) return;
    const id = setInterval(() => {
      refreshTraces();
      // Pass `true` so the function knows it's a stealth background update
      if (traceId) loadTrace(traceId, true);
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
        alert(`Fork ID Generated!\n\nCopy this ID:\n${res.traceId}\n\nPaste it into your FlightRecorder initialization in your code to resume your agent from this point.`);
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

    // For LangGraph Nodes, find the associated chain_end event to show state_update
    let stateUpdate = p.state_update;
    let endPayload: any = null;
    if (e.kind === "note" && p?.kind === "langgraph_node" && !stateUpdate) {
      const endEvent = events.find((ev: any) => ev.parentSpanId === e.spanId && ev.payload?.event === "chain_end");
      if (endEvent) {
         endPayload = (endEvent as any).payload;
         stateUpdate = endPayload?.state_update;
      }
    }

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
          <div className="trace-meta-id">{generateAlias(e.spanId, "Span")}</div>
        </div>

        <div className="detail-body">
          {/* Metadata */}
          <CollapsibleSection title="Span Info">
            <div className="kv-grid">
              {[
                ["project", (e as any).projectId || "—"],
                ["env", (e as any).environment || "—"],
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
            <details style={{ marginTop: 12, cursor: "pointer" }}>
              <summary style={{ fontSize: 11, color: "var(--text-muted)" }}>Advanced Details (Raw IDs)</summary>
              <div className="kv-grid" style={{ marginTop: 8, padding: "8px", background: "rgba(0,0,0,0.2)", borderRadius: 4 }}>
                <div className="kv-row"><span className="kv-key">trace id</span><span className="kv-val">{e.traceId}</span></div>
                <div className="kv-row"><span className="kv-key">span id</span><span className="kv-val">{e.spanId}</span></div>
                <div className="kv-row"><span className="kv-key">parent id</span><span className="kv-val">{e.parentSpanId ?? "— root"}</span></div>
              </div>
            </details>
          </CollapsibleSection>

          {/* Text content if present */}
          {p.text && (
            <CollapsibleSection title="Content">
              <div className="kv-val-text">{p.text}</div>
            </CollapsibleSection>
          )}
          {p.message && (
            <CollapsibleSection title="Message" titleColor="var(--red)">
              <div className="kv-val-text" style={{ color: "var(--red)" }}>
                {p.message}
              </div>
            </CollapsibleSection>
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
              {forkInProgress ? "Forking…" : "⑂ Generate Fork ID"}
            </button>
          </div>

          <div className="divider" />

          {/* T017: span-level model + usage display */}
          {(p?.model?.name || p?.usage?.totalTokens != null || (e as any).durationMs != null) && (
            <CollapsibleSection title="Trace Timing & Tokens">
              <div className="kv-grid">
                {p?.model?.name && (
                  <div className="kv-row">
                    <span className="kv-key">model</span>
                    <span className="kv-val" style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>
                      {p.model.name}{p.model.provider ? ` · ${p.model.provider}` : ""}
                    </span>
                  </div>
                )}
                {p?.model?.version != null && (
                  <div className="kv-row">
                    <span className="kv-key">version</span>
                    <span className="kv-val">{p.model.version}</span>
                  </div>
                )}
                {p?.usage?.totalTokens != null && (
                  <div className="kv-row">
                    <span className="kv-key">tokens total</span>
                    <span className="kv-val">{p.usage.totalTokens.toLocaleString()}</span>
                  </div>
                )}
                {p?.usage?.inputTokens != null && (
                  <div className="kv-row">
                    <span className="kv-key">tokens in</span>
                    <span className="kv-val">{p.usage.inputTokens.toLocaleString()}</span>
                  </div>
                )}
                {p?.usage?.outputTokens != null && (
                  <div className="kv-row">
                    <span className="kv-key">tokens out</span>
                    <span className="kv-val">{p.usage.outputTokens.toLocaleString()}</span>
                  </div>
                )}
                {(e as any).durationMs != null && (
                  <div className="kv-row">
                    <span className="kv-key">duration</span>
                    <span className="kv-val">{(e as any).durationMs} ms</span>
                  </div>
                )}
              </div>
            </CollapsibleSection>
          )}

          <div className="divider" />

          {e.kind === "state_snapshot" ? (
            <StateInspector event={e} />
          ) : e.kind === "retriever" ? (
            <RetrieverInspector event={e} />
          ) : e.kind === "checkpoint" ? (
            <CheckpointView event={e} />
          ) : e.kind === "note" && p?.kind === "langgraph_node" ? (
            // ── LangGraph Node Inspector ──────────────────────────────────────
            <>
              <div className="detail-section">
                <div className="detail-section-label" style={{ color: "rgb(20,184,166)" }}>
                  ◈ LangGraph Node {p.event === "chain_end" ? "(End)" : ""}
                </div>
                <div className="kv-grid">
                  <div className="kv-row">
                    <span className="kv-key">node</span>
                    <span className="kv-val" style={{ fontFamily: "var(--font-mono)", color: "rgb(20,184,166)", fontWeight: 600 }}>
                      {p.node}
                    </span>
                  </div>
                  {p.step != null && (
                    <div className="kv-row">
                      <span className="kv-key">step</span>
                      <span className="kv-val">{p.step}</span>
                    </div>
                  )}
                  {Array.isArray(p.triggers) && p.triggers.length > 0 && (
                    <div className="kv-row">
                      <span className="kv-key">triggered by</span>
                      <span className="kv-val" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                        {(p.triggers as string[]).join(" → ")}
                      </span>
                    </div>
                  )}
                  {Array.isArray(p.path) && p.path.length > 0 && (
                    <div className="kv-row">
                      <span className="kv-key">path</span>
                      <span className="kv-val" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>
                        {(p.path as string[]).join(" / ")}
                      </span>
                    </div>
                  )}
                  {p.checkpointNs && (
                    <div className="kv-row">
                      <span className="kv-key">checkpoint ns</span>
                      <span className="kv-val" style={{ fontFamily: "var(--font-mono)", fontSize: 10 }}>{p.checkpointNs}</span>
                    </div>
                  )}
                </div>
              </div>
              
              {(p.state_before || stateUpdate) && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: "16px", marginBottom: "8px" }}>
                  <div className="detail-section-label" style={{ margin: 0 }}>State Views</div>
                  <div style={{ display: "flex", gap: "4px", background: "rgba(0,0,0,0.2)", padding: "2px", borderRadius: "4px" }}>
                    <button 
                      onClick={() => setStateViewMode("human")}
                      style={{ 
                        border: "none", 
                        background: stateViewMode === "human" ? "rgba(255,255,255,0.1)" : "transparent",
                        color: stateViewMode === "human" ? "#fff" : "rgba(255,255,255,0.5)",
                        padding: "4px 8px",
                        fontSize: "10px",
                        borderRadius: "3px",
                        cursor: "pointer",
                        fontWeight: stateViewMode === "human" ? 600 : 400
                      }}
                    >
                      Human Readable
                    </button>
                    <button 
                      onClick={() => setStateViewMode("raw")}
                      style={{ 
                        border: "none", 
                        background: stateViewMode === "raw" ? "rgba(255,255,255,0.1)" : "transparent",
                        color: stateViewMode === "raw" ? "#fff" : "rgba(255,255,255,0.5)",
                        padding: "4px 8px",
                        fontSize: "10px",
                        borderRadius: "3px",
                        cursor: "pointer",
                        fontWeight: stateViewMode === "raw" ? 600 : 400
                      }}
                    >
                      Raw JSON
                    </button>
                  </div>
                </div>
              )}

              {p.state_before && (
                <>
                  <div className="divider" />
                  <CollapsibleSection title="State Before (Inputs)" titleColor="rgb(20,184,166)">
                    {stateViewMode === "human" ? <HumanReadableState data={p.state_before} /> : <JsonView data={p.state_before} />}
                  </CollapsibleSection>
                </>
              )}
              
              {stateUpdate && (
                <>
                  <div className="divider" />
                  <CollapsibleSection title="State Update (Outputs)" titleColor="rgb(20,184,166)">
                    {stateViewMode === "human" ? <HumanReadableState data={stateUpdate} /> : <JsonView data={stateUpdate} />}
                  </CollapsibleSection>
                </>
              )}

              <div className="divider" />
              <CollapsibleSection title="Raw Payload" defaultOpen={false}>
                <div style={{ marginBottom: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>Start Payload</div>
                <JsonView data={p} />
                {endPayload && (
                  <>
                    <div style={{ marginTop: 12, marginBottom: 8, fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>End Payload</div>
                    <JsonView data={endPayload} />
                  </>
                )}
              </CollapsibleSection>
            </>
          ) : (
            <>
              {e.kind === "response" && p?.streamingTelemetry && (
                <StreamingMetrics event={e} />
              )}
              <CollapsibleSection title="Raw Payload">
                <JsonView data={p} />
              </CollapsibleSection>
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
          <div className="header-logo" style={{ width: "50px", height: "50px", overflow: "hidden", border: "none", background: "transparent" }}>
            <img src="https://res.cloudinary.com/decbdlnqg/image/upload/v1782286461/aerograph-logo_2_uwysko.png" alt="Logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
          </div>
          <span className="title">AeroGraph</span>
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

          {viewMode !== "projects" && (
            <div style={{ display: "flex", gap: "8px", marginRight: "16px" }}>
              <button
                className={`btn ${viewMode === "trace" ? "btn-primary" : ""}`}
                onClick={() => setViewMode("trace")}
              >
                Trace Graph
              </button>
              <button
                className={`btn ${viewMode === "lineage" ? "btn-primary" : ""}`}
                onClick={() => setViewMode("lineage")}
              >
                Project Lineage
              </button>
            </div>
          )}

          {/* Theme toggle */}
          <button
            className="theme-toggle btn"
            onClick={() => setIsDark(!isDark)}
            title="Toggle theme"
          >
            {isDark ? "☀️" : "🌙"}
          </button>

          {/* Delete Trace */}
          {traceId && viewMode === "trace" && (
            <button
              className="btn btn-danger"
              style={{ background: "var(--bg-error, #ef4444)", color: "#fff", borderColor: "var(--border-error, #dc2626)" }}
              onClick={async () => {
                if (window.confirm("Are you sure you want to delete this trace? This action cannot be undone.")) {
                  try {
                    await api.deleteTrace(traceId);
                    setTraceId("");
                    refreshTraces();
                  } catch (err: any) {
                    setError(err.message ?? "Failed to delete trace");
                  }
                }
              }}
              title="Delete Trace"
            >
              🗑️ Delete Trace
            </button>
          )}

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
      {viewMode === "projects" ? (
        <main className="main" style={{ display: "flex", flexDirection: "column", padding: 40, alignItems: "center", overflowY: "auto", background: "var(--bg-base)" }}>
          <h2 style={{ color: "var(--text-primary)", marginBottom: 24, fontSize: 24 }}>Select a Project Workspace</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "center", maxWidth: 800 }}>
            {uniqueProjects.length === 0 && <div style={{ color: "var(--text-muted)" }}>No projects found in database.</div>}
            {uniqueProjects.map(proj => (
              <div 
                key={proj}
                onClick={() => { setFilterProjectId(proj); setViewMode("trace"); }}
                style={{ 
                  background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", 
                  padding: "24px 32px", borderRadius: 8, cursor: "pointer", minWidth: 200,
                  textAlign: "center", transition: "all 0.2s"
                }}
                onMouseOver={(e) => e.currentTarget.style.borderColor = "var(--accent)"}
                onMouseOut={(e) => e.currentTarget.style.borderColor = "var(--border-subtle)"}
              >
                <div style={{ fontSize: 18, color: "var(--text-primary)", fontWeight: "bold" }}>{proj}</div>
              </div>
            ))}
          </div>
        </main>
      ) : (
      <main className="main" style={{ gridTemplateColumns: `${leftSidebarOpen ? '280px' : '0px'} 1fr ${rightSidebarOpen ? '380px' : '0px'}`, transition: 'grid-template-columns 0.3s ease' }}>
        {/* Left Sidebar: Traces */}
        <aside className="side side-left">
          <div className="side-header" style={{ padding: "16px" }}>
            <span className="side-title">Traces</span>
          </div>
          <GlobalFilterBar
            projectId={filterProjectId}
            environment={filterEnvironment}
            onFilterChange={(filters) => {
              setFilterProjectId(filters.projectId);
              setFilterEnvironment(filters.environment);
            }}
            onClearProject={() => setFilterProjectId("")}
          />
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
            {(() => {
              const activeTraces = traces.filter(t => !t.isDeleted);
              const traceMap = new Set(activeTraces.map(t => t.traceId));
              const rootTraces = activeTraces.filter(t => !t.derivedFrom?.baseTraceId || !traceMap.has(t.derivedFrom.baseTraceId));
              const childrenByParent: Record<string, TraceMeta[]> = {};
              activeTraces.forEach(t => {
                if (t.derivedFrom?.baseTraceId && traceMap.has(t.derivedFrom.baseTraceId)) {
                  childrenByParent[t.derivedFrom.baseTraceId] = childrenByParent[t.derivedFrom.baseTraceId] || [];
                  childrenByParent[t.derivedFrom.baseTraceId].push(t);
                }
              });

              const renderTrace = (t: TraceMeta, depth = 0) => {
                const alias = generateAlias(t.traceId, "Trace");
                const searchTerms = traceSearch.toLowerCase();
                const matchesSearch = t.traceId.toLowerCase().includes(searchTerms) || alias.toLowerCase().includes(searchTerms);
                const children = childrenByParent[t.traceId] || [];

                return (
                  <div key={t.traceId}>
                    <div 
                      className={`trace-list-item ${t.traceId === traceId ? "active" : ""}`}
                      onClick={() => setTraceId(t.traceId)}
                      style={{ paddingLeft: `${12 + depth * 16}px`, display: matchesSearch || searchTerms === "" ? "flex" : "none", flexDirection: "column", alignItems: "flex-start" }}
                    >
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "13px", color: "var(--text-primary)", fontWeight: depth === 0 ? "bold" : "normal" }}>
                        {depth > 0 ? "↳ " : ""}{alias}
                      </div>
                      <div style={{ fontSize: "11px", color: "var(--text-muted)" }}>
                        {t.eventCount} events {t.environment ? ` · ${t.environment}` : ""}
                      </div>
                    </div>
                    {children.map(child => renderTrace(child, depth + 1))}
                  </div>
                );
              };
              return rootTraces.map(t => renderTrace(t, 0));
            })()}
          </div>
        </aside>
        {/* Graph canvas */}
        <section className="graph">
          {viewMode === "lineage" ? (
            <ProjectLineageView 
              traces={traces} 
              onSelectTrace={(id) => {
                setTraceId(id);
                setViewMode("trace");
              }} 
            />
          ) : (
            <>
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
                <FitViewOnUpdate traceId={traceId} />
                <Background color={isDark ? "#334155" : "#e2e8f0"} variant={BackgroundVariant.Dots} gap={24} size={1} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </>
          )}

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

          {/* T016: Analytics panel */}
          <div 
            className="side-header hover:bg-bg-hover transition-colors" 
            style={{ cursor: "pointer", userSelect: "none", borderTop: "1px solid var(--border-subtle)" }} 
            onClick={() => setAnalyticsOpen(!analyticsOpen)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="side-title">Analytics</span>
              <span style={{ fontSize: "10px", color: "var(--text-muted)", transition: "transform 0.3s", transform: analyticsOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
            </div>
          </div>
          <div
            className={`accordion-content ${analyticsOpen ? "open" : ""}`}
            style={{ borderBottom: analyticsOpen ? "1px solid var(--border-subtle)" : "none" }}
          >
            <div className="accordion-inner">
              <TraceAnalyticsPanel stats={traceStats} loading={statsLoading} />
            </div>
          </div>

          {/* T044: Loop warnings panel */}
          <div 
            className="side-header hover:bg-bg-hover transition-colors" 
            style={{ cursor: "pointer", userSelect: "none", borderTop: "1px solid var(--border-subtle)" }} 
            onClick={() => setLoopWarningsOpen(!loopWarningsOpen)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
              <span className="side-title">Loop Warnings</span>
              {analysis && analysis.loops.length > 0 && (
                <button
                  className="btn"
                  onClick={(e) => { e.stopPropagation(); jumpToFirstLoop(); }}
                  style={{ fontSize: 11, marginLeft: "auto", marginRight: 8 }}
                >
                  Jump to first
                </button>
              )}
              <span style={{ fontSize: "10px", color: "var(--text-muted)", transition: "transform 0.3s", transform: loopWarningsOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
            </div>
          </div>
          <div
            className={`accordion-content ${loopWarningsOpen ? "open" : ""}`}
            style={{ borderBottom: loopWarningsOpen ? "1px solid var(--border-subtle)" : "none" }}
          >
            <div className="accordion-inner">
            {!analysis || analysis.loops.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "14px 16px" }}>
                No loop warnings detected
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 16px" }}>
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
      )}
    </div>
  );
}
