import { z } from "zod";

export const runModeSchema = z.enum(["record", "replay", "fork"]);
export type RunMode = z.infer<typeof runModeSchema>;

export const runStatusSchema = z.enum(["pending", "running", "completed", "failed", "crashed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const startRunRequestSchema = z.object({
  mode: runModeSchema,
  /** Required for record: command to run (e.g. ["python", "agent.py"]) */
  command: z.array(z.string()).optional(),
  /** Required for replay and fork: existing cassette run ID */
  cassetteRunId: z.string().optional(),
  /** Required for fork: span ID at which to fork */
  forkFromSpanId: z.string().optional(),
  /** Optional for fork: prompt override at fork span */
  forkOverrides: z.object({ promptText: z.string().optional() }).optional(),
  /** Optional: override default project root */
  projectRoot: z.string().optional(),
  /** Optional: virtual environment path (e.g. .venv) */
  virtualEnv: z.string().optional().nullable(),
  /** Optional: exact executable path (e.g. /path/to/.venv/bin/python) */
  executablePath: z.string().optional().nullable(),
  /** Optional: entrypoint script file */
  entrypoint: z.string().optional().nullable()
});
export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const startRunResponseSchema = z.object({
  runId: z.string().min(1),
  traceId: z.string().min(1),
  status: runStatusSchema
});
export type StartRunResponse = z.infer<typeof startRunResponseSchema>;

export const getRunResponseSchema = z.object({
  runId: z.string().min(1),
  traceId: z.string().min(1),
  parentTraceId: z.string().nullable(),
  cassetteRunId: z.string().nullable(),
  status: runStatusSchema,
  mode: runModeSchema,
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  command: z.array(z.string()).optional(),
  projectRoot: z.string().optional(),
  virtualEnv: z.string().optional().nullable(),
  executablePath: z.string().optional().nullable(),
  entrypoint: z.string().optional().nullable()
});
export type GetRunResponse = z.infer<typeof getRunResponseSchema>;

/** POST /v1/traces/:traceId/replay — triggers replay of an existing recorded trace. */
export const replayTraceRequestSchema = z.object({
  /** If omitted, replay uses the cassette linked to this trace (from run record). */
  cassetteRunId: z.string().optional()
});
export type ReplayTraceRequest = z.infer<typeof replayTraceRequestSchema>;

/** POST /v1/traces/:traceId/fork-and-resume — extends existing fork logic with auto-resume. */
export const forkAndResumeRequestSchema = z.object({
  forkFromSpanId: z.string().min(1),
  overrides: z.object({ promptText: z.string().optional() }).optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  projectConfigYaml: z.string().optional(),
  projectRoot: z.string().optional(),
  cassetteRunId: z.string().optional(),
  virtualEnv: z.string().optional().nullable(),
  executablePath: z.string().optional().nullable(),
  entrypoint: z.string().optional().nullable(),
  mode: runModeSchema.optional()
});
export type ForkAndResumeRequest = z.infer<typeof forkAndResumeRequestSchema>;

export const runtimeMetadataSchema = z.object({
  projectRoot: z.string().min(1),
  virtualEnv: z.string().optional().nullable(),
  executablePath: z.string().optional().nullable(),
  entrypoint: z.string().optional().nullable(),
  command: z.union([z.string(), z.array(z.string())]).optional()
});
export type RuntimeMetadata = z.infer<typeof runtimeMetadataSchema>;

export const forkAndResumeResponseSchema = z.object({
  childTraceId: z.string().min(1),
  runId: z.string().min(1),
  status: runStatusSchema
});
export type ForkAndResumeResponse = z.infer<typeof forkAndResumeResponseSchema>;

export function validateStartRunRequest(input: unknown): StartRunRequest {
  return startRunRequestSchema.parse(input);
}

export function validateStartRunResponse(input: unknown): StartRunResponse {
  return startRunResponseSchema.parse(input);
}

export function validateGetRunResponse(input: unknown): GetRunResponse {
  return getRunResponseSchema.parse(input);
}

export function validateReplayTraceRequest(input: unknown): ReplayTraceRequest {
  return replayTraceRequestSchema.parse(input);
}

export function validateForkAndResumeRequest(input: unknown): ForkAndResumeRequest {
  return forkAndResumeRequestSchema.parse(input);
}

export function validateForkAndResumeResponse(input: unknown): ForkAndResumeResponse {
  return forkAndResumeResponseSchema.parse(input);
}

export function validateRuntimeMetadata(input: unknown): RuntimeMetadata {
  return runtimeMetadataSchema.parse(input);
}

