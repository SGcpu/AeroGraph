import { sortTraceEventsDeterministic, type TraceEvent } from "@aerograph/contracts";

export type RecursiveToolWarning = {
  kind: "recursive_tool";
  severity: "low" | "medium" | "high";
  reason: string;
  spanIds: string[];
};

/** Normalizes tool input to a signature string (ignores attempt counts / incremental fields). */
function normalizeToolSignature(toolId: string, input: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input || {})) {
    const lower = k.toLowerCase();
    if (lower === "attempt" || lower === "iteration" || lower === "retry" || lower === "count") continue;
    filtered[k] = v;
  }
  return `${toolId}:${JSON.stringify(filtered, Object.keys(filtered).sort())}`;
}

/** Extract meaningful token set from tool arguments for fuzzy similarity */
function extractInputTokens(input: Record<string, unknown>): Set<string> {
  const tokens: string[] = [];
  for (const [k, v] of Object.entries(input || {})) {
    const lower = k.toLowerCase();
    if (lower === "attempt" || lower === "iteration" || lower === "retry" || lower === "count") continue;
    if (typeof v === "string") {
      tokens.push(...v.toLowerCase().split(/[\s,._\-:;/?!&"'{}[\]]+/));
    } else if (typeof v === "number" || typeof v === "boolean") {
      tokens.push(String(v));
    } else if (v && typeof v === "object") {
      tokens.push(...JSON.stringify(v).toLowerCase().split(/[\s,._\-:;/?!&"'{}[\]]+/));
    }
  }
  return new Set(tokens.filter((t) => t.length > 0));
}

/** Calculate Jaccard similarity coefficient between two token sets */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0.0;
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Check if a tool output represents an empty result or no-op response */
function isOutputEmptyOrNoOp(output: unknown): boolean {
  if (output === undefined) return false; // Not captured
  if (output === null) return true;
  if (typeof output === "string") {
    const trimmed = output.trim().toLowerCase();
    return (
      trimmed === "" ||
      trimmed === "[]" ||
      trimmed === "{}" ||
      trimmed === "null" ||
      trimmed === "none" ||
      trimmed.includes("no results found") ||
      trimmed.includes("not found")
    );
  }
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return true;
    if (Array.isArray(obj.results) && obj.results.length === 0) return true;
    if (Array.isArray(obj.items) && obj.items.length === 0) return true;
    if (Array.isArray(obj.records) && obj.records.length === 0) return true;
    if (obj.count === 0) return true;
    if (obj.status === "empty" || obj.status === "not_found" || obj.status === "no_results") return true;
  }
  return false;
}

const RECURSIVE_TOOL_THRESHOLD = 3;

interface ToolInvocation {
  spanId: string;
  occurredAt: string;
  toolId: string;
  input: Record<string, unknown>;
  output: unknown;
  status: string;
  signature: string;
  tokens: Set<string>;
}

/**
 * Detect recursive tool usage:
 * 1. Identical normalized inputs invoked >= 3 times.
 * 2. High semantic/fuzzy input similarity (Jaccard >= 0.70) with stagnant/empty outputs or consecutive errors.
 */
export function detectRecursiveTools(events: readonly TraceEvent[]): RecursiveToolWarning[] {
  const sorted = sortTraceEventsDeterministic([...events]);

  // Index tool_result events by parentSpanId so tool outputs are properly associated
  const toolResultsByParent = new Map<string, Extract<TraceEvent, { kind: "tool_result" }>>();
  for (const event of sorted) {
    if (event.kind === "tool_result" && event.parentSpanId) {
      toolResultsByParent.set(event.parentSpanId, event as Extract<TraceEvent, { kind: "tool_result" }>);
    }
  }

  // Extract all tool_call events
  const toolInvocations: ToolInvocation[] = [];
  for (const event of sorted) {
    if (event.kind !== "tool_call") continue;
    const tc = event as Extract<TraceEvent, { kind: "tool_call" }>;
    const payload = (tc.payload ?? {}) as Record<string, unknown>;
    const toolId = String(payload.name || payload.tool || payload.toolName || tc.actor.id);
    const input = (payload.input as Record<string, unknown>) || {};
    const resultEvent = toolResultsByParent.get(event.spanId);
    const resultPayload = (resultEvent?.payload ?? {}) as Record<string, unknown>;
    const output =
      payload.output ??
      payload.result ??
      payload.response ??
      resultPayload.output ??
      resultPayload.result;
    const status = event.status === "error" || resultEvent?.status === "error" ? "error" : event.status;

    toolInvocations.push({
      spanId: event.spanId,
      occurredAt: event.occurredAt,
      toolId,
      input,
      output,
      status,
      signature: normalizeToolSignature(toolId, input),
      tokens: extractInputTokens(input)
    });
  }

  if (toolInvocations.length < RECURSIVE_TOOL_THRESHOLD) return [];

  const warnings: RecursiveToolWarning[] = [];
  const reportedSpanIds = new Set<string>();

  // 1. Group by exact normalized signature (Standard baseline)
  const exactGroups = new Map<string, ToolInvocation[]>();
  for (const inv of toolInvocations) {
    if (!exactGroups.has(inv.signature)) exactGroups.set(inv.signature, []);
    exactGroups.get(inv.signature)!.push(inv);
  }

  for (const [sig, entries] of exactGroups) {
    if (entries.length >= RECURSIVE_TOOL_THRESHOLD) {
      const count = entries.length;
      const spanIds = entries.map((e) => e.spanId);
      spanIds.forEach((id) => reportedSpanIds.add(id));

      const severity: "low" | "medium" | "high" =
        count >= 8 ? "high" : count >= 5 ? "medium" : "low";

      warnings.push({
        kind: "recursive_tool",
        severity,
        reason: `Tool called ${count} times with equivalent input signature (${sig.slice(0, 60)})`,
        spanIds
      });
    }
  }

  // 2. Group remaining invocations by toolId to detect fuzzy "No Progress" loops
  const byTool = new Map<string, ToolInvocation[]>();
  for (const inv of toolInvocations) {
    if (!byTool.has(inv.toolId)) byTool.set(inv.toolId, []);
    byTool.get(inv.toolId)!.push(inv);
  }

  for (const [toolId, list] of byTool) {
    if (list.length < RECURSIVE_TOOL_THRESHOLD) continue;

    // Sliding window across consecutive calls to this tool
    let windowStart = 0;
    while (windowStart <= list.length - RECURSIVE_TOOL_THRESHOLD) {
      const cluster: ToolInvocation[] = [list[windowStart]];

      for (let j = windowStart + 1; j < list.length; j++) {
        const candidate = list[j];
        const sim = jaccardSimilarity(cluster[0].tokens, candidate.tokens);

        if (sim >= 0.70) {
          cluster.push(candidate);
        } else {
          break;
        }
      }

      if (cluster.length >= RECURSIVE_TOOL_THRESHOLD) {
        const newSpans = cluster.map((c) => c.spanId).filter((id) => !reportedSpanIds.has(id));

        if (newSpans.length >= RECURSIVE_TOOL_THRESHOLD) {
          // Check for explicit No Progress indicators
          const capturedOutputs = cluster.filter((c) => c.output !== undefined);
          const emptyCount = cluster.filter((c) => isOutputEmptyOrNoOp(c.output)).length;
          const errorCount = cluster.filter((c) => c.status === "error").length;
          const allOutputsIdentical =
            capturedOutputs.length >= 2 &&
            capturedOutputs.every((c) => JSON.stringify(c.output) === JSON.stringify(capturedOutputs[0].output));

          // Only flag fuzzy calls if there is concrete evidence of failure/stagnation
          if (emptyCount >= 2 || errorCount >= 2 || (allOutputsIdentical && capturedOutputs.length >= 2)) {
            cluster.forEach((c) => reportedSpanIds.add(c.spanId));
            const count = cluster.length;

            const diagnostic =
              errorCount >= 2
                ? "repeated tool errors without recovery"
                : emptyCount >= 2
                ? "repeated empty/null result sets"
                : "stagnant identical outputs";

            warnings.push({
              kind: "recursive_tool",
              severity: count >= 5 ? "high" : "medium",
              reason: `Tool '${toolId}' called ${count} times without progress (${diagnostic})`,
              spanIds: cluster.map((c) => c.spanId)
            });
          }
        }
        windowStart += cluster.length;
      } else {
        windowStart++;
      }
    }
  }

  // Deterministic ordering: by first spanId's occurredAt, then spanId
  warnings.sort((a, b) => {
    const aSpan = sorted.find((e) => e.spanId === a.spanIds[0]);
    const bSpan = sorted.find((e) => e.spanId === b.spanIds[0]);
    const t = (aSpan?.occurredAt ?? "").localeCompare(bSpan?.occurredAt ?? "");
    if (t !== 0) return t;
    return (a.spanIds[0] ?? "").localeCompare(b.spanIds[0] ?? "");
  });

  return warnings;
}
