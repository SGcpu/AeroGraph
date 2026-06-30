# @aerograph/sdk

The core Node.js Flight Recorder for emitting normalized trace events from any JavaScript/TypeScript codebase to the AeroGraph collector.

## Overview

AeroGraph is an open-source cognitive observability layer for AI agent workflows. It allows you to record, playback, and visually inspect the deterministic decision-making paths of your agents.

This SDK provides a `FlightRecorder` instance to seamlessly construct and emit strictly validated `TraceEvent` objects.

## Installation

```bash
npm install @aerograph/sdk
```

*(Requires Node.js >= 18.18.0)*

## Quick Start

```typescript
import { FlightRecorder } from "@aerograph/sdk";

// 1. Initialize the recorder
const recorder = new FlightRecorder({
  endpoint: "http://localhost:4317", // AeroGraph Collector URL
  actor: {
    id: "my-travel-agent",
    name: "Travel Planner",
  },
  projectId: "travel-app", // Optional (v1.1.0)
  environment: "production" // Optional (v1.1.0)
});

// 2. Emit events
const promptEvent = await recorder.prompt({
  text: "Plan a trip to Tokyo",
  // Optional v1.1.0 canonical telemetry
  model: { name: "gpt-4o", provider: "openai" },
  usage: { inputTokens: 10, totalTokens: 10 },
  durationMs: 50
});

const responseEvent = await recorder.response({
  parentSpanId: promptEvent.spanId,
  text: "Here is your 3-day itinerary...",
  usage: { inputTokens: 10, outputTokens: 50, totalTokens: 60 },
  durationMs: 2500
});
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

Every event acts as a "span" in the trace tree. To link a child event to a parent event, pass the parent's `spanId` via the `parentSpanId` parameter:

```typescript
const root = await recorder.prompt({ text: "root prompt" });
const child = await recorder.tool_call({ 
  parentSpanId: root.spanId, 
  toolId: "search", 
  input: { q: "query" } 
});
```

## License
Apache-2.0
