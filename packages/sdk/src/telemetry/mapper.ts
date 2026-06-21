/**
 * packages/sdk/src/telemetry/mapper.ts
 *
 * Generic canonical telemetry mapper utility.
 *
 * Provides framework-agnostic helpers to build and validate the canonical
 * TelemetryModelInfo, TelemetryUsage, and event-level telemetry fields that
 * are new in schema v1.1.0.
 *
 * Design principles (from constitution):
 *  - Adapters call these helpers; they never invent schema fields ad-hoc.
 *  - All fields are optional — partial data is accepted gracefully.
 *  - Cost is NOT computed or stored here; it is derived by the analytics layer.
 */

import {
  type TelemetryModelInfo,
  type TelemetryUsage,
  telemetryModelInfoSchema,
  telemetryUsageSchema
} from "@aerograph/contracts";

// ─── Public surface types ──────────────────────────────────────────────────

/** Raw model info as supplied by a framework adapter (all fields optional). */
export type RawModelInput = {
  name?: string | null;
  provider?: string | null;
  version?: string | null;
};

/** Raw usage counters as supplied by a framework adapter (all fields optional). */
export type RawUsageInput = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedTokens?: number | null;
  /** Alias: some frameworks call input tokens "prompt_tokens" */
  prompt_tokens?: number | null;
  /** Alias: some frameworks call output tokens "completion_tokens" */
  completion_tokens?: number | null;
  /** Alias: some frameworks use "total_tokens" */
  total_tokens?: number | null;
};

/** Complete telemetry block that may be spread into a trace event. */
export type CanonicalTelemetry = {
  model?: TelemetryModelInfo;
  usage?: TelemetryUsage;
  durationMs?: number;
  projectId?: string;
  environment?: string;
  tags?: Record<string, string>;
};

// ─── Model mapping ─────────────────────────────────────────────────────────

/**
 * Build a validated {@link TelemetryModelInfo} from raw adapter input.
 *
 * Returns `undefined` if the input has no usable model name.
 */
export function mapModelInfo(raw: RawModelInput): TelemetryModelInfo | undefined {
  const name = raw.name?.trim();
  if (!name) return undefined;

  const parsed = telemetryModelInfoSchema.safeParse({
    name,
    provider: raw.provider?.trim() || undefined,
    version: raw.version?.trim() || undefined
  });

  return parsed.success ? parsed.data : undefined;
}

// ─── Usage mapping ─────────────────────────────────────────────────────────

/**
 * Build a validated {@link TelemetryUsage} from raw adapter input.
 *
 * Normalizes common framework aliases (prompt_tokens, completion_tokens, etc.)
 * to canonical field names before validation.
 * Returns `undefined` if no token count data is available.
 */
export function mapUsage(raw: RawUsageInput): TelemetryUsage | undefined {
  const inputTokens = raw.inputTokens ?? raw.prompt_tokens ?? undefined;
  const outputTokens = raw.outputTokens ?? raw.completion_tokens ?? undefined;
  const totalTokens =
    raw.totalTokens ?? raw.total_tokens ?? sumIfAvailable(inputTokens, outputTokens);
  const cachedTokens = raw.cachedTokens ?? undefined;

  // All fields undefined → nothing useful to emit
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedTokens === undefined
  ) {
    return undefined;
  }

  const parsed = telemetryUsageSchema.safeParse({
    inputTokens: coerceNonNegativeInt(inputTokens),
    outputTokens: coerceNonNegativeInt(outputTokens),
    totalTokens: coerceNonNegativeInt(totalTokens),
    cachedTokens: coerceNonNegativeInt(cachedTokens)
  });

  return parsed.success ? parsed.data : undefined;
}

// ─── Composite builder ─────────────────────────────────────────────────────

/**
 * Build a complete {@link CanonicalTelemetry} block from disparate raw inputs.
 *
 * @param params - Raw data and optional enrichment.
 * @returns Canonical telemetry block ready to be spread into a trace event.
 */
export function buildCanonicalTelemetry(params: {
  model?: RawModelInput;
  usage?: RawUsageInput;
  durationMs?: number | null;
  projectId?: string | null;
  environment?: string | null;
  tags?: Record<string, string> | null;
}): CanonicalTelemetry {
  const result: CanonicalTelemetry = {};

  if (params.model) {
    const mapped = mapModelInfo(params.model);
    if (mapped) result.model = mapped;
  }

  if (params.usage) {
    const mapped = mapUsage(params.usage);
    if (mapped) result.usage = mapped;
  }

  if (typeof params.durationMs === "number" && params.durationMs >= 0) {
    result.durationMs = Math.round(params.durationMs);
  }

  if (params.projectId?.trim()) {
    result.projectId = params.projectId.trim();
  }

  if (params.environment?.trim()) {
    result.environment = params.environment.trim();
  }

  if (params.tags && Object.keys(params.tags).length > 0) {
    result.tags = params.tags;
  }

  return result;
}

// ─── Duration helpers ──────────────────────────────────────────────────────

/**
 * Compute duration in milliseconds from a start timestamp (ms epoch).
 * Returns `undefined` if startMs is not available.
 */
export function computeDurationMs(startMs: number | undefined): number | undefined {
  if (startMs === undefined) return undefined;
  return Math.max(0, Date.now() - startMs);
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function sumIfAvailable(
  a: number | null | undefined,
  b: number | null | undefined
): number | undefined {
  if (a == null && b == null) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function coerceNonNegativeInt(v: number | null | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Math.round(v);
  return n >= 0 ? n : undefined;
}
