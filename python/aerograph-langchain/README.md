# aerograph-langchain

LangChain callback adapter for [AeroGraph](https://github.com/SGcpu/AeroGraph).

Automatically records LangChain chain, LLM, tool, and retriever events as AeroGraph trace events.

## Installation

When published, you can install the adapter via pip:

```bash
pip install aerograph-langchain
```

For local testing or development, install the packages in editable mode from the repository root:

```bash
# Install the core SDK first
pip install -e python/aerograph-sdk

# Install the LangChain adapter
pip install -e python/aerograph-langchain
```

## Usage

Integrating `AeroGraphCallbackHandler` into your existing LangChain codebase is simple. Setup a `FlightRecorder`, initialize the handler, and pass it to your chain or model invocations.

### Basic Example

```python
import asyncio
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from aerograph_sdk.recorder import FlightRecorder
from aerograph_langchain.handler import AeroGraphCallbackHandler

async def main():
    # 1. Initialize the FlightRecorder pointing to your collector
    recorder = FlightRecorder(
        endpoint="http://localhost:4317",
        actor={"id": "my-agent", "name": "TravelPlanner"}
    )

    # 2. Initialize the AeroGraph callback handler
    handler = AeroGraphCallbackHandler(recorder)

    # 3. Create your LangChain chat model
    model = ChatOpenAI(model="gpt-4o")

    # 4. Invoke the model and pass the handler in callbacks
    response = await model.ainvoke(
        [HumanMessage(content="What are 3 fun things to do in San Francisco?")],
        config={"callbacks": [handler]}
    )
    print(response.content)

if __name__ == "__main__":
    asyncio.run(main())
```

### Advanced Usage with Chains and RAG

You can attach the callback handler at the chain execution level. LangChain automatically propagates the callbacks down to all sub-chains, LLMs, retrievers, and tool invocations.

```python
# Pass the handler to the chain invoke call
result = rag_chain.invoke(
    "How do I configure the server?",
    config={"callbacks": [handler]}
)
```

## Features and Event Mapping

The callback adapter automatically intercepts LangChain execution signals and translates them to canonical AeroGraph `TraceEvent` types:

- **LLM/Chat Starts** (`on_llm_start`, `on_chat_model_start`) $\rightarrow$ `PromptEvent`
- **LLM Ends** (`on_llm_end`) $\rightarrow$ `ResponseEvent` (includes streaming telemetry completion metrics: TTFT and tokens/sec when tokens are streamed)
- **Tool Starts** (`on_tool_start`) $\rightarrow$ `ToolCallEvent`
- **Tool Ends** (`on_tool_end`) $\rightarrow$ `ToolResultEvent`
- **Retriever Runs** (`on_retriever_start`, `on_retriever_end`) $\rightarrow$ `RetrieverEvent` (captures source documents, queries, and metadata)
- **Errors** (`on_llm_error`, `on_tool_error`, `on_chain_error`) $\rightarrow$ `ErrorEvent`
- **Custom Events** (`on_custom_event`) $\rightarrow$ `StateSnapshotEvent` and `CheckpointEvent` for LangGraph nodes

## License

Apache-2.0
