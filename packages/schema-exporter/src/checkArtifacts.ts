/**
 * packages/schema-exporter/src/checkArtifacts.ts
 *
 * Drift detection: fails if committed artifacts differ from what would be generated.
 * Used in CI to prevent schema drift.
 */

import { existsSync } from "fs";
import { generateArtifactInMemory, readCommittedArtifact } from "./export.js";
import { traceEventSchemaPath, manifestPath } from "./paths.js";
import { CURRENT_VERSION } from "./versions.js";

export interface DriftCheckResult {
  ok: boolean;
  errors: string[];
}

/**
 * Compare the committed on-disk artifact with a freshly generated one.
 * Ignores the `generatedAt` field (timestamp) during comparison.
 */
export function checkArtifactDrift(): DriftCheckResult {
  const errors: string[] = [];

  // 1. Check that artifact files exist
  const schemaPath = traceEventSchemaPath(CURRENT_VERSION);
  const mPath = manifestPath(CURRENT_VERSION);

  if (!existsSync(schemaPath)) {
    errors.push(
      `Missing artifact: ${schemaPath}\n` +
        `Run "npm run schema:export -w @aerograph/schema-exporter" to generate.`
    );
  }

  if (!existsSync(mPath)) {
    errors.push(
      `Missing manifest: ${mPath}\n` +
        `Run "npm run schema:export -w @aerograph/schema-exporter" to generate.`
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // 2. Read committed artifact
  let committed: ReturnType<typeof readCommittedArtifact>;
  try {
    committed = readCommittedArtifact(CURRENT_VERSION);
  } catch (err) {
    errors.push(`Failed to read committed artifact: ${String(err)}`);
    return { ok: false, errors };
  }

  // 3. Generate fresh artifact (in memory, no disk writes)
  const fresh = generateArtifactInMemory();

  // 4. Compare schema-structural fields (exclude generatedAt)
  const committedForComparison = withoutGeneratedAt(committed as unknown as Record<string, unknown>);
  const freshForComparison = withoutGeneratedAt(fresh as unknown as Record<string, unknown>);

  const committedJson = JSON.stringify(committedForComparison, null, 2);
  const freshJson = JSON.stringify(freshForComparison, null, 2);

  if (committedJson !== freshJson) {
    errors.push(
      `Schema artifact is stale: committed artifact does not match current contracts.\n` +
        `Run "npm run schema:export -w @aerograph/schema-exporter" to regenerate and commit.\n\n` +
        `Diff hint:\n` +
        generateSimpleDiff(committedJson, freshJson)
    );
  }

  // 5. Check schemaVersion matches current contracts
  if (committed.schemaVersion !== CURRENT_VERSION) {
    errors.push(
      `Artifact schemaVersion mismatch: committed="${committed.schemaVersion}", expected="${CURRENT_VERSION}".`
    );
  }

  return { ok: errors.length === 0, errors };
}

function withoutGeneratedAt(artifact: Record<string, unknown>): Record<string, unknown> {
  const { generatedAt: _, ...rest } = artifact;
  return rest;
}

function generateSimpleDiff(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const maxLines = Math.max(aLines.length, bLines.length);
  const diffLines: string[] = [];
  let diffCount = 0;
  for (let i = 0; i < maxLines && diffCount < 20; i++) {
    const aLine = aLines[i] ?? "";
    const bLine = bLines[i] ?? "";
    if (aLine !== bLine) {
      diffLines.push(`- ${aLine}`);
      diffLines.push(`+ ${bLine}`);
      diffCount++;
    }
  }
  if (diffCount >= 20) {
    diffLines.push("... (truncated)");
  }
  return diffLines.join("\n");
}
