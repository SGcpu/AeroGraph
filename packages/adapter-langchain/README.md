# @aerograph/adapter-langchain

This adapter bridges LangChain.js workflows into the AeroGraph.

## Deterministic Mapping

LangChain's complex callback hierarchy is deterministically mapped to the minimal Flight Recorder contracts as follows:

| LangChain Callback | AFR Event Kind | Metadata Mapped |
|---|---|---|
| `handleLLMStart` | `prompt` | messages/prompts, `model.name`, parentSpanId, runId -> spanId |
| `handleLLMEnd` | `response` | generations, streaming metrics, `usage` tokens, `durationMs`, runId -> spanId |
| `handleLLMError` | `error` | error message, `durationMs`, runId -> spanId |
| `handleToolStart` | `tool_call` | input string/JSON, runId -> spanId |
| `handleToolEnd` | `tool_result` | output, `durationMs`, runId -> spanId |
| `handleToolError` | `error` | error message, `durationMs`, runId -> spanId |
| `handleChainEnd` | `note` | emits `payload.event = "chain_end"` and includes output key summary |

## Installation

```bash
npm install @aerograph/adapter-langchain @aerograph/sdk
```

*(Requires Node.js >= 18.18.0)*

## Quick Start

The adapter provides a callback handler that you inject into your LangChain invocations.

```typescript
import { FlightRecorder } from "@aerograph/sdk";
import { AeroGraphCallbackHandler } from "@aerograph/adapter-langchain";
import { ChatOpenAI } from "@langchain/openai";

const recorder = new FlightRecorder({
  endpoint: "http://localhost:4317",
  actor: { id: "my-langchain-agent" }
});

const handler = new AeroGraphCallbackHandler(recorder);
const model = new ChatOpenAI({ modelName: "gpt-4" });

// The handler automatically maps LangChain callbacks to AeroGraph events
await model.invoke("Hello, how are you?", {
  callbacks: [handler]
});
```

## Supported Features
- LLM Call Tracking (Prompts & Responses)
- Streaming Telemetry (TTFT, tokens/sec)
- RAG Retriever Document Payloads
- Tool Calls & Results
- LangGraph State Snapshots

## License
Apache-2.0
| `handleAgentAction`| *(ignored)* | Caught by tool/llm events |

For Phase 1 MVP, we focus strictly on LLMs and Tools plus lightweight chain boundary notes to keep the graph comprehensible.
