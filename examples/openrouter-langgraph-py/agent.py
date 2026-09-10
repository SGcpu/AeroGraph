import os
import sys
from typing import TypedDict, List, Dict, Any, Optional

import httpx
from dotenv import load_dotenv

from langchain_core.messages import (
    BaseMessage,
    HumanMessage,
    AIMessage,
)
from langchain_core.callbacks import dispatch_custom_event
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, START, END

from aerograph_sdk import FlightRecorder, new_trace_id
from aerograph_langchain import AeroGraphCallbackHandler


# ============================================================
# Environment
# ============================================================

load_dotenv()


# ============================================================
# 1. Define LangGraph State Schema
# ============================================================

class AgentState(TypedDict):
    messages: List[BaseMessage]
    query: str
    research_data: Dict[str, Any]
    route_decision: str
    iteration: int
    final_summary: str


# ============================================================
# 2. Safe HTTP Transport for AeroGraph Collector
# ============================================================

class SafeCollectorTransport(httpx.BaseTransport):
    """
    Prevent the application from crashing if the AeroGraph
    collector is offline.

    The workflow continues even when the collector cannot
    be reached.
    """

    def __init__(self, inner: httpx.BaseTransport):
        self.inner = inner

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        try:
            return self.inner.handle_request(request)

        except Exception as exc:
            print(f"[AEROGRAPH] Collector unavailable: {exc}")

            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "status": "collector_offline",
                },
            )


# ============================================================
# 3. Main Workflow
# ============================================================

def main():

    # --------------------------------------------------------
    # Windows UTF-8 support
    # --------------------------------------------------------

    if sys.platform == "win32":
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    print("=" * 60)
    print("🚀 AeroGraph + LangGraph + OpenRouter Python Test Workflow")
    print("=" * 60)
    print()

    # --------------------------------------------------------
    # Environment configuration
    # --------------------------------------------------------

    api_key = os.getenv("OPENROUTER_API_KEY")

    model_name = os.getenv(
        "OPENROUTER_MODEL",
        "openrouter/free",
    )

    collector_url = os.getenv(
        "AEROGRAPH_ENDPOINT",
        "http://localhost:4317",
    )

    # --------------------------------------------------------
    # OpenRouter configuration status
    # --------------------------------------------------------

    if not api_key:

        print(
            "⚠️ [NOTICE] OPENROUTER_API_KEY is not set "
            "in environment or .env."
        )

        print(
            "   To execute live OpenRouter LLM calls, "
            "set OPENROUTER_API_KEY=<your-key>."
        )

        print(
            "   Proceeding with simulated OpenRouter model "
            "responses to verify the full graph flow..."
        )

        print()

    else:

        print(
            f"✅ [CONFIG] Using OpenRouter API Key "
            f"with model: '{model_name}'"
        )

    # ========================================================
    # 4. Initialize AeroGraph Flight Recorder
    # ========================================================

    trace_id = os.getenv("AFR_TRACE_ID") or new_trace_id()

    # HTTP client used by AeroGraph to communicate with
    # the local/remote collector.
    client = httpx.Client(
        timeout=5.0,
        transport=SafeCollectorTransport(
            httpx.HTTPTransport()
        ),
    )

    recorder = FlightRecorder(
        endpoint=collector_url,
        trace_id=trace_id,
        project_id="openrouter-eval-suite",
        environment="development",
        actor={
            "id": "openrouter-langgraph-py",
            "name": "Python LangGraph Agent",
        },
        http_client=client,
    )

    # LangChain callback adapter for AeroGraph.
    handler = AeroGraphCallbackHandler(
        recorder,
        trace_id=trace_id,
    )

    print(
        f"📡 [AEROGRAPH] Initialized FlightRecorder "
        f"for Trace: {trace_id}"
    )

    print(
        f"🔗 [AEROGRAPH] Target Collector: {collector_url}"
    )

    # ========================================================
    # 5. Initialize OpenRouter LLM
    # ========================================================

    llm = None

    if api_key:

        try:

            from langchain_openai import ChatOpenAI

            llm = ChatOpenAI(
                model=model_name,
                api_key=api_key,
                base_url="https://openrouter.ai/api/v1",
                default_headers={
                    "HTTP-Referer": "https://aerograph.dev",
                    "X-Title": "AeroGraph Python Agent Workflow",
                },
                temperature=0.2,
            )

            print("🤖 [LLM] OpenRouter ChatOpenAI initialized.")

        except ImportError:

            print(
                "⚠️ [WARN] langchain-openai is not installed."
            )

            print(
                "   Falling back to simulated LLM responses."
            )

            llm = None

    # ========================================================
    # 6. Node 1 — Planner
    # ========================================================

    def planner_node(
        state: AgentState,
        config: Optional[RunnableConfig] = None,
    ) -> Dict[str, Any]:

        print(
            "\n[Node 1: Planner] "
            "Analyzing query and determining subtasks..."
        )

        prompt_text = (
            "You are an AI research planner.\n\n"
            f'User goal: "{state["query"]}"\n\n'
            "Identify 2 key technical sub-topics to research. "
            "Respond in 2 short bullet points."
        )

        plan_content = ""

        # ----------------------------------------------------
        # Live OpenRouter execution
        # ----------------------------------------------------

        if llm:

            response = llm.invoke(
                [
                    HumanMessage(
                        content=prompt_text
                    )
                ],
                config=config,
            )

            plan_content = (
                response.content
                if isinstance(response.content, str)
                else str(response.content)
            )

        # ----------------------------------------------------
        # Simulated execution
        # ----------------------------------------------------

        else:

            # AeroGraph prompt event
            prompt_span = recorder.prompt(
                parent_span_id=None,
                text=prompt_text,
                model={
                    "name": model_name,
                    "provider": "openrouter",
                },
            )

            plan_content = (
                "- Terrain hazard elevation mapping "
                "via stereoscopic depth cameras\n"
                "- Visual odometry drift compensation "
                "using SLAM loop closure"
            )

            # AeroGraph response event
            recorder.response(
                parent_span_id=prompt_span.spanId,
                text=plan_content,
                model={
                    "name": model_name,
                    "provider": "openrouter",
                },
                usage={
                    "inputTokens": 45,
                    "outputTokens": 30,
                    "totalTokens": 75,
                },
                duration_ms=450,
            )

        formatted_plan = plan_content.replace(
            "\n",
            "\n  ",
        )

        print(
            f"  📋 Plan generated:\n"
            f"  {formatted_plan}"
        )

        return {
            "messages": [
                AIMessage(
                    content=f"Plan: {plan_content}"
                )
            ],

            # Planner has completed one planning iteration.
            "iteration": state["iteration"] + 1,
        }

    # ========================================================
    # 7. Node 2 — Research / Tool Execution
    # ========================================================

    def tool_node(
        state: AgentState,
        config: Optional[RunnableConfig] = None,
    ) -> Dict[str, Any]:

        print(
            "\n[Node 2: Tool Execution] "
            "Querying research database..."
        )

        # ----------------------------------------------------
        # Build research query using planner output
        # ----------------------------------------------------

        research_query = (
            "rover visual odometry SLAM algorithms "
            "stereo depth traversability mapping"
        )

        # ----------------------------------------------------
        # AeroGraph Tool Call
        # ----------------------------------------------------

        call_event = recorder.tool_call(
            parent_span_id=None,
            tool_id="rover_telemetry_database",
            input={
                "query": research_query,
                "filter": "peer_reviewed",
            },
        )

        # ----------------------------------------------------
        # Simulated research database result
        #
        # This is intentionally mocked.
        # Replace this section with the actual database/API
        # when integrating the real research tool.
        # ----------------------------------------------------

        tool_output = {
            "status": "success",
            "recordsRetrieved": 3,
            "findings": [
                (
                    "Stereo Visual Odometry yields 1.2% "
                    "distance drift over 10km traverses."
                ),
                (
                    "Patch-based loop closures prevent "
                    "accumulation of rotational drift."
                ),
                (
                    "Dense elevation maps allow real-time "
                    "traversability assessment under 200ms."
                ),
            ],
        }

        # ----------------------------------------------------
        # AeroGraph Tool Result
        # ----------------------------------------------------

        recorder.tool_result(
            parent_span_id=call_event.spanId,
            tool_id="rover_telemetry_database",
            output=tool_output,
        )

        print(
            f"  🔍 Tool retrieved "
            f"{tool_output['recordsRetrieved']} "
            f"technical telemetry records."
        )

        # ----------------------------------------------------
        # Update LangGraph State
        # ----------------------------------------------------

        return {
            "research_data": {
                "telemetry": tool_output["findings"]
            },

            "iteration": state["iteration"] + 1,
        }

    # ========================================================
    # 8. Node 3 — Evaluator
    # ========================================================

    def evaluator_node(
        state: AgentState,
        config: Optional[RunnableConfig] = None,
    ) -> Dict[str, Any]:

        print(
            "\n[Node 3: Evaluator] "
            "Checking if research data satisfies "
            "technical depth..."
        )

        telemetry = (
            state
            .get("research_data", {})
            .get("telemetry", [])
        )

        has_enough = bool(telemetry)

        # Maximum research iterations.
        max_iterations = 3

        if has_enough:

            decision = "sufficient_data"

        elif state["iteration"] >= max_iterations:

            decision = "sufficient_data"

            print(
                "  ⚠️ Maximum iterations reached. "
                "Proceeding with available data."
            )

        else:

            decision = "needs_refinement"

        print(
            f"  ⚖️ Route decision: "
            f"'{decision}' "
            f"(Iteration: {state['iteration']})"
        )

        # ----------------------------------------------------
        # AeroGraph State Snapshot
        # ----------------------------------------------------

        snapshot_state = {
            "decision": decision,
            "iteration": state["iteration"],
            "dataCount": len(telemetry),
        }

        recorder.state_snapshot(
            node_name="evaluator",
            full_state=snapshot_state,
        )

        # ----------------------------------------------------
        # LangGraph custom event
        # ----------------------------------------------------

        try:

            dispatch_custom_event(
                "langgraph_state_snapshot",
                {
                    "node_name": "evaluator",
                    "full_state": snapshot_state,
                },
                config=config,
            )

        except Exception as exc:

            print(
                f"  ⚠️ Could not dispatch "
                f"LangGraph snapshot event: {exc}"
            )

        return {
            "route_decision": decision
        }

    # ========================================================
    # 9. Node 4 — Synthesizer
    # ========================================================

    def synthesizer_node(
        state: AgentState,
        config: Optional[RunnableConfig] = None,
    ) -> Dict[str, Any]:

        print(
            "\n[Node 4: Synthesizer] "
            "Compiling final grounded synthesis..."
        )

        findings = (
            state
            .get("research_data", {})
            .get("telemetry", [])
        )

        prompt_text = (
            "Synthesize the findings into an executive "
            "technical briefing.\n\n"
            f"Findings: {findings}\n\n"
            "Provide a concise 2-sentence summary."
        )

        synthesis_text = ""

        # ----------------------------------------------------
        # Live OpenRouter execution
        # ----------------------------------------------------

        if llm:

            response = llm.invoke(
                [
                    HumanMessage(
                        content=prompt_text
                    )
                ],
                config=config,
            )

            synthesis_text = (
                response.content
                if isinstance(response.content, str)
                else str(response.content)
            )

        # ----------------------------------------------------
        # Simulated execution
        # ----------------------------------------------------

        else:

            # AeroGraph prompt event
            prompt_span = recorder.prompt(
                parent_span_id=None,
                text=prompt_text,
                model={
                    "name": model_name,
                    "provider": "openrouter",
                },
            )

            synthesis_text = (
                "Autonomous planetary rovers ensure reliable "
                "long-range navigation by combining stereo "
                "visual odometry with real-time traversability "
                "elevation grids to keep drift under 1.2%. "
                "Periodic SLAM loop closures eliminate "
                "rotational bias across multi-kilometer "
                "traverses."
            )

            # AeroGraph response event
            recorder.response(
                parent_span_id=prompt_span.spanId,
                text=synthesis_text,
                model={
                    "name": model_name,
                    "provider": "openrouter",
                },
                usage={
                    "inputTokens": 90,
                    "outputTokens": 50,
                    "totalTokens": 140,
                },
                duration_ms=750,
            )

        # ----------------------------------------------------
        # AeroGraph Human-in-the-Loop Checkpoint
        # ----------------------------------------------------

        recorder.checkpoint(
            checkpoint_id="chk-synthesis-review",
            reason=(
                "Executive briefing ready "
                "for engineer sign-off"
            ),
            state={
                "finalSummaryLength": len(
                    synthesis_text
                )
            },
        )

        # ----------------------------------------------------
        # LangGraph checkpoint event
        # ----------------------------------------------------

        try:

            dispatch_custom_event(
                "langgraph_checkpoint",
                {
                    "checkpoint_id": "chk-synthesis-review",
                    "reason": (
                        "Executive briefing ready "
                        "for engineer sign-off"
                    ),
                    "state": {
                        "finalSummaryLength": len(
                            synthesis_text
                        )
                    },
                },
                config=config,
            )

        except Exception as exc:

            print(
                f"  ⚠️ Could not dispatch "
                f"LangGraph checkpoint event: {exc}"
            )

        print(
            f'  📝 Final Synthesis:\n'
            f'  "{synthesis_text}"'
        )

        return {
            "final_summary": synthesis_text,

            "messages": [
                AIMessage(
                    content=synthesis_text
                )
            ],
        }

    # ========================================================
    # 10. Build the LangGraph StateGraph
    # ========================================================

    workflow = StateGraph(AgentState)

    # Add nodes
    workflow.add_node(
        "planner",
        planner_node,
    )

    workflow.add_node(
        "researcher",
        tool_node,
    )

    workflow.add_node(
        "evaluator",
        evaluator_node,
    )

    workflow.add_node(
        "synthesizer",
        synthesizer_node,
    )

    # --------------------------------------------------------
    # Graph edges
    # --------------------------------------------------------

    workflow.add_edge(
        START,
        "planner",
    )

    workflow.add_edge(
        "planner",
        "researcher",
    )

    workflow.add_edge(
        "researcher",
        "evaluator",
    )

    # --------------------------------------------------------
    # Conditional evaluator routing
    #
    # sufficient_data → synthesizer
    # needs_refinement → researcher
    # --------------------------------------------------------

    workflow.add_conditional_edges(
        "evaluator",

        lambda state: (
            "synthesizer"
            if state["route_decision"]
            == "sufficient_data"
            else "researcher"
        ),

        {
            "synthesizer": "synthesizer",
            "researcher": "researcher",
        },
    )

    workflow.add_edge(
        "synthesizer",
        END,
    )

    # --------------------------------------------------------
    # Compile graph
    # --------------------------------------------------------

    app = workflow.compile()

    # ========================================================
    # 11. Execute Workflow with AeroGraph Tracking
    # ========================================================

    print(
        "\n⚡ [EXECUTION] Invoking Python "
        "LangGraph agent workflow..."
    )

    initial_state: AgentState = {
        "query": (
            "Analyze latest autonomous rover "
            "navigation algorithms and synthesize "
            "a technical summary."
        ),

        "messages": [],

        "research_data": {},

        "route_decision": "pending",

        "iteration": 0,

        "final_summary": "",
    }

    final_state = app.invoke(
        initial_state,

        # AeroGraph callback handler is attached
        # to the entire LangGraph execution.
        config={
            "callbacks": [handler]
        },
    )

    # ========================================================
    # 12. Final Output
    # ========================================================

    print("\n" + "=" * 60)

    print(
        "🎉 Workflow Completed Successfully!"
    )

    print(
        f"📊 Trace ID:        {trace_id}"
    )

    print(
        "🌐 Web Dashboard:   "
        f"http://localhost:5173/?traceId={trace_id}"
    )

    print(
        f"📝 Final Summary:   "
        f"{final_state.get('final_summary', '')}"
    )

    print("=" * 60)

    # --------------------------------------------------------
    # Close HTTP client cleanly
    # --------------------------------------------------------

    client.close()


# ============================================================
# Entry Point
# ============================================================

if __name__ == "__main__":
    main()