/**
 * packages/schema-exporter/src/index.ts
 *
 * Public surface of the schema-exporter package.
 * Re-exports the primary utilities for programmatic use in tests.
 */

export { exportSchemas, readCommittedArtifact, generateArtifactInMemory } from "./export.js";
export type { ExportResult, SchemaArtifact, Manifest } from "./export.js";
export { checkArtifactDrift } from "./checkArtifacts.js";
export type { DriftCheckResult } from "./checkArtifacts.js";
export { artifactsDir, traceEventSchemaPath, manifestPath } from "./paths.js";
export { KNOWN_VERSIONS, CURRENT_VERSION, getCurrentVersionConfig } from "./versions.js";
export type { VersionConfig } from "./versions.js";
