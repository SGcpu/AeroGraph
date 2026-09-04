# Implementation Plan: Feature 006 — Deterministic Replay via agrepl Integration

**Branch**: `006-deterministic-replay` | **Date**: 2026-09-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-deterministic-replay/spec.md`

---

## Summary

Feature 006 transforms AeroGraph from a passive observability tool into an **active replay substrate**. By vendoring a patched fork of `agrepl` (renamed `aerograph-replay-core`) as a local proxy sidecar, AeroGraph can capture every HTTP/HTTPS interaction an agent makes, store it in a content-addressed cassette, and replay it deterministically at zero cost with <5ms per-span hydration latency.

**Updated assessment ([FEAS], [SEC], [STATE] audits):** Integration is still the right approach. The parts of agrepl that are _not_ in question — interception, CA generation, auth/OAuth, sharing, diffing, and CLI — are complete and well-built. The revision is about which specific subsystems need to be built in the fork: the hashed request matcher (upstream uses a linear scan), streaming support (confirmed absent), and CA lifecycle cleanup (confirmed security gap). The fork scope is larger than originally planned but narrow and specific.

The feature introduces four new components:
1. **`aerograph-replay-core`** — hardened agrepl fork (`packages/replay-core/`)
2. **Replay Orchestrator** — Node.js sub-service inside `apps/collector/src/replay/` (port 4318)
3. **`aerorepl` CLI** — developer-facing CLI (`packages/aerorepl/`)
4. **Replay UI** — "Fork and Resume" and "Replay" controls in `apps/web/src/App.tsx`

The existing fork/lineage infrastructure in the Collector is **already correct** and is extended (not replaced) for the replay workflow. The SDK and adapters are **not changed** for the initial release.

---

## Technical Context

**Language/Version**: TypeScript 5.x (Node 18.18+), Go 1.21+ (relay-core binary only), Python 3.10+ (Python SDK — unchanged)

**Primary Dependencies**:
- `better-sqlite3` (existing) — replay run metadata storage
- `commander` (new) — `aerorepl` CLI argument parsing
- `nanoid` (existing) — run ID generation
- `js-yaml` (new) — `aerograph.project.yaml` and `aerograph.replay.yaml` parsing
- `mkcert` (system, new) — TLS interception by replay-core
- Go stdlib `net/http/httputil` — inside vendored replay-core

**Storage**:
- SQLite `replay_runs` table (new, in `apps/collector/data/afr.sqlite`)
- `.aerograph/cassettes/<runId>.json` files (in developer's project root; copied from fork's native `.agent-replay/runs/<id>.json`)

**Testing**:
- `vitest` (existing) — unit tests for all TypeScript components
- `pytest` (existing) — Python SDK tests (unaffected)
- Integration test: spawn real Orchestrator, mock `aerograph-replay-core` binary

**Target Platform**: Local developer machine (Windows/macOS/Linux). No cloud, no containers.

**Performance Goals**:
- SC-001: Per-span cassette hydration < 5ms p50
- SC-002: Full trace replay < 2× original agent run time
- SC-003: Zero additional network calls for `replay_safe` spans

**Constraints**: No Kubernetes, Redis, Kafka, remote workers. Single machine only. Orchestrator binds to `127.0.0.1` only.

**Scale/Scope**: 1 agent process per record/replay run. Cassettes up to 50MB.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Gate | Status | Evidence |
|------|--------|----------|
| **I. Backward Compatibility** | ✅ PASS | All new contract fields are optional. Schema version stays `1.1.0`. Migration 006 is additive-only (ALTER TABLE ADD COLUMN). |
| **II. No Breaking Changes** | ✅ PASS | Existing endpoints unchanged. New endpoints are additive. `traceForkRequestSchema` not modified. |
| **III. Trace Replayability (Constitution mandate)** | ✅ PASS | This entire feature fulfills this constitutional requirement. |
| **IV. Local-first** | ✅ PASS | Orchestrator on `127.0.0.1:4318`. Cassettes are local files. No cloud services added. |
| **V. Schema Stability** | ✅ PASS | Additive extension to `baseEventSchema`. New cassette/orchestrator schemas in separate files. |
| **VI. Complexity Budget** | ✅ PASS | 2 new workspace packages (`replay-core`, `aerorepl`) + 1 new sub-service. Justified by constitutional mandate. |

---

## Project Structure

### Documentation (this feature)

```text
specs/006-deterministic-replay/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0 research findings
├── data-model.md        # Phase 1 data model and schemas
├── quickstart.md        # End-to-end validation guide
├── contracts/
│   └── orchestrator-api.md   # API contract reference
└── tasks.md             # Phase 2 output (/speckit-tasks command)
```

### Source Code (repository root)

```text
packages/
├── contracts/src/
│   ├── index.ts                    # [MODIFY] Add replayMeta fields to baseEventSchema
│   ├── cassette.ts                 # [NEW] CassetteEntry, Cassette schemas
│   └── orchestrator.ts             # [NEW] Run, StartRunRequest, ForkAndResume schemas
├── aerorepl/                       # [NEW PACKAGE] Developer CLI
│   ├── src/
│   │   ├── cli.ts                  # Commander entry, subcommands
│   │   ├── client.ts               # HTTP client to Orchestrator API
│   │   └── config.ts               # Reads aerograph.project.yaml
│   ├── package.json
│   └── tsconfig.json
└── replay-core/                    # [NEW PACKAGE] Vendored agrepl fork
    ├── main.go                     # Entry point with --live-hosts patch
    ├── proxy/                      # MITM proxy (from upstream agrepl)
    ├── cassette/                   # Cassette read/write (from upstream agrepl)
    ├── Makefile                    # Builds aerograph-replay-core binary
    └── bin/                        # Compiled binary (gitignored except placeholder)

apps/
├── collector/src/
│   ├── server.ts                   # [MODIFY] Add /replay, /fork-and-resume endpoints
│   ├── sqliteStore.ts              # [MODIFY] Add getRunById, createRun, updateRunStatus
│   ├── sqlite/
│   │   └── migrate.ts              # [MODIFY] Add migration 006_replay
│   └── replay/                     # [NEW] Replay Orchestrator sub-service
│       ├── orchestrator.ts         # Express sub-app on port 4318
│       ├── runner.ts               # Spawns aerograph-replay-core + agent process
│       ├── policy.ts               # Loads aerograph.replay.yaml, computes --live-hosts
│       ├── cassette.ts             # Reads/writes .aerograph/cassettes/*.json
│       ├── correlator.ts           # X-AeroGraph-Span-Id header injection helper
│       └── orchestrator.test.ts    # Integration tests
└── web/src/
    ├── App.tsx                     # [MODIFY] Replace alert() with Fork-and-Resume modal,
    │                               #          add Replay button, show replaySource badge
    ├── ReplayControlPanel.tsx      # [NEW] Record/Replay/Fork control panel
    ├── RunStatusBadge.tsx          # [NEW] Live polling run status display
    └── api.ts                      # [MODIFY] Add orchestratorUrl, replay/fork-and-resume calls

tests/
└── fixtures/                       # [NEW] simple-agent.py + aerograph.project.yaml
```

**Structure Decision**: Option 1 (Single monorepo workspace). New components added as workspace packages and sub-directories to maintain consistency with existing structure.

---

## Architecture: Component Flow

```
Developer Project
┌─────────────────────────────────────────────────────────────────┐
│  aerograph.project.yaml    aerograph.replay.yaml                │
│  agent.py (or agent.ts)                                         │
└─────────────────────────────────────────────────────────────────┘
          │
          │  spawn + inject HTTP_PROXY
          ▼
┌─────────────────────┐      ┌─────────────────────────────────┐
│  Replay Orchestrator│◄────►│ aerograph-replay-core (Go MITM) │
│  :4318              │      │  Record mode: capture to cassette│
│  (inside Collector) │      │  Replay mode: serve from cassette│
└─────────────────────┘      │  --live-hosts: passthrough       │
          │                  └──────────────────────────────────┘
          │ POST /v1/events                   │
          ▼                                   │ annotates spans with
┌─────────────────────┐                       │ replaySource, requestKey
│  Collector :4317    │◄──────────────────────┘
│  SqliteTraceStore   │
│  + migration 006    │
└─────────────────────┘
          │ GET /v1/traces, /v1/runs
          ▼
┌─────────────────────┐
│  Web UI :5173       │
│  ReplayControlPanel │
│  RunStatusBadge     │
│  Fork-and-Resume    │
└─────────────────────┘
```

---

## Implementation Phases

### Phase 0: Fork Build — Hashed Matcher + Spike (no production AeroGraph code)

**Goal**: Build the SHA-256 hashed request matcher in the fork (replacing the upstream linear `DeepEqual` scan). Then run the verification spike against this improved fork.

**Why this changed**: The original plan treated Phase 0 as verification-only. Direct code audit of `pkg/interceptor/http.go` and `pkg/interceptor/llm.go` confirmed the hashed matcher is not implemented — the upstream uses `bytes.Equal`/`reflect.DeepEqual` over a linear step list. The paper's O(1)/sub-ms benchmark assumed a hash index that doesn't exist. This must be built before the spike results can be trusted.

**Output**: Working hashed matcher in `packages/replay-core/`. Spike findings written to `research.md`.

**Work**:
1. Vendor agrepl source into `packages/replay-core/`, update `go.mod`
2. **Design and implement** SHA-256 hashed index keyed on `(X-AeroGraph-Span-Id, K(s))` in `pkg/interceptor/http.go` and `pkg/interceptor/llm.go` (replacing `DeepEqual` linear scan)
3. Verify trace JSON format compatibility with `diff`/`list`/`share`/`pull` post-rewrite
4. Benchmark p95 lookup latency at 200, 500, 1000 step traces; verify < 5ms; record in `research.md`
5. Spike: wrap AeroGraph demo app with rebuilt binary, test `X-AeroGraph-Span-Id` header passthrough
6. Spike: test retry deduplication behavior
7. Spike: test on Windows with mkcert

**Go/No-Go Gate**: Hashed matcher benchmarks pass (p95 < 5ms at 200+ steps). Spike findings documented. Phase 0.5 and Security Gate begin next.

### Phase 0.5: Fork Build — Streaming (NEW, confirmed build target)

**Goal**: Implement SSE/chunked transfer passthrough and `GenerateContentStream` interception in the fork. This is **not** a spike to verify — it is a confirmed build target.

**Why this is here**: Upstream agrepl buffers full response bodies via `ioutil.ReadAll` (`pkg/interceptor/http.go`) and does not intercept `GenerateContentStream` at all (`pkg/interceptor/llm.go`). This is a confirmed blocking dependency: any AeroGraph feature relying on TTFT/tokens-per-sec telemetry will silently degrade to zero for streaming LLM calls through the proxy.

**Sequencing**: Must complete before or alongside Phase 1, because it affects the cassette format. Orchestrator (Phase 2) must not be built against a non-streaming fork.

**Work**:
1. Add chunked/SSE passthrough to HTTP interceptor: stop buffering with `ioutil.ReadAll`, pass chunks through as array entries in cassette
2. Add `GenerateContentStream` interception to `pkg/interceptor/llm.go`
3. Verify AeroGraph TTFT / tokens-per-sec telemetry survives round-trip through the replay proxy
4. Write unit tests for streaming round-trip in `packages/replay-core/`

**Output**: Fork binary supports streaming. Cassette format includes chunk arrays for streaming responses.

---

### Security Gate (NEW — must complete before Phase 2)

**Gate condition**: `aerograph-replay-core` fork MUST NOT be invoked unattended by the Orchestrator until all items below are implemented and re-audited. **This gate blocks Phase 2.**

**Why**: The upstream agrepl generates a real ECDSA P-256 CA and persists the private key indefinitely under `.agent-replay/ca/` (10-year validity, no cleanup on exit). Standing automated invocation from the Orchestrator turns an occasional developer action into a standing system-driven trust relationship with a leaking key — the blast radius scales with the automation.

**Required fork changes (FR-037)**:
1. Move CA to in-memory where possible; where disk is required, write to `os.MkdirTemp` and wipe after execution
2. Add deferred `os.RemoveAll` in `cmd/record.go` and `cmd/replay.go`
3. Add `SIGINT`/`SIGTERM` trap to guarantee cleanup on interrupt
4. Replace `curl | bash` advisory in `cmd/uninstall.go` with native Go cleanup
5. Re-run SAST audit against the fork
6. File upstream issue/advisory with Taiwrash maintainer (parallel, independent action)

**Output**: Security-hardened fork binary. SAST re-audit documented.

---

### Phase 1: Foundation — Replay Core + Schema

**Goal**: Compile vendored binary, add DB migration, extend contract schemas.

**Files**:
- `packages/replay-core/` — fork agrepl (Phases 0/0.5/Security Gate work), add `--live-hosts` flag and `--annotation-log` flag, cross-compile binaries
- `packages/contracts/src/cassette.ts` — `CassetteEntry`, `Cassette` schemas
- `packages/contracts/src/orchestrator.ts` — `RunStatus`, `StartRunRequest`, etc.
- `packages/contracts/src/index.ts` — extend `baseEventSchema` with `replayMeta` fields
- `apps/collector/src/sqlite/migrate.ts` — migration `006_replay` (new `replay_runs` table + event columns)
- `apps/collector/src/sqliteStore.ts` — `createRun()`, `updateRunStatus()`, `getRunById()`, `listRuns()`

**Tests**:
- `packages/contracts/src/index.test.ts` — validate new optional fields accepted/rejected correctly
- `apps/collector/src/sqliteStore.test.ts` — CRUD tests for `replay_runs`

---

### Phase 2: Replay Orchestrator

**Blocked by**: Security Gate (FR-037) must be complete before this phase.

**Goal**: Implement the Orchestrator sub-service in `apps/collector/src/replay/`.

**Files**:
- `apps/collector/src/replay/orchestrator.ts` — Express app on port 4318, routes: `GET /health`, `POST /v1/runs`, `GET /v1/runs`, `GET /v1/runs/:id`, `POST /v1/runs/:id/cancel`
- `apps/collector/src/replay/runner.ts` — `spawn(mode, runId)`: locates `aerograph-replay-core` binary, builds env vars (`HTTP_PROXY`, `HTTPS_PROXY`, `AFR_RUN_ID`), spawns process, watches for exit, updates run status in DB
- `apps/collector/src/replay/policy.ts` — `loadPolicy(projectRoot)`: reads `aerograph.replay.yaml`, returns computed `--live-hosts` string
- `apps/collector/src/replay/cassette.ts` — `readCassette(runId)`, `writeCassette(runId, data)`: I/O for `.aerograph/cassettes/`
- `apps/collector/src/replay/correlator.ts` — `buildCorrelationHeader(spanId)`: returns `{ 'X-AeroGraph-Span-Id': spanId }`
- `apps/collector/src/server.ts` — mount Orchestrator on port 4318 in `createApp()`

**Tests**:
- `apps/collector/src/replay/orchestrator.test.ts` — mock binary, test run lifecycle, cancel, status
- `apps/collector/src/replay/policy.test.ts` — YAML loading, malformed YAML graceful handling

---

### Phase 3: Collector Endpoint Extensions

**Goal**: Add replay and fork-and-resume endpoints to the existing Collector.

**Files**:
- `apps/collector/src/server.ts`:
  - `POST /v1/traces/:traceId/replay` — validates cassette exists, delegates to Orchestrator
  - `POST /v1/traces/:traceId/fork-and-resume` — calls `forkTrace()` then Orchestrator `POST /v1/runs` with `mode: "fork"`
- `apps/collector/src/sqliteStore.ts`:
  - `getRunByTraceId(traceId)` — lookup run linked to a trace

**Tests**:
- `apps/collector/src/server.test.ts` — add tests for `/replay` and `/fork-and-resume` routes (mock Orchestrator)

---

### Phase 4: `aerorepl` CLI

**Goal**: Implement the `aerorepl` npm package with `record`, `replay`, `list`, `status`, `cancel` subcommands.

**Files**:
- `packages/aerorepl/src/cli.ts` — Commander program with all subcommands
- `packages/aerorepl/src/client.ts` — Typed HTTP client wrapping Orchestrator API
- `packages/aerorepl/src/config.ts` — Reads `aerograph.project.yaml` using `js-yaml`
- `packages/aerorepl/package.json` — `"bin": { "aerorepl": "./dist/cli.js" }`

**Tests**:
- `packages/aerorepl/src/cli.test.ts` — mock Orchestrator, test each subcommand

---

### Phase 5: Web UI — Replay Controls

**Goal**: Replace the `alert()` fork flow with a proper UI; add replay controls and `replaySource` badges.

**Files**:
- `apps/web/src/App.tsx`:
  - Replace `doForkFromSpan` to call `POST /v1/traces/:id/fork-and-resume` instead of `alert()`
  - Add "Fork and Resume" modal: shows fork span info, prompt override field, "Launch" button
  - Add "▶ Replay Trace" button in top toolbar (only visible when current trace has a linked cassette)
  - Show `replaySource` badge per span node in graph (cache icon / live icon)
  - Show `replayLatencyMs`, `tokensSaved` in Span Info panel
  - Show `streamingPreserved: false` amber warning in span detail
- `apps/web/src/ReplayControlPanel.tsx` — New component: mode selector, cassette info, run history
- `apps/web/src/RunStatusBadge.tsx` — Polls `GET /v1/runs/:runId` every 2s, shows status chip
- `apps/web/src/api.ts` — Add `startRun()`, `getRun()`, `forkAndResume()`, `replayTrace()`

---

### Phase 6: Span Annotation Pipeline

**Goal**: Wire `replaySource`, `requestKey`, `tokensSaved`, `replayLatencyMs`, `streamingPreserved` from agrepl responses into the event stream flowing into the Collector.

**Mechanism**: The `aerograph-replay-core` binary (via `--annotation-log <path>`) writes a JSON file after the run. The Orchestrator reads this file after process exit, correlates with `X-AeroGraph-Span-Id` headers captured in the cassette, and emits enriched span updates via `POST /v1/events`.

**Detailed flow**:
1. SDK/adapter injects `X-AeroGraph-Span-Id: <spanId>` on each LLM HTTP call
2. `aerograph-replay-core` records `correlatedSpanId` in cassette entry from request header
3. On replay, `aerograph-replay-core` writes annotation log to `--annotation-log <path>`
4. Orchestrator reads annotation log after process exit
5. Orchestrator calls `PATCH /v1/events/:spanId` (new endpoint) or re-emits with enriched fields

**Files**:
- `packages/replay-core/` — add `--annotation-log <path>` flag to binary
- `apps/collector/src/replay/runner.ts` — after process exit, read annotation log and emit enriched events

---

### Phase 7: Tool Safety Policy Engine

**Goal**: Load `aerograph.replay.yaml`, compute `--live-hosts`, pass to binary, and log routing decisions.

**Files**:
- `apps/collector/src/replay/policy.ts` — `computeLiveHosts(policy): string[]`
- `packages/replay-core/main.go` — add `--live-hosts <comma-separated-domains>` flag; pass-through matching requests to real network
- `apps/collector/src/replay/runner.ts` — call `loadPolicy()`, pass computed `--live-hosts` to spawn args

**Decision logging**: Orchestrator logs `[REPLAY-ROUTE] <host> → <class> (<decision>)` to stdout.

---

### Phase 8: Schema Exporter + Documentation

**Goal**: Regenerate JSON Schema and update docs.

**Files**:
- `packages/schema-exporter/` — re-run after new schemas exported
- `README.md` — add Feature 006 section: "Deterministic Replay"

---

## Complexity Tracking

> No constitution violations — no entries required.

---

## Failure Modes and Mitigations

| Failure Mode | Detection | Mitigation |
|-------------|-----------|-----------|
| `aerograph-replay-core` binary not found | Orchestrator startup check | Fail fast: "Run `make build` in `packages/replay-core/`" |
| Agent crashes during replay | Exit code != 0 → `status: failed` | Expose in UI, `errorMessage` in run record |
| Cassette miss in strict mode | Binary exits non-zero | Run status: `failed`, message: "cassette miss for key K" |
| `aerograph.project.yaml` missing | `/fork-and-resume` or `/replay` called | 409: "No agent command configured. Create aerograph.project.yaml." |
| `must_execute` call fails in replay | Binary propagates HTTP error | Span gets `replaySource: "live"` + `status: "error"` |
| Annotation log not written | Orchestrator reads empty file | Spans get no replay annotation; logged as warning |
| Port 4318 already in use | Orchestrator startup | Log warning; Collector still works on 4317 |
| Cassette file corrupt | `readCassette()` throws | Return 500; do not corrupt existing trace data |

---

## Security Considerations

| Risk | Implementation Safeguard |
|------|--------------------------|
| **CA key persistence (CRITICAL, FR-037)** | Fork must implement in-memory/temp-dir CA, deferred cleanup, SIGINT/SIGTERM traps before Phase 2 begins. Upstream maintainer notified independently. |
| Shell injection from `aerograph.project.yaml` | `command` parsed as YAML array, passed to `child_process.spawn()` array form (no shell) |
| Path traversal in cassette path | `path.resolve()` + `path.startsWith(projectRoot + '/.aerograph')` assertion |
| Orchestrator exposed to network | `server.listen(4318, '127.0.0.1')` — loopback only |
| `mkcert` CA trust on CI | Document opt-out; CI runs with mock binary |

---

## Verification Plan

### Automated Tests

```bash
npm test                                      # full suite
npm run test -w @aerograph/contracts          # schema validation
npm run test -w apps-collector                # orchestrator + store
npm run test -w packages/aerorepl             # CLI tests
```

### Manual Verification

1. Run Scenarios 1–6 from `quickstart.md`
2. Verify `GET /v1/runs` persists across Collector restart
3. Confirm `streamingPreserved: false` warning appears correctly
4. Verify `must_execute` hosts bypass cassette correctly
5. Confirm port 4317 endpoints are unaffected by Orchestrator startup failure
