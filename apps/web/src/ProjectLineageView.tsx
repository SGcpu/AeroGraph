import React, { useMemo } from "react";
import ReactFlow, { MarkerType, Node, Edge, Background, Controls } from "reactflow";
import type { TraceMeta } from "@aerograph/contracts";

function generateAlias(id: string, prefix = "ID") {
  if (!id) return `${prefix}-Unknown`;
  return `${prefix}-${id.replace(/[-_]/g, "").slice(-5).toUpperCase()}`;
}

export type ProjectLineageViewProps = {
  traces: TraceMeta[];
  onSelectTrace: (traceId: string) => void;
};

export function ProjectLineageView({ traces, onSelectTrace }: ProjectLineageViewProps) {
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    
    // Group children
    const childrenByParent: Record<string, TraceMeta[]> = {};
    const traceMap = new Set(traces.map(t => t.traceId));
    
    traces.forEach(t => {
      if (t.derivedFrom?.baseTraceId && traceMap.has(t.derivedFrom.baseTraceId)) {
        const base = t.derivedFrom.baseTraceId;
        childrenByParent[base] = childrenByParent[base] || [];
        childrenByParent[base].push(t);
      }
    });

    const rootTraces = traces.filter(t => !t.derivedFrom?.baseTraceId || !traceMap.has(t.derivedFrom.baseTraceId));
    
    let currentY = 100;
    
    const layoutSubtree = (t: TraceMeta, x: number, y: number): number => {
      nodes.push({
        id: t.traceId,
        position: { x, y },
        data: { label: generateAlias(t.traceId, "Trace") },
        style: {
          border: "2px solid rgba(99,102,241,0.5)",
          background: "var(--bg-surface)",
          color: "var(--text-primary)",
          padding: "10px",
          borderRadius: "8px",
          width: 150,
          textAlign: "center",
          fontFamily: "var(--font-mono)",
          fontSize: "12px",
          cursor: "pointer",
        }
      });
      
      const children = childrenByParent[t.traceId] || [];
      let nextY = y;
      
      children.forEach((child, idx) => {
        edges.push({
          id: `e-${t.traceId}-${child.traceId}`,
          source: t.traceId,
          target: child.traceId,
          animated: true,
          style: { stroke: "rgba(129,140,248,0.7)", strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "rgba(129,140,248,0.9)" }
        });
        
        // Stagger children vertically
        const childY = idx === 0 ? y : nextY + 120;
        nextY = layoutSubtree(child, x + 200, childY);
      });
      
      return Math.max(y, nextY);
    };

    rootTraces.forEach(root => {
      currentY = layoutSubtree(root, 100, currentY);
      currentY += 120;
    });

    return { nodes, edges };
  }, [traces]);

  return (
    <div style={{ width: "100%", height: "100%", background: "var(--bg-base)", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "20px 24px", borderBottom: "1px solid var(--border-subtle)" }}>
        <h2 style={{ fontSize: 20, color: "var(--text-primary)" }}>Project Lineage</h2>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
          This graph visualizes the fork history for all traces in the current project workspace.
        </p>
      </div>
      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={(_, node) => onSelectTrace(node.id)}
          fitView
        >
          <Background color="rgba(255,255,255,0.05)" />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
