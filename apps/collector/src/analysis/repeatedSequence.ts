import { sortTraceEventsDeterministic, type TraceEvent } from "@aerograph/contracts";

export type LoopWarning = {
  kind: "repeated_sequence";
  severity: "low" | "medium" | "high";
  reason: string;
  spanIds: string[];
};

/**
 * Stable key for repeated-sequence windowing.
 * Uses kind:actorId / tool / node — detects structural patterns
 * of repeated execution flow, not exact span identity.
 */
function patternKey(event: TraceEvent): string {
  const payload = (event as any).payload ?? {};
  if (payload.kind === "langgraph_node" && payload.node) {
    return `langgraph_node:${payload.node}`;
  }
  const toolName = payload.name || payload.tool || payload.toolName;
  if (toolName) {
    return `tool_call:${toolName}`;
  }
  return `${event.kind}:${event.actor.id}`;
}

/**
 * Determine if an event represents an active execution step rather than passive telemetry.
 */
function isActionStep(event: TraceEvent): boolean {
  if (event.kind === "prompt" || event.kind === "response" || event.kind === "tool_call" || event.kind === "handoff") {
    return true;
  }
  const payload = (event as any).payload ?? {};
  if (payload.kind === "langgraph_node" || payload.agent_name || payload.action) {
    return true;
  }
  return false;
}

/**
 * Detect repeated event-sequence windows (motifs & oscillations) in a sorted trace.
 *
 * Algorithm:
 * 1. Analyzes both raw trace and action-filtered trace (to bypass interleaved passive noise).
 * 2. Scans for repeating sub-sequence motifs of length W in [1, 8] with repetition factor K >= 2.
 * 3. Deduplicates overlapping windows into maximal periodic runs.
 * 4. Outputs deterministic warnings sorted by first span occurredAt.
 */
export function detectRepeatedSequences(events: readonly TraceEvent[]): LoopWarning[] {
  const sorted = sortTraceEventsDeterministic([...events]);
  if (sorted.length < 4) return [];

  const warnings: LoopWarning[] = [];
  const reportedSpanSets = new Set<string>();

  // Helper to scan a sequence for periodic repeats
  function scanSequence(items: TraceEvent[], isFiltered: boolean) {
    const keys = items.map(patternKey);
    const n = items.length;
    const coveredIndices = new Set<number>();

    // Scan window sizes from 2 up to 8 (and 1 for single-action hammering)
    for (let w = 2; w <= Math.min(8, Math.floor(n / 2)); w++) {
      for (let i = 0; i + 2 * w <= n; i++) {
        if (coveredIndices.has(i)) continue;

        const motif = keys.slice(i, i + w).join(",");
        let k = 1;

        while (i + (k + 1) * w <= n) {
          const nextWindow = keys.slice(i + k * w, i + (k + 1) * w).join(",");
          if (nextWindow === motif) {
            k++;
          } else {
            break;
          }
        }

        // Require at least 3 repeats for small patterns (w <= 2), or 2 repeats for larger motifs (w >= 3)
        const minRepeats = w <= 2 ? 3 : 2;
        if (k >= minRepeats) {
          const matchedEvents = items.slice(i, i + k * w);
          const spanIds = matchedEvents.map((e) => e.spanId);
          const spanSetKey = spanIds.join(",");

          if (!reportedSpanSets.has(spanSetKey)) {
            reportedSpanSets.add(spanSetKey);

            // Mark indices covered
            for (let idx = i; idx < i + k * w; idx++) {
              coveredIndices.add(idx);
            }

            const motifLabels = items
              .slice(i, i + w)
              .map((e) => {
                const pk = patternKey(e);
                return pk.includes(":") ? pk.split(":")[1] : pk;
              })
              .join(" → ");

            const severity: "low" | "medium" | "high" =
              k >= 4 || w >= 4 ? "high" : k >= 3 || w >= 3 ? "medium" : "low";

            warnings.push({
              kind: "repeated_sequence",
              severity,
              reason: isFiltered
                ? `Oscillatory sequence (${motifLabels}) repeated ${k} times (with interleaved telemetry)`
                : `Repeated ${w}-event sequence (${motifLabels}) detected ${k} times starting at index ${i}`,
              spanIds
            });
          }
        }
      }
    }
  }

  // Pass 1: Raw sequence (strict consecutive repeats)
  scanSequence(sorted, false);

  // Pass 2: Action-filtered sequence (noise-resilient repeats across interleaved telemetry)
  const actionEvents = sorted.filter(isActionStep);
  if (actionEvents.length >= 4 && actionEvents.length < sorted.length) {
    scanSequence(actionEvents, true);
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
