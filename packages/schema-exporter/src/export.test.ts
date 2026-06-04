/**
 * packages/schema-exporter/src/export.test.ts
 *
 * Snapshot/regression test for schema export.
 * Verifies structure stability and key fields of generated JSON Schema artifacts.
 */

import { describe, expect, it } from "vitest";
import { generateArtifactInMemory } from "./export.js";
import { CURRENT_VERSION } from "./versions.js";
import { traceEventSchemaVersion } from "@aerograph/contracts";

describe("schema-exporter: generateArtifactInMemory", () => {
  it("produces an artifact with the correct schemaVersion", () => {
    const artifact = generateArtifactInMemory();
    expect(artifact.schemaVersion).toBe(traceEventSchemaVersion);
    expect(artifact.schemaVersion).toBe(CURRENT_VERSION);
  });

  it("produces a traceEventSchema with all known kinds in the discriminated union", () => {
    const artifact = generateArtifactInMemory();
    const schema = artifact.traceEventSchema as any;

    // The Zod discriminated union produces `anyOf` in JSON Schema
    const anyOf: any[] = schema.definitions?.TraceEvent?.anyOf ?? schema.anyOf ?? [];
    expect(anyOf.length).toBeGreaterThan(0);

    // Extract all `kind` const values from the union members
    const kinds = anyOf
      .map((branch: any) => branch?.properties?.kind?.const)
      .filter(Boolean);

    const expectedKinds = [
      "prompt",
      "response",
      "tool_call",
      "tool_result",
      "handoff",
      "error",
      "note",
      "state_snapshot",
      "retriever",
      "checkpoint"
    ];

    for (const kind of expectedKinds) {
      expect(kinds).toContain(kind);
    }
  });

  it("produces a traceSchema referencing the core fields", () => {
    const artifact = generateArtifactInMemory();
    const schema = artifact.traceSchema as any;
    const topLevel = schema.definitions?.Trace ?? schema;
    const props = topLevel?.properties ?? {};
    expect(props).toHaveProperty("traceId");
    expect(props).toHaveProperty("events");
  });

  it("produces a traceMetaSchema with updatedAt field", () => {
    const artifact = generateArtifactInMemory();
    const schema = artifact.traceMetaSchema as any;
    const topLevel = schema.definitions?.TraceMeta ?? schema;
    const props = topLevel?.properties ?? {};
    expect(props).toHaveProperty("traceId");
    expect(props).toHaveProperty("updatedAt");
    expect(props).toHaveProperty("eventCount");
  });

  it("is structurally stable across two calls (excluding generatedAt)", () => {
    const a = generateArtifactInMemory();
    const b = generateArtifactInMemory();

    // Remove generatedAt before comparing
    const { generatedAt: _a, ...restA } = a as any;
    const { generatedAt: _b, ...restB } = b as any;

    expect(JSON.stringify(restA)).toBe(JSON.stringify(restB));
  });

  it("includes $schema and required metadata fields", () => {
    const artifact = generateArtifactInMemory();
    expect(artifact.$schema).toBe("https://json-schema.org/draft-07/schema#");
    expect(artifact.title).toContain("AeroGraph");
    expect(artifact.description).toContain("@aerograph/contracts");
  });
});
