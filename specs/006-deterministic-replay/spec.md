# Feature Specification: Deterministic Replay for AeroGraph via agrepl Integration

**Feature Branch**: `006-deterministic-replay`

**Created**: 2026-09-01

**Status**: Draft

**Input**: Integration of `agrepl` (MIT-licensed, Go-based MITM proxy record/replay engine) with `AeroGraph` (TypeScript/Python semantic trace graph platform) to deliver deterministic, zero-cost replay, automatic fork-and-resume, tool-safety categorization, and an interactive REPL — with a new Replay Orchestrator as the connective tissue between the two systems.

---

## Overview

AeroGraph today is a **pure observation platform**: it records what an AI agent did, renders it as a visual DAG, and lets developers inspect failures. It does **not** re-execute anything, does not cache LLM/tool calls, and its existing "Fork from here" feature requires the developer to manually copy a trace ID back into their own code and re-run their agent from their terminal.

`agrepl` is a real, independently developed, MIT-licensed Go CLI that solves the complementary problem: it intercepts all outbound HTTP traffic from a process via a local MITM proxy, records every (request, response) pair to a JSON cassette, and can replay any prior run with zero network calls and zero token cost — with empirically proven fidelity (F = 1.0, 98.3% median latency reduction across 250 replay instances).

**This feature closes the gap**: it integrates `agrepl` as AeroGraph's execution substrate for record and replay, adds a new thin **Replay Orchestrator** service to coordinate between the two systems, and extends AeroGraph's UI and collector to make replay and fork-and-resume fully automatic — no manual developer steps required.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Zero-Cost Replay of a Past Run (Priority: P1)

A developer ran their LangChain agent yesterday, spent $2.40 in LLM tokens, and found a bug. Today they want to re-run that exact same agent against the same inputs to reproduce the failure and iterate on a fix — **without spending any more tokens and without waiting for API latency on every step**.

They open the AeroGraph web UI, find the trace from yesterday, and click **"Replay"**. The agent re-executes immediately. Every LLM call and tool call that was made in the original run is served from the locally stored cassette — no network requests leave the machine. The UI shows the same trace DAG as before, but each span is badged as **"replayed · $0.00 · <Nms"** instead of showing live cost and latency. The developer can now iterate on their fix rapidly, replaying as many times as needed.

**Why this priority**: This is the foundational, highest-value capability. It directly eliminates per-debugging-session token cost and makes the iteration loop near-instant. All other scenarios depend on this substrate working correctly.

**Independent Test**: Can be fully tested by recording a single-agent run, modifying nothing, clicking "Replay" in the UI, and verifying that (a) no outbound network requests were made, (b) the trace DAG is semantically identical to the original, and (c) every span carries a "replayed" badge with $0.00 cost.

**Acceptance Scenarios**:

1. **Given** a previously recorded AeroGraph trace, **When** the developer clicks "Replay" on that trace in the web UI, **Then** the agent re-executes with all LLM/tool responses served from the cassette, producing a new trace DAG that is semantically identical to the original, with every span marked as `replaySource: "cache"` and zero live network calls.

2. **Given** a replay is in progress, **When** any span completes, **Then** the UI updates in real time exactly as it does for a live run — the replay is visually indistinguishable from a live run except for the "replayed" badge and the $0.00 cost annotation.

3. **Given** the recorded cassette is intact, **When** replay is triggered, **Then** median per-step hydration time is under 5ms (based on the empirically validated 0.9ms median from the agrepl benchmark, with headroom for orchestration overhead).

4. **Given** a cassette that was recorded with streaming LLM responses, **When** replay is triggered, **Then** the streamed chunks are replayed in order and AeroGraph's streaming telemetry (TTFT, tokens/sec) is preserved accurately.

5. **Given** a replay is triggered, **When** a request in the agent run does not match any entry in the cassette (e.g. the developer changed a prompt slightly before replaying), **Then** the system falls back to a live network call for that request and continues replay for all subsequent matched requests, logging the fallback clearly on the span.

---

### User Story 2 — Fork-and-Resume from a Specific Trace Step (Priority: P2)

A developer is inspecting a failed 20-step agent run in AeroGraph. They can see the agent went wrong at step 12 — it was passed a poorly phrased prompt. The developer edits that prompt directly in the AeroGraph UI node inspector and clicks **"Fork and resume"**.

AeroGraph automatically: creates a new trace (linked to the original via lineage), replays steps 1–11 from the cassette at zero cost, then fires the edited prompt live at step 12, and continues executing steps 13–20 live. The developer never touches their terminal. The result is a new, fully independent trace DAG showing both the original (failed) run and the forked (corrected) run side by side, with Myers diff highlighting what changed.

**Why this priority**: This turns AeroGraph's existing but incomplete "Fork from here" feature into a genuinely automated one-click operation. It requires the replay substrate (P1) to already work.

**Independent Test**: Can be fully tested by recording a multi-step agent run, editing a prompt at an intermediate step in the UI, clicking "Fork and resume," and verifying that (a) steps before the fork point are served from cache, (b) the fork step and all subsequent steps execute live, (c) a new linked trace appears in the UI with the correct `derivedFrom` lineage pointer.

**Acceptance Scenarios**:

1. **Given** a recorded multi-step trace, **When** the developer selects a step, edits its prompt in the UI node inspector, and clicks "Fork and resume," **Then** a new trace is created with a `derivedFrom` pointer to the parent trace ID, steps before the fork point are marked `replaySource: "cache"`, and steps from the fork point onwards are marked `replaySource: "live"`.

2. **Given** a fork-and-resume is triggered, **When** the forked agent process starts, **Then** no manual developer action (pasting a trace ID, running a terminal command) is required — the entire re-invocation is handled automatically by the system.

3. **Given** a fork-and-resume completes, **When** the developer views the traces list, **Then** both the original trace and the forked trace appear linked by lineage, and the web UI's diff panel shows the Myers diff between the two traces highlighting divergence from the fork step.

4. **Given** an agent that uses deeply nested LangGraph state at the fork point, **When** the developer triggers fork-and-resume, **Then** the system warns with a specific, actionable message if prompt substitution cannot be fully automated for that framework, rather than silently producing incorrect behavior.

5. **Given** the fork-and-resume is in progress, **When** a `must_execute`-classified tool call is encountered in the pre-fork cached portion, **Then** that specific call is executed live (not served from cache), and the system logs this override clearly on the span.

---

### User Story 3 — Tool Safety: Replay-Safe vs. Must-Execute Classification (Priority: P2)

A developer is debugging an agent that calls both OpenAI (idempotent — safe to replay from cache) and SendGrid (side-effecting — sends real emails). Without safety classification, replaying the trace would silently re-send emails every time the developer iterates, which is dangerous.

The developer creates an `aerograph.replay.yaml` config file in their project root mapping URL patterns to safety classes. When they replay or fork, AeroGraph reads this config and ensures that `must_execute`-classified calls always go live, while `replay_safe`-classified calls are served from cache. Any URL pattern not listed in the config defaults to `must_execute` for safety. Every live vs. cached routing decision is logged explicitly in the AeroGraph UI for auditability.

**Why this priority**: Safety classification is the highest-risk correctness requirement. A misclassified tool could silently skip critical side effects. The safe default (`must_execute` for unlisted patterns) makes this fail-safe.

**Independent Test**: Can be fully tested by creating an `aerograph.replay.yaml` with one `replay_safe` and one `must_execute` entry, triggering a replay, and verifying (a) the `replay_safe` call is served from cache and (b) the `must_execute` call triggers a real network request — verifiable via network traffic monitoring or mock interceptor assertions.

**Acceptance Scenarios**:

1. **Given** an `aerograph.replay.yaml` file with URL patterns classified as `replay_safe` or `must_execute`, **When** a replay or fork-and-resume is triggered, **Then** each outbound request is routed according to its matching class: `replay_safe` → served from cassette, `must_execute` → always forwarded live.

2. **Given** an outbound request whose URL does not match any pattern in `aerograph.replay.yaml`, **When** replay or fork-and-resume is triggered, **Then** the request is treated as `must_execute` (live) and a warning is surfaced in the AeroGraph UI: "This request was not classified — defaulting to must_execute. Add it to aerograph.replay.yaml to suppress this warning."

3. **Given** a replay or fork-and-resume run, **When** any routing decision is made (cache hit, cache miss, must_execute override), **Then** the decision is recorded as an annotation on the corresponding AeroGraph span, showing: decision type, matched URL pattern (or "no match"), and the effective class applied.

4. **Given** an `aerograph.replay.yaml` that is malformed or missing, **When** replay is triggered, **Then** the system refuses to proceed and displays a clear, actionable error message — it does not silently default to an unsafe mode.

5. **Given** a `must_execute`-classified URL pattern, **When** the system is running in a network-isolated environment, **Then** the system warns the developer before starting the replay that one or more `must_execute` calls cannot be served from cache and will require network access.

---

### User Story 4 — Interactive Terminal REPL (aerorepl) (Priority: P3)

A developer prefers a terminal-first workflow. They use the `aerorepl` CLI to inspect, navigate, and control agent replay sessions without opening a browser. They can step through a replay one step at a time, inspect span payloads, override responses for specific steps to test alternative outcomes, rewind N steps to re-run from a different point, and fork directly from a terminal command.

All `aerorepl` commands are backed by the same Replay Orchestrator API that powers the web UI — `aerorepl` is a thin terminal client, not a separate implementation of replay logic. Every operation available in the terminal is also available in the UI, and vice versa.

**Why this priority**: The REPL provides significant value for terminal-first developers and CI/CD workflows, but requires the Orchestrator (P1/P2) and tool-safety policy (P2) to exist first.

**Independent Test**: Can be fully tested by running `aerorepl replay <run-id>`, stepping through a recorded run one step at a time, inspecting a span payload, and verifying the output matches what is shown in the AeroGraph web UI for the same span.

**Acceptance Scenarios**:

1. **Given** a running `aerorepl` session attached to a recorded run, **When** the developer executes `/step`, **Then** the next step in the replay executes and the terminal outputs the span summary (span ID, kind, duration, cache/live badge, cost saved).

2. **Given** a running `aerorepl` session, **When** the developer executes `/inspect <span-id>`, **Then** the terminal outputs the full request and response payload for that span, formatted as pretty-printed JSON.

3. **Given** a running `aerorepl` session, **When** the developer executes `/override <span-id> <json-value>`, **Then** subsequent replay steps that depend on that span's output receive the overridden value instead of the cached value, and the affected spans are marked `overridden: true` in the resulting trace.

4. **Given** a running `aerorepl` session, **When** the developer executes `/rewind 3`, **Then** the session rolls back 3 steps and the developer can re-step forward from that point, producing a new trace fork linked by lineage.

5. **Given** a running `aerorepl` session, **When** the developer executes `/fork <span-id>`, **Then** a new trace is created from that point forward exactly as the web UI's "Fork and resume" would, with the same safety policy enforced.

---

### User Story 5 — Framework-Agnostic Adapter Authoring (Priority: P3)

A developer wants to add replay support for a new AI framework (e.g., CrewAI) that does not yet have an AeroGraph adapter. They follow the existing adapter authoring guide, create a new adapter package mirroring the LangChain adapter's structure, and emit the standard AeroGraph event schema.

Because `agrepl` operates at the network transport layer (not the SDK layer), the new adapter **automatically gets zero-cost replay support** the moment it is registered with the Replay Orchestrator — with zero replay-specific code in the adapter itself.

**Why this priority**: This validates the framework-agnostic architectural claim. It depends on P1 (replay substrate). Real-world value is delivered when new frameworks are onboarded; the P3 priority reflects that core infrastructure comes first.

**Independent Test**: Can be fully tested by writing a minimal stub adapter that emits at least one `tool_call` event, wrapping a stub process in record mode, and verifying that the stub process's outbound HTTP calls are captured and can be replayed at zero cost without any replay-specific code in the adapter.

**Acceptance Scenarios**:

1. **Given** a new AeroGraph adapter that correctly emits events per the canonical event schema, **When** the agent process using that adapter is run under the Replay Orchestrator, **Then** all outbound HTTP/HTTPS calls are intercepted and recorded, and replay works without any changes to the adapter code.

2. **Given** an adapter author following the published adapter authoring guide, **When** they register their adapter with the Replay Orchestrator, **Then** the adapter documentation explicitly states: "Replay support is inherited automatically — no replay-specific code is required in your adapter."

3. **Given** a new adapter's agent run, **When** the run is recorded and replayed, **Then** the AeroGraph UI correctly renders the semantic trace DAG using the new adapter's event mappings, with correct "replayed" badges on all spans.

---

### Edge Cases

- **Cassette file missing or corrupted**: The Replay Orchestrator detects this before starting the agent process, refuses to begin, and returns a specific error: "Cassette for run `<id>` is missing or unreadable. Re-record this run before replaying." The agent process is never started in a degraded state.
- **Agent process crashes mid-replay**: The orchestrator captures the exit code and stderr, surfaces the crash in the AeroGraph UI as an `error` span at the point of failure, and persists all spans captured up to that point. The partial trace is flagged `status: crashed`.
- **`must_execute` call fails during replay (external API down)**: The orchestrator propagates the real error to the agent process — it does not substitute a cached response. The resulting span is marked `replaySource: "live" · status: error`. The agent's own error handling is not bypassed.
- **Streaming LLM response stored as single body**: If individual chunks cannot be preserved, the cassette entry is stored with `streamingPreserved: false` and the UI warns that TTFT/tokens-per-second metrics from this replay are not representative.
- **Two concurrent replays of the same cassette**: Each replay session gets its own isolated process group and output trace ID. The cassette is read-only during replay and never locked or mutated, so concurrent replays are safe.
- **Overlapping URL patterns in `aerograph.replay.yaml`**: The first matching rule (top-to-bottom) applies, consistent with standard routing convention. The applied rule is logged on each span.
- **Cassette recorded on a different machine (e.g., via `agrepl pull`)**: The cassette is portable (pure JSON). The Replay Orchestrator treats it identically to a local cassette, provided `aerograph.replay.yaml` is also present on the replaying machine.
- **Agent process uses gRPC or HTTP/2**: Out of scope. The system detects non-HTTP/1.1 traffic at record time and surfaces a warning: "This run contains gRPC/HTTP2 traffic that cannot be recorded. Those calls will always execute live during replay."

---

## Requirements *(mandatory)*

### Functional Requirements

#### Replay Orchestrator (New Component)

- **FR-001**: The system MUST provide a Replay Orchestrator service that can launch an agent process wrapped by the record/replay proxy, manage the full process lifecycle (start, monitor, terminate), and produce a linked AeroGraph trace as output.
- **FR-002**: The Replay Orchestrator MUST accept a command template (the agent's invocation command) and a run mode (`record`, `replay`, or `fork`) as its primary inputs.
- **FR-003**: The Replay Orchestrator MUST inject a correlation identifier into each outbound request from the wrapped agent process so that each network-layer request can be matched 1-to-1 to the AeroGraph semantic span that triggered it.
- **FR-004**: After each run completes, the Replay Orchestrator MUST ingest the network-layer cassette into the AeroGraph collector as span annotations: `replaySource` (`"cache"` or `"live"`), `latencyMs`, `requestKey`, and `tokensSaved`.
- **FR-005**: The Replay Orchestrator MUST expose a local HTTP API with at minimum: `POST /v1/runs` (start record/replay run), `GET /v1/runs/:id` (get run status), `POST /v1/traces/:traceId/replay` (trigger full replay), `POST /v1/traces/:traceId/fork-and-resume` (trigger fork-and-resume from a specific span).
- **FR-006**: The Replay Orchestrator MUST be deployable as a local sidecar process on the developer's machine. It MUST NOT require any cloud infrastructure, message queues, or Kubernetes in its primary self-hosted deployment mode.

#### Record

- **FR-007**: The system MUST record all outbound HTTP/HTTPS requests made by a wrapped agent process to a locally stored cassette, without requiring any code changes to the agent, its framework, or its SDK.
- **FR-008**: Each recorded cassette MUST be stored in a stable, human-readable, version-control-friendly format (structured JSON, one file per run) under `.aerograph/cassettes/<run-id>.json`.
- **FR-009**: Cassette entries MUST be keyed by a content-derived hash of `(HTTP method, normalized URL, request body hash)` — not by sequence position — so that replay is order-independent lookup. **[REVISED — Build Target]** The SHA-256 hashed matcher must be implemented in the `aerograph-replay-core` fork; the upstream codebase uses a linear `DeepEqual` scan (`pkg/interceptor/http.go`, `pkg/interceptor/llm.go`). Sub-100ms p95 lookup latency at 200+ steps is a requirement this integration must build and benchmark, not inherit.
- **FR-010**: Streaming LLM responses (SSE/chunked transfer encoding) MUST be recorded with individual chunks preserved so they can be replayed in order. If a framework's streaming format cannot be stored chunk-by-chunk, the cassette entry MUST record `streamingPreserved: false` and the AeroGraph UI MUST surface a warning that streaming telemetry metrics from this replay are not representative. **[REVISED — Confirmed Build Target]** Upstream agrepl buffers full response bodies via `ioutil.ReadAll` and does not intercept `GenerateContentStream`. SSE passthrough and stream interception must be built in the fork before Orchestrator development.

#### Replay (Scenario A — Zero-Cost)

- **FR-011**: The system MUST replay a previously recorded run by serving all matched requests from the cassette with zero outbound network calls, producing a new AeroGraph trace with every span marked `replaySource: "cache"`.
- **FR-012**: During replay, any request whose content-derived hash does not match any cassette entry MUST be handled according to the tool safety policy: forwarded live if fallback mode is active, or cause the replay to fail with a clear error message if strict mode is active.
- **FR-013**: The AeroGraph web UI MUST display replay-sourced spans with a visible "Replayed · $0.00 · `<Nms>`" badge, clearly distinguishing them from live spans.
- **FR-014**: The replay action MUST be triggerable directly from the AeroGraph web UI (one click on a recorded trace), without the developer opening a terminal or running any commands.

#### Fork-and-Resume (Scenario B)

- **FR-015**: The AeroGraph web UI MUST extend its existing "Fork from here" action to include a "Fork and resume" mode that: creates a new trace, generates a filtered cassette containing only the steps up to the fork point, and re-invokes the agent process via the Replay Orchestrator automatically.
- **FR-016**: During a fork-and-resume run, steps before the fork point MUST be served from cache; the edited step and all steps after it MUST execute live if their request hashes no longer match the cassette.
- **FR-017**: The forked trace MUST carry a `derivedFrom` field referencing the parent trace ID, preserving lineage exactly as the current AeroGraph fork mechanism already does.
- **FR-018**: The web UI diff panel MUST surface the Myers diff between the parent and forked traces, highlighting divergence starting at the fork step.
- **FR-019**: Where prompt substitution cannot be fully automated for a given framework (e.g., deeply nested LangGraph state), the system MUST surface a specific, actionable warning message rather than silently producing incorrect behavior.

#### Tool Safety Policy

- **FR-020**: The system MUST support a project-level configuration file (`aerograph.replay.yaml`) that maps URL patterns (glob) and/or tool names to a safety class: `replay_safe` or `must_execute`.
- **FR-021**: During any replay or fork-and-resume, `must_execute`-classified requests MUST always be forwarded live to the real endpoint, regardless of whether a matching cassette entry exists.
- **FR-022**: Any request whose URL does not match any pattern in `aerograph.replay.yaml` MUST default to `must_execute` (live). This default MUST NOT be configurable to `replay_safe` at the global level.
- **FR-023**: The first matching rule in `aerograph.replay.yaml` (top-to-bottom) MUST apply to any given request.
- **FR-024**: If `aerograph.replay.yaml` is absent or malformed when a replay or fork-and-resume is triggered, the system MUST refuse to start and return a clear, actionable error. It MUST NOT proceed silently in a degraded mode.
- **FR-025**: Every routing decision (cache hit, cache miss, must_execute override, fallback) MUST be logged as an annotation on the corresponding AeroGraph span, including: decision type, matched URL pattern (or "no match"), and the effective safety class applied.
- **FR-026**: A published JSON Schema for `aerograph.replay.yaml` MUST be provided for IDE autocomplete and validation.

#### Interactive REPL (`aerorepl`) (Scenario D)

- **FR-027**: A standalone CLI tool named `aerorepl` MUST be provided, connecting to the Replay Orchestrator's local HTTP API, exposing: `/list`, `/replay <run-id>`, `/step`, `/inspect <span-id>`, `/override <span-id> <json-value>`, `/rewind <N>`, `/fork <span-id>`.
- **FR-028**: `aerorepl` MUST be implemented as a thin client of the Replay Orchestrator API — it MUST NOT contain any independent implementation of replay logic. The web UI and `aerorepl` MUST share the same backend behavior for all replay operations.
- **FR-029**: The `/override` command MUST record the overridden span value in the resulting trace so the override is auditable after the session.
- **FR-030**: The `/rewind N` command MUST produce a new trace fork (with a `derivedFrom` lineage pointer) rather than mutating the existing trace in place.

#### Schema & Contracts

- **FR-031**: The AeroGraph event schema MUST be extended with the following new optional/nullable fields on span records: `replaySource` (`"cache" | "live" | null`), `requestKey` (string), `tokensSaved` (number), `latencyMs` (number), `streamingPreserved` (boolean). The existing `derivedFrom` field MUST be verified present and documented.
- **FR-032**: All new schema fields MUST be added via the canonical schema definition (never as ad-hoc fields in individual services) and MUST include forward/backward compatibility tests per Constitution Principle I.
- **FR-033**: The AeroGraph collector MUST expose two new API endpoints consistent with the existing REST contract style: `POST /v1/traces/:id/replay` and `POST /v1/traces/:id/fork-and-resume`.

#### agrepl Vendoring, Fork Scope & Security (Updated)

- **FR-034**: The `agrepl` binary MUST be vendored as a pinned fork (`aerograph-replay-core`) within the AeroGraph monorepo, rather than depending on the upstream binary directly.
- **FR-035**: The vendored fork MUST add a `--live-hosts <pattern,...>` flag (or equivalent per-host passthrough mechanism) to the proxy layer, enabling individual host patterns to be forced live even during a full replay run.
- **FR-036**: The per-host passthrough change MUST be proposed as a contribution to the upstream `Taiwrash/agrepl` project after internal validation.
- **FR-037 [NEW — NON-NEGOTIABLE, gates Phase 2]**: **CA Key Hygiene.** The `aerograph-replay-core` fork MUST be modified so that the MITM CA private key is **never persisted to disk after a session ends**, whether the session exits cleanly or is interrupted. Required changes: (a) use in-memory CA where possible; where disk is unavoidable, write to `os.MkdirTemp` and wipe after execution; (b) add deferred `os.RemoveAll` in `cmd/record.go` and `cmd/replay.go`; (c) add `SIGINT`/`SIGTERM` traps to guarantee cleanup on interrupt. **The Orchestrator MUST NOT invoke `aerograph-replay-core` unattended until FR-037 is implemented and re-audited.** The upstream maintainer MUST be notified of this vulnerability independently.
- **FR-038 [NEW — Streaming Build Dependency]**: The vendored fork MUST implement chunked/SSE passthrough in the HTTP interceptor (replacing `ioutil.ReadAll`) and add `GenerateContentStream` interception to `pkg/interceptor/llm.go`. This is a confirmed build dependency sequenced before Orchestrator development, as it blocks AeroGraph's streaming telemetry (TTFT, tokens/sec) for all replay paths.

---

### Key Entities

- **Run**: A single execution of an agent process under the Replay Orchestrator. Has a mode (`record`, `replay`, `fork`), a status (`running`, `completed`, `failed`, `crashed`), a reference to its cassette, and a linked AeroGraph trace ID.
- **Cassette**: The locally stored JSON file produced by a `record`-mode run. An immutable, ordered collection of (request, response) entries keyed by content-derived hash. Stored at `.aerograph/cassettes/<run-id>.json`.
- **CassetteEntry**: A single recorded (request, response) pair. Fields: `requestKey` (hash), `method`, `normalizedUrl`, `requestBodyHash`, `responseStatus`, `responseHeaders`, `responseBody` (chunked array if streaming), `streamingPreserved` (bool), `recordedAt` (timestamp).
- **ToolSafetyPolicy**: The parsed representation of `aerograph.replay.yaml`. Contains an ordered list of rules, each with a URL pattern, optional tool name pattern, and safety class (`replay_safe` | `must_execute`). Effective class for any request is determined by first-match evaluation.
- **ReplayDecision**: A per-request routing decision made by the Replay Orchestrator at runtime. Fields: `requestKey`, `matchedPattern` (or `null`), `effectiveClass`, `decision` (`"cache"` | `"live"` | `"must_execute_override"`). Stored as a span annotation in AeroGraph.
- **Trace** (existing, extended): AeroGraph's existing trace entity, extended with `replaySource`, `requestKey`, `tokensSaved`, `latencyMs`, `streamingPreserved` on each span, and a top-level `derivedFrom` lineage pointer for forks.
- **OrchestratorSession**: An active replay run session managed by the Replay Orchestrator. Tracks: running agent process PID, current replay step index, cassette in use, and output trace ID. Sessions are local and ephemeral.
- **aerorepl Session**: A terminal REPL session attached to a specific `OrchestratorSession` via the Orchestrator's local HTTP API. Maintains a pointer to the current step for `/step` and `/rewind` operations.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** (Zero-Cost Replay): A developer can replay any previously recorded agent run with zero outbound network calls and zero additional token cost, with per-step hydration time under 5ms at the 50th percentile. **[Build target]** This requires the SHA-256 hashed matcher to be implemented in `aerograph-replay-core`; the upstream linear `DeepEqual` scan does not meet this target at 200+ steps. The benchmark MUST be verified against the fork, not cited from the academic paper.
- **SC-002** (Replay Fidelity): The output trace produced by a replay run is semantically identical to the original recorded trace — fidelity score F = 1.0 (`D(E,E') = ∅`) when the agent command and inputs are unchanged.
- **SC-003** (Fork Automation): A developer can trigger a fork-and-resume entirely within the AeroGraph web UI with no manual terminal commands, and the forked trace appears in the UI within 10 seconds of clicking the action (excluding live LLM call latency from the fork point onward).
- **SC-004** (Tool Safety Correctness): In a mixed-class replay, 100% of `must_execute` requests result in live network calls and 100% of `replay_safe` requests are served from cache — zero silent misclassifications. Every routing decision is visible on the corresponding span.
- **SC-005** (Safe Default): When `aerograph.replay.yaml` is absent or a request is unclassified, 100% of such requests are treated as `must_execute` (live) — the system never silently serves an unclassified side-effecting call from cache.
- **SC-006** (Framework Agnosticism): Any agent process using a new AeroGraph adapter that correctly emits events per the canonical schema automatically receives zero-cost replay support without any replay-specific code in the adapter. Verified by the adapter test suite.
- **SC-007** (Zero-Instrumentation Record): Record mode works without any code changes to the agent, its framework, or its LLM SDK — no imports, no decorators, no environment variables beyond what the Replay Orchestrator injects automatically.
- **SC-008** (REPL Parity): Every replay, fork, inspect, and override operation available in the AeroGraph web UI is also available in `aerorepl`, with output consistent with what the UI shows for the same span/trace.
- **SC-009** (Schema Backward Compatibility): All new schema fields are optional/nullable. Existing traces recorded before this feature is deployed remain valid and renderable without migration. Existing collector/UI code that does not reference new fields continues to work unchanged.
- **SC-010** (Self-Hosted Onboarding): A developer can get from zero to a successful first recording in under 5 minutes using only the AeroGraph getting-started guide, without installing any additional global tools beyond the AeroGraph CLI.

---

## Assumptions

- **Self-hosted scope first**: The initial release targets the self-hosted AeroGraph deployment mode (local SQLite, local process spawning). The hosted/SaaS mode is explicitly out of scope and flagged as a fast-follow requiring a separate local daemon design.
- **Phase 0 spike and Phase 0.5 build required before orchestrator**: A Phase 0 spike MUST be completed before full orchestrator development begins. However, the spike is no longer purely verification — it now includes confirmed build work: (a) replacing the linear `DeepEqual` matcher with a SHA-256 hashed index; (b) implementing SSE passthrough and `GenerateContentStream` interception. These were confirmed absent in the upstream codebase by direct audit. Additionally, CA lifecycle remediation (FR-037) MUST be complete before Phase 2 (Orchestrator) begins.
- **Cassette storage location**: Cassettes are stored under `.aerograph/cassettes/` in the developer's project directory. The upstream `agrepl` fork stores cassettes at `.agent-replay/runs/` (corrected from earlier plan references to `.agrepl/runs/`). AeroGraph copies from the fork's native path to its canonical path after each run.
- **Command template is required**: Developers must provide the Replay Orchestrator with the shell command to invoke their agent (e.g., `python agent.py --input data.json`). This is a one-time setup per project stored in an AeroGraph project config.
- **agrepl vendoring — fork scope is larger than originally planned**: The fork now requires: (1) SHA-256 hashed matcher, (2) SSE/streaming passthrough, (3) CA lifecycle fix (in-memory/temp-dir CA + cleanup), (4) `--live-hosts` flag. Auth, sharing, diffing, storage, and CLI are confirmed complete in upstream and reused as-is.
- **LangGraph deep-state forking is out of scope for v1**: Prompt substitution for deeply nested LangGraph state is not automated in the initial release. The system warns clearly when this case is encountered.
- **Header injection availability**: Correlation header injection (`X-AeroGraph-Span-Id`) works for frameworks where the AeroGraph SDK controls request headers. For frameworks where this is not possible, a fallback correlation strategy (interleaving order + timestamp windowing) is used with acknowledged lower reliability, documented as a known per-framework limitation.
- **gRPC/HTTP2 not in scope**: Out of scope for this release. Detected at record time with a clear warning surfaced to the developer.
- **agrepl upstream contribution is best-effort**: Proposing the `--live-hosts` flag upstream is a best-effort action, not a dependency for the AeroGraph release. The CA vulnerability MUST be reported upstream independently and immediately, regardless of AeroGraph merge status.
- **Existing adapters unchanged**: No changes to `packages/adapter-langchain` or `python/aerograph-langchain` are required for the initial release. Adapters emit events as they do today; the Replay Orchestrator adds replay-specific annotations after run completion.
