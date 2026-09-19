import React, { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { TopologyNodeData } from "./topology";
import {
  AgentIcon,
  ToolIcon,
  RetrieverIcon,
  ModelIcon,
  CheckpointIcon,
  StateIcon,
  LoopIcon,
  ClockIcon,
  CheckIcon,
  AlertTriangleIcon
} from "./icons";

const KIND_CONFIG: Record<
  TopologyNodeData["kind"],
  {
    IconComponent: React.ComponentType<{ size?: number; color?: string }>;
    label: string;
    bg: string;
    border: string;
    color: string;
  }
> = {
  agent: {
    IconComponent: AgentIcon,
    label: "AGENT",
    bg: "rgba(99, 102, 241, 0.16)",
    border: "rgba(99, 102, 241, 0.45)",
    color: "#818cf8"
  },
  tool: {
    IconComponent: ToolIcon,
    label: "TOOL",
    bg: "rgba(245, 158, 11, 0.16)",
    border: "rgba(245, 158, 11, 0.45)",
    color: "#fbbf24"
  },
  retriever: {
    IconComponent: RetrieverIcon,
    label: "RETRIEVER",
    bg: "rgba(6, 182, 212, 0.16)",
    border: "rgba(6, 182, 212, 0.45)",
    color: "#22d3ee"
  },
  llm: {
    IconComponent: ModelIcon,
    label: "MODEL",
    bg: "rgba(236, 72, 153, 0.16)",
    border: "rgba(236, 72, 153, 0.45)",
    color: "#f472b6"
  },
  checkpoint: {
    IconComponent: CheckpointIcon,
    label: "CHECKPOINT",
    bg: "rgba(168, 85, 247, 0.16)",
    border: "rgba(168, 85, 247, 0.45)",
    color: "#c084fc"
  },
  state: {
    IconComponent: StateIcon,
    label: "STATE",
    bg: "rgba(148, 163, 184, 0.16)",
    border: "rgba(148, 163, 184, 0.45)",
    color: "#94a3b8"
  }
};

export const WorkflowTopologyNode = memo(function WorkflowTopologyNode({
  data
}: NodeProps<TopologyNodeData>) {
  const config = KIND_CONFIG[data.kind] || KIND_CONFIG.state;
  const Icon = config.IconComponent;
  const isMultiRun = data.invocations > 1;
  const hasError = data.errorCount > 0;
  const isSelected = Boolean(data.selected);
  const isDimmed = Boolean(data.isDimmed);
  const isHighlighted = Boolean(data.isHighlighted);

  return (
    <div
      style={{
        width: 240,
        minHeight: 104,
        borderRadius: "10px",
        background: isSelected
          ? "#1e293b"
          : "#181b26",
        backdropFilter: "blur(14px)",
        border: hasError
          ? "2px solid #ef4444"
          : isSelected
          ? "2px solid #38bdf8"
          : isHighlighted
          ? "1.5px solid #14b8a6"
          : isMultiRun
          ? "1.5px solid rgba(168, 85, 247, 0.55)"
          : "1.5px solid rgba(255, 255, 255, 0.16)",
        boxShadow: hasError
          ? "0 0 24px rgba(239, 68, 68, 0.4), 0 8px 24px rgba(0, 0, 0, 0.5)"
          : isSelected
          ? "0 0 26px rgba(56, 189, 248, 0.45), 0 8px 24px rgba(0, 0, 0, 0.5)"
          : isHighlighted
          ? "0 0 18px rgba(20, 184, 166, 0.35), 0 8px 24px rgba(0, 0, 0, 0.5)"
          : isMultiRun
          ? "0 6px 20px rgba(168, 85, 247, 0.22), 0 8px 20px rgba(0, 0, 0, 0.4)"
          : "0 8px 24px rgba(0, 0, 0, 0.45)",
        opacity: isDimmed ? 0.48 : 1,
        filter: isDimmed ? "grayscale(35%)" : "none",
        padding: "10px 14px 12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        cursor: "pointer",
        transition: "all 0.18s cubic-bezier(0.4, 0, 0.2, 1)",
        color: "#f8fafc",
        position: "relative",
        overflow: "visible"
      }}
    >
      {/* 4 Handles for all directional connections */}
      <Handle
        id="target-top"
        type="target"
        position={Position.Top}
        style={{
          background: "#38bdf8",
          width: 7,
          height: 7,
          border: "2px solid #0f172a",
          top: -4
        }}
      />
      <Handle
        id="target-left"
        type="target"
        position={Position.Left}
        style={{
          background: "#38bdf8",
          width: 7,
          height: 7,
          border: "2px solid #0f172a",
          left: -4
        }}
      />
      <Handle
        id="source-right"
        type="source"
        position={Position.Right}
        style={{
          background: "#14b8a6",
          width: 7,
          height: 7,
          border: "2px solid #0f172a",
          right: -4
        }}
      />
      <Handle
        id="source-bottom"
        type="source"
        position={Position.Bottom}
        style={{
          background: "#14b8a6",
          width: 7,
          height: 7,
          border: "2px solid #0f172a",
          bottom: -4
        }}
      />

      {/* Top Illuminated Accent Stripe */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 10,
          right: 10,
          height: 2.5,
          borderRadius: "0 0 4px 4px",
          background: config.color,
          boxShadow: `0 0 10px ${config.color}`,
          opacity: 0.85
        }}
      />

      {/* Trajectory Step Badge (in Path View) */}
      {data.stepNumber && (
        <div
          style={{
            position: "absolute",
            top: -9,
            left: 12,
            background: "#090d16",
            border: "1px solid rgba(56, 189, 248, 0.5)",
            borderRadius: "4px",
            padding: "1px 6px",
            fontSize: "9px",
            fontFamily: "var(--font-mono, monospace)",
            fontWeight: 800,
            color: "#38bdf8",
            letterSpacing: "0.06em",
            boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)"
          }}
        >
          STEP #{data.stepNumber < 10 ? `0${data.stepNumber}` : data.stepNumber}
        </div>
      )}

      {/* Header: Icon Box + Name + Kind badge */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginTop: data.stepNumber ? 2 : 2
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              borderRadius: "6px",
              background: config.bg,
              border: `1px solid ${config.border}`,
              color: config.color,
              flexShrink: 0
            }}
          >
            <Icon size={13} color={config.color} />
          </div>
          <span
            style={{
              fontWeight: 700,
              fontSize: "13.5px",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              letterSpacing: "-0.01em",
              color: "#ffffff"
            }}
            title={data.label}
          >
            {data.label}
          </span>
        </div>
        <span
          style={{
            fontSize: "9px",
            fontWeight: 800,
            letterSpacing: "0.05em",
            padding: "2px 6px",
            borderRadius: "4px",
            background: config.bg,
            border: `1px solid ${config.border}`,
            color: config.color,
            flexShrink: 0
          }}
        >
          {config.label}
        </span>
      </div>

      {/* Metrics Row: Invocations count + Avg duration + Status */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: "10.5px",
              fontWeight: 700,
              fontFamily: "var(--font-mono, monospace)",
              padding: "2px 7px",
              borderRadius: "4px",
              background: isMultiRun ? "rgba(168, 85, 247, 0.22)" : "rgba(255, 255, 255, 0.08)",
              color: isMultiRun ? "#d8b4fe" : "#cbd5e1",
              border: isMultiRun ? "1px solid rgba(168, 85, 247, 0.4)" : "1px solid rgba(255, 255, 255, 0.08)"
            }}
            title={`${data.invocations} executions in this workflow`}
          >
            {isMultiRun && <LoopIcon size={10} color="#d8b4fe" />}
            <span>{isMultiRun ? `${data.invocations} runs` : "1 run"}</span>
          </div>

          {data.avgDurationMs > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 3,
                fontSize: "10.5px",
                fontFamily: "var(--font-mono, monospace)",
                color: "#94a3b8"
              }}
            >
              <ClockIcon size={10} color="#94a3b8" />
              <span>{data.avgDurationMs}ms</span>
            </div>
          )}
        </div>

        {/* Status Pill */}
        {hasError ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: "9.5px",
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: "4px",
              background: "rgba(239, 68, 68, 0.2)",
              color: "#f87171",
              border: "1px solid rgba(239, 68, 68, 0.5)"
            }}
          >
            <AlertTriangleIcon size={10} color="#f87171" />
            <span>{data.errorCount} fail</span>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              fontSize: "9.5px",
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: "4px",
              background: "rgba(34, 197, 94, 0.16)",
              color: "#4ade80",
              border: "1px solid rgba(34, 197, 94, 0.35)"
            }}
          >
            <CheckIcon size={10} color="#4ade80" />
            <span>ready</span>
          </div>
        )}
      </div>

      {/* Triggers preview if any */}
      {data.triggers && data.triggers.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 1 }}>
          {data.triggers.slice(0, 2).map((t, idx) => (
            <span
              key={idx}
              style={{
                fontSize: "9px",
                fontFamily: "var(--font-mono, monospace)",
                padding: "1px 5px",
                borderRadius: "3px",
                background: "rgba(148, 163, 184, 0.12)",
                color: "#94a3b8",
                border: "1px solid rgba(148, 163, 184, 0.25)"
              }}
            >
              ↳ {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
