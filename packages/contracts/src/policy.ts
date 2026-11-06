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

export const toolSafetyPolicySchema = z.object({
  tools: z.array(safetyRuleSchema)
});
export type ToolSafetyPolicy = z.infer<typeof toolSafetyPolicySchema>;

export function validateToolSafetyPolicy(data: unknown): ToolSafetyPolicy {
  return toolSafetyPolicySchema.parse(data);
}
