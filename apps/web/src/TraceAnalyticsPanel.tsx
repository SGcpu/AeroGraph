/**
 * TraceAnalyticsPanel.tsx — T016
 *
 * Displays aggregated canonical telemetry statistics for the active trace,
 * sourced from GET /v1/traces/:id/stats.
 *
 * Design principles:
 *  - Gracefully handles null values (v1.0.0 legacy traces show — instead of crashing)
 *  - modelBreakdown expands into per-model rows
 *  - No cost fields; only token counts and durations
 */

import type { TraceStats, TraceAnalysis } from "@aerograph/contracts";

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// ── Stat badge ────────────────────────────────────────────────────────────────
function StatBadge({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{
      background: "rgba(99,130,255,0.07)",
      border: "1px solid rgba(99,130,255,0.14)",
      borderRadius: 8,
      padding: "10px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
      minWidth: 90,
      flex: 1,
    }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-sans)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>
        {value}
      </span>
      {sub && (
        <span style={{ fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

// ── Model breakdown table ─────────────────────────────────────────────────────
function ModelBreakdown({ entries }: { entries: TraceStats["modelBreakdown"] }) {
  if (!entries || entries.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "4px 0" }}>
        No model data in this trace.
      </div>
    );
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
      <thead>
        <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
          {["Model", "Source", "Spans", "In", "Out", "Total"].map((h) => (
            <th key={h} style={{ padding: "3px 6px 5px", fontWeight: 500, fontFamily: "var(--font-sans)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid var(--border-subtle)" }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => {
          const isCached = e.cachedTokens != null && e.cachedTokens > 0 && (!e.liveTokens || e.liveTokens === 0);
          const isLive = e.liveTokens != null && e.liveTokens > 0 && (!e.cachedTokens || e.cachedTokens === 0);
          const isMixed = e.liveTokens != null && e.liveTokens > 0 && e.cachedTokens != null && e.cachedTokens > 0;

          return (
            <tr key={i} style={{ color: "var(--text-primary)", borderBottom: "1px solid rgba(99,130,255,0.05)" }}>
              <td style={{ padding: "4px 6px", fontFamily: "var(--font-mono)", color: "var(--accent)" }}>{e.modelName}</td>
              <td style={{ padding: "4px 6px" }}>
                {isCached ? (
                  <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "rgba(117, 143, 123, 0.2)", color: "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                    Cached
                  </span>
                ) : isLive ? (
                  <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "rgba(100, 132, 160, 0.2)", color: "var(--accent-blue)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                    Live
                  </span>
                ) : isMixed ? (
                  <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "rgba(184, 156, 114, 0.2)", color: "var(--amber)", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                    Mixed
                  </span>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: 10 }}>—</span>
                )}
              </td>
              <td style={{ padding: "4px 6px" }}>{e.spanCount}</td>
              <td style={{ padding: "4px 6px" }}>{fmt(e.inputTokens)}</td>
              <td style={{ padding: "4px 6px" }}>{fmt(e.outputTokens)}</td>
              <td style={{ padding: "4px 6px", fontWeight: 600 }}>{fmt(e.totalTokens)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export function TraceAnalyticsPanel({
  stats,
  routingSummary,
  parentTraceId,
  onCompareWithParent,
  loading
}: {
  stats: TraceStats | null;
  routingSummary?: TraceAnalysis["routingSummary"];
  parentTraceId?: string | null;
  onCompareWithParent?: (parentId: string) => void;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 11, color: "var(--text-muted)" }}>
        Loading stats…
      </div>
    );
  }

  if (!stats) {
    return (
      <div style={{ padding: "12px 16px", fontSize: 11, color: "var(--text-muted)" }}>
        No stats available.
      </div>
    );
  }

  // Calculate real wall-clock elapsed time from start and end if root span duration is absent
  const wallClockMs = (stats.traceStartedAt && stats.traceEndedAt)
    ? Math.max(0, new Date(stats.traceEndedAt).getTime() - new Date(stats.traceStartedAt).getTime())
    : null;
  const wallClockDisplay = stats.rootSpanDurationMs != null 
    ? fmtDuration(stats.rootSpanDurationMs) 
    : (wallClockMs != null ? fmtDuration(wallClockMs) : "—");

  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Timing summary */}
      <div>
        <div className="detail-section-label" style={{ marginBottom: 8 }}>Trace Timing</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <StatBadge label="Events" value={String(stats.eventCount)} />
          <StatBadge label="Actors" value={String(stats.actorCount)} />
          <StatBadge label="Duration" value={fmtDuration(stats.totalDurationMs)} sub="sum of spans" />
          <StatBadge label="Wall-Clock" value={wallClockDisplay} sub="real elapsed" />
        </div>
      </div>

      {/* Scenario Mode Banner */}
      {stats.executionMode && (
        <div style={{
          padding: "8px 10px",
          borderRadius: 6,
          background: stats.executionMode === "replay" 
            ? "rgba(34, 197, 94, 0.08)" 
            : stats.executionMode === "fork" 
              ? "rgba(56, 189, 248, 0.08)" 
              : "rgba(168, 85, 247, 0.08)",
          border: `1px solid ${
            stats.executionMode === "replay" 
              ? "rgba(34, 197, 94, 0.2)" 
              : stats.executionMode === "fork" 
                ? "rgba(56, 189, 248, 0.2)" 
                : "rgba(168, 85, 247, 0.2)"
          }`,
          display: "flex",
          flexDirection: "column",
          gap: 6
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              color: stats.executionMode === "replay" ? "#4ade80" : stats.executionMode === "fork" ? "#38bdf8" : "#c084fc",
              display: "flex",
              alignItems: "center",
              gap: 5
            }}>
              {stats.executionMode === "replay" ? "▶ STRICT REPLAY" : stats.executionMode === "fork" ? "🌿 FORK & RESUME" : "⏺ RECORD RUN"}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
              {stats.executionMode === "replay" 
                ? "100% Cached ($0.00 spend)" 
                : stats.executionMode === "fork" 
                  ? `${stats.savingsPercentage ?? 0}% Saved by Cache` 
                  : "Live Network"}
            </span>
          </div>

          {/* Quick 1-click Compare with Base Trace button if derived/replayed */}
          {parentTraceId && onCompareWithParent && (stats.executionMode === "replay" || stats.executionMode === "fork") && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
              <button
                onClick={() => onCompareWithParent(parentTraceId)}
                style={{
                  fontSize: 10,
                  padding: "3px 8px",
                  borderRadius: 4,
                  background: "rgba(255, 255, 255, 0.06)",
                  border: "1px solid var(--border-subtle)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontFamily: "var(--font-sans)",
                  transition: "background 0.15s ease"
                }}
                title={`Run Myers diff against base trace ${parentTraceId}`}
              >
                <span>⚖</span> Compare with Base
              </button>
            </div>
          )}
        </div>
      )}

      {/* Proxy Routing Interceptor Summary (if available) */}
      {routingSummary && (routingSummary.cacheHits > 0 || routingSummary.liveCalls > 0) && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 10,
          padding: "5px 10px",
          background: "rgba(0, 0, 0, 0.18)",
          borderRadius: 6,
          border: "1px solid var(--border-subtle)",
          fontFamily: "var(--font-mono)"
        }}>
          <span style={{ color: "var(--text-muted)" }}>Proxy Routing:</span>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ color: "var(--accent)" }}>✓ {routingSummary.cacheHits} Cache Hit{routingSummary.cacheHits !== 1 ? "s" : ""}</span>
            {routingSummary.liveCalls > 0 && <span style={{ color: "var(--accent-blue)" }}>⚡ {routingSummary.liveCalls} Live</span>}
            {routingSummary.unclassifiedWarnings > 0 && (
              <span style={{ color: "var(--amber)" }} title="Unclassified requests defaulted to live execution">
                ⚠ {routingSummary.unclassifiedWarnings} Unclassified
              </span>
            )}
          </div>
        </div>
      )}

      {/* Token summary (Dual Accounting: Live vs Cached vs Total) */}
      <div>
        <div className="detail-section-label" style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Token Usage</span>
          {stats.savingsPercentage != null && stats.savingsPercentage > 0 && (
            <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 600, fontFamily: "var(--font-mono)" }}>
              {stats.savingsPercentage}% Saved by Cache
            </span>
          )}
        </div>
        
        {/* If replayed or forked, show breakdown */}
        {stats.executionMode && stats.executionMode !== "record" && stats.cachedTotalTokens != null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <StatBadge label="Live Billed" value={fmt(stats.liveTotalTokens)} sub="actual spend" />
              <StatBadge label="Cached / Saved" value={fmt(stats.cachedTotalTokens)} sub="$0.00 cost" />
              <StatBadge label="Total Work" value={fmt(stats.totalTokens)} sub="workflow total" />
            </div>
            <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", paddingLeft: 2 }}>
              Input: {fmt(stats.liveInputTokens ?? 0)} live / {fmt(stats.cachedInputTokens ?? 0)} cached · Output: {fmt(stats.liveOutputTokens ?? 0)} live / {fmt(stats.cachedOutputTokens ?? 0)} cached
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <StatBadge label="Input" value={fmt(stats.totalInputTokens)} />
            <StatBadge label="Output" value={fmt(stats.totalOutputTokens)} />
            <StatBadge label="Total" value={fmt(stats.totalTokens)} />
          </div>
        )}
      </div>

      {/* Per-model breakdown */}
      <div>
        <div className="detail-section-label" style={{ marginBottom: 6 }}>Model Breakdown</div>
        <ModelBreakdown entries={stats.modelBreakdown} />
      </div>

      {/* Trace window */}
      {(stats.traceStartedAt || stats.traceEndedAt) && (
        <div style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", display: "flex", flexDirection: "column", gap: 2 }}>
          {stats.traceStartedAt && <span>Started: {new Date(stats.traceStartedAt).toLocaleTimeString()}</span>}
          {stats.traceEndedAt && <span>Ended: {new Date(stats.traceEndedAt).toLocaleTimeString()}</span>}
        </div>
      )}
    </div>
  );
}
