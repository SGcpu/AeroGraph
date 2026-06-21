# Tasks: Canonical Telemetry Model Enrichment

**Input**: Design documents from `specs/005-telemetry-enrichment/`
**Prerequisites**: plan.md, spec.md

## Phase 1: Setup

**Purpose**: Project initialization and basic structure.

- [ ] T001 Create `specs/005-telemetry-enrichment/tasks.md` (completed)
- [ ] T002 Review project structure and setup local SQLite database for testing in `apps/collector/`

---

## Phase 2: Foundational

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented.

- [ ] T003 [P] Update canonical event schema to v1.1.0 (excluding cost) in `packages/contracts/src/schema/event.json`
- [ ] T004 [P] Update shared TypeScript contracts for telemetry fields in `packages/contracts/src/types.ts`
- [ ] T005 [P] Update shared Python contracts for telemetry fields in `python/aerograph-sdk/aerograph_sdk/contracts/types.py`
- [ ] T006 [P] Create generic canonical telemetry mapper utility (TypeScript) in `packages/sdk/src/telemetry/mapper.ts`
- [ ] T007 [P] Create generic canonical telemetry mapper utility (Python) in `python/aerograph-sdk/aerograph_sdk/telemetry/mapper.py`
- [ ] T008 Design SQLite migration strategy (new columns/indexes for durationMs, totalTokens, projectId, environment) in `apps/collector/src/db/migrations/005_telemetry.sql`
- [ ] T009 [P] Define OTEL semantic mapping foundation (gen_ai attributes) in `packages/otel/src/semantic_mapping.ts`
- [ ] T010 [P] Create backward compatibility validation suite (1.0.0 event -> 1.1.0 collector, replay, OTEL export, UI rendering) in `apps/collector/tests/backward_compatibility.test.ts`

---

## Phase 3: User Story 1 - Trace Observation and Metric Analysis (Priority: P1)

**Goal**: View detailed observability metrics (token consumption, execution duration, model usage) for traces and trace aggregates in the UI.
**Independent Test**: Send a trace with full telemetry; verify UI correctly visualizes model, usage, and derived cost without regressions.

### Implementation for User Story 1

- [ ] T011 [US1] Implement core telemetry schema support in TypeScript tracer (`durationMs`, `usage`, `model`) in `packages/sdk/src/tracer.ts`
- [ ] T012 [P] [US1] Implement core telemetry schema support in Python tracer (`durationMs`, `usage`, `model`) in `python/aerograph-sdk/aerograph_sdk/tracer.py`
- [ ] T013 [US1] Update collector ingestion paths to parse and store token usage and model metadata in `apps/collector/src/api/ingestion.ts`
- [ ] T014 [P] [US1] Create trace statistics endpoint `GET /v1/traces/:id/stats` (returning totalInputTokens, totalOutputTokens, totalTokens, durationMs, modelBreakdown[]) in `apps/collector/src/api/routes/stats.ts`
- [ ] T015 [P] [US1] Build collector analytics aggregations (tokens, duration, model usage) in `apps/collector/src/api/analytics.ts`
- [ ] T015A [US1] Extend TraceAnalysis generation to include totalInputTokens, totalOutputTokens, totalTokens, totalDurationMs, and modelNamesUsed[] in `apps/collector/src/services/analysis.ts`
- [ ] T016 [P] [US1] Implement UI trace analytics panels (display usage, model, and duration metrics) in `apps/web/src/components/TraceAnalyticsPanel.tsx`
- [ ] T017 [US1] Implement UI token and model visualization at the span level in `apps/web/src/components/SpanDetails.tsx`

---

## Phase 4: User Story 2 - Project and Environment Isolation (Priority: P1)

**Goal**: Filter traces and metrics by project identity and environment context.
**Independent Test**: Emit traces across multiple projects/environments and apply global UI filters to segregate them.

### Implementation for User Story 2

- [ ] T018 [P] [US2] Add `projectId` and `environment` tag support to TypeScript tracer initialization in `packages/sdk/src/config.ts`
- [ ] T019 [P] [US2] Add `projectId` and `environment` tag support to Python tracer initialization in `python/aerograph-sdk/aerograph_sdk/config.py`
- [ ] T020 [US2] Persist `projectId` and `environment` in storage layer in `apps/collector/src/db/repositories/trace_repository.ts`
- [ ] T021 [US2] Add database indexes for `projectId` and `environment` in `apps/collector/src/db/migrations/005_telemetry.sql`
- [ ] T022 [US2] Update collector filtering APIs to accept project and environment parameters in `apps/collector/src/api/routes/traces.ts`
- [ ] T023 [P] [US2] Build UI filtering and search bar components for project and environment selection in `apps/web/src/components/GlobalFilterBar.tsx`

---

## Phase 5: User Story 3 - Framework-Agnostic Telemetry Normalization (Priority: P2)

**Goal**: Framework-specific telemetry maps automatically to the canonical model without unstructured workarounds.
**Independent Test**: Run adapters; verify canonical fields are populated and unstructured kwargs are absent.

### Implementation for User Story 3

- [ ] T024 [P] [US3] Normalize LangChain TypeScript adapter telemetry using generic mapper in `packages/adapter-langchain/src/index.ts`
- [ ] T025 [P] [US3] Normalize LangChain Python adapter telemetry using generic mapper in `python/aerograph-langchain/aerograph_langchain/index.py`
- [ ] T026 [US3] Remove legacy note-event telemetry workarounds across all adapters
- [ ] T027 [US3] Create adapter parity validation suite in `packages/adapter-langchain/tests/parity.test.ts`

---

## Phase 6: User Story 4 - OpenTelemetry GenAI Semantic Integration (Priority: P2)

**Goal**: Emit official OpenTelemetry GenAI semantic attributes for compatibility with external platforms.
**Independent Test**: Export spans via OTEL bridge and assert `gen_ai.*` attributes are correctly populated.

### Implementation for User Story 4

- [ ] T028 [US4] Map canonical telemetry to GenAI semantic conventions (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`) for export in `packages/otel/src/exporter.ts`
- [ ] T029 [US4] Update OTEL import bridge to reconstruct canonical telemetry fields from `gen_ai` semantic attributes in `packages/otel/src/importer.ts`
- [ ] T030 [P] [US4] Update OTEL bridge configuration and payload formatting in `packages/otel/src/index.ts`
- [ ] T031 [P] [US4] Write export validation tests for GenAI attributes in `packages/otel/tests/export.test.ts`
- [ ] T032 [US4] Write import compatibility validation tests for external OTEL collectors in `packages/otel/tests/import.test.ts`
- [ ] T032A [US4] Validate OTEL round-trip mapping for telemetry metadata (Canonical Event → OTEL Span → Canonical Event) ensuring model, usage, durationMs, projectId, and environment are preserved in `packages/otel/tests/roundtrip.test.ts`

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, performance benchmarking, and documentation updates.

- [ ] T033 [P] Run and verify cross-language parity tests (`tests/integration/cross_language.test.ts`)
- [ ] T034 [P] Run and verify replay compatibility tests across updated schemas (`tests/integration/replay.test.ts`)
- [ ] T035 Run schema migration tests against production-like dataset (`apps/collector/tests/migration.test.ts`)
- [ ] T036 Execute performance benchmarks for 100k traces focusing on `totalTokens` and `durationMs` indexes (`apps/collector/tests/analytics_benchmark.ts`)
- [ ] T037 [P] Update user documentation for `telemetry`, `metadata`, `analytics` `projectId`, `environment` (`docs/telemetry.md`)
- [ ] T038 [P] Update `walkthrough.md` with UI screenshots and configuration examples

---

## Coverage Verification Checklist
- `model`: T006, T007, T011, T012, T014, T015, T016, T017
- `usage`: T006, T007, T011, T012, T013, T015, T016
- `durationMs`: T006, T007, T008, T011, T012, T014
- `projectId`: T008, T018, T019, T020, T021, T022, T023
- `environment`: T008, T018, T019, T020, T021, T022, T023
- `tags`: T018, T019, T022
- `OTEL gen_ai attributes`: T009, T028, T029, T031

## Dependencies & Execution Order
- **Setup** → **Foundational** (blocks all user stories)
- **User Story 1 & 2** (P1) can proceed in parallel post-foundation.
- **User Story 3** (P2) depends on User Story 1 (core tracer support).
- **User Story 4** (P2) depends on User Story 1 (canonical fields availability).
- **Polish** depends on the completion of all prioritized stories.
