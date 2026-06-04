/**
 * packages/schema-exporter/src/versions.ts
 *
 * Schema version routing: maps schemaVersion strings to the appropriate
 * export configurations. Add new entries here when the schema version bumps.
 */

import { traceEventSchemaVersion } from "@aerograph/contracts";

export interface VersionConfig {
  /** Canonical schemaVersion string (must match traceEventSchemaVersion). */
  schemaVersion: string;
  /** Human-readable label for this version. */
  label: string;
}

/** All known schema versions, ordered oldest → newest. */
export const KNOWN_VERSIONS: readonly VersionConfig[] = [
  {
    schemaVersion: "1.0.0",
    label: "AeroGraph TraceEvent Schema v1.0.0"
  }
] as const;

/** The current/active schema version derived from contracts. */
export const CURRENT_VERSION = traceEventSchemaVersion;

/**
 * Returns the VersionConfig for the current active schemaVersion.
 * Throws if the current version is not registered in KNOWN_VERSIONS.
 */
export function getCurrentVersionConfig(): VersionConfig {
  const config = KNOWN_VERSIONS.find(v => v.schemaVersion === CURRENT_VERSION);
  if (!config) {
    throw new Error(
      `Schema version "${CURRENT_VERSION}" is not registered in KNOWN_VERSIONS. ` +
        `Add it to packages/schema-exporter/src/versions.ts.`
    );
  }
  return config;
}
