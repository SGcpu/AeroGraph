# aerograph-sdk

The core Python Flight Recorder for emitting normalized trace events from any Python codebase to the AeroGraph collector.

## Overview

AeroGraph is an open-source cognitive observability layer for AI agent workflows. It allows you to record, playback, and visually inspect the deterministic decision-making paths of your agents.

This SDK provides a `FlightRecorder` instance to seamlessly construct and emit strictly validated `TraceEvent` objects.

## Installation

```bash
pip install aerograph-sdk
```

*(Requires Python >= 3.10)*

## Quick Start

```python
from aerograph_sdk import FlightRecorder

# 1. Initialize the recorder
recorder = FlightRecorder(
    endpoint="http://localhost:4317", # AeroGraph Collector URL
    actor={"id": "my-travel-agent", "name": "Travel Planner"},
    project_id="travel-app", # Optional (v1.1.0)
    environment="production" # Optional (v1.1.0)
)

# 2. Emit events
prompt_event = recorder.prompt(
    text="Plan a trip to Tokyo",
    model={"name": "gpt-4o", "provider": "openai"},
    usage={"inputTokens": 10, "totalTokens": 10},
    duration_ms=50
)

response_event = recorder.response(
    parent_span_id=prompt_event.spanId,
    text="Here is your 3-day itinerary...",
    usage={"inputTokens": 10, "outputTokens": 50, "totalTokens": 60},
    duration_ms=2500
)
```

## Async Usage

Every method has an `_async` twin:

```python
await recorder.prompt_async(text="Hello")
```

## Available Event Kinds

The `FlightRecorder` supports 10 canonical event kinds:
- `prompt`: Input sent to an LLM.
- `response`: Output from an LLM.
- `tool_call`: Invocation of a tool.
- `tool_result`: The tool's resulting output.
- `handoff`: Delegating execution from one agent to another.
- `error`: Any exception or system failure.
- `retriever`: RAG retrieval query and source documents.
- `state_snapshot`: A deterministic hash of a LangGraph node's state.
- `checkpoint`: A human-in-the-loop pause.
- `note`: Freeform structured annotations.

## Span Hierarchy

Every event acts as a "span" in the trace tree. To link a child event to a parent event, pass the parent's `spanId` via the `parent_span_id` parameter.

## License
Apache-2.0
