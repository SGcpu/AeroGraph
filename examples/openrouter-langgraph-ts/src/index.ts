import fs from "fs";
import path from "path";

// Auto-load .env from cwd or parent directories without external dependencies
function loadEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const envFile = path.join(dir, ".env");
    if (fs.existsSync(envFile)) {
      const lines = fs.readFileSync(envFile, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
          const [key, ...val] = trimmed.split("=");
          const k = key.trim();
          if (!process.env[k]) {
            process.env[k] = val.join("=").trim().replace(/^["']|["']$/g, "");
          }
        }
      }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnv();

import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { BaseMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { FlightRecorder } from "@aerograph/sdk";
import { AeroGraphCallbackHandler } from "@aerograph/adapter-langchain";

// 1. Define LangGraph State Schema
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  query: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "Analyze latest autonomous rover navigation algorithms and synthesize a technical summary.",
  }),
  researchData: Annotation<Record<string, any>>({
    reducer: (x, y) => ({ ...x, ...y }),
    default: () => ({}),
  }),
  routeDecision: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "pending",
  }),
  iteration: Annotation<number>({
    reducer: (x, y) => x + y,
    default: () => 0,
  }),
  finalSummary: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "",
  }),
});

type StateType = typeof AgentState.State;

async function main() {
  console.log("=========================================================");
  console.log("🚀 AeroGraph + LangGraph + OpenRouter Robust Test Workflow");
  console.log("=========================================================\n");

  const apiKey = process.env.OPENROUTER_API_KEY;
  const modelName = process.env.OPENROUTER_MODEL || "openrouter/free";
  const collectorUrl = process.env.AEROGRAPH_ENDPOINT || "http://localhost:4317";

  if (!apiKey) {
    console.warn("⚠️  [NOTICE] OPENROUTER_API_KEY is not set in environment or .env.");
    console.warn("   To execute live OpenRouter LLM calls, set OPENROUTER_API_KEY=<your-key>.");
    console.warn("   Proceeding with simulated OpenRouter model responses to verify full graph flow...\n");
  } else {
    console.log(`✅ [CONFIG] Using OpenRouter API Key with model: '${modelName}'`);
  }

  // 2. Initialize AeroGraph Flight Recorder & LangChain Adapter
  const safeFetch: typeof fetch = async (input, init) => {
    try {
      return await fetch(input, init);
    } catch {
      // Graceful fallback if collector is not yet started
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  };

  const recorder = new FlightRecorder({
    endpoint: collectorUrl,
    projectId: "openrouter-eval-suite",
    environment: "development",
    actor: { id: "openrouter-langgraph-agent", name: "LangGraph OpenRouter Agent" },
    fetchFn: safeFetch,
  });
  const traceId = recorder.traceId;
  const handler = new AeroGraphCallbackHandler(recorder);

  console.log(`📡 [AEROGRAPH] Initialized FlightRecorder for Trace: ${traceId}`);
  console.log(`🔗 [AEROGRAPH] Target Collector: ${collectorUrl}`);

  // 3. Initialize LLM (OpenRouter or mock fallback)
  const llm = apiKey
    ? new ChatOpenAI({
        model: modelName,
        apiKey: apiKey,
        configuration: {
          baseURL: "https://openrouter.ai/api/v1",
          defaultHeaders: {
            "HTTP-Referer": "https://aerograph.dev",
            "X-Title": "AeroGraph LangGraph Workflow",
          },
        },
        streaming: true,
        temperature: 0.2,
      })
    : null;

  // 4. Node 1: Planner Node (LLM Prompt & Response)
  async function plannerNode(state: StateType): Promise<Partial<StateType>> {
    console.log("\n[Node 1: Planner] Analyzing query and determining subtasks...");
    const promptText = `You are an AI research planner. User goal: "${state.query}". Identify 2 key technical sub-topics to research. Respond in 2 short bullet points.`;

    let planContent = "";
    if (llm) {
      const response = await llm.invoke([new HumanMessage(promptText)], {
        callbacks: [handler],
      });
      planContent = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    } else {
      // Offline fallback: manually record simulated prompt + response with telemetry
      const p = await recorder.prompt({
        parentSpanId: null,
        text: promptText,
        telemetry: { model: { name: modelName, provider: "openrouter" } },
      });
      planContent = "- Terrain geometry hazard detection via stereoscopic depth mapping\n- Visual odometry drift compensation and SLAM loop closure";
      await recorder.response({
        parentSpanId: p.spanId,
        text: planContent,
        telemetry: {
          model: { name: modelName, provider: "openrouter" },
          usage: { inputTokens: 42, outputTokens: 28, totalTokens: 70 },
          durationMs: 420,
        },
      });
    }

    console.log(`  📋 Plan generated:\n  ${planContent.replace(/\n/g, "\n  ")}`);
    return {
      messages: [new AIMessage(`Plan: ${planContent}`)],
      iteration: 1,
    };
  }

  // 5. Node 2: Tool Execution Node (Tool Call & Result)
  async function toolNode(state: StateType): Promise<Partial<StateType>> {
    console.log("\n[Node 2: Tool Execution] Querying research database...");
    
    // Explicit tool call emission to showcase ToolCallEvent & ToolResultEvent
    const toolCall = await recorder.toolCall({
      parentSpanId: null,
      toolId: "rover_telemetry_database",
      input: { query: "rover visual odometry SLAM algorithms", filter: "peer_reviewed" },
    });

    // Simulated retrieval data
    const toolOutput = {
      status: "success",
      recordsRetrieved: 3,
      findings: [
        "Stereo Visual Odometry yields 1.2% distance drift over 10km traverses.",
        "Patch-based loop closures prevent accumulation of rotational drift.",
        "Dense elevation maps allow real-time traversability assessment under 200ms."
      ],
      timestamp: new Date().toISOString()
    };

    await recorder.toolResult({
      parentSpanId: toolCall.spanId,
      toolId: "rover_telemetry_database",
      output: toolOutput,
    });

    console.log(`  🔍 Tool retrieved ${toolOutput.recordsRetrieved} technical telemetry records.`);
    return {
      researchData: { telemetry: toolOutput.findings },
    };
  }

  // 6. Node 3: Evaluator Node (Decision Branching / Route Badges)
  async function evaluatorNode(state: StateType): Promise<Partial<StateType>> {
    console.log("\n[Node 3: Evaluator] Checking if research data satisfies technical depth...");
    const hasEnoughData = state.researchData.telemetry && state.researchData.telemetry.length >= 2;
    const decision = hasEnoughData ? "sufficient_data" : "needs_refinement";

    console.log(`  ⚖️ Route decision: '${decision}' (Iteration: ${state.iteration})`);

    // Record structured state snapshot with deterministic stateHash
    await dispatchCustomEvent(
      "langgraph_state_snapshot",
      {
        node_name: "evaluator",
        full_state: { decision, iteration: state.iteration, dataCount: state.researchData.telemetry?.length },
      },
      { callbacks: [handler] }
    );

    return {
      routeDecision: decision,
    };
  }

  // 7. Node 4: Synthesizer Node (Final LLM Output)
  async function synthesizerNode(state: StateType): Promise<Partial<StateType>> {
    console.log("\n[Node 4: Synthesizer] Compiling final grounded synthesis...");
    const promptText = `Synthesize the findings into an executive briefing:\nFindings: ${JSON.stringify(state.researchData.telemetry)}\nProvide a concise 2-sentence summary.`;

    let synthesisText = "";
    if (llm) {
      const response = await llm.invoke([new HumanMessage(promptText)], {
        callbacks: [handler],
      });
      synthesisText = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    } else {
      const p = await recorder.prompt({
        text: promptText,
        model: { name: modelName, provider: "openrouter" },
      });
      synthesisText = "Autonomous rovers achieve reliable long-range navigation by pairing stereo visual odometry with real-time traversability maps to keep drift below 1.2%. Periodic SLAM loop closures eliminate rotational bias across multi-kilometer planetary traverses.";
      await recorder.response({
        parentSpanId: p.spanId,
        text: synthesisText,
        model: { name: modelName, provider: "openrouter" },
        usage: { inputTokens: 85, outputTokens: 46, totalTokens: 131 },
        durationMs: 780,
      });
    }

    // Emit Human-in-the-Loop Checkpoint to test checkpoint events
    await dispatchCustomEvent(
      "langgraph_checkpoint",
      {
        checkpoint_id: "chk-synthesis-review",
        reason: "Executive briefing ready for engineer sign-off",
        state: { finalSummaryLength: synthesisText.length },
      },
      { callbacks: [handler] }
    );

    console.log(`  📝 Final Synthesis:\n  "${synthesisText}"`);
    return {
      finalSummary: synthesisText,
    };
  }

  // 8. Build the LangGraph StateGraph
  const workflow = new StateGraph(AgentState)
    .addNode("planner", plannerNode)
    .addNode("researcher", toolNode)
    .addNode("evaluator", evaluatorNode)
    .addNode("synthesizer", synthesizerNode)
    .addEdge(START, "planner")
    .addEdge("planner", "researcher")
    .addEdge("researcher", "evaluator")
    .addConditionalEdges("evaluator", (state) => {
      if (state.routeDecision === "sufficient_data") {
        return "synthesizer";
      }
      return END;
    }, {
      synthesizer: "synthesizer",
      end: END,
    })
    .addEdge("synthesizer", END);

  const app = workflow.compile();

  // 9. Execute Graph with AeroGraph Tracking
  console.log("\n⚡ [EXECUTION] Invoking LangGraph agent workflow...");
  const finalResult = await app.invoke(
    { query: "Analyze latest autonomous rover navigation algorithms and synthesize a technical summary." },
    { callbacks: [handler] }
  );

  console.log("\n=========================================================");
  console.log("🎉 Workflow Completed Successfully!");
  console.log(`📊 Trace ID:        ${traceId}`);
  console.log(`🌐 Web Dashboard:   http://localhost:5173/?traceId=${traceId}`);
  console.log("=========================================================");
}

main().catch((err) => {
  console.error("Workflow failed with error:", err);
  process.exit(1);
});
