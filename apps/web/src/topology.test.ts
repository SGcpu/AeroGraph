import { describe, expect, it } from "vitest";
import {
  buildTopologyGraph,
  buildTrajectoryPathGraph,
  resolveLogicalStateKey
} from "./topology";

describe("web: workflow topology reduction", () => {
  it("resolves state key correctly across different framework formats", () => {
    // 1. LangGraph node
    const lgEvent = {
      spanId: "s1",
      occurredAt: "2026-05-20T00:00:00.000Z",
      kind: "note",
      payload: { kind: "langgraph_node", node: "generate_response" }
    } as any;
    expect(resolveLogicalStateKey(lgEvent)).toEqual({
      key: "node:generate_response",
      label: "generate_response",
      kind: "agent"
    });

    // 2. LangGraph tool node
    const lgToolEvent = {
      spanId: "s2",
      occurredAt: "2026-05-20T00:00:01.000Z",
      kind: "note",
      payload: { kind: "langgraph_node", node: "tools" }
    } as any;
    expect(resolveLogicalStateKey(lgToolEvent)).toEqual({
      key: "node:tools",
      label: "tools",
      kind: "tool"
    });

    // 3. CrewAI / multi-agent payload
    const crewEvent = {
      spanId: "s3",
      occurredAt: "2026-05-20T00:00:02.000Z",
      kind: "note",
      payload: { agent_name: "Senior Research Analyst" }
    } as any;
    expect(resolveLogicalStateKey(crewEvent)).toEqual({
      key: "agent:Senior Research Analyst",
      label: "Senior Research Analyst",
      kind: "agent"
    });

    // 4. Canonical tool call
    const toolEvent = {
      spanId: "s4",
      occurredAt: "2026-05-20T00:00:03.000Z",
      kind: "tool_call",
      payload: { name: "web_search" }
    } as any;
    expect(resolveLogicalStateKey(toolEvent)).toEqual({
      key: "tool:web_search",
      label: "web_search",
      kind: "tool"
    });

    // 5. Generic retriever
    const retEvent = {
      spanId: "s5",
      occurredAt: "2026-05-20T00:00:04.000Z",
      kind: "retriever",
      payload: { retriever: "chromadb" }
    } as any;
    expect(resolveLogicalStateKey(retEvent)).toEqual({
      key: "retriever:chromadb",
      label: "chromadb",
      kind: "retriever"
    });
  });

  it("collapses repeated state executions into a single node with iterations and loop back-edges", () => {
    const events = [
      {
        spanId: "s1",
        occurredAt: "2026-05-20T00:00:00.000Z",
        durationMs: 100,
        kind: "note",
        payload: { kind: "langgraph_node", node: "agent" }
      },
      {
        spanId: "s2",
        occurredAt: "2026-05-20T00:00:01.000Z",
        durationMs: 200,
        kind: "tool_call",
        payload: { name: "search" }
      },
      {
        spanId: "s3",
        occurredAt: "2026-05-20T00:00:02.000Z",
        durationMs: 150,
        kind: "note",
        payload: { kind: "langgraph_node", node: "agent" }
      },
      {
        spanId: "s4",
        occurredAt: "2026-05-20T00:00:03.000Z",
        durationMs: 250,
        kind: "tool_call",
        payload: { name: "search" }
      },
      {
        spanId: "s5",
        occurredAt: "2026-05-20T00:00:04.000Z",
        durationMs: 120,
        kind: "note",
        payload: { kind: "langgraph_node", node: "agent" }
      }
    ] as any;

    const { nodes, edges, summary } = buildTopologyGraph(events);

    // Should collapse 5 events into 2 topological nodes
    expect(nodes.length).toBe(2);
    expect(summary.totalStates).toBe(2);

    const agentNode = nodes.find((n) => n.id === "node:agent");
    expect(agentNode).toBeDefined();
    expect(agentNode?.data.invocations).toBe(3);
    expect(agentNode?.data.totalDurationMs).toBe(370);
    expect(agentNode?.data.avgDurationMs).toBe(123);
    expect(agentNode?.data.spanIds).toEqual(["s1", "s3", "s5"]);

    // Iterations collection for drilldown
    expect(agentNode?.data.iterations.length).toBe(3);
    expect(agentNode?.data.iterations[0].iterationNumber).toBe(1);
    expect(agentNode?.data.iterations[1].iterationNumber).toBe(2);
    expect(agentNode?.data.iterations[2].iterationNumber).toBe(3);

    const toolNode = nodes.find((n) => n.id === "tool:search");
    expect(toolNode).toBeDefined();
    expect(toolNode?.data.invocations).toBe(2);
    expect(toolNode?.data.iterations.length).toBe(2);

    // Edges: agent -> search and search -> agent (loop)
    expect(edges.length).toBe(2);
    const forwardEdge = edges.find((e) => e.source === "node:agent" && e.target === "tool:search");
    const loopEdge = edges.find((e) => e.source === "tool:search" && e.target === "node:agent");

    expect(forwardEdge).toBeDefined();
    expect(forwardEdge?.label).toBe("×2");

    expect(loopEdge).toBeDefined();
    expect(loopEdge?.label).toContain("cycle");
    expect(summary.totalLoops).toBeGreaterThan(0);
  });

  it("builds horizontal trajectory path view with step numbers", () => {
    const events = [
      {
        spanId: "s1",
        occurredAt: "2026-05-20T00:00:00.000Z",
        durationMs: 80,
        kind: "note",
        payload: { kind: "langgraph_node", node: "planner" }
      },
      {
        spanId: "s2",
        occurredAt: "2026-05-20T00:00:01.000Z",
        durationMs: 140,
        kind: "tool_call",
        payload: { name: "calculator" }
      },
      {
        spanId: "s3",
        occurredAt: "2026-05-20T00:00:02.000Z",
        durationMs: 90,
        kind: "note",
        payload: { kind: "langgraph_node", node: "planner" }
      }
    ] as any;

    const pathResult = buildTrajectoryPathGraph(events);
    expect(pathResult.nodes.length).toBe(3);
    expect(pathResult.edges.length).toBe(2);

    // First step
    expect(pathResult.nodes[0].data.stepNumber).toBe(1);
    expect(pathResult.nodes[0].data.label).toBe("planner");

    // Second step
    expect(pathResult.nodes[1].data.stepNumber).toBe(2);
    expect(pathResult.nodes[1].data.label).toBe("calculator");

    // Third step
    expect(pathResult.nodes[2].data.stepNumber).toBe(3);
    expect(pathResult.nodes[2].data.label).toBe("planner");
    expect(pathResult.nodes[2].data.iterationNumber).toBe(2);

    // Forward position check: x should increase monotonically within the first row
    expect(pathResult.nodes[1].position.x).toBeGreaterThan(pathResult.nodes[0].position.x);
    expect(pathResult.nodes[2].position.x).toBeGreaterThan(pathResult.nodes[1].position.x);
  });

  it("wraps trajectory steps into a multi-column storyboard grid (4 columns per row)", () => {
    // Generate 9 steps
    const events = Array.from({ length: 9 }, (_, i) => ({
      spanId: `span-${i + 1}`,
      occurredAt: `2026-05-20T00:00:0${i}.000Z`,
      durationMs: 50,
      kind: i % 2 === 0 ? "note" : "tool_call",
      payload: i % 2 === 0 ? { kind: "langgraph_node", node: `agent_${i}` } : { name: `tool_${i}` }
    })) as any;

    const { nodes, edges } = buildTrajectoryPathGraph(events);
    expect(nodes.length).toBe(9);
    expect(edges.length).toBe(8);

    // Row 0: steps 1, 2, 3, 4 (cols 0, 1, 2, 3)
    expect(nodes[0].position.y).toBe(nodes[1].position.y);
    expect(nodes[1].position.y).toBe(nodes[2].position.y);
    expect(nodes[2].position.y).toBe(nodes[3].position.y);

    // Step 4 is at col 3; Step 5 is at col 0, row 1
    expect(nodes[4].position.y).toBeGreaterThan(nodes[3].position.y);
    expect(nodes[4].position.x).toBe(nodes[0].position.x);

    // Intra-row edge (step 1 -> step 2) uses horizontal handles
    const intraRowEdge = edges[0];
    expect(intraRowEdge.sourceHandle).toBe("source-right");
    expect(intraRowEdge.targetHandle).toBe("target-left");

    // Inter-row wrap edge (step 4 -> step 5) uses vertical handles
    const wrapEdge = edges[3]; // edge connecting step 4 (idx 3) to step 5 (idx 4)
    expect(wrapEdge.source).toBe(nodes[3].id);
    expect(wrapEdge.target).toBe(nodes[4].id);
    expect(wrapEdge.sourceHandle).toBe("source-bottom");
    expect(wrapEdge.targetHandle).toBe("target-top");
  });

  it("respects layout orientation ('LR' vs 'TB') in buildTopologyGraph", () => {
    const events = [
      {
        spanId: "s1",
        occurredAt: "2026-05-20T00:00:00.000Z",
        kind: "note",
        payload: { kind: "langgraph_node", node: "start" }
      },
      {
        spanId: "s2",
        occurredAt: "2026-05-20T00:00:01.000Z",
        kind: "note",
        payload: { kind: "langgraph_node", node: "finish" }
      }
    ] as any;

    const lrResult = buildTopologyGraph(events, undefined, undefined, "LR");
    const tbResult = buildTopologyGraph(events, undefined, undefined, "TB");

    const lrStart = lrResult.nodes.find((n) => n.id === "node:start")!;
    const lrFinish = lrResult.nodes.find((n) => n.id === "node:finish")!;
    const tbStart = tbResult.nodes.find((n) => n.id === "node:start")!;
    const tbFinish = tbResult.nodes.find((n) => n.id === "node:finish")!;

    // In LR orientation, finish should be to the right of start (higher x)
    expect(lrFinish.position.x).toBeGreaterThan(lrStart.position.x);

    // In TB orientation, finish should be below start (higher y)
    expect(tbFinish.position.y).toBeGreaterThan(tbStart.position.y);
  });

  it("supports path highlighting and dimming when a node is focused", () => {
    const events = [
      {
        spanId: "s1",
        occurredAt: "2026-05-20T00:00:00.000Z",
        kind: "note",
        payload: { kind: "langgraph_node", node: "A" }
      },
      {
        spanId: "s2",
        occurredAt: "2026-05-20T00:00:01.000Z",
        kind: "note",
        payload: { kind: "langgraph_node", node: "B" }
      },
      {
        spanId: "s3",
        occurredAt: "2026-05-20T00:00:02.000Z",
        kind: "note",
        payload: { kind: "langgraph_node", node: "C" }
      }
    ] as any;

    // Focus on node B: A and C are connected, so neither A nor C should be dimmed
    const focusedB = buildTopologyGraph(events, "node:B", "node:B");
    const nodeA = focusedB.nodes.find((n) => n.id === "node:A");
    const nodeB = focusedB.nodes.find((n) => n.id === "node:B");
    expect(nodeB?.data.selected).toBe(true);
    expect(nodeA?.data.isDimmed).toBe(false);
    expect(nodeA?.data.isHighlighted).toBe(true);

    // Selecting node B without path focus: no nodes should be dimmed
    const selectedOnlyB = buildTopologyGraph(events, "node:B", null);
    const selNodeA = selectedOnlyB.nodes.find((n) => n.id === "node:A");
    const selNodeB = selectedOnlyB.nodes.find((n) => n.id === "node:B");
    expect(selNodeB?.data.selected).toBe(true);
    expect(selNodeA?.data.isDimmed).toBe(false);
    expect(selectedOnlyB.nodes.every((n) => !n.data.isDimmed)).toBe(true);
  });

  it("handles errors gracefully and flags nodes with errorCount", () => {
    const events = [
      {
        spanId: "s1",
        occurredAt: "2026-05-20T00:00:00.000Z",
        kind: "note",
        payload: { kind: "langgraph_node", node: "validator" },
        status: "error"
      }
    ] as any;

    const { nodes, summary } = buildTopologyGraph(events);
    expect(nodes.length).toBe(1);
    expect(nodes[0].data.errorCount).toBe(1);
    expect(summary.hasErrors).toBe(true);
  });

  it("handles empty or null event lists without crashing", () => {
    const empty1 = buildTopologyGraph([]);
    expect(empty1.nodes).toEqual([]);
    expect(empty1.edges).toEqual([]);
    expect(empty1.summary.totalStates).toBe(0);

    const empty2 = buildTopologyGraph(null as any);
    expect(empty2.nodes).toEqual([]);
    expect(empty2.edges).toEqual([]);

    const empty3 = buildTrajectoryPathGraph([]);
    expect(empty3.nodes).toEqual([]);
    expect(empty3.edges).toEqual([]);
  });
});
