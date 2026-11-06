import { sortTraceEventsDeterministic, type TraceEvent, type TraceAnalysis } from "@aerograph/contracts";
import { detectRepeatedSequences } from "./repeatedSequence";
import { detectRecursiveTools } from "./recursiveTool";
import { detectHandoffCycles } from "./handoffCycle";

/**
 * Classifies an error event into standard agent failure modes with root-cause identification.
 */
function classifyFailure(event: TraceEvent, isRootCause: boolean): string {
  const payload = (event as any).payload ?? {};
  const text = (
    (event.title || "") +
    " " +
    JSON.stringify(payload.error || payload.exception || payload.message || payload.response || payload)
  ).toLowerCase();

  let category = "RUNTIME_ERROR";

  if (
    text.includes("rate limit") ||
    text.includes("429") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("deadline exceeded") ||
    text.includes("504")
  ) {
    category = "RATE_LIMIT_OR_TIMEOUT";
  } else if (
    text.includes("validation error") ||
    text.includes("schema") ||
    text.includes("missing required") ||
    text.includes("invalid argument") ||
    text.includes("json parse") ||
    text.includes("syntaxerror")
  ) {
    category = "SCHEMA_VALIDATION";
  } else if (
    text.includes("tool not found") ||
    text.includes("unknown tool") ||
    text.includes("not a valid tool") ||
    text.includes("no such function") ||
    text.includes("hallucinated")
  ) {
    category = "HALLUCINATED_TOOL";
  } else if (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("unauthorized") ||
    text.includes("forbidden") ||
    text.includes("api key")
  ) {
    category = "AUTH_FAILURE";
  } else if (
    text.includes("recursion limit") ||
    text.includes("max iterations") ||
    text.includes("maximum context length") ||
    text.includes("token limit")
  ) {
    category = "RECURSION_OR_CONTEXT_LIMIT";
  }

  const baseTitle = event.title || `${event.kind}:${event.actor.id} failed`;
  const rootTag = isRootCause ? " [Root Cause]" : " [Cascaded]";
  return `[${category}]${rootTag} ${baseTitle}`;
}

/**
 * Compose all loop analysis heuristics into a single TraceAnalysis result.
 *
 * Output invariants:
 * - All loop warnings are deterministically merged and sorted by:
 *   first span occurredAt → first spanId (lexicographic).
 * - Failures list: error-status events classified with failure mode and root-cause attribution.
 * - Stats: derived from the input events.
 */
export function analyzeTrace(events: readonly TraceEvent[]): TraceAnalysis {
  const sorted = sortTraceEventsDeterministic([...events]);

  // Collect all loop warnings from all heuristics
  const repeatedSeq = detectRepeatedSequences(sorted);
  const recursiveTool = detectRecursiveTools(sorted);
  const handoffCycles = detectHandoffCycles(sorted);

  // Merge and sort all warnings deterministically
  const allWarnings = [
    ...repeatedSeq.map((w) => ({
      kind: w.kind as "repeated_sequence" | "recursive_tool" | "handoff_cycle",
      severity: w.severity as "low" | "medium" | "high",
      reason: w.reason,
      spanIds: w.spanIds
    })),
    ...recursiveTool.map((w) => ({
      kind: w.kind as "repeated_sequence" | "recursive_tool" | "handoff_cycle",
      severity: w.severity as "low" | "medium" | "high",
      reason: w.reason,
      spanIds: w.spanIds
    })),
    ...handoffCycles.map((w) => ({
      kind: w.kind as "repeated_sequence" | "recursive_tool" | "handoff_cycle",
      severity: w.severity as "low" | "medium" | "high",
      reason: w.reason,
      spanIds: w.spanIds
    }))
  ];

  // Sort merged list: first by first spanId's occurredAt, then by first spanId
  allWarnings.sort((a, b) => {
    const aSpan = sorted.find((e) => e.spanId === a.spanIds[0]);
    const bSpan = sorted.find((e) => e.spanId === b.spanIds[0]);
    const t = (aSpan?.occurredAt ?? "").localeCompare(bSpan?.occurredAt ?? "");
    if (t !== 0) return t;
    return (a.spanIds[0] ?? "").localeCompare(b.spanIds[0] ?? "");
  });

  // Failures: events with status "error", classified with root-cause attribution
  const errorEvents = sorted.filter((e) => e.status === "error");
  const failures = errorEvents.map((e, index) => ({
    spanId: e.spanId,
    title: classifyFailure(e, index === 0)
  }));

  // Stats
  const actorIds = new Set(sorted.map((e) => e.actor.id));

  return {
    loops: allWarnings,
    failures,
    stats: {
      eventCount: sorted.length,
      actorCount: actorIds.size
    }
  };
}
