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
| `handleChainStart` / `handleChainEnd` | `note` | Detects LangGraph node boundaries (`kind: "langgraph_node"`), capturing `state_before` (Inputs) and `state_update` (Outputs) |

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
## Replay Support

Replay support is inherited automatically — no replay-specific code is required in your adapter.

When executing an agent workflow under AeroGraph record mode (`aerorepl record <cmd>` or Orchestrator `POST /v1/runs {mode: "record"}`), HTTP traffic is intercepted and cached in a deterministic cassette. Replaying or forking that workflow transparently serves cached responses to the adapter without requiring any changes or replay imports in your adapter code. See [Replay Getting Started](../../docs/replay/getting-started.md) for details.

### Span Correlation
When outbound HTTP clients permit custom header injection, `X-AeroGraph-Span-Id: <spanId>` is attached to correlate network interactions with specific trace spans. When client libraries do not expose header hooks, the proxy seamlessly employs a deterministic timestamp-window fallback to correlate cassette entries.

## License
Apache-2.0
| `handleAgentAction`| *(ignored)* | Caught by tool/llm events |

For Phase 1 MVP, we focus strictly on LLMs and Tools plus lightweight chain boundary notes to keep the graph comprehensible.

