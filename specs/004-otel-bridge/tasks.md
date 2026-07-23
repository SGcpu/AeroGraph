# Tasks: Feature 004 — OpenTelemetry Bridge

**Input**: Design documents from `specs/004-otel-bridge/`

**Prerequisites**: [plan.md](plan.md) · [spec.md](spec.md) · [research.md](research.md) · [data-model.md](data-model.md) · [contracts/contracts.md](contracts/contracts.md) · [quickstart.md](quickstart.md)

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no shared dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Include exact file paths in every description

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Scaffold the two new packages and the shared golden fixture directory. No logic yet — just project initialization.

- [x] T001 Create `packages/otel/` directory with `package.json` (name `@aerograph/otel`, peer dep `@aerograph/contracts@^0.2.0`, dep `zod`, devDep `vitest`)
- [x] T002 Create `packages/otel/tsconfig.json` extending root `tsconfig.base.json` and `packages/otel/vitest.config.ts`
- [x] T003 Create `packages/otel/src/index.ts` as empty barrel export (placeholder so package builds)
- [x] T004 Add `@aerograph/otel` to root `package.json` workspaces array and build/test scripts
- [x] T005 Create `python/aerograph-otel/` directory with `pyproject.toml` (name `aerograph-otel`, dep `aerograph-sdk`)
- [x] T006 Create `python/aerograph-otel/src/aerograph_otel/__init__.py` as empty module placeholder
- [x] T007 Create `specs/004-otel-bridge/fixtures/` directory and populate 10 canonical AeroGraph TraceEvent JSON files (one per event kind: `prompt_event.json`, `response_event.json`, `tool_call_event.json`, `tool_result_event.json`, `handoff_event.json`, `error_event.json`, `note_event.json`, `retriever_event.json`, `checkpoint_event.json`, `state_snapshot_event.json`) — all must pass `validateTraceEvent()` from `@aerograph/contracts`
- [x] T008 Create `specs/004-otel-bridge/fixtures/expected_otlp/` directory with 10 expected OTLP span JSON files (`prompt_span.json`, `response_span.json`, etc.) derived from the semantic mapping table in `data-model.md`

**Checkpoint**: Both packages scaffold, fixture directory populated. Running `npm run build -w @aerograph/otel` produces a valid (empty) build.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core shared utilities that ALL bridge logic depends on. Must be complete before any user story implementation begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T009 [P] Implement `packages/otel/src/constants.ts` — `AEROGRAPH_ATTRS` object with all attribute key string constants as defined in `contracts/contracts.md §1.3`
- [x] T010 [P] Implement `packages/otel/src/timestamp.ts` — `isoToUnixNano(iso: string): string` and `unixNanoToIso(nano: string): string` using BigInt arithmetic, matching algorithm in `data-model.md §4`
- [x] T011 [P] Implement `packages/otel/src/otlp-schema.ts` — Zod schemas: `otlpAttributeSchema`, `otlpSpanSchema`, `otlpExportRequestSchema` and exported types `OtlpSpan`, `OtlpExportRequest`, `OtlpAttribute`, `OtlpLink` as specified in `contracts/contracts.md §1.4`
- [x] T012 [P] Implement `python/aerograph-otel/src/aerograph_otel/constants.py` — `AeroGraphAttrs` class with identical attribute key constants mirroring T009
- [x] T013 [P] Implement `python/aerograph-otel/src/aerograph_otel/timestamp.py` — `iso_to_unix_nano(iso: str) -> str` and `unix_nano_to_iso(nano: str) -> str` with identical semantics to T010
- [x] T014 Write unit tests for `timestamp.ts` in `packages/otel/src/__tests__/timestamp.test.ts` — covers round-trip precision, edge cases (midnight, milliseconds, epoch), and matches Python output for same inputs
- [x] T015 Write unit tests for `timestamp.py` in `python/aerograph-otel/src/aerograph_otel/tests/test_timestamp.py` — identical assertions to T014

**Checkpoint**: Foundation ready — `npm run test -w @aerograph/otel` passes timestamp tests; `pytest python/aerograph-otel -k timestamp` passes.

---

## Phase 3: User Story 1 — AeroGraph → OTel Export (Priority: P1) 🎯 MVP

**Goal**: Implement the full AeroGraph-to-OTLP export path in both TypeScript and Python. A developer can take any AeroGraph `TraceEvent` and produce a valid, deterministic, OTLP-compatible span structure.

**Independent Test**: Run `npm run test -w @aerograph/otel -- --grep "export"` and `pytest python/aerograph-otel -k export`. Verify the 10 fixture events produce OTLP spans that match `expected_otlp/*.json` exactly.

### Implementation for User Story 1

- [x] T016 [P] [US1] Implement `packages/otel/src/mapping.ts` — `getSpanNameForKind`, `getSpanKindInt`, `buildAttributesFromEvent`, `exportLinksToOtlp` covering all 10 event kinds per the mapping table in `data-model.md §5.1`
- [x] T017 [P] [US1] Implement `python/aerograph-otel/src/aerograph_otel/mapping.py` — `get_span_name_for_kind`, `get_span_kind_for_kind`, `build_attributes_from_event`, `export_links_to_otlp` mirroring T016 exactly
- [x] T018 [US1] Implement `packages/otel/src/export.ts` — `exportEventToOtlpSpan(event: TraceEvent): OtlpSpan` and `exportEventsToOtlp(events: TraceEvent[], options?: ExportOptions): OtlpExportRequest` (depends on T009, T010, T011, T016)
- [x] T019 [US1] Implement `python/aerograph-otel/src/aerograph_otel/export.py` — `export_event_to_otlp_span(event)` and `export_events_to_otlp(events, *, service_name, scope_name, scope_version)` (depends on T012, T013, T017)
- [x] T020 [US1] Update `packages/otel/src/index.ts` — re-export `exportEventToOtlpSpan`, `exportEventsToOtlp`, `AEROGRAPH_ATTRS`, `OtlpSpan`, `OtlpExportRequest`, `ExportOptions`, `isoToUnixNano`, `unixNanoToIso`, `otlpExportRequestSchema`
- [x] T021 [US1] Update `python/aerograph-otel/src/aerograph_otel/__init__.py` — re-export `export_event_to_otlp_span`, `export_events_to_otlp`, `AeroGraphAttrs`, `iso_to_unix_nano`, `unix_nano_to_iso`
- [x] T022 [P] [US1] Write `packages/otel/src/__tests__/mapping.test.ts` — unit tests for `getSpanNameForKind`, `getSpanKindInt`, `buildAttributesFromEvent` for all 10 event kinds
- [x] T023 [P] [US1] Write `packages/otel/src/__tests__/export.test.ts` — unit tests for `exportEventToOtlpSpan` for all 10 event kinds; assert traceId, spanId, parentSpanId, name, kind integer, status code, and key attributes
- [x] T024 [P] [US1] Write `python/aerograph-otel/src/aerograph_otel/tests/test_mapping.py` — unit tests mirroring T022
- [x] T025 [P] [US1] Write `python/aerograph-otel/src/aerograph_otel/tests/test_export.py` — unit tests mirroring T023
- [x] T026 [US1] Write `packages/otel/src/__tests__/parity.test.ts` — load fixtures from `specs/004-otel-bridge/fixtures/`, run `exportEventToOtlpSpan` on each, assert output matches `expected_otlp/*.json` exactly (deterministic check)
- [x] T027 [US1] Write `python/aerograph-otel/src/aerograph_otel/tests/test_parity.py` — load the same fixtures as T026, run `export_event_to_otlp_span`, assert output matches `expected_otlp/*.json` exactly (cross-language parity gate)

**Checkpoint**: `npm run test -w @aerograph/otel` passes export + parity tests. `pytest python/aerograph-otel` passes export + parity tests. TS and Python produce identical OTLP for all 10 fixture inputs.

---

## Phase 4: User Story 2 — OTel → AeroGraph Import (Priority: P2)

**Goal**: Implement the OTLP-to-AeroGraph import path in both TypeScript and Python. A developer can take any OTLP span and convert it into a validated AeroGraph `TraceEvent`, losslessly when the span carries `aerograph.kind`, and via heuristic mapping otherwise.

**Independent Test**: Run `npm run test -w @aerograph/otel -- --grep "import|roundtrip"` and `pytest python/aerograph-otel -k "import or roundtrip"`. Verify round-trip preserves all topology-critical fields (traceId, spanId, parentSpanId, kind, actor, links, status, occurredAt).

### Implementation for User Story 2

- [x] T028 [P] [US2] Implement `packages/otel/src/mapping.ts` — extend with `resolveAeroGraphKindFromSpan(span: OtlpSpan): TraceEventKind` and `extractAttributeValue(attrs: OtlpAttribute[], key: string): string | undefined` (same file as T016, new exports added)
- [x] T029 [P] [US2] Implement `python/aerograph-otel/src/aerograph_otel/mapping.py` — extend with `resolve_aerograph_kind_from_span(span: dict) -> str` and `extract_attribute_value(attrs: list, key: str) -> str | None` mirroring T028
- [x] T030 [US2] Implement `packages/otel/src/import.ts` — `importOtlpSpanToEvent(span: OtlpSpan, ctx: MappingContext): TraceEvent` (lossless path + heuristic path per `data-model.md §5.2`) and `importOtlpToEvents(request: OtlpExportRequest, ctx?: Partial<MappingContext>): TraceEvent[]` (depends on T009, T010, T011, T028)
- [x] T031 [US2] Implement `python/aerograph-otel/src/aerograph_otel/import_.py` — `import_otlp_span_to_event(span, ctx)` and `import_otlp_to_events(request, *, default_actor_id, preserve_original_ids)` mirroring T030 (depends on T012, T013, T029)
- [x] T032 [US2] Update `packages/otel/src/index.ts` — add re-exports for `importOtlpSpanToEvent`, `importOtlpToEvents`, `MappingContext`
- [x] T033 [US2] Update `python/aerograph-otel/src/aerograph_otel/__init__.py` — add re-exports for `import_otlp_span_to_event`, `import_otlp_to_events`, `MappingContext`
- [x] T034 [P] [US2] Write `packages/otel/src/__tests__/import.test.ts` — unit tests for `importOtlpSpanToEvent`: lossless round-trip path (aerograph.kind present), heuristic paths for `gen_ai.chat`, `gen_ai.tool.call`, error spans, and unknown spans falling back to `note`
- [x] T035 [P] [US2] Write `packages/otel/src/__tests__/roundtrip.test.ts` — for all 10 event kinds: `importOtlpSpanToEvent(exportEventToOtlpSpan(event), ctx)` must preserve traceId, spanId, parentSpanId, kind, actor.id, actor.kind, status, occurredAt, and links topology
- [x] T036 [P] [US2] Write `python/aerograph-otel/src/aerograph_otel/tests/test_import.py` — unit tests mirroring T034
- [x] T037 [P] [US2] Write `python/aerograph-otel/src/aerograph_otel/tests/test_roundtrip.py` — round-trip tests mirroring T035

**Checkpoint**: All import and round-trip tests pass in both TS and Python. Full parity gate still passes.

---

## Phase 5: User Story 3 — Cross-System Trace Correlation via Collector (Priority: P3)

**Goal**: Add the optional `POST /v1/otlp/traces` endpoint to the collector. External OTel spans can be ingested into the AeroGraph collector and retrieved via the existing trace retrieval APIs. No existing routes are modified.

**Independent Test**: `curl -X POST http://localhost:4317/v1/otlp/traces -d '{...valid OTLP JSON...}'` returns `201`. Then `GET /v1/traces/{traceId}` returns the ingested events. `POST /v1/events` still returns `201` (regression check).

### Implementation for User Story 3

- [x] T038 [US3] Add `@aerograph/otel` to `apps/collector/package.json` dependencies
- [x] T039 [US3] Create `apps/collector/src/otel/ingest.ts` — `createOtlpIngestHandler(store: SqliteTraceStore): express.RequestHandler` implementing: parse body with `otlpExportRequestSchema`, call `importOtlpToEvents()`, validate each with `validateTraceEvent()`, append each via `store.appendEvent()`, return 201 or 400 with error detail
- [x] T040 [US3] Modify `apps/collector/src/server.ts` — import `createOtlpIngestHandler` and add `app.post('/v1/otlp/traces', createOtlpIngestHandler(store))` (additive only — no other lines changed)
- [x] T041 [US3] Write `apps/collector/src/otel/ingest.test.ts` — integration tests using in-memory SQLite store: (a) valid OTLP JSON returns 201 and events are retrievable via `store.getTrace()`, (b) malformed JSON returns 400, (c) OTLP with invalid span fields returns 400, (d) existing `POST /v1/events` still works (regression)

**Checkpoint**: `npm run test -w apps/collector` passes. `POST /v1/otlp/traces` works end-to-end. All existing collector tests still pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: CI governance, documentation, and final validation.

- [x] T042 [P] Add `npm run build -w @aerograph/otel` and `npm run test -w @aerograph/otel` to root `package.json` build and test scripts (CI integration)
- [x] T043 [P] Add `cd python/aerograph-otel && pytest` step to Python CI configuration (same pattern as `aerograph-sdk` in Feature 003)
- [x] T044 Verify `npm run schema:check` still passes after all package additions (schema drift gate — run and confirm output)
- [x] T045 [P] Update root `README.md` — add `@aerograph/otel` and `aerograph-otel` to package listing, add brief interoperability section referencing `quickstart.md`
- [x] T046 Run end-to-end validation per `quickstart.md` — execute all four flows (export, import via collector, round-trip, correlation) and confirm all validation checklist items pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — **BLOCKS all user stories**
- **Phase 3 (US1 — Export)**: Depends on Phase 2
- **Phase 4 (US2 — Import)**: Depends on Phase 2; partially depends on Phase 3 (uses `mapping.ts` and `export.ts` for round-trip tests)
- **Phase 5 (US3 — Collector)**: Depends on Phase 3 AND Phase 4 (import bridge must exist)
- **Phase 6 (Polish)**: Depends on Phase 5

### User Story Dependencies

- **US1 (Export, P1)**: Can start after Phase 2 — no dependency on US2 or US3
- **US2 (Import, P2)**: Can start after Phase 2 — depends on mapping.ts and export.ts from US1 for round-trip tests only; core import logic is independent
- **US3 (Collector, P3)**: Depends on US1 and US2 completion (import bridge required)

### Within Each User Story

- Constants and utilities (T009–T013) before mapping logic (T016–T017)
- Mapping logic before export/import logic (T018–T019, T030–T031)
- Core logic before index re-exports (T020–T021, T032–T033)
- Core logic before tests (T022–T027, T034–T037)
- Parity tests require fixtures from Phase 1 (T007–T008)

### Parallel Opportunities

- T009, T010, T011 can run in parallel (different files, Phase 2)
- T012, T013 can run in parallel with T009–T011 (Python vs TypeScript)
- T016 and T017 can run in parallel (TS and Python mapping)
- T022–T025 can all run in parallel once T016–T019 are done
- T026 and T027 (parity tests) can run in parallel once fixtures and export logic exist

---

## Parallel Example: User Story 1

```bash
# After Phase 2 completes, launch these together:
Task T016: "Implement packages/otel/src/mapping.ts (TS)"
Task T017: "Implement python/aerograph-otel/src/aerograph_otel/mapping.py (Python)"

# Once T016 + T017 complete, launch in parallel:
Task T018: "Implement packages/otel/src/export.ts"
Task T019: "Implement python/aerograph-otel/src/aerograph_otel/export.py"

# Once T018 + T019 complete, launch all tests in parallel:
Task T022: "Write mapping.test.ts"
Task T023: "Write export.test.ts"
Task T024: "Write test_mapping.py"
Task T025: "Write test_export.py"
Task T026: "Write parity.test.ts"
Task T027: "Write test_parity.py"
```

---

## Implementation Strategy

### MVP First (User Story 1 — Export Only)

1. Complete Phase 1: Scaffold packages and create fixtures
2. Complete Phase 2: Constants, timestamps, OTLP schema
3. Complete Phase 3: Export bridge (TS + Python), parity tests
4. **STOP and VALIDATE**: Both parity test suites pass, TS and Python output is identical
5. The export bridge alone delivers immediate value for teams that want to visualize AeroGraph traces in OTel backends

### Incremental Delivery

1. Phase 1 + 2 → Packages scaffolded, fixtures defined, foundation ready
2. Phase 3 (US1) → Export works → Teams can export to Jaeger/Datadog ✅
3. Phase 4 (US2) → Import + round-trip works → Full bidirectional bridge ✅
4. Phase 5 (US3) → Collector ingestion → External OTel spans stored in AeroGraph ✅
5. Phase 6 → CI governance + docs → Feature complete ✅

### Parallel Team Strategy

With two developers:
- **Developer A**: TypeScript tasks (T009, T011, T016, T018, T020, T022–T023, T026)
- **Developer B**: Python tasks (T012, T013, T017, T019, T021, T024–T025, T027)
- Both converge for Phase 5 (collector) and Phase 6 (CI)

---

## Notes

- [P] tasks = different files, no unresolved dependencies — safe to run concurrently
- [US1/US2/US3] label maps tasks to spec user stories for traceability
- Parity tests (T026, T027) are the single most important quality gate — they enforce that TS and Python implementations produce identical OTLP for the same inputs
- Fixtures (T007, T008) are hand-crafted ground truth — never auto-generated
- The collector change (T040) is intentionally minimal: 2 lines added to `server.ts`, all logic in `ingest.ts`
- Schema drift check (T044) must pass — `@aerograph/contracts` must be unchanged
- Run `quickstart.md` validation (T046) as the final integration gate before marking the feature complete
