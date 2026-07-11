import { sortTraceEventsDeterministic, type TraceEvent } from "@aerograph/contracts";
import { MarkerType, type Node, type Edge } from "reactflow";

import dagre from "dagre";

export function buildGraph(events: TraceEvent[]): { nodes: Node[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  
  // Set layout direction and spacing
  const nodeWidth = 230;
  const nodeHeight = 120;
  dagreGraph.setGraph({ rankdir: "TB", nodesep: 50, ranksep: 70 });

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  
  // 1. Filter out visual noise (e.g., chain_end events)
  const visualEvents = events.filter((e) => {
    const p = (e as any).payload;
    if (e.kind === "note" && p?.event === "chain_end") return false;
    return true;
  });

  const visualEventIds = new Set(visualEvents.map((e) => e.spanId));

  // 2. Build nodes and add to dagre
  for (const event of visualEvents) {
    nodes.push({
      id: event.spanId,
      position: { x: 0, y: 0 }, // Will be set by dagre
      data: { event },
      type: "default",
      // Failure highlighting using event.status only (T026)
      style: {
        border: event.status === "error" ? "2px solid red" : "1px solid #ddd",
        background: event.status === "error" ? "#ffe6e6" : "white",
        padding: "10px",
        borderRadius: "5px",
        width: 200
      }
    });
    
    dagreGraph.setNode(event.spanId, { width: nodeWidth, height: nodeHeight });
  }

  // 3. Build edges and add to dagre
  
  // Group by parent
  const childrenByParent = new Map<string, TraceEvent[]>();
  for (const event of visualEvents) {
    if (event.parentSpanId && visualEventIds.has(event.parentSpanId)) {
      if (!childrenByParent.has(event.parentSpanId)) {
        childrenByParent.set(event.parentSpanId, []);
      }
      childrenByParent.get(event.parentSpanId)!.push(event);
    }
  }

  // Ensure siblings are sorted chronologically
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  }

  for (const [parentId, siblings] of childrenByParent.entries()) {
    for (let i = 0; i < siblings.length; i++) {
      const child = siblings[i];

      // A. Parent -> Child edge (Hierarchy, dashed)
      edges.push({
        id: `h-${parentId}-${child.spanId}`,
        source: parentId,
        target: child.spanId,
        animated: true,
        style: { stroke: "rgba(156,163,175,0.35)", strokeWidth: 1.5, strokeDasharray: "4 4" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "rgba(156,163,175,0.5)",
          width: 12,
          height: 12
        }
      });
      dagreGraph.setEdge(parentId, child.spanId, { weight: 1 });

      // B. Sibling -> Sibling edge (Control Flow, solid teal)
      if (i > 0) {
        const prevChild = siblings[i - 1];
        
        // Determine if there are LangGraph triggers to label the control flow edge
        let edgeLabel: string | undefined = undefined;
        const p = (child as any).payload;
        if (p?.kind === "langgraph_node" && Array.isArray(p?.triggers) && p.triggers.length > 0) {
          edgeLabel = p.triggers.join(" → ");
        }

        edges.push({
          id: `c-${prevChild.spanId}-${child.spanId}`,
          source: prevChild.spanId,
          target: child.spanId,
          animated: true,
          label: edgeLabel,
          labelStyle: { fill: "rgba(100,116,139,1)", fontWeight: 600, fontSize: 10, fontFamily: "var(--font-mono)" },
          labelBgStyle: { fill: "rgba(255,255,255,0.85)", color: "#fff" },
          style: { stroke: "rgba(20,184,166,0.85)", strokeWidth: 2.5 },
          zIndex: 1000,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "rgba(20,184,166,1)",
            width: 16,
            height: 16
          }
        });
        
        // Give control flow edges high weight so Dagre keeps them vertically aligned
        dagreGraph.setEdge(prevChild.spanId, child.spanId, { weight: 10 });
      }
    }
  }

  // 4. Compute layout
  dagre.layout(dagreGraph);

  // 5. Apply computed coordinates back to ReactFlow nodes
  nodes.forEach((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    // ReactFlow positions from top-left, Dagre uses center
    node.position = {
      x: nodeWithPosition.x - nodeWidth / 2,
      y: nodeWithPosition.y - nodeHeight / 2,
    };
  });

  return { nodes, edges };
}

export function computePlaybackState(events: TraceEvent[], cursorIndex: number): TraceEvent[] {
  const sorted = sortTraceEventsDeterministic(events);
  return sorted.slice(0, cursorIndex + 1);
}

/**
 * Apply diff highlighting to graph nodes (T033).
 * Changed spanIds get a distinct visual style.
 * Deterministic: styling is determined solely by the changedSpanIds set.
 */
export function applyDiffHighlighting(
  nodes: Node[],
  changedSpanIds: Set<string>
): Node[] {
  return nodes.map((node) => {
    if (!changedSpanIds.has(node.id)) return node;
    return {
      ...node,
      className: (node.className ?? "") + " node-diff-highlight",
      style: {
        ...node.style,
        border: "2.5px solid #f59e0b",
        background: "rgba(245,158,11,0.18)",
        boxShadow: "0 0 0 3px rgba(245,158,11,0.25), 0 0 18px rgba(245,158,11,0.45)"
      }
    };
  });
}

/**
 * Apply loop warning highlighting to graph nodes (T045).
 * Loop-flagged spanIds get a distinct visual style.
 * Deterministic: styling is determined solely by the loopSpanIds set.
 */
export function applyLoopHighlighting(
  nodes: Node[],
  loopSpanIds: Set<string>
): Node[] {
  return nodes.map((node) => {
    if (!loopSpanIds.has(node.id)) return node;
    return {
      ...node,
      className: (node.className ?? "") + " node-loop-highlight",
      style: {
        ...node.style,
        border: "2.5px solid #a78bfa",
        background: "rgba(139,92,246,0.18)",
        boxShadow: "0 0 0 3px rgba(139,92,246,0.3), 0 0 20px rgba(139,92,246,0.5)"
      }
    };
  });
}
