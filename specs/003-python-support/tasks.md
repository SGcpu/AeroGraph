# Tasks: Feature 003 — Python SDK & Multi-Language Contract Support

**Input**: Design documents from `/specs/003-python-support/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are REQUIRED for schema export/governance, deterministic hashing parity, adapters, and Python→collector integration.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the minimum scaffolding to support schema export and Python packages.

- [x] T001 Add new workspace package skeleton for schema export in `packages/schema-exporter/package.json`
- [x] T002 [P] Add TypeScript build config for schema exporter in `packages/schema-exporter/tsconfig.json`
- [x] T003 [P] Add schema exporter entrypoint scaffold in `packages/schema-exporter/src/index.ts`
- [x] T004 Wire schema exporter into workspace scripts in `package.json`
- [x] T005 [P] Scaffold Python SDK package layout in `python/aerograph-sdk/pyproject.toml`
- [x] T006 [P] Scaffold Python LangChain adapter package layout in `python/aerograph-langchain/pyproject.toml`
- [x] T007 [P] Add Python repo tooling documentation in `python/README.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema governance and cross-language parity MUST be complete before ANY Python SDK or adapter implementation begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Schema Exporter (contracts → versioned JSON Schema)

- [x] T008 Add JSON Schema export implementation (TraceEvent + core types) in `packages/schema-exporter/src/export.ts`
- [x] T009 Add schema version routing (keyed by event `schemaVersion`) in `packages/schema-exporter/src/versions.ts`
- [x] T010 Define the on-disk artifact layout and output paths in `packages/schema-exporter/src/paths.ts`
- [x] T011 Add CLI/script entry to generate artifacts in `packages/schema-exporter/src/cli.ts`
- [x] T012 Generate and commit versioned JSON Schema artifacts in `packages/schema-exporter/artifacts/1.0.0/trace-event.schema.json`

### Drift Detection (CI fails if artifacts are stale)

- [x] T013 Add a drift-check command that fails on uncommitted schema changes in `packages/schema-exporter/src/checkArtifacts.ts`
- [x] T014 Wire `schema:export` and `schema:check` scripts in `packages/schema-exporter/package.json`
- [x] T015 Add a repo-level drift check aggregator script in `package.json` (runs schema + Python model checks)

### Cross-Language Parity Fixtures (source-controlled)

- [x] T016 Add canonical hashing fixtures (inputs + expected hash strings) in `packages/contracts/src/__fixtures__/parity/state-hash.json`
- [x] T017 Add canonical event fixtures (one per `kind`) in `packages/contracts/src/__fixtures__/parity/trace-events.json`
- [x] T018 Add ordering fixtures covering tie-break rules in `packages/contracts/src/__fixtures__/parity/event-ordering.json`

### TypeScript-side Parity Tests (ground truth)

- [x] T019 Add Vitest coverage for state hash fixtures in `packages/contracts/src/utils/hash.test.ts`
- [x] T020 Add Vitest coverage for ordering fixtures (occurredAt → spanId → kind) in `packages/contracts/src/index.test.ts`
- [x] T021 Add a schema exporter snapshot/regression test in `packages/schema-exporter/src/export.test.ts`

### Python Contract Model Generation (derived artifact)

- [x] T022 Add a pinned model-generation toolchain config in `python/aerograph-sdk/tools/datamodel-codegen.toml`
- [x] T023 Add generator wrapper to produce Pydantic v2 models from JSON Schema in `python/aerograph-sdk/tools/generate_contracts.py`
- [x] T024 Generate and commit Python contract models into `python/aerograph-sdk/src/aerograph_sdk/contracts/generated.py`
- [x] T025 Add a drift-check that fails if generated models are stale in `python/aerograph-sdk/tools/check_generated_contracts.py`

**Checkpoint**: Foundation ready — schema artifacts, parity fixtures, and drift checks exist; user story work can begin.

---

## Phase 3: User Story 1 — Python Developers Can Record Traces (Priority: P1) 🎯 MVP

**Goal**: Provide a Python SDK that emits schema-valid trace events to the existing collector and renders correctly in the existing UI.

**Independent Test**: Run collector + web UI, run a small Python script using the SDK to emit a representative trace, verify trace is persisted/retrievable and renders deterministically.

### Tests for User Story 1 ⚠️

> **NOTE**: Write these tests FIRST and ensure they FAIL before implementation.

- [x] T026 [P] [US1] Add pytest harness and config in `python/aerograph-sdk/pyproject.toml`
- [x] T027 [P] [US1] Add Python hashing parity tests (uses TS fixtures) in `python/aerograph-sdk/tests/test_state_hash_parity.py`
- [x] T028 [P] [US1] Add Python contract model validation tests against event fixtures in `python/aerograph-sdk/tests/test_trace_event_models.py`
- [x] T029 [US1] Add Python ordering parity tests (occurredAt → spanId → kind) in `python/aerograph-sdk/tests/test_event_ordering.py`
- [x] T030 [US1] Add SDK batching + sync/async emission unit tests with HTTP mocking in `python/aerograph-sdk/tests/test_emitter.py`

### Implementation for User Story 1

- [x] T031 [P] [US1] Implement JSON-compat normalization helpers in `python/aerograph-sdk/src/aerograph_sdk/json_normalize.py`
- [x] T032 [P] [US1] Implement deterministic state hashing (JS UTF-16 FNV-1a parity) in `python/aerograph-sdk/src/aerograph_sdk/state_hash.py`
- [x] T033 [P] [US1] Implement ID helpers (trace/span) in `python/aerograph-sdk/src/aerograph_sdk/ids.py`
- [x] T034 [US1] Implement TraceEvent builders (one per kind) in `python/aerograph-sdk/src/aerograph_sdk/events.py`
- [x] T035 [US1] Implement FlightRecorder core (sync + async + batching) in `python/aerograph-sdk/src/aerograph_sdk/recorder.py`
- [x] T036 [US1] Add minimal runnable example script in `python/aerograph-sdk/examples/minimal_trace.py`

### Integration for User Story 1

- [x] T037 [US1] Add Python→collector smoke integration test (run collector, emit, retrieve) in `python/aerograph-sdk/tests_integration/test_collector_smoke.py`

**Checkpoint**: User Story 1 works independently — Python users can emit traces and see them in the UI.

---

## Phase 4: User Story 2 — LangChain Python Users Can Attach an Adapter (Priority: P2)

**Goal**: Provide a Python LangChain callback adapter that emits deterministic, schema-valid normalized events.

**Independent Test**: Run a small LangChain workflow with the adapter enabled and verify emitted trace includes prompt/response, tool call/result (if used), retriever context (if used), and state/checkpoint events when available.

### Tests for User Story 2 ⚠️

> **NOTE**: Write these tests FIRST and ensure they FAIL before implementation.

- [x] T038 [P] [US2] Add adapter test harness + pinned LangChain deps in `python/aerograph-langchain/pyproject.toml`
- [x] T039 [P] [US2] Add deterministic spanId derivation tests for LangChain run IDs in `python/aerograph-langchain/tests/test_span_id_derivation.py`
- [x] T040 [P] [US2] Add adapter mapping fixture (LangChain callbacks → expected TraceEvents) in `python/aerograph-langchain/tests/fixtures/langchain_run.json`
- [x] T041 [US2] Add unit tests for prompt/response/tool mapping in `python/aerograph-langchain/tests/test_handler_mapping.py`
- [x] T042 [US2] Add unit tests for streaming telemetry emission in `python/aerograph-langchain/tests/test_streaming.py`
- [x] T043 [US2] Add unit tests for retriever payload emission in `python/aerograph-langchain/tests/test_retriever.py`
- [x] T044 [US2] Add unit tests for LangGraph state snapshots + checkpoints (when available) in `python/aerograph-langchain/tests/test_langgraph.py`

### Implementation for User Story 2

- [x] T045 [US2] Implement callback handler wiring and lifecycle hooks in `python/aerograph-langchain/src/aerograph_langchain/handler.py`
- [x] T046 [P] [US2] Implement stable span ID derivation helpers in `python/aerograph-langchain/src/aerograph_langchain/span_ids.py`
- [x] T047 [US2] Implement prompt/response/tool event mapping in `python/aerograph-langchain/src/aerograph_langchain/mapping.py`
- [x] T048 [US2] Implement streaming telemetry support in `python/aerograph-langchain/src/aerograph_langchain/streaming.py`
- [x] T049 [US2] Implement retriever payload support in `python/aerograph-langchain/src/aerograph_langchain/retriever.py`
- [x] T050 [US2] Implement LangGraph state snapshot + checkpoint emission hooks in `python/aerograph-langchain/src/aerograph_langchain/langgraph.py`
- [x] T051 [US2] Add runnable LangChain example in `python/aerograph-langchain/examples/langchain_demo.py`

**Checkpoint**: User Story 2 works independently — a LangChain workflow emits rich, deterministic traces.

---

## Phase 5: User Story 3 — Maintainers Prevent Cross-Language Contract Drift (Priority: P3)

**Goal**: Ensure canonical contracts, JSON Schema artifacts, and Python generated models cannot drift silently.

**Independent Test**: Change canonical contracts and confirm CI fails unless schema artifacts + generated Python models are updated; verify cross-language hashing fixtures prevent divergence.

### Implementation for User Story 3

- [x] T052 Add maintainer documentation for updating artifacts in `docs/architecture/contract-governance.md`
- [x] T053 Add CI workflow for schema export + drift detection in `.github/workflows/schema-governance.yml`
- [x] T054 Add CI workflow for Python unit tests + model drift checks in `.github/workflows/python.yml`
- [x] T055 Add CI workflow for cross-language parity checks (hash + fixtures) in `.github/workflows/parity.yml`
- [x] T056 Add a contributor-facing "update artifacts" command reference in `README.md`
- [x] T057 Add future-adapter architecture placeholders (no implementation) in `docs/architecture/python-adapter-futures.md`

**Checkpoint**: User Story 3 works independently — drift checks fail deterministically and documentation is clear.

---

## Phase 6: Cross-Story Integration Tests (Python ↔ Collector)

**Purpose**: Validate end-to-end interoperability and replay-safe invariants once SDK + adapter exist.

- [ ] T058 Add a Node-driven test harness to start collector for integration tests in `apps/collector/src/testUtils.ts`
- [ ] T059 Add end-to-end test: run Python SDK example → verify collector retrieval responses in `apps/collector/src/pythonSdk.e2e.test.ts`
- [ ] T060 Add end-to-end test: run Python LangChain example → verify trace shape invariants in `apps/collector/src/pythonLangchain.e2e.test.ts`

---

## Phase 7: Packaging and Release (Priority: P2)

- [x] T060 Update version numbers in `python/aerograph-sdk/pyproject.toml`
- [x] T061 Update version numbers in `python/aerograph-langchain/pyproject.toml`
- [x] T062 Add PyPI release workflow in `.github/workflows/release-python.yml`
- [x] T063 Update main repo `README.md` to reference the Python SDK

**Purpose**: Ensure Python packages are buildable/publishable and guarded by parity checks.

- [x] T064 Add a release checklist that requires hash + contract parity passing in `docs/architecture/python-release-checklist.md`

---

## Phase 8: Polish and Handoff (Priority: P4)

- [x] T064 Format all Python code (run `ruff format`)
- [x] T065 Lint all Python code (run `ruff check --fix`)
- [x] T066 Type check all Python code (run `pyright`)
- [x] T067 Final review against architecture spec (`specs/003-python-support/spec.md`)
- [x] T068 Commit all changes with `speckit-git-commit`
- [x] T069 Update product guide to mention Python SDK + adapters
- [x] T070 Update or add Python quickstart documentation (repo docs)
- [x] T071 Add LangChain Python example documentationation in `docs/architecture/python-langchain-example.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3–5)**: All depend on Foundational completion
  - US1 should be implemented first (MVP)
  - US2 depends on US1 (adapter uses SDK)
  - US3 can be implemented after Foundational and in parallel with US1/US2 if staffed
- **Cross-Story Integration (Phase 6)**: Depends on US1 and US2
- **Packaging (Phase 7)**: Depends on US1 and governance gates (US3 + parity)
- **Polish (Phase 8)**: Can proceed once US1 exists; best after US2/US3

### User Story Dependencies

- **US1 (P1)**: Start after Foundational — no dependencies on other stories
- **US2 (P2)**: Start after US1 — depends on the Python SDK surface
- **US3 (P3)**: Start after Foundational — independent but validates the whole system

### Parallel Opportunities

- All tasks marked [P] can run in parallel within their phase
- Within Foundational: fixtures + TS tests + schema exporter tests can be parallelized
- Within US1: hashing/IDs/events modules can be parallelized
- Within US2: streaming/retriever/langgraph modules can be parallelized
- CI workflow authoring (US3) can proceed in parallel once the commands exist

---

## Parallel Example: User Story 1

```bash
Task: "[US1] Implement deterministic state hashing (JS UTF-16 FNV-1a parity) in python/aerograph-sdk/src/aerograph_sdk/state_hash.py"
Task: "[US1] Implement ID helpers (trace/span) in python/aerograph-sdk/src/aerograph_sdk/ids.py"
Task: "[US1] Implement TraceEvent builders (one per kind) in python/aerograph-sdk/src/aerograph_sdk/events.py"
```

---

## Parallel Example: User Story 2

```bash
Task: "[US2] Implement streaming telemetry support in python/aerograph-langchain/src/aerograph_langchain/streaming.py"
Task: "[US2] Implement retriever payload support in python/aerograph-langchain/src/aerograph_langchain/retriever.py"
Task: "[US2] Implement LangGraph state snapshot + checkpoint emission hooks in python/aerograph-langchain/src/aerograph_langchain/langgraph.py"
```

---

## Notes

- Tasks in Phase 2 (Foundational) are explicit governance gates: schema export + drift detection + parity fixtures must exist before Python implementation.
- Adapter scope is limited to LangChain Python for this feature; AutoGen and CrewAI are treated as future architecture targets only.
- Hash parity MUST match `@aerograph/contracts` behavior for backward compatibility.
