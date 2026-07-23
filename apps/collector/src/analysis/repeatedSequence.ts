import { sortTraceEventsDeterministic, type TraceEvent } from "@aerograph/contracts";

export type LoopWarning = {
  kind: "repeated_sequence";
  severity: "low" | "medium" | "high";
  reason: string;
  spanIds: string[];
};

/**
 * Stable key for repeated-sequence windowing.
 * Uses kind:actorId (no spanId) — the window heuristic detects structural patterns
 * of repeated execution flow, not exact span identity.
 */
function patternKey(event: TraceEvent): string {
  return `${event.kind}:${event.actor.id}`;
}

/**
 * Detect repeated event-sequence windows in a sorted trace.
 *
 * Algorithm:
 * - For each window size W in [2, 5]:
 *   - Scan the stable-key sequence with a sliding window.
 *   - If two consecutive windows of size W produce the same key sequence,
 *     record a warning for those spans.
 * - Output is deduplicated and deterministically ordered by first-span occurredAt.
 */
export function detectRepeatedSequences(events: readonly TraceEvent[]): LoopWarning[] {
  const sorted = sortTraceEventsDeterministic([...events]);
  const keys = sorted.map(patternKey);
  const n = sorted.length;

  const warnings: LoopWarning[] = [];
  const seen = new Set<string>();

  for (let w = 2; w <= 5; w++) {
    for (let i = 0; i + 3 * w <= n; i++) {
      const windowA = keys.slice(i, i + w).join(",");
      const windowB = keys.slice(i + w, i + 2 * w).join(",");
      const windowC = keys.slice(i + 2 * w, i + 3 * w).join(",");

      if (windowA === windowB && windowB === windowC) {
        const dedupKey = `${windowA}@${i}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const spanIds = [
          ...sorted.slice(i, i + w).map((e) => e.spanId),
          ...sorted.slice(i + w, i + 2 * w).map((e) => e.spanId),
          ...sorted.slice(i + 2 * w, i + 3 * w).map((e) => e.spanId)
        ];

        const severity: "low" | "medium" | "high" = w >= 4 ? "high" : "medium";

        warnings.push({
          kind: "repeated_sequence",
          severity,
          reason: `Repeated ${w}-event sequence detected 3 times starting at index ${i}`,
          spanIds
        });
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
