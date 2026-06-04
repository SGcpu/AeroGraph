# LangChain Python Integration Example

AeroGraph provides a seamless `AeroGraphCallbackHandler` for LangChain and LangGraph developers in Python. You can continue writing LangChain applications normally and just attach the callback handler to get normalized traces and streaming telemetry.

## Installation

```bash
pip install aerograph-sdk aerograph-langchain langchain-core
```

## Example: Tracing a simple Agent

```python
import asyncio
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool
# (Assuming a mock or actual chat model from langchain_openai etc.)
from aerograph_sdk import FlightRecorder
from aerograph_langchain import AeroGraphCallbackHandler

@tool
def get_weather(city: str) -> str:
    """Get the weather for a given city."""
    return f"It is always sunny in {city}!"

async def run_langchain():
    # 1. Setup the Recorder
    recorder = FlightRecorder(endpoint="http://localhost:4317")
    
    # 2. Setup the LangChain callback handler
    handler = AeroGraphCallbackHandler(recorder)

    # 3. Setup standard LangChain tools and models
    # model = ChatOpenAI(model="gpt-4o")
    # agent = create_tool_calling_agent(model, [get_weather], prompt)
    # agent_executor = AgentExecutor(agent=agent, tools=[get_weather])
    
    # Example direct model invocation with tool
    # await model.ainvoke(
    #     [HumanMessage(content="What is the weather in San Francisco?")],
    #     config={"callbacks": [handler]}
    # )
    print("Agent executed and traces sent to AeroGraph!")

if __name__ == "__main__":
    asyncio.run(run_langchain())
```

## Features Supported

The Python adapter automatically maps:
- `on_llm_start` -> `PromptEvent`
- `on_llm_end` -> `ResponseEvent`
- `on_tool_start` -> `ToolCallEvent`
- `on_tool_end` -> `ToolResultEvent`
- `on_retriever_start` / `on_retriever_end` -> `RetrieverEvent`
- `on_llm_error` / `on_tool_error` / `on_chain_error` -> `ErrorEvent`
- `on_custom_event` -> `StateSnapshotEvent` and `CheckpointEvent` for LangGraph nodes

It also captures streaming telemetry (time-to-first-token and tokens-per-second) automatically when `on_llm_new_token` fires.
