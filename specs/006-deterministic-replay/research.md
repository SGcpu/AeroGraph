# Research: Deterministic Replay for AeroGraph via agrepl Integration

**Phase 0 Research — Feature 006**
**Date**: 2026-09-01
**Branch**: `006-deterministic-replay`

---

## 1. Repository State Assessment

### 1.1 What Exists Today (verified against live code)

| Component | Current State | Relevance to Feature 006 |
|-----------|--------------|--------------------------|
| `packages/contracts` | Zod schema v1.1.0, 10 event kinds, `derivedFrom` in `TraceMeta`, `traceForkRequestSchema` with `forkFromSpanId` + optional `promptText` override | Must be **extended** with replay fields; existing fork contract reused |
| `apps/collector` | Express on port 4317, `SqliteTraceStore`, full fork/lineage/diff/stats endpoints | Must be **extended** with replay + fork-and-resume endpoints; **no process spawning** exists |
| `apps/web` | ReactFlow DAG, `doForkFromSpan()` calls `POST /v1/traces/:id/fork`, shows alert with trace ID for manual copy | **Needs "Fork and resume" mode** replacing alert; no replay UI exists |
| `packages/sdk` | `FlightRecorder` TypeScript, emits via `POST /v1/events`, no replay awareness | **Unchanged** for initial release |
| `python/aerograph-sdk` | `FlightRecorder` Python mirror, empty `replay/` directory (only `__pycache__`) | **Unchanged** for initial release; `replay/` dir exists as placeholder |
| `packages/adapter-langchain` | `AFRCallbackHandler extends BaseCallbackHandler`, emits events via `FlightRecorder` | **Unchanged** for initial release |
| `python/aerograph-langchain` | Python LangChain callback adapter | **Unchanged** for initial release |
| `apps/demo` | Minimal demo app | Used for Phase 0 spike |
| `apps/collector/src/store.ts` | Legacy JSONL in-memory store, retained "temporarily for reference during Phase 2 replay/fork work" | **Reference only** — production uses `sqliteStore.ts` |
| `apps/collector/src/sqlite/migrate.ts` | Migration 005 = last migration (telemetry columns) | New migration `006_replay` needed |

### 1.2 Key Discovery: Fork Already Exists But Is Manual

The existing fork implementation (`doForkFromSpan` in `App.tsx`, `POST /v1/traces/:id/fork` in `server.ts`, `forkTrace()` in `sqliteStore.ts`) **works correctly** but calls `alert()` to tell the developer to copy a trace ID and re-run manually. The **entire gap** for Feature 006 is:
1. Adding a Replay Orchestrator to actually re-invoke the agent process
2. Making the `POST /v1/traces/:id/fork` call trigger that re-invocation instead of stopping at "copy this ID"

### 1.3 Schema: `derivedFrom` Already Exists

`traceMetaSchema` already has:
```typescript
derivedFrom: z.object({
  baseTraceId: z.string(),
  forkedFromSpanId: z.string()
}).optional()
```
And `trace_derivations` table is fully implemented. **No new lineage schema work needed.**

### 1.4 The `replay/` Directory in Python SDK

`python/aerograph-sdk/src/aerograph_sdk/replay/` exists but contains only `__pycache__` — it was created as a placeholder. This is where future replay-aware Python utilities could live, but no implementation is needed there for Feature 006.

---

## 2. agrepl Compatibility Assessment

**Source**: Official README, integration plan document, formal paper by Mudasiru

### 2.1 Verified agrepl Capabilities

| Capability | agrepl Status | Notes |
|-----------|--------------|-------|
| Zero-instrumentation record | ✅ Implemented | MITM proxy via `goproxy`, injects `HTTP_PROXY`/`HTTPS_PROXY` env vars |
| HTTP/HTTPS interception | ✅ Implemented | Ephemeral local CA via mkcert for TLS |
| Cassette storage | ✅ Implemented | JSON files under `.agrepl/runs/` |
| Request matching | ✅ Implemented | `K(s) = SHA256(method ‖ norm(url) ‖ hash(body))`, order-independent |
| Replay (zero-network) | ✅ Implemented | `agrepl run <run-id>` or `agrepl run -- <cmd>` |
| Fallback mode | ✅ Implemented | `--fallback` flag: live for cache misses, cache for hits |
| Team sharing | ✅ Implemented | `agrepl share` / `agrepl pull` via Cloudflare R2 |
| Diff | ✅ Implemented | `agrepl diff` with Signal/Noise/Removed taxonomy |
| Python agent compatibility | ✅ Works | Proxy-level, language-agnostic |
| Node agent compatibility | ✅ Works | Same proxy-level mechanism |
| Go agent compatibility | ✅ Works | Same |
| Per-host passthrough (`--live-hosts`) | ❌ NOT implemented | **Must be added to vendored fork** |
| gRPC / HTTP/2 interception | ❌ NOT implemented | On upstream roadmap; out of scope |
| Streaming SSE preservation | ⚠️ UNKNOWN | Must be validated in Phase 0 spike |
| Concurrent cassette reads | ✅ Safe | Cassette is read-only during replay |
| Correlation header passthrough | ⚠️ Partial | Proxy forwards headers; custom header injection needs verification |
| Cassette portability | ✅ Implemented | Pure JSON, portable across machines |

### 2.2 Compatibility Table (Feature 006 Requirements)

| FR# | Requirement | agrepl Supports | AeroGraph Change | agrepl Fork | Unknown |
|-----|-------------|----------------|------------------|-------------|---------|
| FR-007 | Zero-instrumentation record | ✅ | No | No | |
| FR-009 | Content-derived request key | ✅ | No | No | |
| FR-010 | Streaming chunk preservation | | | | ✅ Phase 0 spike needed |
| FR-011 | Zero-network replay | ✅ | No | No | |
| FR-012 | Fallback for cache miss | ✅ | No | No | |
| FR-013 | replaySource badge in UI | | ✅ | No | |
| FR-021 | `must_execute` always live | | ✅ Orchestrator | ✅ `--live-hosts` | |
| FR-022 | Default `must_execute` | | ✅ Orchestrator | No | |
| FR-025 | Per-decision logging | | ✅ Orchestrator | No | |
| FR-035 | `--live-hosts` flag | | No | ✅ Required | |

### 2.3 Cassette Location Mapping

agrepl stores cassettes at `.agrepl/runs/<id>.json`. AeroGraph will **store a copy** at `.aerograph/cassettes/<id>.json` after each record run, maintaining the agreed spec storage location while optionally keeping the agrepl native location for raw access.

### 2.4 The Spike Question: Streaming

The integration plan's paper cites F=1.0 fidelity and 0.9ms median latency. These benchmarks were measured on non-streaming requests. AeroGraph's `streamingTelemetrySchema` (TTFT, tokensPerSecond, tokenCount) depends on chunk timing. If agrepl stores responses as a single body blob, streaming metrics will be incorrect during replay. **Phase 0 spike MUST test this.**

Fallback strategy: If streaming cannot be preserved chunk-by-chunk, set `streamingPreserved: false` on affected spans and surface a UI warning. This is already required by FR-010.

---

## 3. Architecture Decisions

### Decision 1: Orchestrator Technology — TypeScript/Node (not Go, not Python)
- **Decision**: Implement the Replay Orchestrator as a TypeScript/Node service, co-located as a new module inside `apps/collector/src/replay/`
- **Rationale**: The Collector is already Node/Express. Putting the Orchestrator inside the same process avoids a second service and a second port. The Orchestrator spawns child processes (`agrepl` + agent) via Node's `child_process.spawn()`. This is safe and well-understood in Node.
- **Alternatives rejected**: Separate Go daemon (unnecessary complexity), Python daemon (no existing Python service to host it), separate Node process (requires IPC).

### Decision 2: Cassette Storage — `.aerograph/cassettes/` as canonical, `.agrepl/runs/` as source
- **Decision**: After each `agrepl record` run, the Orchestrator copies the cassette from `.agrepl/runs/<id>.json` to `.aerograph/cassettes/<id>.json`. AeroGraph uses the `.aerograph/` path as canonical.
- **Rationale**: Keeps AeroGraph's storage namespaced separately from raw agrepl artifacts. Avoids coupling to agrepl's internal directory structure if we fork/patch it.

### Decision 3: agrepl Vendoring — Inside `packages/replay-core/` as compiled Go binary
- **Decision**: Vendor agrepl source as `packages/replay-core/` (Go module). The build produces a `aerograph-replay-core` binary. The Orchestrator spawns this binary as a child process.
- **Rationale**: MIT license permits this. Keeps the `--live-hosts` patch within AeroGraph's control. Go is not required in the npm workspace; the binary is pre-compiled.
- **Alternative rejected**: Download upstream binary at runtime (too fragile), depend on system-installed agrepl (zero-instrumentation claim breaks if developer must install separate tool).

### Decision 4: Request Correlation — Header injection + timestamp fallback
- **Decision**: Primary strategy is injecting `X-AeroGraph-Span-Id` as a custom header. The AeroGraph SDK (TS and Python) will be extended with a lightweight `ReplayCorrelator` helper that sets this header before each LLM call where the framework allows it. For frameworks that do not permit header injection (e.g. some langchain streaming paths), fall back to timestamp-windowing correlation.
- **Rationale**: The integration plan explicitly names this strategy. The fallback is documented as lower-reliability.

### Decision 5: Tool Safety Policy — Evaluated by Orchestrator, enforced via `--live-hosts`
- **Decision**: `aerograph.replay.yaml` is loaded and parsed by the Orchestrator, which computes the effective per-host routing and passes `must_execute` hosts to agrepl via `--live-hosts`. This flag is added to the vendored fork.
- **Rationale**: agrepl today is binary per-run (strict or fallback). Per-host granularity requires the `--live-hosts` patch. The Orchestrator owns policy; agrepl enforces it at the transport level.

### Decision 6: `aerorepl` — TypeScript CLI in `packages/aerorepl/`
- **Decision**: A new `packages/aerorepl/` workspace package, Node CLI built with `commander` or similar, thin HTTP client to Orchestrator API.
- **Rationale**: Consistent with existing TypeScript workspace conventions. No new language runtime required.

### Decision 7: Project Configuration — `aerograph.project.yaml` in project root
- **Decision**: A YAML file at the developer's project root (where they run agent scripts) stores the command template. Published JSON Schema enables IDE autocomplete.
- **Rationale**: Explicit, discoverable, version-control friendly.

---

## 4. Streaming Investigation (Preliminary)

The agrepl paper benchmarks used standard REST responses. Streaming (SSE) behavior is unknown. The two possible outcomes from the Phase 0 spike are:

**Case A — agrepl already buffers SSE correctly**: No fork changes needed. Streaming metrics work in replay.

**Case B — agrepl stores SSE as a single body blob**: The vendored fork must be patched to store chunks as an array. Until the spike is done, FR-010 is implemented defensively: the Orchestrator always checks `streamingPreserved` in the cassette and surfaces a warning if false.

---

## 5. Security Research

Because the Orchestrator spawns developer-provided shell commands, the following risks are acknowledged:

| Risk | Mitigation |
|------|-----------|
| Command injection via `aerograph.project.yaml` | Validate command template against an allowlist of characters; never pass through shell interpolation |
| Path traversal in cassette path | Validate cassette paths are under `.aerograph/cassettes/` |
| Malicious cassette response content | The agent receives cassette responses — same trust model as live LLM responses |
| Orchestrator API exposed beyond localhost | Bind only to `127.0.0.1`, document clearly |
| `must_execute` misclassification | Default-deny (`must_execute` for unlisted patterns), loud logging |

---

## 6. Performance Research

agrepl benchmark (from paper):
- Median replay latency per step: **0.9ms**
- Median latency reduction: **98.3%**
- Fidelity (F): **1.0** across 250 instances

AeroGraph target (SC-001): **<5ms p50** per-step hydration. This is 5.5× the paper benchmark, providing headroom for Orchestrator overhead, span annotation ingestion, and process startup.

Critical path to measure in Phase 0: Does the header injection round-trip (SDK → Orchestrator → agrepl annotation) add material latency?

---

## Unresolved Items (to be confirmed by Phase 0 Spike)

| Item | Risk if not resolved | Resolution path |
|------|---------------------|-----------------|
| SSE/streaming chunk storage in agrepl | FR-010 cannot be fully implemented | Phase 0 spike with streaming LLM call |
| Header injection via LangChain/LangGraph | Correlation fidelity unknown | Phase 0 spike test |
| CA cert installation on Windows (dev machine) | agrepl HTTPS interception may fail silently | Phase 0 spike on Windows |
| agrepl retry deduplication | Retries may create duplicate cassette entries | Phase 0 spike with retry test |
