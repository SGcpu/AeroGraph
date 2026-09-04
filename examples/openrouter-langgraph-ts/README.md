# OpenRouter + LangGraph TypeScript Example

This example demonstrates a complete, robust agent workflow built with **LangGraph.js**, **LangChain**, and **OpenRouter**, fully instrumented with **AeroGraph**.

It showcases all AeroGraph observability and deterministic replay capabilities in a single runnable project:
- **LLM Prompts & Responses**: Uses OpenRouter (`openrouter/free` or configurable model) with token usage and streaming telemetry.
- **Tools**: Captures explicit tool calls and tool results with timing and structured inputs/outputs.
- **LangGraph Multi-Node Tracking**: Automatic node boundary extraction (`state_before` vs `state_update`).
- **Conditional Branching**: Shows route decision badges on graph edges.
- **State Snapshots & Checkpoints**: Emits deterministic SHA-256 state hashes (`stateHash`) and human approval pause points.
- **Deterministic Replay**: Ready to record with `aerorepl` and replay with zero token cost (<5ms).

---

## Prerequisites

1. **AeroGraph Collector Running**:
   ```bash
   npm run dev -w apps/collector
   ```
2. **(Optional) OpenRouter API Key**:
   Set your OpenRouter key in the environment or in `.env`:
   ```bash
   export OPENROUTER_API_KEY=sk-or-v1-...
   # Optional: specify a free or preferred model:
   export OPENROUTER_MODEL=openrouter/free
   ```
   *(Note: If `OPENROUTER_API_KEY` is not provided, the script runs in simulated model mode so you can test the full graph and telemetry immediately).*

---

## Running the Workflow

### Direct Execution
```bash
# Run from repository root:
npx tsx examples/openrouter-langgraph-ts/src/index.ts
```

### Record with `aerorepl`
Record all network calls into a content-addressed cassette:
```bash
cd examples/openrouter-langgraph-ts
aerorepl record npx tsx src/index.ts
```
This saves an exact cassette into `.aerograph/cassettes/<runId>.json`.

### Replay with Zero Cost
Re-run the workflow with external LLM calls fulfilled from cache:
```bash
aerorepl replay <runId>
```
Execution finishes in under 50ms with 0 token spend!

### One-Click Fork-and-Resume
1. Open the Web Dashboard: `http://localhost:5173`.
2. Select any node in the trace graph.
3. Click **⑂ Fork and Resume**, tweak the prompt or query, and watch AeroGraph replay up to that step and execute the remainder live, rendering the side-by-side Myers divergence diff.
