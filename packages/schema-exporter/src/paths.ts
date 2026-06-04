/**
 * packages/schema-exporter/src/paths.ts
 *
 * Defines on-disk artifact layout and output paths for versioned JSON Schema exports.
 * All paths are relative to the package root unless noted.
 */

import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
// This file lives at packages/schema-exporter/dist/paths.js at runtime,
// so go up 2 dirs to reach the package root.
const packageRoot = path.resolve(path.dirname(__filename), "..");

/**
 * Returns the directory where schema artifacts for a given schemaVersion are written.
 * e.g. packages/schema-exporter/artifacts/1.0.0/
 */
export function artifactsDir(schemaVersion: string): string {
  return path.join(packageRoot, "artifacts", schemaVersion);
}

/** The main TraceEvent JSON Schema output filename. */
export const TRACE_EVENT_SCHEMA_FILE = "trace-event.schema.json";

/** The manifest filename. */
export const MANIFEST_FILE = "manifest.json";

/**
 * Full path to the trace-event schema for the given version.
 */
export function traceEventSchemaPath(schemaVersion: string): string {
  return path.join(artifactsDir(schemaVersion), TRACE_EVENT_SCHEMA_FILE);
}

/**
 * Full path to the manifest for the given version.
 */
export function manifestPath(schemaVersion: string): string {
  return path.join(artifactsDir(schemaVersion), MANIFEST_FILE);
}
