import { sortTraceEventsDeterministic, type TraceEvent } from "@aerograph/contracts";
import { MarkerType, type Node, type Edge } from "reactflow";
import dagre from "dagre";

export interface StateIteration {
  spanId: string;
  iterationNumber: number;
  occurredAt: string;
  durationMs: number;
  status: "ok" | "error";
  trigger?: string;
}

export interface TopologyNodeData {
  id: string;
  label: string;
  kind: "agent" | "tool" | "retriever" | "llm" | "checkpoint" | "state";
  invocations: number;
  totalDurationMs: number;
  avgDurationMs: number;
  errorCount: number;
  spanIds: string[];
  iterations: StateIteration[];
  firstOccurredAt: string;
  lastOccurredAt: string;
  triggers: string[];
  selected?: boolean;
  isDimmed?: boolean;
  isHighlighted?: boolean;
  // Used in Path/Trajectory view
  stepNumber?: number;
  iterationNumber?: number;
  colIndex?: number;
  rowIndex?: number;
}

export interface TopologySummary {
  totalStates: number;
  totalTransitions: number;
  totalLoops: number;
  maxInvocations: number;
  hasErrors: boolean;
}

export interface TopologyGraphResult {
  nodes: Node<TopologyNodeData>[];
  edges: Edge[];
  summary: TopologySummary;
}

/**
 * Resolves a trace event to its logical state identity and semantic kind
 * in a completely framework-agnostic manner.
 */
export function resolveLogicalStateKey(event: TraceEvent): {
  key: string;
  label: string;
  kind: TopologyNodeData["kind"];
} {
  const payload = (event as any).payload ?? {};

  // 1. Framework state machine node (e.g. LangGraph node)
  if (payload.kind === "langgraph_node" && typeof payload.node === "string" && payload.node.trim()) {
    const nodeName = payload.node.trim();
    const isTool = nodeName.toLowerCase().includes("tool");
    return {
      key: `node:${nodeName}`,
      label: nodeName,
      kind: isTool ? "tool" : "agent"
    };
  }

  if (typeof payload.node === "string" && payload.node.trim()) {
    const nodeName = payload.node.trim();
    const isTool = nodeName.toLowerCase().includes("tool");
    return {
      key: `node:${nodeName}`,
      label: nodeName,
      kind: isTool ? "tool" : "agent"
    };
  }

  // 2. Multi-agent framework actor (e.g. CrewAI, AutoGen, Agno, OpenAI Agents)
  if (payload.agent_name && typeof payload.agent_name === "string") {
    return {
      key: `agent:${payload.agent_name}`,
      label: payload.agent_name,
      kind: "agent"
    };
  }

  // 3. Actor name/id from canonical schema
  if (event.actor?.name && event.actor.name.trim()) {
    return {
      key: `actor:${event.actor.name}`,
      label: event.actor.name,
      kind: event.actor.kind === "tool" ? "tool" : "agent"
    };
  }

  // 4. Specific tool call or tool result
  if (event.kind === "tool_call" || event.kind === "tool_result") {
    const toolName = payload.name || payload.tool || payload.toolName || event.actor?.id || "tool";
    return {
      key: `tool:${toolName}`,
      label: String(toolName),
      kind: "tool"
    };
  }

  // 5. Retriever operation
  if (event.kind === "retriever") {
    const retrieverName = payload.retriever || payload.source || "vector_search";
    return {
      key: `retriever:${retrieverName}`,
      label: String(retrieverName),
      kind: "retriever"
    };
  }

  // 6. Checkpoint snapshot
  if (event.kind === "checkpoint" || event.kind === "state_snapshot") {
    return {
      key: "state:checkpoint",
      label: "Checkpoint",
      kind: "checkpoint"
    };
  }

  // 7. LLM prompt/response
  if (event.kind === "prompt" || event.kind === "response") {
    const model = payload.model || (event as any).telemetry?.model?.name || "llm";
    return {
      key: `llm:${model}`,
      label: String(model),
      kind: "llm"
    };
  }

  // 8. Actor ID fallback
  if (event.actor?.id && event.actor.id !== "system" && event.actor.id !== "user") {
    return {
      key: `actor:${event.actor.id}`,
      label: event.actor.id,
      kind: event.actor.kind === "tool" ? "tool" : "agent"
    };
  }

  // 9. Generic semantic fallback
  return {
    key: `state:${event.kind}`,
    label: event.kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    kind: "state"
  };
}

/**
 * Filter visual noise (chain_end markers, heartbeats, internal notes)
 */
export function filterVisualEvents(events: TraceEvent[]): TraceEvent[] {
  if (!events) return [];
  const sorted = sortTraceEventsDeterministic(events);
  return sorted.filter((e) => {
    const p = (e as any).payload;
    if (e.kind === "note" && (p?.event === "chain_end" || p?.event === "heartbeat")) {
      return false;
    }
    return true;
  });
}

/**
 * Aggregates trace events into a high-level, framework-agnostic workflow topology
 * (State Machine Graph View) with invocation counters, average latencies, and cyclic loop edges.
 * Supports both "LR" (horizontal widescreen layout) and "TB" (compact vertical layout).
 */
export function buildTopologyGraph(
  events: TraceEvent[],
  selectedStateKey: string | null = null,
  focusedStateKey: string | null = null,
  orientation: "LR" | "TB" = "LR"
): TopologyGraphResult {
  const visualEvents = filterVisualEvents(events);

  if (visualEvents.length === 0) {
    return {
      nodes: [],
      edges: [],
      summary: {
        totalStates: 0,
        totalTransitions: 0,
        totalLoops: 0,
        maxInvocations: 0,
        hasErrors: false
      }
    };
  }

  // 1. Aggregate events by logical state key
  const stateMap = new Map<string, TopologyNodeData>();
  const stateIterationCounter = new Map<string, number>();

  for (const event of visualEvents) {
    const { key, label, kind } = resolveLogicalStateKey(event);
    const duration = typeof event.durationMs === "number" && !isNaN(event.durationMs) ? event.durationMs : 0;
    const isError = event.status === "error";

    const payload = (event as any).payload ?? {};
    const triggers: string[] = Array.isArray(payload.triggers) ? payload.triggers.map(String) : [];

    const currentIter = (stateIterationCounter.get(key) || 0) + 1;
    stateIterationCounter.set(key, currentIter);

    const iteration: StateIteration = {
      spanId: event.spanId,
      iterationNumber: currentIter,
      occurredAt: event.occurredAt,
      durationMs: duration,
      status: isError ? "error" : "ok",
      trigger: triggers[0]
    };

    if (!stateMap.has(key)) {
      stateMap.set(key, {
        id: key,
        label,
        kind,
        invocations: 1,
        totalDurationMs: duration,
        avgDurationMs: duration,
        errorCount: isError ? 1 : 0,
        spanIds: [event.spanId],
        iterations: [iteration],
        firstOccurredAt: event.occurredAt,
        lastOccurredAt: event.occurredAt,
        triggers: [...triggers],
        selected: key === selectedStateKey
      });
    } else {
      const existing = stateMap.get(key)!;
      existing.invocations += 1;
      existing.totalDurationMs += duration;
      existing.avgDurationMs = Math.round(existing.totalDurationMs / existing.invocations);
      if (isError) existing.errorCount += 1;
      existing.spanIds.push(event.spanId);
      existing.iterations.push(iteration);
      existing.lastOccurredAt = event.occurredAt;
      for (const trig of triggers) {
        if (!existing.triggers.includes(trig)) {
          existing.triggers.push(trig);
        }
      }
      if (key === selectedStateKey) {
        existing.selected = true;
      }
    }
  }

  // 2. Synthesize transitions and detect cyclic loops
  interface EdgeAccumulator {
    source: string;
    target: string;
    count: number;
    isLoop: boolean;
    labels: Set<string>;
  }

  const edgeMap = new Map<string, EdgeAccumulator>();
  const seenStatesSoFar = new Set<string>();
  let totalLoops = 0;

  for (let i = 0; i < visualEvents.length; i++) {
    const currentEvent = visualEvents[i];
    const currentKey = resolveLogicalStateKey(currentEvent).key;

    if (i > 0) {
      const prevEvent = visualEvents[i - 1];
      const prevKey = resolveLogicalStateKey(prevEvent).key;

      if (prevKey !== currentKey) {
        const edgeId = `${prevKey}->${currentKey}`;
        const isCycle = seenStatesSoFar.has(currentKey);

        const currentPayload = (currentEvent as any).payload ?? {};
        const triggers: string[] = Array.isArray(currentPayload.triggers) ? currentPayload.triggers.map(String) : [];

        if (!edgeMap.has(edgeId)) {
          if (isCycle) totalLoops += 1;
          edgeMap.set(edgeId, {
            source: prevKey,
            target: currentKey,
            count: 1,
            isLoop: isCycle,
            labels: new Set(triggers)
          });
        } else {
          const acc = edgeMap.get(edgeId)!;
          acc.count += 1;
          triggers.forEach((t) => acc.labels.add(t));
        }
      } else {
        // Self loop transition
        const edgeId = `${currentKey}->${currentKey}`;
        if (!edgeMap.has(edgeId)) {
          totalLoops += 1;
          edgeMap.set(edgeId, {
            source: currentKey,
            target: currentKey,
            count: 1,
            isLoop: true,
            labels: new Set(["retry/cycle"])
          });
        } else {
          edgeMap.get(edgeId)!.count += 1;
        }
      }
    }

    seenStatesSoFar.add(currentKey);
  }

  // 3. Determine active focus / path highlighting
  const activeFocus = focusedStateKey || null;
  const connectedNodeIds = new Set<string>();
  if (activeFocus) {
    connectedNodeIds.add(activeFocus);
    edgeMap.forEach((e) => {
      if (e.source === activeFocus) connectedNodeIds.add(e.target);
      if (e.target === activeFocus) connectedNodeIds.add(e.source);
    });
  }

  // 4. Layout with Dagre
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const nodeWidth = 240;
  const nodeHeight = 105;
  // Compact ranksep & nodesep for dense, clean visual fit
  dagreGraph.setGraph({
    rankdir: orientation,
    nodesep: orientation === "LR" ? 40 : 50,
    ranksep: orientation === "LR" ? 60 : 55
  });

  stateMap.forEach((_, key) => {
    dagreGraph.setNode(key, { width: nodeWidth, height: nodeHeight });
  });

  edgeMap.forEach((edge) => {
    const weight = edge.isLoop ? 1 : 5;
    dagreGraph.setEdge(edge.source, edge.target, { weight });
  });

  dagre.layout(dagreGraph);

  // 5. Assemble ReactFlow Nodes
  const nodes: Node<TopologyNodeData>[] = [];
  let maxInvocations = 0;
  let hasErrors = false;

  stateMap.forEach((data, key) => {
    if (data.invocations > maxInvocations) maxInvocations = data.invocations;
    if (data.errorCount > 0) hasErrors = true;

    const dagreNode = dagreGraph.node(key);
    const x = dagreNode ? dagreNode.x - nodeWidth / 2 : 0;
    const y = dagreNode ? dagreNode.y - nodeHeight / 2 : 0;

    const isSelected = key === selectedStateKey;
    const isConnected = activeFocus ? connectedNodeIds.has(key) : true;
    const isDimmed = activeFocus ? !isConnected : false;
    const isHighlighted = activeFocus ? isConnected && !isSelected : false;

    nodes.push({
      id: key,
      type: "topologyNode",
      position: { x, y },
      data: {
        ...data,
        selected: isSelected,
        isDimmed,
        isHighlighted
      }
    });
  });

  // 6. Assemble ReactFlow Edges
  const edges: Edge[] = [];

  edgeMap.forEach((edge, edgeId) => {
    const triggerLabel = Array.from(edge.labels).slice(0, 2).join(", ");
    let displayLabel = "";
    if (edge.count > 1) {
      displayLabel = edge.isLoop ? `cycle ×${edge.count}` : `×${edge.count}`;
    }
    if (triggerLabel) {
      displayLabel = displayLabel ? `${displayLabel} (${triggerLabel})` : triggerLabel;
    }

    const isConnectedToFocus = activeFocus
      ? edge.source === activeFocus || edge.target === activeFocus
      : true;
    const edgeDimmed = activeFocus ? !isConnectedToFocus : false;

    // Handles orientation
    const sourceHandle = orientation === "LR" ? "source-right" : "source-bottom";
    const targetHandle = orientation === "LR" ? "target-left" : "target-top";

    edges.push({
      id: `topo-${edgeId}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.isLoop ? "source-bottom" : sourceHandle,
      targetHandle: edge.isLoop ? "target-top" : targetHandle,
      animated: isConnectedToFocus,
      label: displayLabel || undefined,
      labelStyle: {
        fill: edgeDimmed ? "#475569" : edge.isLoop ? "#c084fc" : "#0d9488",
        fontWeight: 700,
        fontSize: 10,
        fontFamily: "var(--font-mono, monospace)"
      },
      labelBgStyle: {
        fill: "rgba(15, 23, 42, 0.94)",
        rx: 4,
        ry: 4
      },
      labelBgPadding: [4, 2],
      style: {
        stroke: edgeDimmed
          ? "rgba(100, 116, 139, 0.2)"
          : edge.isLoop
          ? "#a855f7"
          : "#14b8a6",
        strokeWidth: isConnectedToFocus ? (edge.isLoop ? 3 : 2.5) : 1.5,
        strokeDasharray: edge.isLoop ? "5 4" : undefined,
        opacity: edgeDimmed ? 0.25 : 1
      },
      zIndex: isConnectedToFocus ? 300 : edge.isLoop ? 200 : 100,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edgeDimmed ? "#475569" : edge.isLoop ? "#a855f7" : "#14b8a6",
        width: 14,
        height: 14
      }
    });
  });

  return {
    nodes,
    edges,
    summary: {
      totalStates: nodes.length,
      totalTransitions: edges.length,
      totalLoops,
      maxInvocations,
      hasErrors
    }
  };
}

/**
 * Builds the Trajectory Storyboard View as a multi-column responsive grid (4 steps per row).
 * Lays out steps in a clean storyboard grid (e.g. 4 steps across, wrapping to the next row),
 * ensuring that 16+ steps remain large, crisp, and readable at 100% zoom without shrinking.
 */
export function buildTrajectoryPathGraph(
  events: TraceEvent[],
  selectedSpanId: string | null = null,
  columns: number = 4
): TopologyGraphResult {
  const visualEvents = filterVisualEvents(events);

  if (visualEvents.length === 0) {
    return {
      nodes: [],
      edges: [],
      summary: {
        totalStates: 0,
        totalTransitions: 0,
        totalLoops: 0,
        maxInvocations: 0,
        hasErrors: false
      }
    };
  }

  const nodes: Node<TopologyNodeData>[] = [];
  const edges: Edge[] = [];
  const stateCounts = new Map<string, number>();

  let hasErrors = false;
  const nodeWidth = 240;
  const nodeHeight = 105;
  const horizontalGap = 70;
  const verticalGap = 75;

  const actualColumns = Math.max(2, columns);

  for (let i = 0; i < visualEvents.length; i++) {
    const event = visualEvents[i];
    const { key, label, kind } = resolveLogicalStateKey(event);
    const duration = typeof event.durationMs === "number" && !isNaN(event.durationMs) ? event.durationMs : 0;
    const isError = event.status === "error";
    if (isError) hasErrors = true;

    const iterCount = (stateCounts.get(key) || 0) + 1;
    stateCounts.set(key, iterCount);

    const stepId = `step-${i}-${event.spanId}`;
    const isSelected = event.spanId === selectedSpanId;

    // Multi-column grid coordinates
    const col = i % actualColumns;
    const row = Math.floor(i / actualColumns);
    const x = col * (nodeWidth + horizontalGap);
    const y = row * (nodeHeight + verticalGap);

    nodes.push({
      id: stepId,
      type: "topologyNode",
      position: { x, y },
      data: {
        id: stepId,
        label,
        kind,
        invocations: iterCount,
        totalDurationMs: duration,
        avgDurationMs: duration,
        errorCount: isError ? 1 : 0,
        spanIds: [event.spanId],
        iterations: [
          {
            spanId: event.spanId,
            iterationNumber: iterCount,
            occurredAt: event.occurredAt,
            durationMs: duration,
            status: isError ? "error" : "ok"
          }
        ],
        firstOccurredAt: event.occurredAt,
        lastOccurredAt: event.occurredAt,
        triggers: [],
        selected: isSelected,
        stepNumber: i + 1,
        iterationNumber: iterCount,
        colIndex: col,
        rowIndex: row
      }
    });

    if (i > 0) {
      const prevEvent = visualEvents[i - 1];
      const prevStepId = `step-${i - 1}-${prevEvent.spanId}`;
      const prevRow = Math.floor((i - 1) / actualColumns);

      const payload = (event as any).payload ?? {};
      const triggers = Array.isArray(payload.triggers) ? payload.triggers.map(String) : [];

      const isSameRow = row === prevRow;
      const sourceHandle = isSameRow ? "source-right" : "source-bottom";
      const targetHandle = isSameRow ? "target-left" : "target-top";

      edges.push({
        id: `path-${prevStepId}->${stepId}`,
        source: prevStepId,
        target: stepId,
        sourceHandle,
        targetHandle,
        animated: true,
        label: triggers[0] ? `↳ ${triggers[0]}` : undefined,
        labelStyle: {
          fill: "#0d9488",
          fontWeight: 700,
          fontSize: 10,
          fontFamily: "var(--font-mono, monospace)"
        },
        labelBgStyle: { fill: "rgba(15, 23, 42, 0.94)", rx: 4, ry: 4 },
        labelBgPadding: [4, 2],
        style: { stroke: "#14b8a6", strokeWidth: 2.5 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "#14b8a6",
          width: 14,
          height: 14
        }
      });
    }
  }

  return {
    nodes,
    edges,
    summary: {
      totalStates: nodes.length,
      totalTransitions: edges.length,
      totalLoops: 0,
      maxInvocations: Math.max(...Array.from(stateCounts.values()), 1),
      hasErrors
    }
  };
}
