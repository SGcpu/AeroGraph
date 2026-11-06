import { sortTraceEventsDeterministic, type TraceEvent } from "@aerograph/contracts";

export type HandoffCycleWarning = {
  kind: "handoff_cycle";
  severity: "low" | "medium" | "high";
  reason: string;
  spanIds: string[];
};

interface AgentTransition {
  from: string;
  to: string;
  spanId: string;
  occurredAt: string;
}

/**
 * Detect handoff cycles and multi-agent ping-pong patterns across frameworks.
 *
 * Algorithm:
 * 1. Extract agent transitions from:
 *    a. Explicit `handoff` events (fromAgentId → toAgentId).
 *    b. Implicit framework actor shifts (consecutive agent spans with differing actor.id).
 *    c. Delegation tool calls (delegate_to_*, transfer_to_*).
 * 2. Detect direct ping-pong oscillations (A ↔ B >= 2 transitions).
 * 3. Detect transitive directed cycles (A → B → C → A) via DFS path search.
 * 4. Deduplicate and order deterministically.
 */
export function detectHandoffCycles(events: readonly TraceEvent[]): HandoffCycleWarning[] {
  const sorted = sortTraceEventsDeterministic([...events]);
  if (sorted.length < 2) return [];

  const transitions: AgentTransition[] = [];

  // 1a. Explicit handoff events
  for (const e of sorted) {
    if (e.kind === "handoff") {
      const h = e as Extract<TraceEvent, { kind: "handoff" }>;
      transitions.push({
        from: h.payload.fromAgentId,
        to: h.payload.toAgentId,
        spanId: h.spanId,
        occurredAt: h.occurredAt
      });
    }
  }

  // 1b. If no explicit handoff events, extract transitions from agent actor shifts & delegation tools
  if (transitions.length < 2) {
    let lastAgent: { id: string; spanId: string } | null = null;

    for (const e of sorted) {
      // Check delegation tool call
      if (e.kind === "tool_call") {
        const payload = (e as any).payload ?? {};
        const toolName = String(payload.name || payload.tool || e.actor.id || "");
        const match = toolName.match(/(?:delegate|transfer|handoff)[_-]to[_-]([a-zA-Z0-9_-]+)/i);
        if (match && match[1]) {
          const target = match[1];
          const from = e.actor.id || "agent";
          if (from !== target) {
            transitions.push({
              from,
              to: target,
              spanId: e.spanId,
              occurredAt: e.occurredAt
            });
          }
        }
      }

      // Check agent actor shift
      if (e.actor.kind === "agent" && e.actor.id && e.actor.id !== "system" && e.actor.id !== "user") {
        if (lastAgent && lastAgent.id !== e.actor.id) {
          transitions.push({
            from: lastAgent.id,
            to: e.actor.id,
            spanId: e.spanId,
            occurredAt: e.occurredAt
          });
        }
        lastAgent = { id: e.actor.id, spanId: e.spanId };
      }
    }
  }

  if (transitions.length < 2) return [];

  const warnings: HandoffCycleWarning[] = [];
  const seenCycles = new Set<string>();

  // 2. Direct Ping-Pong Detection (A ↔ B)
  const pingPongEdges = new Map<string, string[]>();
  for (let i = 0; i < transitions.length - 1; i++) {
    const t1 = transitions[i];
    const t2 = transitions[i + 1];
    if (t1.from === t2.to && t1.to === t2.from && t1.from !== t1.to) {
      const pairKey = [t1.from, t1.to].sort().join("↔");
      if (!pingPongEdges.has(pairKey)) pingPongEdges.set(pairKey, []);
      pingPongEdges.get(pairKey)!.push(t1.spanId, t2.spanId);
    }
  }

  for (const [pairKey, spanIds] of pingPongEdges) {
    const uniqueSpans = Array.from(new Set(spanIds));
    const [agentA, agentB] = pairKey.split("↔");
    seenCycles.add(pairKey);
    seenCycles.add(`${agentA}→${agentB}`);
    seenCycles.add(`${agentB}→${agentA}`);

    warnings.push({
      kind: "handoff_cycle",
      severity: uniqueSpans.length >= 4 ? "high" : "medium",
      reason: `Multi-agent ping-pong cycle detected between ${agentA} ↔ ${agentB} (${uniqueSpans.length} handoffs)`,
      spanIds: uniqueSpans
    });
  }

  // 3. Build Adjacency List for DFS Cycle Detection
  const adjacency = new Map<string, Array<{ to: string; spanId: string }>>();
  for (const t of transitions) {
    if (!adjacency.has(t.from)) adjacency.set(t.from, []);
    adjacency.get(t.from)!.push({ to: t.to, spanId: t.spanId });
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stackPath: Array<{ agent: string; spanId: string }> = [];

  function dfs(agent: string): void {
    if (inStack.has(agent)) {
      const cycleStart = stackPath.findIndex((s) => s.agent === agent);
      if (cycleStart >= 0) {
        const cycleSegment = stackPath.slice(cycleStart);
        const cycleKey = cycleSegment.map((s) => s.agent).join("→");
        const reverseKey = [...cycleSegment.map((s) => s.agent)].reverse().join("→");

        if (!seenCycles.has(cycleKey) && !seenCycles.has(reverseKey)) {
          seenCycles.add(cycleKey);
          const spanIds = Array.from(new Set(cycleSegment.map((s) => s.spanId).filter(Boolean)));
          if (spanIds.length > 0) {
            warnings.push({
              kind: "handoff_cycle",
              severity: cycleSegment.length >= 4 ? "high" : "medium",
              reason: `Handoff cycle detected: ${cycleKey}`,
              spanIds
            });
          }
        }
      }
      return;
    }
    if (visited.has(agent)) return;
    visited.add(agent);
    inStack.add(agent);

    const neighbors = adjacency.get(agent) ?? [];
    for (const { to, spanId } of neighbors) {
      stackPath.push({ agent: to, spanId });
      dfs(to);
      stackPath.pop();
    }

    inStack.delete(agent);
  }

  for (const from of adjacency.keys()) {
    stackPath.push({ agent: from, spanId: "" });
    dfs(from);
    stackPath.pop();
  }

  // 4. Repeated Handoff Edges (same directed edge A → B occurring 2+ times)
  const edgeCounts = new Map<string, string[]>();
  for (const t of transitions) {
    const edgeKey = `${t.from}→${t.to}`;
    if (!edgeCounts.has(edgeKey)) edgeCounts.set(edgeKey, []);
    edgeCounts.get(edgeKey)!.push(t.spanId);
  }

  for (const [edgeKey, spanIds] of edgeCounts) {
    if (spanIds.length >= 2 && !seenCycles.has(edgeKey)) {
      seenCycles.add(edgeKey);
      warnings.push({
        kind: "handoff_cycle",
        severity: spanIds.length >= 4 ? "high" : "low",
        reason: `Repeated handoff edge (${edgeKey}) occurred ${spanIds.length} times`,
        spanIds: Array.from(new Set(spanIds))
      });
    }
  }

  // Deterministic ordering: by first spanId's occurredAt, then spanId
  warnings.sort((a, b) => {
    const aSpan = sorted.find((e) => e.spanId === a.spanIds[0]);
    const bSpan = sorted.find((e) => e.spanId === b.spanIds[0]);
    const t = (aSpan?.occurredAt ?? "").localeCompare(bSpan?.occurredAt ?? "");
    if (t !== 0) return t;
    return (a.spanIds[0] ?? "").localeCompare(b.spanIds[0] ?? "");
  });

  return warnings;
}
