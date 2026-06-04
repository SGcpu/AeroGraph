/**
 * packages/schema-exporter/src/export.ts
 *
 * Core JSON Schema export implementation.
 * Converts @aerograph/contracts Zod schemas to JSON Schema artifacts.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import {
  traceEventKindSchema,
  traceEventStatusSchema,
  actorKindSchema,
  actorSchema,
  agentActorSchema,
  toolActorSchema,
  systemActorSchema,
  linkRelSchema,
  traceLinkSchema,
  promptPayloadSchema,
  streamingTelemetrySchema,
  responsePayloadSchema,
  toolCallPayloadSchema,
  toolResultPayloadSchema,
  handoffPayloadSchema,
  errorPayloadSchema,
  stateSnapshotPayloadSchema,
  retrieverDocumentSchema,
  retrieverPayloadSchema,
  checkpointPayloadSchema,
  traceEventSchema,
  traceEventSchemaVersion,
  traceSchema,
  traceMetaSchema,
  traceWithMetaSchema,
  traceListResponseSchema,
  promptEventSchema,
  responseEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  handoffEventSchema,
  errorEventSchema,
  noteEventSchema,
  stateSnapshotEventSchema,
  retrieverEventSchema,
  checkpointEventSchema
} from "@aerograph/contracts";
import { artifactsDir, traceEventSchemaPath, manifestPath, TRACE_EVENT_SCHEMA_FILE } from "./paths.js";
import { getCurrentVersionConfig } from "./versions.js";

export interface ExportResult {
  schemaVersion: string;
  traceEventSchemaPath: string;
  manifestPath: string;
}

export interface SchemaArtifact {
  $schema: string;
  title: string;
  description: string;
  schemaVersion: string;
  generatedAt: string;
  traceEventSchema: unknown;
  traceSchema: unknown;
  traceMetaSchema: unknown;
  traceWithMetaSchema: unknown;
  traceListResponseSchema: unknown;
  pythonCodegenSchema: unknown;
}

export interface Manifest {
  schemaVersion: string;
  exporterPackageVersion: string;
  contractsPackageVersion: string;
  generatedAt: string;
  artifacts: string[];
}

/**
 * Export JSON Schema artifacts for the current schemaVersion to disk.
 */
export function exportSchemas(options?: { dryRun?: boolean }): ExportResult {
  const versionConfig = getCurrentVersionConfig();
  const { schemaVersion } = versionConfig;
  const now = new Date().toISOString();

  // Build JSON Schema from Zod schemas
  const traceEventJsonSchema = zodToJsonSchema(traceEventSchema, {
    name: "TraceEvent",
    errorMessages: false,
    $refStrategy: "none"
  });

  const traceJsonSchema = zodToJsonSchema(traceSchema, {
    name: "Trace",
    errorMessages: false,
    $refStrategy: "none"
  });

  const traceMetaJsonSchema = zodToJsonSchema(traceMetaSchema, {
    name: "TraceMeta",
    errorMessages: false,
    $refStrategy: "none"
  });

  const traceWithMetaJsonSchema = zodToJsonSchema(traceWithMetaSchema, {
    name: "TraceWithMeta",
    errorMessages: false,
    $refStrategy: "none"
  });

  const traceListResponseJsonSchema = zodToJsonSchema(traceListResponseSchema, {
    name: "TraceListResponse",
    errorMessages: false,
    $refStrategy: "none"
  });

  const rawSchema = zodToJsonSchema(z.object({
    TraceEventKind: traceEventKindSchema,
    TraceEventStatus: traceEventStatusSchema,
    ActorKind: actorKindSchema,
    Actor: actorSchema,
    AgentActor: agentActorSchema,
    ToolActor: toolActorSchema,
    SystemActor: systemActorSchema,
    LinkRel: linkRelSchema,
    TraceLink: traceLinkSchema,
    PromptPayload: promptPayloadSchema,
    StreamingTelemetry: streamingTelemetrySchema,
    ResponsePayload: responsePayloadSchema,
    ToolCallPayload: toolCallPayloadSchema,
    ToolResultPayload: toolResultPayloadSchema,
    HandoffPayload: handoffPayloadSchema,
    ErrorPayload: errorPayloadSchema,
    StateSnapshotPayload: stateSnapshotPayloadSchema,
    RetrieverDocument: retrieverDocumentSchema,
    RetrieverPayload: retrieverPayloadSchema,
    CheckpointPayload: checkpointPayloadSchema,
    PromptEvent: promptEventSchema,
    ResponseEvent: responseEventSchema,
    ToolCallEvent: toolCallEventSchema,
    ToolResultEvent: toolResultEventSchema,
    HandoffEvent: handoffEventSchema,
    ErrorEvent: errorEventSchema,
    NoteEvent: noteEventSchema,
    StateSnapshotEvent: stateSnapshotEventSchema,
    RetrieverEvent: retrieverEventSchema,
    CheckpointEvent: checkpointEventSchema,
    TraceEvent: traceEventSchema,
    Trace: traceSchema,
    TraceMeta: traceMetaSchema,
    TraceWithMeta: traceWithMetaSchema,
    TraceListResponse: traceListResponseSchema
  }), {
    name: "AeroGraph",
    errorMessages: false,
    $refStrategy: "root"
  }) as any;

  const pythonCodegenSchema = {
    $schema: "https://json-schema.org/draft-07/schema#",
    definitions: rawSchema.definitions
  };

  const artifact: SchemaArtifact = {
    $schema: "https://json-schema.org/draft-07/schema#",
    title: "AeroGraph TraceEvent Schema",
    description:
      "Language-neutral JSON Schema artifact exported from @aerograph/contracts. " +
      "Used to generate and validate non-TypeScript runtime bindings.",
    schemaVersion,
    generatedAt: now,
    traceEventSchema: traceEventJsonSchema,
    traceSchema: traceJsonSchema,
    traceMetaSchema: traceMetaJsonSchema,
    traceWithMetaSchema: traceWithMetaJsonSchema,
    traceListResponseSchema: traceListResponseJsonSchema,
    pythonCodegenSchema
  };

  const manifest: Manifest = {
    schemaVersion,
    exporterPackageVersion: "0.2.0",
    contractsPackageVersion: "0.2.0",
    generatedAt: now,
    artifacts: [TRACE_EVENT_SCHEMA_FILE]
  };

  const outDir = artifactsDir(schemaVersion);
  const schemaPath = traceEventSchemaPath(schemaVersion);
  const mPath = manifestPath(schemaVersion);

  if (!options?.dryRun) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(schemaPath, JSON.stringify(artifact, null, 2) + "\n", "utf-8");
    writeFileSync(mPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  }

  return {
    schemaVersion,
    traceEventSchemaPath: schemaPath,
    manifestPath: mPath
  };
}

/**
 * Read the committed artifact from disk and return it parsed.
 * Used by the drift check.
 */
export function readCommittedArtifact(schemaVersion: string): SchemaArtifact {
  const schemaPath = traceEventSchemaPath(schemaVersion);
  const raw = readFileSync(schemaPath, "utf-8");
  return JSON.parse(raw) as SchemaArtifact;
}

/**
 * Generate the current artifact in memory (dry-run) and return it.
 * Used for drift detection without touching disk.
 */
export function generateArtifactInMemory(): SchemaArtifact {
  // Use a fixed timestamp placeholder so we can compare structure without time noise
  const versionConfig = getCurrentVersionConfig();
  const { schemaVersion } = versionConfig;

  const traceEventJsonSchema = zodToJsonSchema(traceEventSchema, {
    name: "TraceEvent",
    errorMessages: false,
    $refStrategy: "none"
  });
  const traceJsonSchema = zodToJsonSchema(traceSchema, { name: "Trace", errorMessages: false, $refStrategy: "none" });
  const traceMetaJsonSchema = zodToJsonSchema(traceMetaSchema, { name: "TraceMeta", errorMessages: false, $refStrategy: "none" });
  const traceWithMetaJsonSchema = zodToJsonSchema(traceWithMetaSchema, { name: "TraceWithMeta", errorMessages: false, $refStrategy: "none" });
  const traceListResponseJsonSchema = zodToJsonSchema(traceListResponseSchema, { name: "TraceListResponse", errorMessages: false, $refStrategy: "none" });

  const rawSchema = zodToJsonSchema(z.object({
    TraceEventKind: traceEventKindSchema,
    TraceEventStatus: traceEventStatusSchema,
    ActorKind: actorKindSchema,
    Actor: actorSchema,
    AgentActor: agentActorSchema,
    ToolActor: toolActorSchema,
    SystemActor: systemActorSchema,
    LinkRel: linkRelSchema,
    TraceLink: traceLinkSchema,
    PromptPayload: promptPayloadSchema,
    StreamingTelemetry: streamingTelemetrySchema,
    ResponsePayload: responsePayloadSchema,
    ToolCallPayload: toolCallPayloadSchema,
    ToolResultPayload: toolResultPayloadSchema,
    HandoffPayload: handoffPayloadSchema,
    ErrorPayload: errorPayloadSchema,
    StateSnapshotPayload: stateSnapshotPayloadSchema,
    RetrieverDocument: retrieverDocumentSchema,
    RetrieverPayload: retrieverPayloadSchema,
    CheckpointPayload: checkpointPayloadSchema,
    PromptEvent: promptEventSchema,
    ResponseEvent: responseEventSchema,
    ToolCallEvent: toolCallEventSchema,
    ToolResultEvent: toolResultEventSchema,
    HandoffEvent: handoffEventSchema,
    ErrorEvent: errorEventSchema,
    NoteEvent: noteEventSchema,
    StateSnapshotEvent: stateSnapshotEventSchema,
    RetrieverEvent: retrieverEventSchema,
    CheckpointEvent: checkpointEventSchema,
    TraceEvent: traceEventSchema,
    Trace: traceSchema,
    TraceMeta: traceMetaSchema,
    TraceWithMeta: traceWithMetaSchema,
    TraceListResponse: traceListResponseSchema
  }), {
    name: "AeroGraph",
    errorMessages: false,
    $refStrategy: "root"
  }) as any;

  const pythonCodegenSchema = {
    $schema: "https://json-schema.org/draft-07/schema#",
    definitions: rawSchema.definitions
  };

  return {
    $schema: "https://json-schema.org/draft-07/schema#",
    title: "AeroGraph TraceEvent Schema",
    description:
      "Language-neutral JSON Schema artifact exported from @aerograph/contracts. " +
      "Used to generate and validate non-TypeScript runtime bindings.",
    schemaVersion,
    generatedAt: "PLACEHOLDER",
    traceEventSchema: traceEventJsonSchema,
    traceSchema: traceJsonSchema,
    traceMetaSchema: traceMetaJsonSchema,
    traceWithMetaSchema: traceWithMetaJsonSchema,
    traceListResponseSchema: traceListResponseJsonSchema,
    pythonCodegenSchema
  };
}
