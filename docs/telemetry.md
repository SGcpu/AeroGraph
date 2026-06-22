# Telemetry Enrichment

AeroGraph introduces robust telemetry enrichment capabilities across traces.

## Core Telemetry Fields

AeroGraph standardizes common telemetry inside `TraceEvent` natively to ensure semantic predictability and easy analytics.

### `model`
Captures model configuration for generation steps.
* **name**: The explicit model name (e.g., `gpt-4-turbo`)
* **provider**: The system/provider behind the model (e.g., `openai`)

### `usage`
Standardized token and resource tracking.
* **inputTokens**: Tokens consumed during prompt ingestion.
* **outputTokens**: Tokens yielded during response generation.
* **totalTokens**: Total combined cost footprint.

### `durationMs`
Represents the execution time spanning from ingestion to completion, measured in milliseconds. Derived directly from OTEL's timestamps when imported from external collectors.

### `projectId`
An identifier representing the logical project boundaries executing the agent flow. Important for grouping analytics and multi-tenant telemetry isolation.

### `environment`
Indicates the runtime ecosystem (e.g., `production`, `staging`, `development`). 

### `tags`
Custom business-level metadata attached to the event. Replaces `metadata` grouping in previous schema iterations to flatten indexing paths.

## Telemetry Normalization Flow

AeroGraph employs a standard "Canonical First" strategy.
1. **Agent SDKs** emit structured objects via `@aerograph/sdk` using the canonical schema (v1.1.0).
2. **OTEL Exporter** securely converts this canonical format deterministically into standard OTLP attributes (e.g., `model.name` -> `gen_ai.request.model`).
3. **Collector / Storage** retains these standard telemetry fields as relational columns and fast-read JSON segments.
4. **OTEL Importer** parses foreign OTLP spans and flawlessly rebuilds the canonical schema.

## OTEL Integration

Through `packages/otel`, we seamlessly embrace the **OpenTelemetry GenAI Semantic Conventions**. 
* Custom telemetry tags map as `aerograph.tag.<key>`.
* Identifiers map to `project.id` and `deployment.environment`.
* Generative AI metadata transforms gracefully into `gen_ai.system`, `gen_ai.request.model`, and `gen_ai.usage.*`.
