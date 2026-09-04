# Authoring Framework Adapters for AeroGraph

This guide explains how to build framework adapters (e.g., for LangChain, LlamaIndex, CrewAI, AutoGen) that integrate seamlessly with AeroGraph and its deterministic replay capabilities.

## The Replay Inheritance Guarantee

> **Core Principle**: Any adapter emitting canonical `TraceEvent` events gets deterministic zero-cost replay automatically. No replay-specific code or imports are required or permitted in the adapter.

AeroGraph achieves deterministic replay at the transport/proxy level, not at the application framework level:

1. During **Record mode** (`aerorepl record <cmd>` or Orchestrator `POST /v1/runs {mode: "record"}`), outbound HTTP traffic from the agent is proxied through `aerograph-replay-core`. Responses from model providers and tools are captured into a deterministic cassette (`.aerograph/cassettes/<runId>.json`).
2. Telemetry events emitted by the adapter to the Collector (`POST /v1/events` or OTel exporter) are mapped to canonical `TraceEvent` structures.
3. During **Replay mode** (`aerorepl replay <runId>`), the proxy intercepts outbound requests and serves identical matching responses from the cassette cache with sub-5ms latency and zero token cost.
4. Spans in the resulting replay trace are automatically annotated with `replaySource: "cache"`, `tokensSaved`, and `replayLatencyMs`.

## Authoring Rules for Adapters

When writing an adapter:

1. **Emit Canonical `TraceEvent`s**: Use `@aerograph/sdk` (`FlightRecorder`) in TypeScript or `aerograph_sdk` in Python. Map framework-specific events (e.g., prompt start, response end, tool call, tool result) to standard AFR event kinds (`prompt`, `response`, `tool_call`, `tool_result`, `note`, `error`).
2. **DO NOT import replay modules**: Adapters must never import or reference replay binaries, cassettes, or caching logic.
3. **Preserve Span Hierarchy**: Maintain `spanId` and `parentSpanId` causality links so that traces form directed acyclic graphs (DAGs).
4. **Project Configuration**: Ensure `aerograph.project.yaml` is present at the project root to specify agent launch commands and proxy settings:
   ```yaml
   version: "1.0.0"
   command:
     - python
     - agent.py
   collectorUrl: "http://127.0.0.1:4317"
   orchestratorUrl: "http://127.0.0.1:4318"
   ```
5. **Tool Safety Policy**: Define URL safety classifications in `aerograph.replay.yaml` (`replay_safe` vs. `must_execute`) to control whether tool requests replay from cache or execute live during replay and fork runs.

See the [Deterministic Replay Getting Started](../replay/getting-started.md) and [Tool Safety Policy](../replay/safety-policy.md) for complete end-to-end workflows.
