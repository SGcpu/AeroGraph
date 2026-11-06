# 📖 AeroGraph: The Complete Developer Integration Manual

> **AeroGraph** is the open-source flight recorder and time-travel debugging layer for autonomous AI agents.  
> This manual guides you step-by-step through integrating AeroGraph into any Python or TypeScript agent project, configuring deterministic replay, and mastering all CLI and Web commands.

---

## Table of Contents

1. [Architecture & Quick Mental Model](#1-architecture--quick-mental-model)
2. [Prerequisites & Setting Up AeroGraph Core](#2-prerequisites--setting-up-aerograph-core)
3. [Instrumenting Your Agent Application](#3-instrumenting-your-agent-application)
   - [Option A: Python + LangGraph / LangChain](#option-a-python--langgraph--langchain)
   - [Option B: TypeScript / Node.js + LangChain](#option-b-typescript--nodejs--langchain)
   - [Option C: Standalone SDK (Framework-Agnostic / Custom Code)](#option-c-standalone-sdk-framework-agnostic--custom-code)
   - [Option D: OpenTelemetry Native Bridge (AutoGen, CrewAI, OTLP)](#option-d-opentelemetry-native-bridge-autogen-crewai-otlp)
4. [Deterministic Replay & Time-Travel Execution](#4-deterministic-replay--time-travel-execution)
   - [Step 1: Record an Agent Run](#step-1-record-an-agent-run)
   - [Step 2: Replay at Zero Cost ($0.00)](#step-2-replay-at-zero-cost-000)
   - [Step 3: Interactive Stepping & Prompt Overrides (`aerorepl session`)](#step-3-interactive-stepping--prompt-overrides-aerorepl-session)
   - [Step 4: One-Click "Fork & Resume" from the Web UI](#step-4-one-click-fork--resume-from-the-web-ui)
5. [Tool Safety Policies (`aerograph.replay.yaml`)](#5-tool-safety-policies-aerographreplayyaml)
6. [Zero-File Project Binding (`aerograph.project.yaml`)](#6-zero-file-project-binding-aerographprojectyaml)
7. [Complete CLI Command Reference (`aerorepl`)](#7-complete-cli-command-reference-aerorepl)
8. [REST API Endpoints Reference](#8-rest-api-endpoints-reference)
9. [Verification, Health Checks & Troubleshooting](#9-verification-health-checks--troubleshooting)

---

## 1. Architecture & Quick Mental Model

When you integrate AeroGraph, two simple components interact:

```
┌────────────────────────────────────────────────────────┐
│                   YOUR AGENT APP                       │
│    (Python or Node.js: LangGraph, CrewAI, AutoGen)     │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
   1. Telemetry Events (Spans)     2. Outbound HTTP/HTTPS
 (prompts, responses, state hops)   (OpenAI, Anthropic, Tools)
               │                          │
               ▼                          ▼
┌──────────────────────────────┐  ┌──────────────────────┐
│     AeroGraph Collector      │  │  Go MITM Replay Core │
│      (Port 4317 / 4318)      │  │    (Port 8080/auto)  │
│  - Stores traces in SQLite   │  │  - Records cassettes │
│  - Analyzes loop tripwires   │  │  - Replays at <5ms   │
│  - Calculates dual tokens    │  │  - Zero private keys │
└──────────────┬───────────────┘  └──────────────────────┘
               │
               ▼
┌──────────────────────────────┐
│     AeroGraph Web UI         │
│         (Port 5173)          │
│  - Dual-edge trace canvas    │
│  - 1-click Fork & Resume     │
│  - Myers trace diffing       │
└──────────────────────────────┘
```

- **In "Record Mode"**: Your agent executes normally. AeroGraph captures the trace timeline and records network payloads into a local cassette (`.aerograph/cassettes/<runId>.json`).
- **In "Strict Replay Mode"**: Outgoing calls are intercepted and served directly from the local cassette in **<5ms with $0.00 token cost**.
- **In "Fork & Resume Mode"**: Pre-fork steps are served instantly from cache ($0.00); post-fork steps run live with your modified prompt or updated logic.

---

## 2. Prerequisites & Setting Up AeroGraph Core

### Requirements
- **Node.js**: `≥ 18.18.0` (LTS recommended)
- **Go**: `≥ 1.21` (for building the MITM replay core)
- **Python**: `≥ 3.10` with `uv` or `pip`

### Step 1: Clone and Build the AeroGraph Core Engine

```bash
git clone https://github.com/SGcpu/AeroGraph.git
cd AeroGraph

# 1. Install Node workspace dependencies
npm install

# 2. Compile contracts, adapters, and packages
npm run build

# 3. Compile the Go MITM Replay Core
# On Windows:
cd packages/replay-core && go build -o bin/aerograph-replay-core.exe main.go && cd ../..
# On Linux / macOS:
cd packages/replay-core && go build -o bin/aerograph-replay-core main.go && cd ../..
```

### Step 2: Start the Collector & Web UI Services

Open two terminals:

```bash
# Terminal 1: Start the Collector (port 4317) & Orchestrator (port 4318)
npm run dev -w apps/collector

# Terminal 2: Start the Web UI (port 5173)
npm run dev -w apps/web
```

Open **`http://localhost:5173`** in your browser. The flight recorder interface is now live and waiting for trace events.

---

## 3. Instrumenting Your Agent Application

Choose the method matching your agent's language and framework:

---

### Option A: Python + LangGraph / LangChain

Install the Python packages:

```bash
pip install aerograph-sdk aerograph-langchain
# Or via uv:
uv pip install -e python/aerograph-sdk -e python/aerograph-langchain
```

Add the `AeroGraphCallbackHandler` to your agent script:

```python
import os
from langgraph.graph import StateGraph, START, END
from aerograph_sdk import FlightRecorder, new_trace_id
from aerograph_langchain import AeroGraphCallbackHandler

# 1. Initialize FlightRecorder
trace_id = os.getenv("AFR_TRACE_ID") or new_trace_id()
recorder = FlightRecorder(
    endpoint=os.getenv("AEROGRAPH_ENDPOINT", "http://localhost:4317"),
    trace_id=trace_id,
    project_id="my-agent-project",
    environment="development",
    actor={"id": "python-agent", "name": "Research Agent"}
)

# 2. Wrap recorder in the LangChain callback handler
handler = AeroGraphCallbackHandler(recorder, trace_id=trace_id)

# 3. Pass callback into your chain or LangGraph invocation
app = workflow.compile()
response = app.invoke(
    {"query": "Analyze visual odometry drift"},
    config={"callbacks": [handler]}
)
```

**What AeroGraph Captures Automatically:**
- Every LangGraph node boundary (`planner`, `evaluator`, `tool_node`).
- Input/Output state transitions (`state_before` vs `state_update`).
- All child prompts, LLM completion tokens, tool calls, and results.
- LangGraph conditional routing decisions (e.g. `branch:to:researcher`).

---

### Option B: TypeScript / Node.js + LangChain

Install the TypeScript packages:

```bash
npm install @aerograph/sdk @aerograph/adapter-langchain
```

Add the `AeroGraphCallbackHandler`:

```typescript
import { FlightRecorder, newTraceId } from "@aerograph/sdk";
import { AeroGraphCallbackHandler } from "@aerograph/adapter-langchain";

// 1. Initialize FlightRecorder
const traceId = process.env.AFR_TRACE_ID ?? newTraceId();
const recorder = new FlightRecorder({
  endpoint: process.env.AEROGRAPH_ENDPOINT ?? "http://localhost:4317",
  traceId,
  projectId: "my-node-agent",
  environment: "development",
  actor: { id: "node-agent", name: "Node Pipeline" }
});

// 2. Wrap recorder in callback handler
const handler = new AeroGraphCallbackHandler(recorder, { traceId });

// 3. Attach handler to runnable or chain config
const result = await myChain.invoke(
  { input: "Synthesize findings" },
  { callbacks: [handler] }
);
```

---

### Option C: Standalone SDK (Framework-Agnostic / Custom Code)

If you are using raw `openai`, `anthropic`, or custom HTTP APIs without LangChain:

#### Python:
```python
from aerograph_sdk import FlightRecorder, new_trace_id

recorder = FlightRecorder(endpoint="http://localhost:4317", trace_id=new_trace_id())

# 1. Log a prompt
prompt_span = recorder.prompt(
    text="You are a research assistant. Summarize...",
    model={"name": "gpt-4o", "provider": "openai"}
)

# 2. Execute your model call (OpenAI, Anthropic, etc.)
# ...

# 3. Log the response
recorder.response(
    parent_span_id=prompt_span.span_id,
    text="Here is the summary...",
    model={"name": "gpt-4o", "provider": "openai"},
    usage={"inputTokens": 45, "outputTokens": 30, "totalTokens": 75},
    duration_ms=420
)

# 4. Log tool execution
tool_span = recorder.tool_call(tool_id="search_api", input={"query": "rover telemetry"})
# execute search...
recorder.tool_result(parent_span_id=tool_span.span_id, tool_id="search_api", output={"results": [...]})
```

#### TypeScript:
```typescript
import { FlightRecorder, newTraceId } from "@aerograph/sdk";

const recorder = new FlightRecorder({ endpoint: "http://localhost:4317", traceId: newTraceId() });

const prompt = await recorder.prompt({
  text: "Extract order ID",
  model: { name: "claude-3-5-sonnet", provider: "anthropic" }
});

await recorder.response({
  parentSpanId: prompt.spanId,
  text: "Order #84920",
  model: { name: "claude-3-5-sonnet", provider: "anthropic" },
  usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
  durationMs: 350
});
```

---

### Option D: OpenTelemetry Native Bridge (AutoGen, CrewAI, OTLP)

If your agent framework already emits OpenTelemetry spans (e.g. Microsoft AutoGen with OTLP):

```bash
# Point your framework's standard OTel exporter directly to AeroGraph:
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317/v1/otlp"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/json"
```

AeroGraph's collector natively ingests standard OTLP JSON spans via `/v1/otlp/traces`, automatically converting them into canonical AeroGraph events.

---

## 4. Deterministic Replay & Time-Travel Execution

AeroGraph's command line tool `aerorepl` controls recording and replaying.

### Step 1: Record an Agent Run

Run your agent with `aerorepl record`:

```bash
npx aerorepl record -- python agent.py
# Or for Node.js:
npx aerorepl record -- npm start
```

**What happens:**
1. AeroGraph launches the Go MITM Proxy on an ephemeral port.
2. It sets `HTTP_PROXY`, `HTTPS_PROXY`, and `SSL_CERT_FILE` in the sub-process environment.
3. Every outbound model completion and API call is captured to `.aerograph/cassettes/<runId>.json`.
4. The output outputs the assigned `runId` and `traceId`.

> [!TIP]
> **Writing Replay-Ready Agent Scripts:**
> * **Pass Inputs via Arguments/Environment Variables**: Background/Web UI runners are non-interactive. Avoid bare `input()` calls which throw `EOFError`. Accept inputs via `sys.argv` or `os.getenv("AGENT_QUERY")` with a fallback default.
> * **Do Not Overwrite Proxy Certificates**: AeroGraph sets `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` to trust the local MITM proxy. Avoid unconditionally doing `os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()` in your code, as this breaks proxy TLS verification.

---

### Step 2: Replay at Zero Cost ($0.00)

Replay the recorded run without touching live network APIs:

```bash
npx aerorepl replay <runId>
```

**What happens:**
- Network requests are intercepted and served directly from the cassette cache.
- **Latency drops from ~30 seconds to ~300ms (80–100x speedup)**.
- **Token cost is $0.00 (0 live tokens billed)**.
- In the Web UI, the trace receives a `▶ STRICT REPLAY` badge and displays `100% saved`.

---

### Step 3: Interactive Stepping & Prompt Overrides (`aerorepl session`)

To debug an agent step-by-step in your terminal:

```bash
npx aerorepl session <runId>
```

Inside the interactive REPL:

```
aerorepl [run_1234] > /step
Executed Step 1: planner (planner_node) -> ChatOpenAI (Prompt: "Identify 2 subtasks")

aerorepl [run_1234] > /inspect span_abcd1234
{
  "type": "prompt",
  "text": "Identify 2 subtasks",
  "model": "gpt-4o"
}

aerorepl [run_1234] > /override span_abcd1234 "Identify 4 subtasks with high priority"
[OVERRIDE APPLIED] Next execution of span_abcd1234 will inject this prompt.

aerorepl [run_1234] > /fork span_abcd1234
[FORK STARTED] Pre-fork steps replayed from cassette. Step 2 running live with overridden prompt.
New child run: run_5678 (Trace: tr_child_999)
```

---

### Step 4: One-Click "Fork & Resume" from the Web UI

1. Open **`http://localhost:5173`** and click on any trace.
2. Click any node in the graph (e.g. `planner` or `researcher`).
3. Click the **⑂ Fork and Resume** button.
4. A modal appears with the exact prompt/input payload. Edit the text to test an alternative reasoning branch.
5. Click **Run Fork**:
   - Pre-fork steps are served from cache at **$0.00**.
   - Post-fork steps execute live with your modified prompt.
   - The UI automatically displays the **Myers Diff Overlay**, highlighting exactly where the child trace diverged.
6. Click **[ ⚖ Compare with Base ]** to view delta cards:
   - **Tokens Delta**: `▼ -350 tokens`
   - **Duration Delta**: `▼ -28.4s`
   - **Loop Status**: `✓ Loop resolved!`

---

## 5. Tool Safety Policies (`aerograph.replay.yaml`)

When replaying an agent, you want LLM completions cached, but what about tools that have real-world side effects (like charging Stripe, sending emails, or deleting files)?

Define your policy in `aerograph.replay.yaml` in your project root:

```yaml
version: "1.0.0"

# Safety rules for external network requests
tools:
  # 1. Safe tools: Cached from cassette (zero network hits)
  - pattern: "api.openrouter.ai"
    class: "replay_safe"

  - pattern: "api.openai.com"
    class: "replay_safe"

  - pattern: "*/telemetry/search"
    class: "replay_safe"

  # 2. Side-effect tools: MUST execute live even during replay
  - pattern: "api.stripe.com/*"
    class: "must_execute"

  - pattern: "hooks.slack.com/*"
    class: "must_execute"

# Guardrail thresholds
tripwires:
  max_iterations: 5      # Flag recursive agent loops
  max_tokens: 50000      # Kill run if context explodes
```

- **`replay_safe`**: Request is served 100% from cassette. Zero network cost.
- **`must_execute`**: Replay proxy passes the request live to the internet, recording the new response.

---

## 6. Zero-File Project Binding (`aerograph.project.yaml`)

AeroGraph never forces you to clutter your repository root with configuration files.

You can set and bind your project command directly via the CLI:

```bash
# Auto-bind your agent command to .aerograph/aerograph.project.yaml:
npx aerorepl config set uv run agent.py
# Or:
npx aerorepl config set npm run start
```

Or view active settings:

```bash
npx aerorepl config get
```

Or paste configuration directly into the terminal:

```bash
npx aerorepl config paste
# Paste your YAML lines and type END on a new line
```

---

## 7. Complete CLI Command Reference (`aerorepl`)

| Command | Usage | Description |
| :--- | :--- | :--- |
| `record` | `npx aerorepl record -- <command...>` | Launches the command wrapped with the replay proxy, recording all model & tool calls to cassette. |
| `replay` | `npx aerorepl replay <runId>` | Replays a run deterministically from cassette at zero cost ($0.00) with sub-5ms steps. |
| `session` | `npx aerorepl session <runId>` | Starts an interactive debugging REPL for stepping, payload inspection, and prompt overrides. |
| `list` | `npx aerorepl list` | Lists all recorded agent runs with run ID, trace ID, timestamp, and step count. |
| `show` | `npx aerorepl show <runId>` | Displays detailed summary of a specific run (spans, execution mode, duration, token usage). |
| `config get` | `npx aerorepl config get` | Prints current project execution command and active tool safety policies. |
| `config set` | `npx aerorepl config set <command...>` | Sets the agent execution command in `.aerograph/aerograph.project.yaml`. |
| `config paste`| `npx aerorepl config paste [file]` | Pastes or imports YAML configuration, auto-detecting project command vs safety policy. |
| `diff` | `npx aerorepl diff <runIdA> <runIdB>` | Terminal Myers diff comparing two execution traces, showing added/removed spans. |

### Interactive Session Commands (Inside `/session`)

| Session Command | Arguments | Description |
| :--- | :--- | :--- |
| `/step` | *none* | Advances the agent execution by one span step. |
| `/inspect` | `<spanId>` | Prints the complete JSON payload (prompt, response, state, tokens) for a span. |
| `/override` | `<spanId> <text>` | Overrides a prompt on the fly (accepts raw string, multi-line JSON, or `@file.json`). |
| `/rewind` | `[count]` | Rewinds execution back by $N$ steps. |
| `/fork` | `<spanId>` | Creates an alternate timeline starting from `<spanId>`, running pre-fork from cache. |
| `/history` | *none* | Prints chronological history of all steps executed in this session. |
| `/status` | *none* | Prints active session run ID, trace ID, and step counter. |
| `/quit` | *none* | Terminates the interactive session cleanly. |

---

## 8. REST API Endpoints Reference

If you are building custom dashboards or CI pipelines, the Collector (`http://localhost:4317`) and Orchestrator (`http://localhost:4318`) expose standard REST APIs:

### Telemetry & Query Endpoints (Port 4317)
- `POST /v1/events`: Ingests canonical trace events (JSON array).
- `GET /traces`: Lists all traces (filters: `?projectId=`, `?environment=`, `?search=`).
- `GET /traces/:id`: Retrieves full event timeline for a trace.
- `GET /traces/:id/lineage`: Returns ancestry tree (`parentTrace`, `childTraces`, `siblings`).
- `GET /traces/:id/stats`: Returns token analytics, live vs cached spend, and savings percentage.
- `GET /traces/:id/analysis`: Returns detected loops, cycle counts, and proxy routing summary.
- `GET /diff/traces?a=<idA>&b=<idB>`: Executes Myers structural diff between two traces.

### Orchestrator Endpoints (Port 4318)
- `POST /v1/runs`: Spawns a background agent run (`mode: "record" | "replay" | "fork"`).
- `GET /v1/runs/:id`: Returns status and live output of a running agent process.
- `POST /v1/sessions`: Starts an interactive REPL session.
- `POST /v1/sessions/:id/step`: Advances interactive session one step.
- `POST /v1/sessions/:id/override`: Sets a dynamic wire-level prompt override.
- `POST /v1/sessions/:id/fork`: Forks session into a new derived run.

---

## 9. Verification, Health Checks & Troubleshooting

### Health Checks

Check if services are running:

```bash
# Check Collector Health:
curl http://localhost:4317/health
# Output: {"status":"ok","service":"aerograph-collector"}

# Check Orchestrator Health:
curl http://localhost:4318/health
# Output: {"status":"ok","service":"aerograph-orchestrator"}
```

### Pre-Push Verification Suite

Before committing or pushing agent updates to your repository:

```bash
# 1. Verify schema governance (zero drift)
npm run drift:check

# 2. Run Ephemeral Security Scanner (verifies no raw API keys or private keys)
npm run security:check

# 3. Run monorepo tests
npm test
npm run test:integration
```

### Troubleshooting Common Issues

1. **`Cannot find module '@aerograph/contracts/dist/index.js'`**
   - **Fix**: Run `npm run build` in the repository root. This compiles all TypeScript packages to their `dist/` directories.
2. **`listen EADDRINUSE: address already in use :::4317`**
   - **Fix**: Another collector instance is already running on port 4317. Check running background tasks or terminate existing node processes.
3. **`Proxy certificate warning / untrusted CA`**
   - **Fix**: AeroGraph automatically injects `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS` when using `aerorepl record`. If running custom scripts manually, ensure your HTTP client respects system proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`).
4. **`Cassette contains sensitive API keys`**
   - **Fix**: Run `npm run security:check`. AeroGraph's cassette recorder automatically replaces `Authorization: Bearer ...` and `X-Api-Key` headers with `[REDACTED]`. Never disable redaction filters.
