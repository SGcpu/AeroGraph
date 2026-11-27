import { z } from "zod";

export const replaySourceSchema = z.enum(["cache", "live"]);
export type ReplaySource = z.infer<typeof replaySourceSchema>;

export const cassetteEntrySchema = z.object({
  /** Content-derived key: SHA256(method + normalizedUrl + SHA256(body)) */
  requestKey: z.string().min(1),
  method: z.string().min(1),
  normalizedUrl: z.string().min(1),
  /** SHA256 of the request body. Empty string for GET/HEAD. */
  requestBodyHash: z.string(),
  responseStatus: z.number().int(),
  responseHeaders: z.record(z.string(), z.string()),
  /**
   * If streamingPreserved=true: array of SSE/chunk strings in order.
   * If streamingPreserved=false: single-element array containing full concatenated body.
   */
  responseChunks: z.array(z.string()),
  streamingPreserved: z.boolean(),
  recordedAt: z.string().datetime(),
  /** AeroGraph span ID that triggered this request. Null if correlation failed. */
  correlatedSpanId: z.string().nullable(),
  /** Deterministic branch path for parallel fan-out correlation. */
  branchId: z.string().nullable().optional(),
  /** Per-branch monotonic sequence counter. */
  localSeq: z.number().int().nonnegative().nullable().optional()
});
export type CassetteEntry = z.infer<typeof cassetteEntrySchema>;

export const inboundTurnSchema = z.object({
  channel: z.enum(["stdin", "http", "hitl"]).default("stdin"),
  turn: z.number().int().nonnegative(),
  prompt: z.string(),
  payload: z.string(),
  spanId: z.string().nullable().optional(),
  recordedAt: z.string().datetime().optional()
});
export type InboundTurn = z.infer<typeof inboundTurnSchema>;

export const localRetrievalEntrySchema = z.object({
  provider: z.enum(["chromadb", "faiss", "lancedb"]),
  queryKey: z.string().min(1),
  collection: z.string().optional(),
  queryArgs: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()),
  spanId: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
  localSeq: z.number().int().nonnegative().optional(),
  recordedAt: z.string().datetime().optional()
});
export type LocalRetrievalEntry = z.infer<typeof localRetrievalEntrySchema>;

export const cassetteSchema = z.object({
  /** Schema version for the cassette format itself. */
  cassetteVersion: z.enum(["1.0.0", "2.0.0"]),
  /** The AeroGraph run ID (also the cassette file name base). */
  runId: z.string().min(1),
  /** The AeroGraph trace ID produced during the record run. */
  traceId: z.string().min(1),
  /** The shell command that was wrapped. */
  command: z.array(z.string()),
  recordedAt: z.string().datetime(),
  entries: z.array(cassetteEntrySchema),
  /** Recorded inbound human_input / webhook turns (v2.0.0). */
  inbound: z.array(inboundTurnSchema).optional(),
  /** Recorded local in-process vector DB retrievals (v2.0.0). */
  localRetrievals: z.array(localRetrievalEntrySchema).optional()
});
export type Cassette = z.infer<typeof cassetteSchema>;

export function validateCassetteEntry(input: unknown): CassetteEntry {
  return cassetteEntrySchema.parse(input);
}

export function validateCassette(input: unknown): Cassette {
  return cassetteSchema.parse(input);
}
