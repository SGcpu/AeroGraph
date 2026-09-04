import React, { useState } from "react";
import type { Api } from "./api";
import { RunStatusBadge } from "./RunStatusBadge";
import type { GetRunResponse } from "@aerograph/contracts";

export interface ReplayControlPanelProps {
  api: Api;
  activeTraceId: string | null;
  hasCassette?: boolean;
  onTraceReplayed?: (newTraceId: string) => void;
}

export function ReplayControlPanel({
  api,
  activeTraceId,
  hasCassette = true,
  onTraceReplayed
}: ReplayControlPanelProps): JSX.Element {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReplay = async () => {
    if (!activeTraceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.replayTrace(activeTraceId);
      setActiveRunId(res.runId);
    } catch (err: any) {
      setError(err.message || "Failed to start replay");
    } finally {
      setLoading(false);
    }
  };

  const handleRunCompleted = (run: GetRunResponse) => {
    if (onTraceReplayed && run.traceId) {
      onTraceReplayed(run.traceId);
    }
  };

  if (!activeTraceId) {
    return <></>;
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <button
        onClick={handleReplay}
        disabled={loading || !hasCassette}
        title={!hasCassette ? "No cassette linked for this trace. Run must be recorded first." : "Replay trace deterministically from cassette"}
        style={{
          padding: "5px 12px",
          backgroundColor: hasCassette ? "#2563eb" : "#9ca3af",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: hasCassette ? "pointer" : "not-allowed",
          fontSize: "13px",
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: "6px"
        }}
      >
        <span>▶</span>
        <span>{loading ? "Starting..." : "Replay Trace"}</span>
      </button>

      {activeRunId && (
        <RunStatusBadge
          api={api}
          runId={activeRunId}
          onCompleted={handleRunCompleted}
        />
      )}

      {error && (
        <span style={{ color: "#dc2626", fontSize: "12px" }}>
          {error}
        </span>
      )}
    </div>
  );
}
