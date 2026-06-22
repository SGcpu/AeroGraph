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

import type { TraceStats } from "@aerograph/contracts";

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
          {["Model", "Provider", "Spans", "In", "Out", "Total"].map((h) => (
            <th key={h} style={{ padding: "3px 6px 5px", fontWeight: 500, fontFamily: "var(--font-sans)", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.05em", borderBottom: "1px solid var(--border-subtle)" }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr key={i} style={{ color: "var(--text-primary)", borderBottom: "1px solid rgba(99,130,255,0.05)" }}>
            <td style={{ padding: "4px 6px", fontFamily: "var(--font-mono)", color: "var(--accent)" }}>{e.modelName}</td>
            <td style={{ padding: "4px 6px", color: "var(--text-muted)" }}>{e.provider ?? "—"}</td>
            <td style={{ padding: "4px 6px" }}>{e.spanCount}</td>
            <td style={{ padding: "4px 6px" }}>{fmt(e.inputTokens)}</td>
            <td style={{ padding: "4px 6px" }}>{fmt(e.outputTokens)}</td>
            <td style={{ padding: "4px 6px", fontWeight: 600 }}>{fmt(e.totalTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export function TraceAnalyticsPanel({ stats, loading }: { stats: TraceStats | null; loading?: boolean }) {
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

  return (
    <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Timing summary */}
      <div>
        <div className="detail-section-label" style={{ marginBottom: 8 }}>Trace Timing</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <StatBadge label="Events" value={String(stats.eventCount)} />
          <StatBadge label="Actors" value={String(stats.actorCount)} />
          <StatBadge label="Duration" value={fmtDuration(stats.totalDurationMs)} sub="sum of spans" />
          <StatBadge label="Root Span" value={fmtDuration(stats.rootSpanDurationMs)} sub="wall-clock" />
        </div>
      </div>

      {/* Token summary */}
      <div>
        <div className="detail-section-label" style={{ marginBottom: 8 }}>Token Usage</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <StatBadge label="Input" value={fmt(stats.totalInputTokens)} />
          <StatBadge label="Output" value={fmt(stats.totalOutputTokens)} />
          <StatBadge label="Total" value={fmt(stats.totalTokens)} />
        </div>
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
