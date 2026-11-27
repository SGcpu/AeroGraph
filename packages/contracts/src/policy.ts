import { z } from "zod";

export const safetyClassSchema = z.enum(["replay_safe", "must_execute"]);
export type SafetyClass = z.infer<typeof safetyClassSchema>;

export const safetyRuleSchema = z.object({
  /** Glob pattern matched against the full URL (protocol included). */
  match: z.string().min(1),
  /** Optional additional tool name matcher. */
  toolName: z.string().optional(),
  class: safetyClassSchema
});
export type SafetyRule = z.infer<typeof safetyRuleSchema>;

export const maskRegexRuleSchema = z.object({
  pattern: z.string().min(1),
  replace: z.string().default("[DYNAMIC_VALUE]")
});
export type MaskRegexRule = z.infer<typeof maskRegexRuleSchema>;

export const normalizationPolicySchema = z.object({
  strip_headers: z.array(z.string()).optional(),
  mask_json_keys: z.array(z.string()).optional(),
  mask_regexes: z.array(maskRegexRuleSchema).optional()
});
export type NormalizationPolicy = z.infer<typeof normalizationPolicySchema>;

export const toolSafetyPolicySchema = z.object({
  tools: z.array(safetyRuleSchema).default([]),
  normalization: normalizationPolicySchema.optional()
});
export type ToolSafetyPolicy = z.infer<typeof toolSafetyPolicySchema>;
export const replaySafetyPolicySchema = toolSafetyPolicySchema;
export type ReplaySafetyPolicy = ToolSafetyPolicy;

export function validateToolSafetyPolicy(data: unknown): ToolSafetyPolicy {
  return toolSafetyPolicySchema.parse(data);
}
