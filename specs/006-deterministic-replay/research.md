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

**Source**: Direct codebase audit ([FEAS] AeroGraph_ag_Feasibility_Report.md, [SEC] security_report_agrepl.md, [STATE] Current_State_Report.md). The formal paper by Mudasiru is cited only for the determinism invariant, fidelity metric, and noise taxonomy — not for claims about the shipped implementation, which diverges from the paper in the matching and CA subsystems.

### 2.1 Verified agrepl Capabilities (corrected against source code)

| Capability | agrepl Status | Source evidence | Notes |
|-----------|--------------|----------------|-------|
| Zero-instrumentation record | ✅ Implemented | [FEAS] §2.1 | Custom `net/http` connection-hijacking proxy — **NOT goproxy** as the paper describes (`pkg/proxy/http_proxy.go`) |
| HTTP/HTTPS interception | ✅ Implemented | [FEAS] §2.1 | **Persistent** local CA written to `.agent-replay/ca/` and reused across runs — **NOT ephemeral** (`pkg/proxy/ca.go`). See §5 Security. |
| Cassette storage | ✅ Implemented | [FEAS] §2.2 | JSON files under **`.agent-replay/runs/`** (not `.agrepl/runs/` as the paper states — `pkg/storage/json_storage.go`) |
| Request matching | ⚠️ **Shipped differently** | [FEAS] §2.3, [STATE] §2.3 | **Linear scan** using `bytes.Equal`/`reflect.DeepEqual` over recorded steps — **SHA-256 hashed O(1) lookup NOT implemented**. `usedSteps` map prevents double-replay. **This is a build target, not an inherited capability.** |
| Replay (zero-network) | ✅ Implemented | [STATE] §2.3 | `agrepl run <run-id>` works correctly |
| Fallback mode | ✅ Implemented | [FEAS] §2.4 | `--fallback` flag confirmed in `cmd/replay.go` and `pkg/interceptor/http.go` |
| Team sharing (`share`/`pull`) | ✅ Complete | [STATE] §5 | R2-backed via AWS SDK v2, GitHub OAuth with device-code fallback |
| Diff engine | ✅ Complete | [STATE] §6 | Noise-aware diff with Signal/Noise/Removed taxonomy — confirmed reusable as-is |
| `list`/`inspect`/`auth` | ✅ Complete | [STATE] §4,§5 | SQLite-backed local indexing, tiered access (`local`/`pro`/`enterprise`) |
| Python agent compatibility | ✅ Works | Proxy-level, language-agnostic | |
| Node agent compatibility | ✅ Works | Same proxy-level mechanism | |
| Per-host passthrough (`--live-hosts`) | ❌ NOT implemented | [FEAS] §2.6 | **Must be added to vendored fork** — confirmed absent |
| gRPC / HTTP/2 interception | ❌ NOT implemented | | On upstream roadmap; out of scope |
| **Streaming SSE preservation** | ❌ **Confirmed broken** | [FEAS] §2.5, [STATE] §2.1,§7.3 | Full bodies buffered via `ioutil.ReadAll`; `GenerateContentStream` not intercepted at all (only non-streaming `GenerateContent` handled in `pkg/interceptor/llm.go`). **This is a confirmed blocking build target, not a risk to verify.** |
| Concurrent cassette reads | ✅ Safe | Cassette is read-only during replay | |
| Correlation header passthrough | ⚠️ Needs verification | | Proxy forwards headers; custom `X-AeroGraph-Span-Id` injection needs spike confirmation |
| Cassette portability | ✅ Implemented | Pure JSON, portable across machines | |
| Supply chain cleanliness | ✅ Clean | [SEC] "Supply Chain Assessment" | Reputable deps only (`aws-sdk-go-v2`, `cobra`, `google.golang.org/genai`, `modernc.org/sqlite`); no typosquatting or hidden telemetry found |

### 2.2 Compatibility Table (Feature 006 Requirements — updated)

| FR# | Requirement | agrepl Supports | AeroGraph Change | agrepl Fork | Status |
|-----|-------------|----------------|------------------|-------------|--------|
| FR-007 | Zero-instrumentation record | ✅ | No | No | Ready |
| FR-009 | Content-derived request key | ❌ **Must build** | No | ✅ Hashed matcher rewrite | **Build target** |
| FR-010 | Streaming chunk preservation | ❌ **Confirmed broken** | No | ✅ SSE passthrough + `GenerateContentStream` | **Build target** |
| FR-011 | Zero-network replay | ✅ | No | No | Ready |
| FR-012 | Fallback for cache miss | ✅ `--fallback` confirmed | No | No | Ready |
| FR-013 | replaySource badge in UI | | ✅ | No | AeroGraph work |
| FR-021 | `must_execute` always live | | ✅ Orchestrator | ✅ `--live-hosts` | Needs fork |
| FR-022 | Default `must_execute` | | ✅ Orchestrator | No | AeroGraph work |
| FR-025 | Per-decision logging | | ✅ Orchestrator | No | AeroGraph work |
| FR-035 | `--live-hosts` flag | | No | ✅ Required | Needs fork |

### 2.3 Cassette Location Mapping (corrected)

agrepl stores cassettes at **`.agent-replay/runs/<id>.json`** (verified in `pkg/storage/json_storage.go` — the paper's `.agrepl/runs/` path is incorrect). AeroGraph will **store a copy** at `.aerograph/cassettes/<id>.json` after each record run, maintaining the agreed spec storage location while keeping the fork's native location as source.

### 2.4 Streaming — Reclassified from Risk to Confirmed Build Target

The integration plan listed streaming as "needs verification in Phase 0." **[FEAS] and [STATE] both confirm it is simply not implemented**: full response bodies are buffered via `ioutil.ReadAll`; `GenerateContentStream` is not intercepted at all. This is no longer a spike question — it is a confirmed Phase 0.5 build item (see §6 Revised Roadmap in plan.md).

**Consequence**: Any replay path that routes streaming LLM calls through agrepl as it exists today will silently drop TTFT/tokens-per-sec telemetry. This is a launch blocker for streaming-by-default framework/model combinations and must be sequenced before Orchestrator development.

Fallback strategy (unchanged): If streaming cannot be fully preserved, set `streamingPreserved: false` on affected spans and surface a UI warning. This is already required by FR-010.

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

### 5.1 Orchestrator-Level Risks (AeroGraph-side)

Because the Orchestrator spawns developer-provided shell commands, the following risks are acknowledged:

| Risk | Mitigation |
|------|-----------|
| Command injection via `aerograph.project.yaml` | Validate command template against an allowlist of characters; never pass through shell interpolation |
| Path traversal in cassette path | Validate cassette paths are under `.aerograph/cassettes/` |
| Malicious cassette response content | The agent receives cassette responses — same trust model as live LLM responses |
| Orchestrator API exposed beyond localhost | `server.listen(4318, '127.0.0.1')` — loopback only |
| `must_execute` misclassification | Default-deny (`must_execute` for unlisted patterns), loud logging |

### 5.2 CA Key Lifecycle — Critical Finding [SEC] (new, gates Orchestrator rollout)

**Finding ([SEC] "CA Lifecycle Analysis", "Critical Vulnerabilities"):** The agrepl MITM proxy generates a real ECDSA P-256 CA and correctly restricts the private key file to `0600` permissions on creation (`pkg/proxy/ca.go`) — but **never deletes it**. The key persists indefinitely under `.agent-replay/ca/`, is silently reused across every future run (10-year validity), and has no `SIGINT`/`SIGTERM` cleanup trap.

**Why this is more severe for AeroGraph than for standalone agrepl use:** A developer manually invoking `agrepl record` occasionally is a bounded, attended action. The Orchestrator design has AeroGraph's backend automatically shelling out to agrepl on every replay and every fork click, **unattended, as a matter of routine UI interaction**. That turns an occasional developer convenience into a standing, system-driven trust relationship with a leaking key — the blast radius scales with exactly the automation we are building.

**Required remediation before Phase 2 (Orchestrator) is allowed to invoke agrepl unattended:**
1. Move to an in-memory-only CA where possible; where child processes need cert material from disk, write it to `os.MkdirTemp` and wipe it after execution — not the persistent `.agent-replay/ca/` path.
2. Add deferred cleanup (`os.RemoveAll` on the CA directory) in both `cmd/record.go` and `cmd/replay.go`.
3. Add `SIGINT`/`SIGTERM` trap so interrupted runs still clean up.
4. Replace `curl | bash` advisory in `cmd/uninstall.go` with a native Go cleanup routine.
5. **Re-run SAST audit against the fork before Phase 2 begins.**

**Non-negotiable spec requirement added:** *"CA Key Hygiene is NON-NEGOTIABLE: the replay engine must never leave a trusted root CA private key persisted on disk after a session ends, whether the session exits cleanly or is interrupted."*

**Responsible disclosure:** File upstream issue/advisory with Taiwrash maintainer as an immediate parallel action — independent of AeroGraph timeline.

### 5.3 Supply Chain Assessment — Clean Bill of Health [SEC]

`go.mod`/`go.sum` reviewed ([SEC] "Supply Chain Assessment"): reputable dependencies only (`aws-sdk-go-v2`, `cobra`, `google.golang.org/genai`, `modernc.org/sqlite`, `cli/oauth`). No typosquatting, no hidden telemetry or backdoors found. These can be treated as stable and reusable as-is.

---

## 6. Performance Research

agrepl paper benchmark (cite only for the formal model — see correction note below):
- Median replay latency per step: **0.9ms** (paper)
- Median latency reduction: **98.3%** (paper)
- Fidelity (F): **1.0** across 250 instances (paper)

**⚠️ Correction [FEAS] §2.3, [STATE] §2.3:** The paper's sub-millisecond benchmark was measured assuming an O(1) SHA-256 hashed lookup. The **shipped implementation uses a linear `DeepEqual` scan**, not a hash index. The paper's performance numbers **do not apply to the current codebase**. Sub-100ms replay lookup latency at 200+ recorded steps is a requirement this integration **must build and verify**, not a property it inherits.

**AeroGraph non-functional requirement (added):** p95 cassette lookup latency < 5ms at 200+ step traces, measured after the hashed matcher is implemented in the fork. This replaces any citation of the paper's benchmark as a given.

AeroGraph target (SC-001): **<5ms p50** per-step hydration. This headroom exists to absorb Orchestrator overhead, span annotation ingestion, and process startup — but the underlying matcher must be rewritten first for this to hold.

Critical path to benchmark in Phase 0: hashed matcher at 200, 500, 1000 trace steps — verify p95 < 5ms.

### 6.1 Verified Benchmark Results (T110)

Benchmarked with `packages/replay-core/cassette/bench_test.go` on AMD Ryzen 7 7435HS:

| Cassette Size | Lookup Latency | Allocations | Performance vs. Target (<5ms) |
|---------------|----------------|-------------|--------------------------------|
| 100 entries   | **16.63 ns/op** | 0 B/op, 0 allocs | ~300,000x faster than target |
| 500 entries   | **16.81 ns/op** | 0 B/op, 0 allocs | ~300,000x faster than target |
| 1000 entries  | **17.93 ns/op** | 0 B/op, 0 allocs | ~280,000x faster than target |

Conclusion: The O(1) SHA-256 hashed index implementation completely eliminates linear scan overhead, achieving sub-microsecond determinism (16-18 ns) and zero memory allocations per lookup.

---

## Unresolved Items (updated post-audit)

| Item | Status | Resolution path |
|------|--------|-----------------|
| SSE/streaming chunk storage in agrepl | ❌ **Confirmed broken** [FEAS] §2.5 | Phase 0.5 build task: add SSE passthrough + `GenerateContentStream` to fork |
| Hashed request matcher in agrepl | ❌ **Confirmed absent** [FEAS] §2.3 | Phase 0 build task: replace `DeepEqual` linear scan with SHA-256 hashed index in fork |
| CA key lifecycle / persistent key on disk | ❌ **Critical security gap** [SEC] | Security gate: implement in-memory/temp-dir CA + deferred cleanup before Phase 2 |
| Header injection via LangChain/LangGraph | ⚠️ Unknown | Phase 0 spike: verify `X-AeroGraph-Span-Id` survives agrepl proxy round-trip |
| CA cert installation on Windows (dev machine) | ⚠️ Unknown | Phase 0 spike on Windows |
| agrepl retry deduplication | ⚠️ Unknown | Phase 0 spike with retry test |
| Cassette path string correction (`.agent-replay/runs/` not `.agrepl/runs/`) | ✅ Corrected [FEAS] §2.2 | Update all orchestrator config and documentation references |

---

## 7. Cross-Language Parity & Portability Results (Phase 8)

| Dimension | Python Runtime (`aerograph-sdk`) | Node.js Runtime (`@aerograph/sdk`) | Parity Status |
|-----------|----------------------------------|------------------------------------|---------------|
| Schema Version | `1.1.0` | `1.1.0` | ✅ Identical |
| TraceEvent Serialization | camelCase JSON aliases | camelCase JSON | ✅ Identical |
| Actor Taxonomy | `agent`, `tool`, `system` | `agent`, `tool`, `system` | ✅ Identical |
| Replay Cache Hydration | `replaySource: "cache"` | `replaySource: "cache"` | ✅ Identical |
| Cassette Slicing & Format | `cassetteVersion: "1.0.0"` | `cassetteVersion: "1.0.0"` | ✅ 100% Portable |
| Cross-Runtime Replay | Python-rec -> Node-replay passes | Node-rec -> Python-replay passes | ✅ Verified |
| API Response Cleanliness | No python/runtime-specific keys | No node/runtime-specific keys | ✅ Clean |

Automated test suites:
- `tests/integration/test_cross_lang.py` (Python SDK emission)
- `tests/integration/cross_lang.test.ts` (Full cross-runtime matrix)
- `tests/integration/stub_adapter.test.ts` (Framework-agnostic guarantee)

