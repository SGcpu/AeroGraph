"""
AeroGraph Example: Autonomous AI Travel Planner Agent (LangGraph + Python)
===========================================================================

This example demonstrates how an AI developer can integrate AeroGraph into
a multi-step LangGraph workflow with zero intrusion.

Features Demonstrated:
1. Automated, non-blocking input handling (safe for CLI, headless runs, and Web UI).
2. Windows UTF-8 stdout reconfiguration (safe printing of emojis like ✈️, 🏨, 📝).
3. AeroGraph FlightRecorder + AeroGraphCallbackHandler for full trace observability.
4. Deterministic replay and time-travel forking via AeroGraph's network proxy.
"""

import sys
import os
from typing import TypedDict, List
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# 1. Best Practice: Windows UTF-8 Console Encoding Guard
# ---------------------------------------------------------------------------
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Load local environment variables (.env)
load_dotenv()

# LangChain & LangGraph imports
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END

# AeroGraph Observability SDK & Callback Handler
from aerograph_sdk import FlightRecorder, new_trace_id
from aerograph_langchain import AeroGraphCallbackHandler


# ---------------------------------------------------------------------------
# 2. Define the Agent State
# ---------------------------------------------------------------------------
class TravelState(TypedDict):
    user_query: str
    destination: str
    duration_days: int
    hotel_options: str
    itinerary: str
    messages: List[BaseMessage]


# ---------------------------------------------------------------------------
# 3. Initialize the LLM (OpenRouter / OpenAI compatible)
# ---------------------------------------------------------------------------
api_key = os.getenv("OPENROUTER_API_KEY")
base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
model_name = os.getenv("OPENROUTER_MODEL", "openrouter/free")

llm = None
if api_key:
    try:
        llm = ChatOpenAI(
            model=model_name,
            api_key=api_key,
            base_url=base_url,
            default_headers={
                "HTTP-Referer": "https://aerograph.dev",
                "X-Title": "AeroGraph AI Travel Planner",
            },
            temperature=0.3,
        )
        print(f"🤖 [LLM] Initialized ChatOpenAI with model: {model_name}")
    except Exception as e:
        print(f"⚠️ [LLM] Could not initialize ChatOpenAI ({e}). Using mock responses.")


# ---------------------------------------------------------------------------
# 4. Define Graph Nodes (Planner, Hotel Agent, Itinerary Synthesizer)
# ---------------------------------------------------------------------------
def planner_node(state: TravelState) -> dict:
    """Node 1: Extract destination and duration from the user query."""
    query = state["user_query"]
    print(f"\n🗺️  [Step 1: Planner] Analyzing travel request: '{query}'")

    if llm:
        prompt = (
            f"Analyze this travel request: '{query}'. "
            "Extract: Destination city/region, duration in days, and trip style. "
            "Keep your response concise in 2 sentences."
        )
        response = llm.invoke([HumanMessage(content=prompt)])
        plan_summary = response.content
    else:
        plan_summary = f"Trip to {query}: Estimated 3 days duration covering top scenic landmarks."

    print(f"   📋 Plan Summary: {plan_summary}")
    return {
        "destination": query,
        "duration_days": 3,
        "messages": [AIMessage(content=f"Plan created: {plan_summary}")],
    }


def hotel_search_node(state: TravelState) -> dict:
    """Node 2: Search and recommend top hotels."""
    destination = state["destination"]
    print(f"\n🏨 [Step 2: Hotel Search] Finding top accommodations for '{destination}'")

    if llm:
        prompt = (
            f"Recommend 2 top hotels for a trip to '{destination}'. "
            "Include hotel name, estimated price tier (Budget/Luxury), and key feature. "
            "Keep response under 4 lines."
        )
        response = llm.invoke([HumanMessage(content=prompt)])
        hotel_data = response.content
    else:
        hotel_data = "1. Grand Heritage Resort ($$$) - Lake View\n2. Pine Valley Inn ($$) - City Center"

    print(f"   🏨 Recommended Hotels:\n{hotel_data}")
    return {
        "hotel_options": hotel_data,
        "messages": [AIMessage(content=f"Hotels found: {hotel_data}")],
    }


def itinerary_synthesizer_node(state: TravelState) -> dict:
    """Node 3: Synthesize day-by-day itinerary."""
    query = state["user_query"]
    hotels = state["hotel_options"]
    print(f"\n📝 [Step 3: Itinerary Synthesizer] Compiling finalized travel schedule")

    if llm:
        prompt = (
            f"Create a practical, budget-aware day-by-day travel itinerary based on:\n"
            f"Request: {query}\n"
            f"Hotel Options:\n{hotels}\n"
            "Format cleanly with Day 1, Day 2, Day 3 bullet points."
        )
        response = llm.invoke([HumanMessage(content=prompt)])
        itinerary = response.content
    else:
        itinerary = (
            "Day 1: Arrival, check-in, scenic evening walk and local dining.\n"
            "Day 2: Full-day guided sightseeing and historical landmarks.\n"
            "Day 3: Souvenir shopping, leisure exploration, and departure."
        )

    print(f"   ✈️  Finalized Itinerary generated ({len(itinerary)} characters)")
    return {
        "itinerary": itinerary,
        "messages": [AIMessage(content=itinerary)],
    }


# ---------------------------------------------------------------------------
# 5. Build the LangGraph Workflow
# ---------------------------------------------------------------------------
builder = StateGraph(TravelState)

builder.add_node("planner", planner_node)
builder.add_node("hotel_search", hotel_search_node)
builder.add_node("itinerary_synthesizer", itinerary_synthesizer_node)

builder.add_edge(START, "planner")
builder.add_edge("planner", "hotel_search")
builder.add_edge("hotel_search", "itinerary_synthesizer")
builder.add_edge("itinerary_synthesizer", END)

travel_graph = builder.compile()


# ---------------------------------------------------------------------------
# 6. Main Execution with AeroGraph Instrumentation
# ---------------------------------------------------------------------------
def main():
    # Best Practice: Non-blocking input (supports CLI args, env var, or fallback)
    if len(sys.argv) > 1:
        user_query = " ".join(sys.argv[1:])
    elif os.getenv("TRAVEL_QUERY"):
        user_query = os.getenv("TRAVEL_QUERY")
    elif sys.stdin.isatty():
        user_query = input("Enter travel request: ")
    else:
        user_query = "Plan a 3-day trip to Kashmir from Mumbai"

    print("=" * 65)
    print("🚀 AeroGraph LangGraph Travel Planner")
    print(f"📍 Request: {user_query}")
    print("=" * 65)

    # 1. Initialize AeroGraph FlightRecorder
    # AeroGraph automatically injects AFR_TRACE_ID when running in record or fork mode
    trace_id = os.getenv("AFR_TRACE_ID") or new_trace_id()
    collector_endpoint = os.getenv("AEROGRAPH_ENDPOINT", "http://localhost:4317")

    recorder = FlightRecorder(
        endpoint=collector_endpoint,
        trace_id=trace_id,
        project_id="travel-planner",
        environment="development",
        actor={"id": "travel-agent", "name": "AI Travel Planner"},
    )

    # 2. Wrap recorder with AeroGraph's LangChain callback handler
    handler = AeroGraphCallbackHandler(recorder, trace_id=trace_id)

    initial_state: TravelState = {
        "user_query": user_query,
        "destination": "",
        "duration_days": 0,
        "hotel_options": "",
        "itinerary": "",
        "messages": [HumanMessage(content=user_query)],
    }

    # 3. Invoke LangGraph with the AeroGraph callback handler attached!
    result = travel_graph.invoke(
        initial_state,
        config={"callbacks": [handler]},
    )

    print("\n" + "=" * 65)
    print("🎉 FINAL TRAVEL ITINERARY")
    print("=" * 65)
    print(result.get("itinerary"))
    print("=" * 65)
    print(f"✨ Trace recorded to AeroGraph Collector: {trace_id}")


if __name__ == "__main__":
    main()

