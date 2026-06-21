# Feature Specification: Canonical Telemetry Model Enrichment

**Feature Branch**: `005-telemetry-enrichment`

**Created**: 2026-06-21

**Status**: Draft

**Input**: User description: "AeroGraph currently captures execution topology correctly but lacks a canonical telemetry and observability model. Critical metadata such as model identity, token usage, execution duration, project context, environment context, and trace tagging is either discarded, emitted as unstructured payloads, adapter-specific, or unavailable for analytics. Introduce a Canonical Telemetry Model as a first-class platform capability..."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Trace Observation and Metric Analysis (Priority: P1)

As an AI engineer debugging an agent workflow, I want to view detailed observability metrics (token consumption, execution duration, estimated cost, model usage) for my traces and trace aggregates in the UI, so I can understand cost and performance bottlenecks.

**Why this priority**: Exposing the enriched telemetry in the UI is the primary user-facing value of this feature, enabling cost estimation and performance tuning.

**Independent Test**: Can be tested independently by running an agent trace with enriched metadata and verifying the UI correctly displays tokens, latency, and model usage without regressions in existing topology visualization.

**Acceptance Scenarios**:

1. **Given** a stored trace with token usage and model metadata, **When** the user views the trace details in the UI, **Then** the UI displays the correct model name, provider, version, and precise token counts (input, output, cached, total) alongside estimated cost (derived via Analytics Layer).
2. **Given** a stored trace with latency data, **When** the user views the trace list or details, **Then** the execution duration is accurately reflected.
3. **Given** a stored trace with multiple span events, **When** the user views the trace aggregates, **Then** the UI correctly displays the total input tokens, total output tokens, total duration, model breakdown, and total cost breakdown across the entire trace.

---

### User Story 2 - Project and Environment Isolation (Priority: P1)

As a platform administrator managing multiple AI projects, I want to filter traces and metrics by project identity and environment context, so I can isolate analytics per project without deploying separate AeroGraph instances.

**Why this priority**: Multi-tenant/project isolation is critical for enterprise use and is explicitly required as a first-class concept.

**Independent Test**: Can be tested independently by emitting traces with different project and environment tags and ensuring the UI and collector queries correctly segregate and filter the data.

**Acceptance Scenarios**:

1. **Given** traces from multiple projects, **When** the user applies a project-aware filter in the UI, **Then** only the traces for the selected project are displayed.
2. **Given** traces tagged with 'production' and 'staging' environments, **When** the user applies an environment filter, **Then** the UI successfully isolates the respective traces.

---

### User Story 3 - Framework-Agnostic Telemetry Normalization (Priority: P2)

As a developer using different agent frameworks (LangChain, AutoGen, etc.), I want my framework-specific telemetry to map automatically to the canonical model, so I do not have to write custom logic or rely on unstructured workarounds.

**Why this priority**: Ensures data consistency and reliability across the platform regardless of the underlying LLM framework.

**Independent Test**: Can be tested independently by running different adapters and verifying that the collector receives standardized canonical telemetry without fallback to unstructured payloads.

**Acceptance Scenarios**:

1. **Given** an execution using the LangChain TypeScript adapter, **When** the adapter emits a trace event, **Then** the token usage and model metadata are normalized into the canonical schema fields.
2. **Given** an execution using the LangChain Python adapter, **When** the adapter emits a trace event, **Then** it produces the exact same canonical structure for equivalent telemetry metrics.

---

### User Story 4 - OpenTelemetry GenAI Semantic Integration (Priority: P2)

As an enterprise user forwarding traces to an external OTEL collector, I want AeroGraph to emit official OpenTelemetry GenAI semantic attributes, so my traces are seamlessly compatible with external observability platforms.

**Why this priority**: Standardizes external observability integration, which is a major enterprise requirement.

**Independent Test**: Can be tested independently by configuring the OTEL bridge and verifying the exported spans contain the standardized `gen_ai.*` semantic conventions.

**Acceptance Scenarios**:

1. **Given** a trace with enriched canonical telemetry, **When** the OTEL bridge exports the span, **Then** the span contains the appropriate OpenTelemetry GenAI semantic attributes mapped from the canonical fields.

### Edge Cases

- What happens when a framework adapter fails to extract token usage or model metadata? (The system should allow omitting these fields gracefully without failing the trace storage.)
- How does the system handle upgrading an older SQLite database containing traces without the new canonical fields? (The migration strategy must ensure backward compatibility and apply defaults or nulls to existing records.)
- What happens when an older AeroGraph SDK client connects to an updated collector expecting schema version 1.1.0?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST extend the canonical event schema (bumping schemaVersion from 1.0.0 to 1.1.0) to explicitly support fields for model metadata (name, provider, version), token usage (input, output, total, cached), execution duration, project identity, environment context, and arbitrary telemetry tags. Cost is explicitly omitted from the schema and MUST be derived via the Analytics Layer using model and token usage data.
- **FR-002**: System MUST remain fully backward compatible with existing stored traces, preserving replayability and structure.
- **FR-003**: System MUST execute a SQLite migration strategy to support the new indexed fields for efficient analytics queries and trace-level aggregation.
- **FR-004**: System MUST remove all adapter-specific telemetry workarounds, requiring all current and future adapters to map to the new canonical schema fields.
- **FR-005**: System MUST expose trace-level aggregate observability metrics in the UI, including total token consumption, total duration, model breakdown, total cost breakdown, project-aware filtering, environment-aware filtering, and telemetry tag filtering.
- **FR-006**: System MUST enforce project isolation as a first-class concept through project-scoped telemetry, avoiding the need for separate infrastructure deployments.
- **FR-007**: System MUST update the OTEL bridge to emit official OpenTelemetry GenAI semantic attributes derived from the canonical telemetry fields.
- **FR-008**: System MUST pass cross-language parity validation, replay compatibility validation, and collector compatibility validation.

### Key Entities *(include if feature involves data)*

- **Telemetry Metadata**: A new structured sub-component of trace events capturing model context and execution properties.
- **Project Identity**: An identifier associating traces with a specific isolated workspace or application project.
- **Environment Context**: A tag defining the deployment environment (e.g., development, staging, production) for a trace.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of stored traces from schema version 1.0.0 remain readable, replayable, and unaffected by the schema update.
- **SC-002**: UI filtering by project, environment, and telemetry tags returns results in under 500ms for databases with up to 100,000 traces due to efficient indexed storage.
- **SC-003**: All supported agent framework adapters successfully normalize their telemetry into the new canonical schema without unstructured fallback payloads.
- **SC-004**: OTEL bridge exports compliant GenAI semantic attributes when canonical telemetry data is present.
- **SC-005**: Trace-level aggregate metrics (total input/output tokens, total duration, model breakdown, cost breakdown) and per-span metrics are visibly exposed in the trace details view for all newly captured executions.

## Assumptions

- SQLite migration scripts will be executed automatically upon collector startup or via a designated migration CLI command.
- Adapters that do not natively support extracting certain token counts (e.g., cached tokens) will safely omit those specific fields while still providing available fields like total tokens.
- Backward compatibility implies older traces will simply display empty or "N/A" values for the new telemetry metrics in the UI.
