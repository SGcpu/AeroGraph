# Authoring Framework Adapters for AeroGraph

This guide explains how to build framework adapters (e.g., for LangChain, LlamaIndex, CrewAI, AutoGen) that integrate seamlessly with AeroGraph and its deterministic replay capabilities.

## The Replay Inheritance Guarantee

> **Core Principle**: Any adapter emitting canonical `TraceEvent` events gets deterministic zero-cost replay automatically. No replay-specific code or imports are required or permitted in the adapter.

AeroGraph achieves deterministic replay at the transport/proxy level, not at the application framework level:

1. During **Record mode** (`aerorepl record <cmd>` or Orchestrator `POST /v1/runs {mode: "record"}`), outbound HTTP traffic from the agent is proxied through `aerograph-replay-core`. Responses from model providers and tools are captured into a deterministic cassette (`.aerograph/cassettes/<runId>.json`).
2. Telemetry events emitted by the adapter to the Collector (`POST /v1/events` or OTel exporter) are mapped to canonical `TraceEvent` structures.
3. During **Replay mode** (`aerorepl replay <runId>`), the proxy intercepts outbound requests and serves identical matching responses from the cassette cache with sub-5ms latency and zero token cost.
4. Spans in the resulting replay trace are automatically annotated with `replaySource: "cache"`, `tokensSaved`, and `replayLatencyMs`.

## Span Correlation & Network Interception Architecture

### The Span Correlation Challenge
When an agent framework makes external calls (such as completions to OpenAI/Anthropic/OpenRouter, or web requests via tool libraries), two independent streams of observability data are created:
1. **Application-Level Telemetry**: Emitted by your adapter (e.g., LangChain callback handler or OTel tracer) to the AeroGraph Collector (`POST /v1/events` or OTLP), generating `prompt`, `response`, `tool_call`, and `tool_result` spans with unique `spanId`s.
2. **Network-Level Telemetry**: Intercepted by the local Go MITM proxy (`aerograph-replay-core`) via `HTTP_PROXY` / `HTTPS_PROXY`, generating request/response steps in the cassette (`.aerograph/cassettes/<runId>.json`) and an annotation log (`afr_ann_<runId>.json`).

Standard HTTP clients (such as Python `langchain-openai`, `requests`, `httpx`, `urllib3`, or browser/Node `fetch`) **do not propagate custom internal telemetry headers**. As a result, the Go proxy intercepts raw HTTP calls where `X-AeroGraph-Span-Id` is empty, producing annotation entries with an empty `correlatedSpanId`.

### AeroGraph's Dual-Correlation Strategy

AeroGraph resolves this seamlessly through a dual-correlation strategy:

#### 1. Header Injection (Explicit O(1) Correlation)
If your adapter controls the HTTP client instance or provides a custom HTTP transport/session wrapper (for example, in custom SDK clients, Axios interceptors, or custom httpx transports):
- Inject the active span ID as an HTTP header:
  ```http
  X-AeroGraph-Span-Id: <spanId>
  ```
- The Go proxy extracts this header directly in `http.go` (`req.Header.Get("X-AeroGraph-Span-Id")`) and attaches it to the `AnnotationEntry.CorrelatedSpanId`.
- This provides exact, instantaneous $O(1)$ correlation between the network request and the trace span.

#### 2. Automatic Sequential Correlation (Built-in Fallback)
For standard adapters where modifying the underlying HTTP client is impractical or undesirable:
- AeroGraph's Runner implements **sequential fallback correlation** in `ingestAnnotations()`.
- The Runner loads the trace's `prompt` and `response` spans in chronological order:
  - Annotation entry `i` is correlated with `promptEvents[i]` (the request) and `responseEvents[i]` (the completion).
  - The spans are enriched with `replaySource` (`"cache"` vs `"live"`), `decision` (`"cache_hit"`, `"must_execute"`, `"fallback"`, `"live_record"`), `replayLatencyMs`, and `requestKey`.
- Any remaining spans in a `replay` run default to `replaySource: "cache"`, while in a `record` run they default to `"live"`.

#### 3. Tool Safety Policy Annotation
For all `tool_call` and `tool_result` spans:
- The Runner inspects the active `aerograph.replay.yaml` tool policy rules.
- Matches tool spans by `toolName` or URL pattern:
  - Rules marked `class: "replay_safe"` receive `effectiveClass: "replay_safe"`, `decision: "cache_hit"`, and badge `🟢 REPLAY SAFE` / `⚡ CACHE`.
  - Rules marked `class: "must_execute"` (or unlisted tools under default-deny safety) receive `effectiveClass: "must_execute"`, `decision: "must_execute"`, and badge `🔴 MUST EXECUTE` / `🌐 LIVE`.

---

## Automatic Runtime Environment Detection & Registration

When developers execute agents directly from their terminal or IDE (e.g., `python agent.py` or `node agent.js`) without running through the CLI wrapper (`aerorepl record`), AeroGraph needs to know the process's working directory, virtual environment, and execution command so that subsequent **"Replay"** or **"Fork & Resume"** actions from the Web UI can re-execute the agent accurately in its original environment.

### The Direct Execution Telemetry Pattern

Every SDK and adapter emitter (Python `aerograph_sdk`, TypeScript `@aerograph/sdk`, or any future language SDK) must implement automatic background runtime metadata collection and registration:

1. **Collect Environment Context**:
   - `projectRoot`: Current working directory (`os.getcwd()` in Python, `process.cwd()` in Node).
   - `virtualEnv`: Active virtual environment path (`os.environ.get("VIRTUAL_ENV")` or `CONDA_PREFIX`, or Python `sys.prefix` if isolated).
   - `executablePath`: Active interpreter binary path (`sys.executable` in Python, `process.execPath` in Node).
   - `entrypoint`: Relative path from `projectRoot` to the executing script entrypoint.
   - `command`: Re-executable command array (e.g., `["python", "agent.py", ...]` or `["node", "agent.js", ...]`).

2. **Register Once per Trace (Non-Blocking)**:
   On the first event emitted for a trace (or during SDK recorder initialization), emit an asynchronous, non-blocking HTTP `POST` to the Collector:
   ```http
   POST /v1/traces/{traceId}/runtime-metadata
   Content-Type: application/json

   {
     "projectRoot": "/path/to/my-agent",
     "virtualEnv": "/path/to/my-agent/.venv",
     "executablePath": "/path/to/my-agent/.venv/bin/python",
     "entrypoint": "agent.py",
     "command": ["python", "agent.py"]
   }
   ```
   - This registration **must be non-blocking** and swallowed on failure so agent workflows never fail if the collector is slow or unreachable.
   - Can be disabled via the environment variable `AEROGRAPH_CAPTURE_RUNTIME=false`.

---

## Authoring Checklist for New Adapters

When contributing or maintaining adapters (e.g. for LangChain, LlamaIndex, AutoGen, CrewAI, Haystack):

1. **Emit Canonical `TraceEvent`s**: Use `@aerograph/sdk` in TypeScript or `aerograph_sdk` in Python. Map framework lifecycle events to the standard 10 event kinds: `prompt`, `response`, `tool_call`, `tool_result`, `retriever`, `checkpoint`, `state_snapshot`, `note`, `handoff`, `error`.
2. **Never Import Replay Binaries**: Adapters must remain pure telemetry emitters. Do not import cassette logic or proxy handlers into the adapter codebase.
3. **Preserve Causal Hierarchy**: Always set `parentSpanId` so parent-child relationships between chains, LLMs, and tools form a coherent DAG.
4. **Header Hook (Optional & Encouraged)**: If the framework allows injecting default headers into LLM/tool HTTP clients, forward `X-AeroGraph-Span-Id` during the span's execution window.
5. **Runtime Environment Detection**: Ensure the underlying FlightRecorder registers `_collect_runtime_metadata` to `/v1/traces/:id/runtime-metadata` so standalone executions (`python agent.py` / `node agent.js`) can be replayed from the UI.
6. **Project Configuration Support**: Support running with `.aerograph/aerograph.project.yaml` and `aerograph.replay.yaml`.

See the [Deterministic Replay Getting Started](../replay/getting-started.md) and [Tool Safety Policy](../replay/safety-policy.md) for full reference.

