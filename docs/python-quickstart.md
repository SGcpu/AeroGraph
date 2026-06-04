# Python SDK Quickstart

The AeroGraph Python SDK allows you to easily trace and visualize AI agent execution flows natively from Python. 

## Installation

Install the core SDK package via pip:

```bash
pip install aerograph-sdk
```

If you are using LangChain, also install the adapter:

```bash
pip install aerograph-langchain
```

## Basic SDK Usage

Here is a simple example using the Python SDK directly:

```python
import asyncio
from aerograph_sdk import FlightRecorder
from aerograph_sdk.ids import new_trace_id

async def run_agent():
    # Initialize the recorder with your collector endpoint
    recorder = FlightRecorder(endpoint="http://localhost:4317")
    
    # Generate a trace ID
    trace_id = new_trace_id()
    
    # 1. Emit a Prompt
    root_span = recorder.new_span_id()
    await recorder.prompt_async(
        parent_span_id=None,
        span_id=root_span,
        text="Plan a 3-day trip to Tokyo",
        trace_id=trace_id
    )
    
    # 2. Emit a Tool Call
    tool_span = recorder.new_span_id()
    await recorder.tool_call_async(
        parent_span_id=root_span,
        span_id=tool_span,
        tool_id="search_flights",
        input={"origin": "SFO", "destination": "HND"},
        trace_id=trace_id
    )
    
    # 3. Emit a Tool Result
    await recorder.tool_result_async(
        parent_span_id=tool_span,
        tool_id="search_flights",
        output={"cheapestPrice": 842, "currency": "USD"},
        trace_id=trace_id
    )
    
    # 4. Emit a Response
    await recorder.response_async(
        parent_span_id=root_span,
        text="I found an itinerary that fits your budget.",
        trace_id=trace_id
    )

if __name__ == "__main__":
    asyncio.run(run_agent())
```

## Running the Collector

Ensure the AeroGraph collector is running locally:

```bash
cd packages/collector
npm run start
```

Now you can inspect `http://localhost:4317/v1/traces` to see your emitted traces!
