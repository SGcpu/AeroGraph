import React, { useState } from "react";
import type { Api } from "./api";
import { RunStatusBadge } from "./RunStatusBadge";
import { HumanInputModal } from "./HumanInputModal";
import type { GetRunResponse } from "@aerograph/contracts";

export interface ReplayControlPanelProps {
  api: Api;
  activeTraceId: string | null;
  projectId?: string;
  hasCassette?: boolean;
  onTraceReplayed?: (newTraceId: string) => void;
}

export function ReplayControlPanel({
  api,
  activeTraceId,
  projectId,
  hasCassette = true,
  onTraceReplayed
}: ReplayControlPanelProps): JSX.Element {
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRecord = async () => {
    setLoading(true);
    setError(null);
    try {
      let opts: {
        command?: string[];
        projectRoot?: string;
        virtualEnv?: string | null;
        executablePath?: string | null;
      } | undefined;
      if (activeTraceId) {
        const meta = await api.getRuntimeMetadata(activeTraceId);
        if (meta && (meta.command?.length || meta.projectRoot)) {
          opts = {
            command: meta.command ?? undefined,
            projectRoot: meta.projectRoot ?? undefined,
            virtualEnv: meta.virtualEnv ?? undefined,
            executablePath: meta.executablePath ?? undefined
          };
        }
      }
      if (!opts && projectId) {
        const cfg = await api.getProjectConfig(projectId);
        if (cfg?.projectRoot || cfg?.config?.command) {
          opts = {
            projectRoot: cfg.projectRoot,
            command: cfg.config?.command
          };
        }
      }
      const res = await api.startRecordRun(opts);
      setActiveRunId(res.runId);
    } catch (err: any) {
      setError(err.message || "Failed to start record run (configure project command in Settings first)");
    } finally {
      setLoading(false);
    }
  };

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

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <button
        onClick={handleRecord}
        disabled={loading}
        title="Run and record configured project agent into a new deterministic cassette"
        style={{
          padding: "5px 12px",
          backgroundColor: "#dc2626",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: loading ? "wait" : "pointer",
          fontSize: "13px",
          fontWeight: 500,
          display: "flex",
          alignItems: "center",
          gap: "6px"
        }}
      >
        <span>●</span>
        <span>{loading ? "Starting..." : "Record Run"}</span>
      </button>

      {activeTraceId && (
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
      )}

      {activeRunId && (
        <RunStatusBadge
          api={api}
          runId={activeRunId}
          onCompleted={handleRunCompleted}
        />
      )}

      <HumanInputModal api={api} runId={activeRunId} />

      {error && (
        <span style={{ color: "#dc2626", fontSize: "12px" }}>
          {error}
        </span>
      )}
    </div>
  );
}
