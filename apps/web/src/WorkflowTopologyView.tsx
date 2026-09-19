import React, { useMemo, useState, useEffect, useCallback } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  useReactFlow,
  type NodeTypes,
  type Node
} from "reactflow";
import "reactflow/dist/style.css";
import type { TraceEvent } from "@aerograph/contracts";
import {
  buildTopologyGraph,
  buildTrajectoryPathGraph,
  type TopologyNodeData,
  type StateIteration
} from "./topology";
import { WorkflowTopologyNode } from "./WorkflowTopologyNode";
import {
  CompassIcon,
  NetworkIcon,
  PathIcon,
  LoopIcon,
  AlertTriangleIcon,
  CheckIcon
} from "./icons";

const nodeTypes: NodeTypes = {
  topologyNode: WorkflowTopologyNode
};

function AutoFitOnViewChange({ keyProp }: { keyProp: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const timer = setTimeout(() => {
      // Constrain fitView so nodes NEVER shrink to unreadable dots
      fitView({ padding: 0.18, minZoom: 0.75, maxZoom: 1.05 });
    }, 60);
    return () => clearTimeout(timer);
  }, [keyProp, fitView]);
  return null;
}

export interface WorkflowTopologyViewProps {
  events: TraceEvent[];
  traceId: string;
  isDark: boolean;
  onSelectSpanId?: (spanId: string) => void;
}

type FilterKind = "all" | "errors" | "agent" | "tool";

export function WorkflowTopologyView({
  events,
  traceId,
  isDark,
  onSelectSpanId
}: WorkflowTopologyViewProps) {
  const [viewType, setViewType] = useState<"graph" | "path">("graph");
  const [graphOrientation, setGraphOrientation] = useState<"LR" | "TB">("LR");
  const [activeFilter, setActiveFilter] = useState<FilterKind>("all");

  const [selectedStateKey, setSelectedStateKey] = useState<string | null>(null);
  const [focusedStateKey, setFocusedStateKey] = useState<string | null>(null);
  const [selectedIterationIndex, setSelectedIterationIndex] = useState<number>(0);

  // Trajectory step index
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);

  // Compute graph based on viewType and orientation
  const { nodes: rawNodes, edges, summary } = useMemo(() => {
    if (viewType === "path") {
      return buildTrajectoryPathGraph(events, selectedStateKey, 4);
    }
    return buildTopologyGraph(events, selectedStateKey, focusedStateKey, graphOrientation);
  }, [events, viewType, selectedStateKey, focusedStateKey, graphOrientation]);

  // Apply node kind / error filtering
  const nodes = useMemo(() => {
    if (activeFilter === "all") return rawNodes;
    return rawNodes.map((n) => {
      let matches = true;
      if (activeFilter === "errors") matches = n.data.errorCount > 0;
      else if (activeFilter === "agent") matches = n.data.kind === "agent";
      else if (activeFilter === "tool") matches = n.data.kind === "tool";

      return {
        ...n,
        data: {
          ...n.data,
          isDimmed: !matches,
          isHighlighted: matches && !n.data.selected
        }
      };
    });
  }, [rawNodes, activeFilter]);

  // Selected node data for iteration drill-down
  const selectedNode = useMemo(() => {
    if (!selectedStateKey) return null;
    const found = nodes.find((n) => n.id === selectedStateKey || n.data.id === selectedStateKey);
    return found?.data ?? null;
  }, [nodes, selectedStateKey]);

  // Auto-select latest iteration when a new node is selected
  useEffect(() => {
    if (selectedNode && selectedNode.iterations && selectedNode.iterations.length > 0) {
      const latestIndex = selectedNode.iterations.length - 1;
      setSelectedIterationIndex(latestIndex);
      if (onSelectSpanId) {
        onSelectSpanId(selectedNode.iterations[latestIndex].spanId);
      }
    }
  }, [selectedNode?.id]);

  // Handle Trajectory Step Navigation
  const handleStepJump = useCallback((index: number) => {
    if (index >= 0 && index < nodes.length) {
      setCurrentStepIndex(index);
      const targetNode = nodes[index];
      if (targetNode) {
        setSelectedStateKey(targetNode.id);
        if (targetNode.data.spanIds[0] && onSelectSpanId) {
          onSelectSpanId(targetNode.data.spanIds[targetNode.data.spanIds.length - 1]);
        }
      }
    }
  }, [nodes, onSelectSpanId]);

  // Escape key clears selection and focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedStateKey(null);
        setFocusedStateKey(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!events || events.length === 0 || nodes.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          gap: 14,
          color: "var(--text-muted, #94a3b8)"
        }}
      >
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: "14px",
            background: "rgba(56, 189, 248, 0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#38bdf8"
          }}
        >
          <CompassIcon size={26} color="#38bdf8" />
        </div>
        <div style={{ fontSize: "16px", fontWeight: 700, color: "#f8fafc" }}>
          No Workflow Topology Available
        </div>
        <div style={{ fontSize: "13px", maxWidth: 360, textAlign: "center", lineHeight: 1.5, color: "#94a3b8" }}>
          This trace does not contain enough events to construct a topology graph or trajectory storyboard.
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Top Controls Toolbar: Docked at top-left to NEVER overlap center replay/fork banners */}
      <div
        style={{
          position: "absolute",
          top: 14,
          left: 16,
          zIndex: 25,
          background: isDark ? "rgba(15, 23, 42, 0.94)" : "rgba(255, 255, 255, 0.96)",
          backdropFilter: "blur(14px)",
          border: isDark ? "1px solid rgba(255, 255, 255, 0.16)" : "1px solid rgba(0, 0, 0, 0.14)",
          borderRadius: 10,
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 12,
          color: isDark ? "#f8fafc" : "#1e293b",
          boxShadow: isDark
            ? "0 8px 24px rgba(0, 0, 0, 0.55)"
            : "0 6px 18px rgba(0, 0, 0, 0.1)"
        }}
      >
        {/* Title */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 800 }}>
          <CompassIcon size={15} color="#38bdf8" />
          <span style={{ letterSpacing: "-0.01em" }}>Workflow Topology</span>
        </div>

        <div style={{ height: 16, width: 1, background: "var(--border-subtle, rgba(255,255,255,0.18))" }} />

        {/* View Mode Toggle (State Graph vs Trajectory Path) */}
        <div
          style={{
            display: "flex",
            background: isDark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.06)",
            borderRadius: 6,
            padding: 2,
            gap: 2
          }}
        >
          <button
            onClick={() => {
              setViewType("graph");
              setSelectedStateKey(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              border: "none",
              background: viewType === "graph" ? (isDark ? "#1e293b" : "#ffffff") : "transparent",
              color: viewType === "graph" ? "#38bdf8" : "#94a3b8",
              padding: "4px 9px",
              borderRadius: 5,
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: viewType === "graph" ? "0 1px 4px rgba(0,0,0,0.3)" : "none",
              transition: "all 0.15s ease"
            }}
            title="State Machine DAG with aggregated loops"
          >
            <NetworkIcon size={12} color={viewType === "graph" ? "#38bdf8" : "currentColor"} />
            <span>State Graph</span>
          </button>

          <button
            onClick={() => {
              setViewType("path");
              setSelectedStateKey(null);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              border: "none",
              background: viewType === "path" ? (isDark ? "#1e293b" : "#ffffff") : "transparent",
              color: viewType === "path" ? "#38bdf8" : "#94a3b8",
              padding: "4px 9px",
              borderRadius: 5,
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
              boxShadow: viewType === "path" ? "0 1px 4px rgba(0,0,0,0.3)" : "none",
              transition: "all 0.15s ease"
            }}
            title="Storyboard multi-column trajectory steps"
          >
            <PathIcon size={12} color={viewType === "path" ? "#38bdf8" : "currentColor"} />
            <span>Trajectory Path</span>
          </button>
        </div>

        {/* Orientation Toggle (Only in State Graph) */}
        {viewType === "graph" && (
          <div
            style={{
              display: "flex",
              background: isDark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.06)",
              borderRadius: 6,
              padding: 2,
              gap: 2
            }}
          >
            <button
              onClick={() => setGraphOrientation("LR")}
              style={{
                border: "none",
                background: graphOrientation === "LR" ? (isDark ? "#1e293b" : "#ffffff") : "transparent",
                color: graphOrientation === "LR" ? "#38bdf8" : "#94a3b8",
                padding: "3px 7px",
                borderRadius: 4,
                fontSize: "10px",
                fontWeight: 700,
                cursor: "pointer"
              }}
              title="Horizontal landscape layout (recommended for widescreen)"
            >
              LR
            </button>
            <button
              onClick={() => setGraphOrientation("TB")}
              style={{
                border: "none",
                background: graphOrientation === "TB" ? (isDark ? "#1e293b" : "#ffffff") : "transparent",
                color: graphOrientation === "TB" ? "#38bdf8" : "#94a3b8",
                padding: "3px 7px",
                borderRadius: 4,
                fontSize: "10px",
                fontWeight: 700,
                cursor: "pointer"
              }}
              title="Vertical column layout"
            >
              TB
            </button>
          </div>
        )}

        <div style={{ height: 16, width: 1, background: "var(--border-subtle, rgba(255,255,255,0.18))" }} />

        {/* Node Filters */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {(["all", "errors", "agent", "tool"] as FilterKind[]).map((f) => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              style={{
                border: activeFilter === f ? "1px solid rgba(56, 189, 248, 0.4)" : "1px solid transparent",
                background: activeFilter === f ? "rgba(56, 189, 248, 0.15)" : "transparent",
                color: activeFilter === f ? "#38bdf8" : "#94a3b8",
                padding: "2px 7px",
                borderRadius: 4,
                fontSize: "10px",
                fontWeight: 700,
                cursor: "pointer",
                textTransform: "capitalize"
              }}
            >
              {f === "errors" ? "Failures" : f}
            </button>
          ))}
        </div>

        <div style={{ height: 16, width: 1, background: "var(--border-subtle, rgba(255,255,255,0.18))" }} />

        {/* Metrics Counters */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "11px" }}>
          <div>
            <span style={{ color: "#94a3b8" }}>States: </span>
            <span style={{ fontWeight: 700, fontFamily: "var(--font-mono, monospace)" }}>
              {summary.totalStates}
            </span>
          </div>

          <div>
            <span style={{ color: "#94a3b8" }}>Transitions: </span>
            <span style={{ fontWeight: 700, fontFamily: "var(--font-mono, monospace)" }}>
              {summary.totalTransitions}
            </span>
          </div>

          {summary.totalLoops > 0 && viewType === "graph" && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <LoopIcon size={11} color="#c084fc" />
              <span style={{ color: "#c084fc", fontWeight: 700 }}>
                {summary.totalLoops} cycles
              </span>
            </div>
          )}

          {summary.hasErrors && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                color: "#f87171",
                background: "rgba(239, 68, 68, 0.18)",
                padding: "2px 7px",
                borderRadius: 4,
                fontWeight: 700,
                fontSize: "10px"
              }}
            >
              <AlertTriangleIcon size={11} color="#f87171" />
              <span>Failures</span>
            </div>
          )}

          {/* Clear Focus / Reset Selection Button */}
          {(selectedStateKey || focusedStateKey) && (
            <>
              <div style={{ height: 16, width: 1, background: "var(--border-subtle, rgba(255,255,255,0.18))" }} />
              <button
                onClick={() => {
                  setSelectedStateKey(null);
                  setFocusedStateKey(null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  border: "1px solid rgba(239, 68, 68, 0.35)",
                  background: "rgba(239, 68, 68, 0.12)",
                  color: "#fca5a5",
                  padding: "3px 8px",
                  borderRadius: 5,
                  fontSize: "10.5px",
                  fontWeight: 700,
                  cursor: "pointer",
                  transition: "all 0.15s ease"
                }}
                title="Clear selection and reset node focus (Esc)"
              >
                <span>✕</span>
                <span>Reset Focus</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* ReactFlow Canvas */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node: Node<TopologyNodeData>) => {
          if (selectedStateKey === node.id) {
            // Re-clicking the selected node toggles selection and focus off!
            setSelectedStateKey(null);
            setFocusedStateKey(null);
          } else {
            setSelectedStateKey(node.id);
            setFocusedStateKey(node.id);
            if (node.data.spanIds && node.data.spanIds.length > 0 && onSelectSpanId) {
              const latestSpanId = node.data.spanIds[node.data.spanIds.length - 1];
              onSelectSpanId(latestSpanId);
            }
          }
        }}
        onPaneClick={() => {
          // Clicking empty canvas resets both selection and dimmed focus
          setSelectedStateKey(null);
          setFocusedStateKey(null);
        }}
        fitView
        fitViewOptions={{ padding: 0.18, minZoom: 0.75, maxZoom: 1.05 }}
        minZoom={0.5}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
      >
        <AutoFitOnViewChange keyProp={`${traceId}-${viewType}-${graphOrientation}`} />
        <Background
          color={isDark ? "#334155" : "#cbd5e1"}
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
        />
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* Trajectory Step Scrubber Bar (Only in Path View) */}
      {viewType === "path" && nodes.length > 1 && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            background: isDark ? "rgba(15, 23, 42, 0.94)" : "rgba(255, 255, 255, 0.96)",
            backdropFilter: "blur(14px)",
            border: "1px solid rgba(56, 189, 248, 0.35)",
            borderRadius: 10,
            padding: "8px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            boxShadow: "0 8px 28px rgba(0, 0, 0, 0.5)"
          }}
        >
          <button
            onClick={() => handleStepJump(currentStepIndex - 1)}
            disabled={currentStepIndex <= 0}
            style={{
              border: "1px solid rgba(255, 255, 255, 0.14)",
              background: currentStepIndex <= 0 ? "transparent" : "rgba(255, 255, 255, 0.08)",
              color: currentStepIndex <= 0 ? "#64748b" : "#f8fafc",
              padding: "4px 10px",
              borderRadius: 5,
              fontSize: "11px",
              fontWeight: 700,
              cursor: currentStepIndex <= 0 ? "not-allowed" : "pointer"
            }}
          >
            ◀ Prev Step
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: "11px", color: "#94a3b8" }}>Step</span>
            <span style={{ fontSize: "13px", fontWeight: 800, color: "#38bdf8", fontFamily: "var(--font-mono)" }}>
              {currentStepIndex + 1}
            </span>
            <span style={{ fontSize: "11px", color: "#94a3b8" }}>of {nodes.length}</span>
            {nodes[currentStepIndex] && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  color: "#f8fafc",
                  background: "rgba(56, 189, 248, 0.12)",
                  padding: "2px 8px",
                  borderRadius: 4,
                  border: "1px solid rgba(56, 189, 248, 0.25)"
                }}
              >
                {nodes[currentStepIndex].data.label}
              </span>
            )}
          </div>

          <button
            onClick={() => handleStepJump(currentStepIndex + 1)}
            disabled={currentStepIndex >= nodes.length - 1}
            style={{
              border: "1px solid rgba(255, 255, 255, 0.14)",
              background: currentStepIndex >= nodes.length - 1 ? "transparent" : "rgba(255, 255, 255, 0.08)",
              color: currentStepIndex >= nodes.length - 1 ? "#64748b" : "#f8fafc",
              padding: "4px 10px",
              borderRadius: 5,
              fontSize: "11px",
              fontWeight: 700,
              cursor: currentStepIndex >= nodes.length - 1 ? "not-allowed" : "pointer"
            }}
          >
            Next Step ▶
          </button>
        </div>
      )}

      {/* Iteration Drilldown Drawer (Arize "Debug Loops" Feature in State Graph) */}
      {viewType === "graph" && selectedNode && selectedNode.iterations && selectedNode.iterations.length > 1 && (
        <div
          style={{
            position: "absolute",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            background: isDark ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.96)",
            backdropFilter: "blur(14px)",
            border: "1px solid rgba(168, 85, 247, 0.35)",
            borderRadius: 10,
            padding: "8px 14px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            boxShadow: "0 8px 28px rgba(0, 0, 0, 0.5)",
            maxWidth: "90%",
            overflowX: "auto"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <LoopIcon size={13} color="#c084fc" />
            <span style={{ fontSize: "11px", fontWeight: 700, color: "#c084fc" }}>
              {selectedNode.label}
            </span>
            <span style={{ fontSize: "11px", color: "var(--text-muted, #94a3b8)" }}>
              ({selectedNode.iterations.length} runs):
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto" }}>
            {selectedNode.iterations.map((iter: StateIteration, idx: number) => {
              const isCurrent = idx === selectedIterationIndex;
              const hasErr = iter.status === "error";

              return (
                <button
                  key={iter.spanId}
                  onClick={() => {
                    setSelectedIterationIndex(idx);
                    if (onSelectSpanId) onSelectSpanId(iter.spanId);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    border: isCurrent
                      ? "1.5px solid #38bdf8"
                      : hasErr
                      ? "1px solid rgba(239, 68, 68, 0.4)"
                      : "1px solid var(--border-subtle, rgba(255,255,255,0.12))",
                    background: isCurrent
                      ? "rgba(56, 189, 248, 0.15)"
                      : hasErr
                      ? "rgba(239, 68, 68, 0.1)"
                      : isDark
                      ? "rgba(30, 41, 59, 0.6)"
                      : "rgba(241, 245, 249, 0.8)",
                    color: isCurrent
                      ? "#38bdf8"
                      : hasErr
                      ? "#f87171"
                      : "var(--text-primary, #f8fafc)",
                    padding: "3px 8px",
                    borderRadius: 6,
                    fontSize: "10px",
                    fontWeight: 600,
                    fontFamily: "var(--font-mono, monospace)",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    transition: "all 0.15s ease"
                  }}
                  title={`Jump to run #${idx + 1} (${iter.durationMs}ms)`}
                >
                  {hasErr ? (
                    <AlertTriangleIcon size={10} color="#f87171" />
                  ) : (
                    <CheckIcon size={10} color="#4ade80" />
                  )}
                  <span>Run #{idx + 1}</span>
                  {iter.durationMs > 0 && (
                    <span style={{ color: "var(--text-muted, #64748b)", fontSize: "9px" }}>
                      {iter.durationMs}ms
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <span
            style={{
              fontSize: "10px",
              color: "var(--text-muted, #64748b)",
              whiteSpace: "nowrap",
              flexShrink: 0
            }}
          >
            Click any run to inspect payload
          </span>
        </div>
      )}
    </div>
  );
}
