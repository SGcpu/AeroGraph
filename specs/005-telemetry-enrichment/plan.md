# Implementation Plan: Canonical Telemetry Model Enrichment

**Branch**: `005-telemetry-enrichment` | **Date**: 2026-06-22 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/005-telemetry-enrichment/spec.md`

## Summary
AeroGraph is introducing a Canonical Telemetry Model as a first-class platform capability to capture model metadata, token usage, execution duration, project identity, and environment context. The feature will update the canonical event schema (v1.0.0 → v1.1.0) and enforce framework-agnostic adapter normalization while ensuring backward compatibility for existing traces and cross-language parity.

## Constitution Check
- **I. Event Schema Is Source of Truth**: Extending the canonical event schema is the primary delivery mechanism; all systems will consume this schema.
- **II. Shared Contracts (No Bypasses)**: UI and backend will exclusively use the shared contracts for telemetry fields.
- **III. Trace Replayability (NON-NEGOTIABLE)**: Schema v1.1.0 is backward compatible with v1.0.0. Existing traces will continue to replay seamlessly.
- **IV. Adapter Normalization**: All adapters will be updated to output the new canonical schema, dropping specific telemetry workarounds.
- **V. Tests Are Mandatory Where It Matters**: The plan explicitly covers cross-language parity validation, backward compatibility validation, and replay validation.

---

## Foundational Work
The following must occur *before* user stories (UI and Analytics) can be built:
1. Update shared `contracts` definition with the new telemetry schema fields.
2. Publish `schemaVersion` 1.1.0 across TypeScript and Python SDKs.
3. Implement SQLite schema migration in the collector.
4. Update the core AeroGraph span ingestion paths to support the new fields.

## Data Model Changes
- **Target**: `contracts` package (JSON Schema / Protobuf).
- **schemaVersion**: Bump from `1.0.0` to `1.1.0`.
- **New Fields in Trace/Span Metadata**:
  - `model` (object, optional): `name` (string), `provider` (string), `version` (string)
  - `usage` (object, optional): `inputTokens` (integer), `outputTokens` (integer), `totalTokens` (integer), `cachedTokens` (integer)
  - `durationMs` (integer, optional)
  - `projectId` (string, optional)
  - `environment` (string, optional)
  - `tags` (map/dict of strings, optional)

## API Contract Changes
- **Collector Analytics APIs**: Introduce aggregation endpoints that accept `projectId`, `environment`, and arbitrary `tags` as filter parameters, returning sum of tokens and duration, computing estimated cost dynamically based on model pricing, grouped by model or trace.
- **Trace Ingestion APIs**: No breaking changes; ingestion endpoints will seamlessly accept payloads with `schemaVersion: "1.1.0"`.

---

## Technical Architecture

### Schema Versioning Strategy
- Version explicitly bumped to `1.1.0` in the payload headers and contracts definition.
- Payloads without the new fields will be treated as `1.0.0` or interpreted gracefully by treating the missing fields as `null` or empty.

### Migration Strategy (SQLite)
- Add new columns for the telemetry fields to the `traces` and/or `spans` tables via `ALTER TABLE` operations in the migration runner. 
- **Backward Compatibility**: New columns default to `NULL`. Older traces will inherently contain `NULL` and the API will serialize them as missing or "N/A".

### SQLite Indexing Strategy
To support efficient queries under 500ms for 100k+ traces:
- Create composite indexes on `(projectId, environment)`.
- Create index on `model_name`.
- Create indexes on `durationMs` and `totalTokens` for rapid analytical aggregations and sorting.

### SDK Updates (TypeScript + Python)
- **Cross-language Parity**: Both SDKs will implement the v1.1.0 event schema simultaneously.
- **Core Tracer**: Extend the underlying Tracer implementation to accept `projectId`, `environment`, and `tags` upon initialization or trace creation. Support duration timing natively within the span context.

### Adapter Normalization Strategy
- **Requirement**: Adapters must map framework-specific data strictly into the canonical fields.
- **Changes**: Update all supported adapters (LangChain, AutoGen, OpenAI SDK, etc.) to capture usage dictionaries or LLM result objects and explicitly map them to the canonical `usage` and `model` keys. Remove unstructured `kwargs` dumps that were previously used as workarounds for telemetry.

### OTEL Bridge Updates
- Map the new canonical telemetry fields to OpenTelemetry Semantic Conventions for Generative AI systems.
  - `gen_ai.system` (mapped from `model.provider`)
  - `gen_ai.request.model` (mapped from `model.name`)
  - `gen_ai.usage.input_tokens`
  - `gen_ai.usage.output_tokens`

### Collector Updates
- Enable querying and filtering traces based on the indexed `projectId`, `environment`, and `tags`.
- Support trace-level aggregations (rolling up span-level tokens and duration (deriving cost during aggregation) to the parent trace level) natively in SQL queries via `SUM()` across child spans.

### UI Architecture & Filtering
- **Trace Details**: Update the sidebar/metadata panel to cleanly render token breakdowns, estimated cost, latency, and model breakdown per trace and per span.
- **Filtering Architecture**: Introduce a robust global filter bar in the trace list view allowing multiple tag, project, and environment selections. Pass these as query parameters to the Analytics API.

---

## Validation & Test Strategy

- **Backward Compatibility Validation**: Feed v1.0.0 JSON payloads to the v1.1.0 collector and assert successful ingestion, replayability, and read-back without errors.
- **Replay Compatibility Validation**: Ensure the addition of the telemetry data does not break execution replay determinism in both languages.
- **Cross-Language Parity Validation**: Run a matrix test feeding the exact same agent workflow through TS and Python SDKs, asserting the resulting serialized trace payloads are identical structurally and semantically.
- **Performance Considerations (100k+ traces)**: Run bulk-insert tests inserting 100,000 mock traces, then execute analytics queries to ensure sub-500ms response times. Use SQL `EXPLAIN QUERY PLAN` to verify proper index utilization.

## Risks
1. **Adapter Fragility**: LLM Frameworks often change their internal telemetry payloads (e.g., LangChain dropping or adding keys in LLMResult unexpectedly). 
   - *Mitigation*: Implement robust null-safe mappings with defensive extraction logic.
2. **Performance Impact**: Adding multiple columns and indexes to SQLite may slightly slow down ingestion. 
   - *Mitigation*: Rely on batched ingestion mechanisms and WAL (Write-Ahead Logging) mode.

## Rollout Strategy
1. **Phase 1**: Update contracts package and deploy Collector SQLite migrations.
2. **Phase 2**: Deploy SDKs v1.1.0 and Adapter mapping updates.
3. **Phase 3**: Deploy UI updates to expose the fields and filtering capabilities.
