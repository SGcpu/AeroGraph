#!/usr/bin/env node
/**
 * packages/schema-exporter/src/cli.ts
 *
 * CLI entry point for schema export and drift check commands.
 *
 * Commands:
 *   node dist/cli.js export   — generate/overwrite artifacts on disk
 *   node dist/cli.js check    — fail if artifacts are stale
 */

import { exportSchemas } from "./export.js";
import { checkArtifactDrift } from "./checkArtifacts.js";

const command = process.argv[2];

switch (command) {
  case "export": {
    console.log("[schema-exporter] Exporting JSON Schema artifacts...");
    try {
      const result = exportSchemas();
      console.log(`[schema-exporter] ✓ Exported schema version: ${result.schemaVersion}`);
      console.log(`  → ${result.traceEventSchemaPath}`);
      console.log(`  → ${result.manifestPath}`);
    } catch (err) {
      console.error("[schema-exporter] ✗ Export failed:", err);
      process.exit(1);
    }
    break;
  }

  case "check": {
    console.log("[schema-exporter] Checking schema artifact drift...");
    const result = checkArtifactDrift();
    if (result.ok) {
      console.log("[schema-exporter] ✓ Schema artifacts are up-to-date.");
    } else {
      console.error("[schema-exporter] ✗ Schema drift detected:");
      for (const error of result.errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }
    break;
  }

  default: {
    console.error(`[schema-exporter] Unknown command: "${command ?? "(none)"}"`);
    console.error("Usage: node dist/cli.js [export|check]");
    process.exit(1);
  }
}
