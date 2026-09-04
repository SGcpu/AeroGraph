# Tasks: Feature 006 — Deterministic Replay via agrepl Integration

**Input**: Design documents from `specs/006-deterministic-replay/`
**Branch**: `006-deterministic-replay`
**Prerequisites**: `spec.md` ✅ | `plan.md` ✅ | `research.md` ✅ | `data-model.md` ✅ | `contracts/orchestrator-api.md` ✅
**TDD**: Strictly required. Tests are written first and must FAIL before implementation.
**Architecture Rule**: The canonical `TraceEvent` schema is the language-neutral interoperability boundary. No Python-specific or Node-specific frontend code. All replay state is authoritative in the Collector/Orchestrator — never in the browser.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no inter-task dependency)
- **[Story]**: Which user story this task belongs to (US1–US5)
- Include exact file paths in all descriptions

---

## Phase 0: Fork Build — Hashed Matcher + Verification Spike (Blocking Gate)

**Purpose**: Build the SHA-256 hashed request matcher in the fork (replacing the confirmed-absent linear `DeepEqual` scan), then run the correlation and Windows verification spike against the improved fork. Streaming is NOT verified here — it is a confirmed build target in Phase 0.5.

**CRITICAL**: No Phase 2+ implementation may begin until Phase 0, Phase 0.5, and the Security Gate are all complete.

**Why Phase 0 is a build phase, not a spike**: Direct audit of `pkg/interceptor/http.go` and `pkg/interceptor/llm.go` confirmed the upstream uses `bytes.Equal`/`reflect.DeepEqual` over a linear step list. The paper's O(1)/sub-ms benchmark assumed a hash index that doesn't exist. Build must happen before spike results are trustworthy.

- [x] T001 Vendor agrepl source into `packages/replay-core/`: copy upstream source (MIT license), update `go.mod` to `module aerograph.dev/replay-core`, verify `record` and `replay` commands compile with Go 1.21+; document Go version in `research.md`
- [x] T002 **[BUILD]** Design hashed index keyed on `(X-AeroGraph-Span-Id, K(s))` where `K(s) = SHA256(method + normalizedUrl + SHA256(body))`; replace linear `DeepEqual` scan in `packages/replay-core/pkg/interceptor/http.go`
- [x] T003 **[BUILD]** Replace linear `DeepEqual` scan in `packages/replay-core/pkg/interceptor/llm.go` with the same hashed index
- [x] T004 [P] Verify trace JSON format compatibility with `diff`/`list`/`share`/`pull` after matcher rewrite; assert existing cassette files still parse correctly
- [x] T005 Benchmark hashed matcher p95 lookup latency at 200, 500, 1000 step traces; assert p95 < 5ms; record measurements in `research.md`; confirm this replaces any citation of the paper's 0.9ms figure
- [x] T006 [P] Spike — correlation headers: verify `X-AeroGraph-Span-Id` custom request header is preserved round-trip through rebuilt fork proxy; document in `research.md`
- [x] T007 [P] Spike — LangChain header injection: test whether LangChain/OpenAI SDK calls allow injecting `X-AeroGraph-Span-Id`; document fallback scope in `research.md`
- [x] T008 [P] Spike — Windows TLS interception: run mkcert CA installation + fork HTTPS interception on Windows; verify Python and Node LLM calls captured; document Windows setup steps in `research.md`
- [x] T009 [P] Spike — retry deduplication: trigger HTTP retry in wrapped agent; inspect cassette for duplicate entries vs. deduplication by hashed key; document in `research.md`
- [x] T010 Update `research.md` hashed matcher and performance sections with complete findings; confirm Go/No-Go gate; update benchmark result table

**Checkpoint**: Hashed matcher built and benchmarked (p95 < 5ms). Spike findings documented. Phase 0.5 and Security Gate begin next.

---

## Phase 0.5: Fork Build — Streaming (Confirmed Build Target)

**Purpose**: Implement SSE/chunked transfer passthrough and `GenerateContentStream` interception. This is NOT a spike — streaming is confirmed broken in upstream (`ioutil.ReadAll` buffering; `GenerateContentStream` not intercepted). Must complete before Orchestrator development since it affects the cassette format.

- [x] T011 **[BUILD]** Replace `ioutil.ReadAll` in `packages/replay-core/pkg/interceptor/http.go` HTTP interceptor with chunked/SSE passthrough: store each chunk as an array entry in the cassette entry, not as a single body blob
- [x] T012 **[BUILD]** Add `GenerateContentStream` interception to `packages/replay-core/pkg/interceptor/llm.go`: handle streaming GenAI calls that were previously not intercepted at all
- [x] T013 Verify AeroGraph TTFT / tokens-per-sec telemetry survives round-trip through the replay proxy on both record and replay passes
- [x] T014 Write unit tests for streaming round-trip in `packages/replay-core/proxy/streaming_test.go`: assert chunks stored as array, assert round-trip chunk count and order match, assert `streamingPreserved: true` in annotation log

**Checkpoint**: Fork binary supports streaming. Cassette format includes chunk arrays for streaming responses. AeroGraph streaming telemetry (TTFT, tokens/sec) survives replay.

---

## Security Gate (Blocking — must complete before Phase 2)

**Purpose**: Remediate the CA key persistence vulnerability before the Orchestrator is allowed to invoke `aerograph-replay-core` unattended (FR-037). This gate BLOCKS Phase 2.

**Background**: Upstream agrepl generates a real ECDSA P-256 CA persisted indefinitely under `.agent-replay/ca/` (10-year validity, no cleanup). Unattended Orchestrator invocation turns this into a standing system-level trust relationship with a leaking key.

- [x] T015 File upstream issue/advisory with Taiwrash agrepl maintainer documenting CA key persistence vulnerability; this is a parallel, independent action — do not block on upstream response
- [x] T016 **[BUILD]** Move CA to `os.MkdirTemp`-based ephemeral storage in `packages/replay-core/pkg/proxy/ca.go`: write key to temp dir, never to persistent `.agent-replay/ca/`
- [x] T017 **[BUILD]** Add deferred `os.RemoveAll` in `packages/replay-core/cmd/record.go` and `packages/replay-core/cmd/replay.go` to wipe CA temp dir after each run
- [x] T018 **[BUILD]** Add `SIGINT`/`SIGTERM` trap in `packages/replay-core/main.go` to guarantee CA cleanup on interrupt (use `os/signal` + `defer` pattern)
- [x] T019 **[BUILD]** Replace `curl | bash` advisory in `packages/replay-core/cmd/uninstall.go` with native Go cleanup routine
- [x] T020 Re-run SAST audit against the hardened fork; document results in `specs/006-deterministic-replay/research.md` security section
- [x] T021 Write test in `packages/replay-core/proxy/ca_test.go`: verify no file persists under `.agent-replay/ca/` after a completed run; verify `SIGTERM` also triggers cleanup

**Checkpoint**: SAST re-audit passed. No persistent CA key after any run, clean or interrupted. Phase 2 may now begin.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create workspace packages, directory scaffolding, and Go build tooling. No business logic.

- [x] T010 Create `packages/replay-core/` Go module: `go.mod` (module `aerograph.dev/replay-core`), `main.go` stub, `proxy/`, `cassette/`, `bin/` directories, `.gitignore` for compiled binary, `Makefile` with `build` target producing `bin/aerograph-replay-core`
- [x] T011 Create `packages/aerorepl/` npm workspace package: `package.json` (name `@aerograph/aerorepl`, bin `aerorepl`), `tsconfig.json` extending root base, `src/`, `vitest.config.ts`
- [x] T012 [P] Create `apps/collector/src/replay/` directory with placeholder `index.ts`; add `replay/` to `apps/collector/tsconfig.json` include paths
- [x] T013 [P] Add `js-yaml` + `@types/js-yaml` to `apps/collector/package.json`; add `commander` to `packages/aerorepl/package.json`
- [x] T014 [P] Create `specs/006-deterministic-replay/contracts/aerograph-project-yaml.schema.json` — JSON Schema v7 for `aerograph.project.yaml`
- [x] T015 [P] Create `specs/006-deterministic-replay/contracts/aerograph-replay-yaml.schema.json` — JSON Schema v7 for `aerograph.replay.yaml`
- [x] T016 Create `tests/fixtures/simple-agent.py` (stub Python agent using `aerograph_sdk.FlightRecorder`) and `tests/fixtures/aerograph.project.yaml` pointing to it

**Checkpoint**: Workspace scaffolding exists. Go module compiles stub binary. npm workspaces resolve.

---

## Phase 2: Foundational (Canonical Contracts — Blocks All User Stories)

**Purpose**: `@aerograph/contracts` is the language-neutral interoperability boundary. ALL components depend on it.

**CRITICAL**: No user story work can begin until Phase 2 is complete.

### Contract Tests (write first — must FAIL before implementation)

- [x] T017 [P] Write failing contract tests for new `baseEventSchema` optional replay fields in `packages/contracts/src/index.test.ts`: assert existing v1.1.0 events still parse; assert new optional fields accepted with correct types; assert `replaySource` rejects non-`cache|live` values
- [x] T018 [P] Write failing contract tests for `CassetteEntry` and `Cassette` schemas in `packages/contracts/src/__tests__/cassette.test.ts`: validate all required fields, chunk array structure, `streamingPreserved` boolean, `correlatedSpanId` nullable
- [x] T019 [P] Write failing contract tests for Orchestrator schemas in `packages/contracts/src/__tests__/orchestrator.test.ts`: `StartRunRequest` for all three modes, `GetRunResponse`, `ForkAndResumeRequest/Response`, validate mode/status enums

### Contract Implementation

- [x] T020 Create `packages/contracts/src/cassette.ts`: export `replaySourceSchema`, `cassetteEntrySchema`, `cassetteSchema`, `validateCassette()`, `validateCassetteEntry()` — exact field set per `data-model.md` section 2
- [x] T021 Create `packages/contracts/src/orchestrator.ts`: export `runModeSchema`, `runStatusSchema`, `startRunRequestSchema`, `startRunResponseSchema`, `getRunResponseSchema`, `replayTraceRequestSchema`, `forkAndResumeRequestSchema`, `forkAndResumeResponseSchema` and Zod validators — exact shape per `data-model.md` section 4
- [x] T022 Extend `packages/contracts/src/index.ts` `baseEventSchema` with optional replay metadata fields: `replaySource`, `requestKey`, `tokensSaved`, `replayLatencyMs`, `streamingPreserved`, `overridden` — all optional/nullable per `data-model.md` section 1; schema version stays `1.1.0`
- [x] T023 Re-export all from `cassette.ts` and `orchestrator.ts` in `packages/contracts/src/index.ts`; verify all existing exports unchanged
- [x] T024 Run contract tests T017-T019 and confirm they now PASS; run existing `packages/contracts/src/index.test.ts` suite to confirm zero regressions

**Checkpoint**: All contract schemas implemented and tested. Existing tests pass. User story phases may now begin.

---

## Phase 3: User Story 1 — Zero-Cost Replay of a Past Run (Priority: P1) MVP

**Goal**: Developer clicks Replay in Web UI on a recorded trace -> agent re-executes with all LLM/tool calls served from cassette -> zero network calls -> new trace DAG with `replaySource: cache` badges.

**Independent Test**: `npm run test -w apps-collector` + Scenarios 1 and 2 from `quickstart.md`.

**Dependency**: Phase 2 complete.

### Tests (write first — must FAIL)

- [x] T025 [P] [US1] Write failing migration test in `apps/collector/src/sqliteStore.test.ts`: assert `replay_runs` table exists after migration; assert new event columns (`replay_source`, `replay_request_key`, `replay_tokens_saved`, `replay_latency_ms`, `replay_streaming_preserved`, `replay_overridden`) exist; assert old events still queryable
- [x] T026 [P] [US1] Write failing store tests for `createRun()`, `updateRunStatus()`, `getRunById()`, `listRuns()`, `getRunByTraceId()` in `apps/collector/src/sqliteStore.test.ts`
- [x] T027 [P] [US1] Write failing Orchestrator route tests in `apps/collector/src/replay/orchestrator.test.ts`: `POST /v1/runs` (record mode) returns 201; `GET /v1/runs/:id` returns run or 404; `GET /health` returns 200; mock `aerograph-replay-core` binary
- [x] T028 [P] [US1] Write failing collector endpoint tests in `apps/collector/src/server.test.ts`: `POST /v1/traces/:id/replay` returns 201 with runId/traceId/status; 404 trace not found; 409 no cassette linked
- [x] T029 [P] [US1] Write failing runner unit tests in `apps/collector/src/replay/runner.test.ts`: spawn called with array args (never shell string); env vars injected (`HTTP_PROXY`, `HTTPS_PROXY`, `AFR_RUN_ID`); run status transitions pending->running->completed; process crash -> status crashed

### Implementation — SQLite Persistence (US1)

- [x] T030 [US1] Add migration `006_replay` to `apps/collector/src/sqlite/migrate.ts`: `ALTER TABLE events ADD COLUMN replay_source TEXT DEFAULT NULL`; add `replay_request_key`, `replay_tokens_saved`, `replay_latency_ms`, `replay_streaming_preserved`, `replay_overridden` columns; CREATE TABLE `replay_runs` with all columns from `data-model.md` section 5; add indexes `idx_replay_runs_trace_id` and `idx_replay_runs_status`; guard with `schema_migrations` row `006_replay`
- [x] T031 [US1] Extend `apps/collector/src/sqliteStore.ts`: add `createRun(input): string`, `updateRunStatus(runId, status, extras?)`, `getRunById(runId): GetRunResponse | null`, `listRuns(): GetRunResponse[]`, `getRunByTraceId(traceId): GetRunResponse | null`

### Implementation — Replay Core Binary (US1)

- [x] T032 [US1] Vendor agrepl source into `packages/replay-core/`: copy upstream source (MIT license), update `go.mod` to `module aerograph.dev/replay-core`, verify `record` and `replay` commands compile cleanly with Go 1.21+
- [x] T033 [US1] Add `--live-hosts <comma-separated-glob-patterns>` flag to `packages/replay-core/main.go` and `packages/replay-core/proxy/`: when request host matches a live-host pattern, bypass cassette and forward to real network; add unit test in `packages/replay-core/proxy/live_hosts_test.go`
- [x] T034 [US1] Add `--annotation-log <path>` flag to `packages/replay-core/main.go`: after run completes, write JSON array of per-request annotation objects (requestKey, correlatedSpanId, replaySource, replayLatencyMs, streamingPreserved, decision, matchedPattern, effectiveClass) to specified path
- [x] T035 [US1] Update `packages/replay-core/Makefile` for cross-compilation: linux/amd64, darwin/arm64, windows/amd64 -> `bin/aerograph-replay-core-{os}-{arch}[.exe]`; add CI stub binary script for test environments without Go

### Implementation — Cassette Layer (US1)

- [x] T036 [US1] Implement `apps/collector/src/replay/cassette.ts`: `readCassette(runId, projectRoot): Cassette` (reads and validates `.aerograph/cassettes/<runId>.json`); `writeCassette(runId, projectRoot, data): void` (atomic write via temp file rename); `cassetteExists(runId, projectRoot): boolean`; `validateCassettePath(runId, projectRoot)` (path-traversal guard: assert resolved path starts with `projectRoot/.aerograph/cassettes/`)

### Implementation — Orchestrator (US1)

- [x] T037 [US1] Implement `apps/collector/src/replay/runner.ts`: `spawnRun(runId, mode, command, projectRoot, opts?)` — resolves binary (checks `AERO_REPLAY_CORE_BIN` env var then `packages/replay-core/bin/`); calls `child_process.spawn(binary, argsArray, {env})` with explicit array (no shell); on exit: reads annotation log, calls `store.updateRunStatus()`, schedules annotation ingestion
- [x] T038 [US1] Implement `apps/collector/src/replay/orchestrator.ts`: Express sub-app binding to `127.0.0.1:4318`; routes: `GET /health`, `POST /v1/runs` (validate + create + spawn, return 201), `GET /v1/runs` (list), `GET /v1/runs/:id` (get or 404), `POST /v1/runs/:id/cancel` (SIGTERM + status update); export `createOrchestratorApp(store, runner)`
- [x] T039 [US1] Mount Orchestrator in `apps/collector/src/server.ts` `createApp()`: start `createOrchestratorApp()` on port 4318; skip in `NODE_ENV=test` unless `ENABLE_ORCHESTRATOR=true`

### Implementation — Collector Replay Endpoint (US1)

- [x] T040 [US1] Add `POST /v1/traces/:traceId/replay` to `apps/collector/src/server.ts`: verify trace exists; verify cassette available via `store.getRunByTraceId()` or explicit `cassetteRunId`; validate cassette file exists; call Orchestrator `POST /v1/runs {mode:replay}`; return 201; return 409 if no cassette

### Implementation — Span Annotation Pipeline (US1)

- [x] T041 [US1] Implement annotation ingestion in `apps/collector/src/replay/runner.ts`: after process exit, read `--annotation-log` file; for each entry with `correlatedSpanId`, call `store.appendReplayAnnotation(traceId, spanId, annotation)`
- [x] T042 [US1] Add `appendReplayAnnotation(traceId, spanId, annotation)` to `apps/collector/src/sqliteStore.ts`: UPDATE events SET replay_source, replay_request_key, replay_latency_ms, replay_tokens_saved, replay_streaming_preserved WHERE trace_id=? AND span_id=?; log warning if span not found

### Implementation — Web UI Replay Controls (US1)

- [x] T043 [US1] Add `replayTrace(traceId, cassetteRunId?)` and `getRun(runId)` to `apps/web/src/api.ts`; read orchestrator base URL from `VITE_ORCHESTRATOR_URL` (default `http://localhost:4318`)
- [x] T044 [P] [US1] Create `apps/web/src/RunStatusBadge.tsx`: polls `GET /v1/runs/:runId` every 2s; renders status chip (spinner/pulse/check/X/warning); stops polling on terminal state
- [x] T045 [P] [US1] Create `apps/web/src/ReplayControlPanel.tsx`: Replay Trace button (disabled if no cassette linked); on click calls `api.replayTrace()`, mounts `RunStatusBadge`; on completed: refreshes trace list and switches active trace
- [x] T046 [US1] Modify `apps/web/src/App.tsx`: add `ReplayControlPanel` to toolbar (conditional on cassette availability); add `replaySource` icon to span nodes; add `replayLatencyMs` + `tokensSaved` to Span Info section; add amber warning when `streamingPreserved === false`

### Validation

- [x] T047 [US1] Run `npm run test -w apps-collector`; confirm T025-T029 pass; fix all failures
- [x] T048 [US1] Run Scenarios 1 and 2 from `specs/006-deterministic-replay/quickstart.md` manually; document results in `research.md`

**Checkpoint**: Zero-cost replay works end-to-end. `replaySource: cache` badges visible in UI. All US1 tests green.

---

## Phase 4: User Story 2 — Fork-and-Resume from a Specific Trace Step (Priority: P2)

**Goal**: Developer clicks Fork and Resume in Web UI, optionally edits a prompt, agent re-executes automatically. Pre-fork steps from cache, post-fork steps live. No manual terminal commands.

**Independent Test**: Scenario 3 from `quickstart.md`.

**Dependency**: Phase 3 complete.

### Tests (write first — must FAIL)

- [x] T049 [P] [US2] Write failing server tests in `apps/collector/src/server.test.ts` for `POST /v1/traces/:id/fork-and-resume`: 201 with childTraceId + runId + status; 400 if forkFromSpanId missing; 404 trace not found; 409 no project config
- [x] T050 [P] [US2] Write failing store tests in `apps/collector/src/sqliteStore.test.ts`: `forkTrace()` creates child trace with `derivedFrom` lineage; parent trace events count unchanged; child prefix events match original spanIds
- [x] T051 [P] [US2] Write failing runner tests for fork mode in `apps/collector/src/replay/runner.test.ts`: partial cassette written with only pre-fork entries; `parent_trace_id` set on run record; `--live-hosts` includes `must_execute` patterns

### Implementation — Fork-and-Resume (US2)

- [x] T052 [US2] Add `POST /v1/traces/:traceId/fork-and-resume` to `apps/collector/src/server.ts`: validate with `forkAndResumeRequestSchema`; call existing `store.forkTrace()` (no changes to existing method); call Orchestrator `POST /v1/runs {mode:fork, cassetteRunId, forkFromSpanId, parentTraceId}`; return 201 with `forkAndResumeResponseSchema`
- [x] T053 [US2] Add fork mode to `apps/collector/src/replay/runner.ts` `spawnRun()`: call `cassette.writeForkCassette()` before spawning to produce partial cassette (pre-fork entries only); spawn binary in replay mode — post-fork requests miss cassette and fall back live
- [x] T054 [US2] Add `writeForkCassette(runId, baseCassetteRunId, forkFromSpanId, projectRoot)` to `apps/collector/src/replay/cassette.ts`: read base cassette; filter entries to those whose `correlatedSpanId` is in the pre-fork span set; write filtered cassette to `.aerograph/cassettes/<runId>.json`
- [x] T055 [US2] Add prompt override support: if `forkOverrides.promptText` provided, write override JSON to temp file and pass `--override-file <path>` to binary; add `--override-file` flag to `packages/replay-core/main.go`: substitute cached response at override span and mark `overridden: true` in annotation log
- [x] T056 [US2] Implement `apps/collector/src/replay/policy.ts`: `loadPolicy(projectRoot): ToolSafetyPolicy` (reads + validates `aerograph.replay.yaml` via js-yaml; throws actionable error if missing or malformed per FR-024); `computeLiveHosts(policy): string[]` (extracts `must_execute` URL pattern domains for `--live-hosts` arg)

### Implementation — Web UI Fork-and-Resume (US2)

- [x] T057 [US2] Add `forkAndResume(traceId, forkFromSpanId, overrides?)` to `apps/web/src/api.ts`
- [x] T058 [US2] Modify `apps/web/src/App.tsx` `doForkFromSpan()`: remove `alert()` call; show fork-and-resume modal (span info + optional prompt override field + Launch button); on confirm: call `api.forkAndResume()`, mount `RunStatusBadge`; on completed: refresh traces and switch to `childTraceId`
- [x] T059 [P] [US2] Extract fork-and-resume modal to `apps/web/src/ForkResumeModal.tsx`: prompt override input, cancel button, `RunStatusBadge` post-submit; Generate Fork ID only toggle for backward-compat when Orchestrator not running
- [x] T060 [US2] After fork-and-resume completes: auto-call `api.getDiff(parentTraceId, childTraceId)` and set `diffResult` state so diff panel highlights divergence from fork step (FR-018)

### Validation

- [x] T061 [US2] Run `npm run test -w apps-collector`; confirm T049-T051 pass; fix failures
- [x] T062 [US2] Run Scenario 3 from `quickstart.md`; verify `derivedFrom` lineage in response; verify diff panel highlights fork point

**Checkpoint**: Fork-and-resume requires zero terminal commands. Lineage and diff panels work correctly.

---

## Phase 5: User Story 3 — Tool Safety Policy (Priority: P2)

**Goal**: `aerograph.replay.yaml` maps URL patterns to replay_safe/must_execute. During replay, must_execute always executes live; unclassified defaults to must_execute. Every routing decision logged as span annotation.

**Independent Test**: Scenario 4 from `quickstart.md`.

**Dependency**: Phase 3 complete; policy.ts stub exists from T056.

### Tests (write first — must FAIL)

- [x] T063 [P] [US3] Write failing policy unit tests in `apps/collector/src/replay/policy.test.ts`: `must_execute` rule appears in `computeLiveHosts()`; first-match semantics correct; missing file throws actionable error; malformed YAML throws; unclassified URL defaults to `must_execute`
- [x] T064 [P] [US3] Write failing integration tests in `apps/collector/src/replay/orchestrator.test.ts`: mock binary receives `--live-hosts` arg for `must_execute` patterns; `replay_safe` hosts absent from `--live-hosts`
- [x] T065 [P] [US3] Write failing annotation tests in `apps/collector/src/sqliteStore.test.ts`: `appendReplayAnnotation` stores `decision`, `matchedPattern`, `effectiveClass`; fields visible on `GET /v1/traces/:id` response

### Implementation — Policy Engine (US3)

- [x] T066 [US3] Complete `apps/collector/src/replay/policy.ts`: `evaluateRequest(url, toolName, policy): SafetyClass` (first-match, default `must_execute`); `computeLiveHosts(policy): string[]`; `logRoutingDecision(store, traceId, spanId, decision)` (calls `appendReplayAnnotation` with decision fields)
- [x] T067 [US3] Integrate policy in `apps/collector/src/replay/runner.ts` `spawnRun()`: call `policy.loadPolicy(projectRoot)` before spawn; on error set `status: failed` with actionable `errorMessage`; pass `computeLiveHosts()` as `--live-hosts` arg
- [x] T068 [US3] Extend `packages/replay-core/main.go` annotation log: add `decision`, `matchedPattern`, `effectiveClass` fields to each annotation entry; update `runner.ts` ingestion to include these in `appendReplayAnnotation` call

### Implementation — Web UI Safety Display (US3)

- [x] T069 [US3] Add routing decision display to `apps/web/src/App.tsx` `renderDetail()`: show decision badge (cache/live/must_execute_override/fallback); show `matchedPattern` or amber no-match warning when `matchedPattern === null`

### JSON Schema Publication (US3)

- [x] T070 [P] [US3] Finalize `specs/006-deterministic-replay/contracts/aerograph-replay-yaml.schema.json`; add `schema` declaration; copy to `apps/web/public/schemas/` for IDE resolution

### Validation

- [x] T071 [US3] Run `npm run test -w apps-collector`; confirm T063-T065 pass; fix failures
- [x] T072 [US3] Run Scenario 4 from `quickstart.md`; verify Stripe -> live, OpenAI -> cache; verify span annotations visible in UI

**Checkpoint**: Safety policy enforced. Routing decisions on every span. Missing/malformed config fails fast.

---

## Phase 6: User Story 4 — aerorepl Interactive CLI (Priority: P3)

**Goal**: Terminal-first developer can record, replay, step, inspect, override, rewind, and fork via `aerorepl` CLI backed by the same Orchestrator API powering the Web UI.

**Independent Test**: Scenario 6 from `quickstart.md`.

**Dependency**: Phases 3 and 5 complete.

### Tests (write first — must FAIL)

- [x] T073 [P] [US4] Write failing CLI tests in `packages/aerorepl/src/cli.test.ts` (mock Orchestrator HTTP): `aerorepl record python agent.py` calls `POST /v1/runs {mode:record,command:[python,agent.py]}`; `aerorepl replay <runId>` calls `POST /v1/runs {mode:replay}`; `aerorepl list` calls `GET /v1/runs` and outputs table; non-zero exit on Orchestrator 5xx
- [x] T074 [P] [US4] Write failing REPL subcommand tests in `packages/aerorepl/src/cli.test.ts`: `/step` maps to `POST /v1/sessions/:id/step`; `/inspect <spanId>` maps to `GET /v1/traces/:id/events/:spanId`; `/override <spanId> <json>` maps to `POST /v1/sessions/:id/override`; `/rewind <N>` maps to `POST /v1/sessions/:id/rewind`; `/fork <spanId>` maps to `POST /v1/traces/:id/fork-and-resume`

### Implementation — Orchestrator Session API (US4)

- [x] T075 [US4] Add session routes to `apps/collector/src/replay/orchestrator.ts`: `POST /v1/sessions` (create interactive session for existing run, return sessionId); `GET /v1/sessions/:id`; `POST /v1/sessions/:id/step` (advance one step, return span summary); `POST /v1/sessions/:id/override` (record override, return updated span with `overridden: true`); `POST /v1/sessions/:id/rewind` (create fork at currentStep - N, return new traceId + sessionId)
- [x] T076 [US4] Add `setOverride(spanId, value)` to active run in `apps/collector/src/replay/runner.ts`; write to `--override-file` format; flag overridden spans with `overridden: true` in annotation log
- [x] T077 [US4] Add `GET /v1/traces/:traceId/events/:spanId` to `apps/collector/src/server.ts`: return full `TraceEvent` JSON; 404 if span not found in trace

### Implementation — aerorepl CLI (US4)

- [x] T078 [US4] Implement `packages/aerorepl/src/config.ts`: `loadProjectConfig(cwd)` walks up directory tree for `aerograph.project.yaml`; validates against JSON Schema; throws Create aerograph.project.yaml message if not found
- [x] T079 [US4] Implement `packages/aerorepl/src/client.ts`: typed HTTP client for all Orchestrator + Collector calls; methods: `startRun()`, `getRun()`, `cancelRun()`, `listRuns()`, `createSession()`, `stepSession()`, `inspectSpan()`, `overrideSpan()`, `rewindSession()`, `forkFromSpan()`; throws `AereplError` with status + body on non-2xx
- [x] T080 [US4] Implement `packages/aerorepl/src/cli.ts`: Commander program; top-level subcommands: `record <cmd...>`, `replay <runId>`, `list`, `status <runId>`, `cancel <runId>`; interactive subcommand `session <runId>` (readline loop accepting `/step`, `/inspect <spanId>`, `/override <spanId> <json>`, `/rewind <N>`, `/fork <spanId>`, `/quit`); `--json` flag for machine-readable output
- [x] T081 [P] [US4] Set bin and build script in `packages/aerorepl/package.json`; add `@aerograph/aerorepl` to root workspace `package.json` build target

### Validation

- [x] T082 [US4] Run `npm run test -w packages/aerorepl`; confirm T073-T074 pass; fix failures
- [x] T083 [US4] Run Scenario 6 from `quickstart.md`; verify `aerorepl list` matches Web UI trace list; verify `/inspect` output matches UI span detail

**Checkpoint**: aerorepl fully functional. All operations backed by Orchestrator. REPL parity with Web UI confirmed.

---

## Phase 7: User Story 5 — Framework-Agnostic Adapter Authoring (Priority: P3)

**Goal**: Any adapter emitting canonical `TraceEvent` events gets zero-cost replay automatically — no replay-specific code required in the adapter.

**Independent Test**: Record + replay stub adapter; verify `replaySource: cache`; assert no replay imports in adapter.

**Dependency**: Phase 3 complete.

### Tests (write first — must FAIL)

- [x] T084 [P] [US5] Write failing integration test in `tests/integration/stub_adapter.test.ts`: spawn stub agent emitting FlightRecorder events; run under Orchestrator record mode; verify cassette created; run replay; verify `replaySource: cache` on all spans; assert zero replay-specific imports in stub adapter
- [x] T085 [P] [US5] Write failing documentation tests: assert `packages/adapter-langchain/README.md` contains phrase Replay support is inherited automatically; assert `python/aerograph-langchain/README.md` contains same phrase

### Implementation — Adapter Docs (US5)

- [x] T086 [US5] Update `packages/adapter-langchain/README.md`: add Replay Support section stating Replay support is inherited automatically — no replay-specific code is required in your adapter; link to `quickstart.md` Scenario 1
- [x] T087 [P] [US5] Update `python/aerograph-langchain/README.md`: identical Replay Support section content
- [x] T088 [P] [US5] Create `docs/adapters/authoring-guide.md`: document that canonical `TraceEvent` emission gives automatic replay; adapters must NOT add replay-specific logic; link to `aerograph.project.yaml` setup
- [x] T089 [P] [US5] Create `tests/fixtures/stub-adapter/stub_agent.py`: imports `aerograph_sdk.FlightRecorder`, emits prompt + response + tool_call + tool_result events, makes one mocked HTTP call; no replay imports

### Validation

- [x] T090 [US5] Run T084-T085; fix failures
- [x] T091 [US5] Verify cassette portability: copy cassette to temp dir, change projectRoot, run replay; verify success

**Checkpoint**: Framework-agnostic claim tested. Adapter docs state the replay inheritance guarantee.

---

## Phase 8: Cross-Language Parity & Integration Testing

**Purpose**: Prove Python and Node agents produce semantically equivalent `TraceEvent` structures and cassettes are portable across runtimes.

**Dependency**: Phases 3-7 complete.

- [x] T092 [P] Write Python record integration test in `tests/integration/test_cross_lang.py`: Python agent -> `aerograph_sdk.FlightRecorder` -> Collector; assert `TraceEvent` fields match canonical contract schema
- [x] T093 [P] Write Node record integration test in `tests/integration/cross_lang.test.ts`: Node agent -> `@aerograph/sdk FlightRecorder` -> Collector; assert `TraceEvent` shapes semantically equivalent to T092
- [x] T094 Write Python-record -> Python-replay test: record with Python stub; replay with Python stub; assert `replaySource: cache` on all spans; assert trace DAG semantically identical
- [x] T095 [P] Write Python-record -> Node-replay test: Python stub records cassette; Node stub replays it; assert cassette portability; assert canonical event shapes match
- [x] T096 [P] Write Node-record -> Python-replay test: Node stub records; Python stub replays; assert portability
- [x] T097 Write frontend parity test: both Python and Node traces served via same `GET /v1/traces/:id` endpoint; assert identical `TraceEvent` schema shapes; assert no language-specific fields in API response
- [x] T098 Run full cross-language matrix; document results in `specs/006-deterministic-replay/research.md` cross-language section

---

## Phase 9: Determinism, Security & Performance Verification

**Purpose**: Validate replay integrity guarantees, security safeguards, and performance targets from `spec.md`.

**Dependency**: Phases 3-7 complete.

### Determinism & Integrity

- [x] T099 [P] Write determinism test in `apps/collector/src/replay/cassette.test.ts`: same request inputs produce identical `requestKey` across independent computations; 100 distinct requests produce no collisions
- [x] T100 [P] Write immutable-parent test in `apps/collector/src/sqliteStore.test.ts`: after fork-and-resume creates child trace, parent trace event count and content are byte-identical to pre-fork state
- [x] T101 [P] Write corrupted cassette test in `apps/collector/src/replay/cassette.test.ts`: write malformed JSON; assert `readCassette()` throws Cassette for run X is missing or unreadable; assert agent process never starts
- [x] T102 [P] Write missing cassette test in `apps/collector/src/server.test.ts`: call `POST /v1/traces/:id/replay` with no cassette; assert 409 No cassette linked. Re-record this run
- [x] T103 [P] Write process-crash test in `apps/collector/src/replay/runner.test.ts`: mock binary exits non-zero; assert `status: failed`, exitCode set, errorMessage populated; assert partial events persisted
- [x] T104 [P] Write concurrent replay test: two simultaneous `POST /v1/runs` for same cassette; assert each gets unique runId/traceId; assert cassette never mutated (read-only during replay)
- [x] T105 Write replay-does-not-mutate-history test: replay a trace; assert original trace events byte-identical before and after; assert no `replay_source` written to original trace spans

### Security

- [x] T106 [P] Write command injection test in `apps/collector/src/replay/runner.test.ts`: `command: [python; rm -rf /, agent.py]` -> assert spawn called with array, semicolon is literal argument not shell operator
- [x] T107 [P] Write path traversal test in `apps/collector/src/replay/cassette.test.ts`: `runId: ../../etc/passwd` -> assert `validateCassettePath()` throws before any filesystem I/O
- [x] T108 [P] Write malformed YAML test in `apps/collector/src/replay/policy.test.ts`: `aerograph.replay.yaml` with invalid YAML -> `loadPolicy()` throws actionable message; run never starts
- [x] T109 [P] Write Orchestrator binding test: assert `server.address().address === 127.0.0.1` (loopback only); assert external IP binding not permitted

### Performance

- [x] T110 [P] Write cassette lookup benchmark in `packages/replay-core/cassette/bench_test.go`: measure `findEntry()` time at 100/500/1000 entries; assert p50 < 5ms; record in `research.md`
- [x] T111 [P] Write hydration latency test in `apps/collector/src/replay/runner.test.ts`: mock binary writes 50 annotation entries; measure annotation ingestion time to `appendReplayAnnotation()` completion; assert p50 < 5ms

---

## Phase 10: Schema Exporter, Documentation & Final Polish

**Purpose**: Regenerate JSON Schema export, finalize documentation, run full quickstart validation.

**Dependency**: All previous phases complete.

- [x] T112 [P] Run `npm run schema:export` after all contract changes; commit updated files in `packages/schema-exporter/dist/`; verify `npm run drift:check` passes
- [x] T113 [P] Update root `README.md`: add Deterministic Replay section (record/replay/fork workflow overview); link to `specs/006-deterministic-replay/quickstart.md`; add `aerorepl` to getting-started guide
- [x] T114 [P] Create `docs/replay/getting-started.md`: step-by-step guide (Go install, mkcert setup, `aerograph.project.yaml` creation, Windows notes); targets SC-010 (first recording in under 5 minutes)
- [x] T115 [P] Create `docs/replay/safety-policy.md`: `aerograph.replay.yaml` reference — all safety classes, default-deny behavior, URL glob syntax, overlap resolution (first-match), worked examples; link to JSON Schema
- [x] T116 [P] Create `docs/replay/windows-setup.md`: Go install, mkcert CA trust, Windows Defender exclusions for MITM proxy port, PowerShell quoting for `aerorepl record`
- [x] T117 [P] Update `packages/adapter-langchain/README.md` and `python/aerograph-langchain/README.md` with correlation header notes: where `X-AeroGraph-Span-Id` injection is supported vs. timestamp-window fallback
- [x] T118 Add migration `006_replay` notice to `CHANGELOG.md`: Additive-only — existing databases upgrade automatically on first start
- [x] T119 Run all six Scenarios from `specs/006-deterministic-replay/quickstart.md`; document pass/fail for each; fix any failures before marking complete
- [x] T120 Run full test suite `npm test`; fix any regressions; confirm `npm run drift:check` passes

---

## Dependencies & Execution Order

### Phase Dependencies

`
Phase 0 (Fork Build: Hashed Matcher + Spike)  -> blocks all implementation
    |
Phase 0.5 (Fork Build: Streaming)              -> blocks Orchestrator (Phase 2)
Security Gate (CA Lifecycle Remediation)        -> BLOCKS Phase 2
    |
Phase 1 (Setup) -> scaffolding, can overlap with Phase 0 for file structure
    |
Phase 2 (Contracts) -> BLOCKS ALL USER STORIES
    |
Phase 3 (US1 Zero-Cost Replay) -> MVP
    |
Phase 4 (US2 Fork-and-Resume)    requires Phase 3
Phase 5 (US3 Safety Policy)      requires Phase 3
    | (Phases 4 and 5 run in parallel after Phase 3)
Phase 6 (US4 aerorepl CLI)       requires Phases 3 + 5
Phase 7 (US5 Framework-Agnostic) requires Phase 3 only
    |
Phase 8 (Cross-Language Parity)  requires Phases 3-7
Phase 9 (Security/Perf)          requires Phases 3-7
    |
Phase 10 (Docs + Polish)         requires all above
`

### Within Each User Story Phase

1. Tests MUST be written first and must FAIL before any implementation starts
2. SQLite persistence -> Orchestrator core -> Collector endpoints -> Web UI / CLI
3. Go binary changes before TypeScript runner code that depends on new flags
4. Schema exports run last, after all contracts stabilized

### Parallel Opportunities

- T002-T003 (hashed matcher build): T003 can run in parallel with T002 (different files)
- T004, T006-T009 (compatibility + spikes): all parallel after T001
- T011-T012 (streaming build): parallel with each other; T014 (test) parallel too
- T015 (upstream disclosure): parallel with all Security Gate build tasks
- T016-T019 (CA lifecycle build): T019 (uninstall) parallel with T016-T018
- T017-T019 within contracts (old IDs shifted): contract tests fully parallel
- All [P]-marked tasks within each phase: see per-task annotations

---

## Implementation Strategy

### MVP Scope (Phases 0, 0.5, Security Gate, 1, 2, then Phase 3)

1. Complete Phase 0 fork build (hashed matcher) + spike, confirm benchmarks
2. Complete Phase 0.5 fork build (streaming) in parallel with Security Gate
3. Complete Security Gate (CA lifecycle) — BLOCKS Phase 2
4. Complete Phase 1 setup, scaffolding ready
5. Complete Phase 2 contracts, CRITICAL blocking gate
6. Complete Phase 3 (US1), zero-cost replay end-to-end
7. STOP AND VALIDATE: Run Scenarios 1 + 2 from quickstart.md (including CA lifecycle check)
8. MVP ACHIEVED: Zero-cost replay works. Demo-ready.

### Incremental Delivery

| Milestone | What ships |
|-----------|-----------|
| Phase 3 done | MVP: Zero-cost replay |
| Phase 4 done | Fork-and-resume automated |
| Phase 5 done | Safety policy enforced |
| Phase 6 done | aerorepl CLI available |
| Phase 7 done | Framework-agnostic claim validated |
| Phases 8-10 done | Full integration tests + docs |

---

## Notes

- [P] = operates on different files, no shared state, safe to parallelize
- Every [US*] maps to a spec user story for completeness traceability
- The canonical TraceEvent (Phase 2) is the language-neutral boundary, never add language-specific fields
- Web UI is a visualization layer only, no replay algorithms in React components
- aerograph-replay-core binary must be the hardened fork build (Phase 0 + 0.5 + Security Gate), not upstream
- ALL child_process.spawn() calls use explicit array form, never shell strings
- Cassette paths validated before any file I/O to prevent path traversal
- Fork native cassette path is .agent-replay/runs/ (NOT .agrepl/runs/ as the paper stated); Orchestrator copies to .aerograph/cassettes/
- Do NOT revive the legacy store.ts JSONL store, sqliteStore.ts is authoritative
- FR-036 upstream contribution is best-effort; feature ships on vendored fork regardless
- FR-037 (CA lifecycle) is NON-NEGOTIABLE and gates the Orchestrator; upstream must also be notified
- FR-038 (streaming) is a confirmed build dependency, not a spike question
- Total tasks: T001-T021 (Phase 0 + 0.5 + Security Gate) + T022+ (Phase 1 onward); task IDs in Phase 1+ are shifted by the new pre-work tasks