import React, { useEffect, useState } from "react";
import type { Api } from "./api";
import type { GetRunResponse, RunStatus } from "@aerograph/contracts";

export interface RunStatusBadgeProps {
  api: Api;
  runId: string;
  onCompleted?: (run: GetRunResponse) => void;
}

export function RunStatusBadge({ api, runId, onCompleted }: RunStatusBadgeProps): JSX.Element {
  const [run, setRun] = useState<GetRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: any = null;
    let isMounted = true;

    async function checkStatus() {
      try {
        const data = await api.getRun(runId);
        if (!isMounted) return;
        setRun(data);

        if (data.status === "completed" || data.status === "failed" || data.status === "crashed") {
          if (data.status === "completed" && onCompleted) {
            onCompleted(data);
          }
          return;
        }

        timer = setTimeout(checkStatus, 2000);
      } catch (err: any) {
        if (!isMounted) return;
        setError(err.message || String(err));
      }
    }

    checkStatus();

    return () => {
      isMounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, runId, onCompleted]);

  if (error) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "2px 8px",
          borderRadius: "12px",
          fontSize: "12px",
          backgroundColor: "#fee2e2",
          color: "#991b1b"
        }}
        title={error}
      >
        ⚠️ Error polling run
      </span>
    );
  }

  if (!run) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          padding: "2px 8px",
          borderRadius: "12px",
          fontSize: "12px",
          backgroundColor: "#f3f4f6",
          color: "#4b5563"
        }}
      >
        ⏳ Initializing...
      </span>
    );
  }

  const statusColors: Record<RunStatus, { bg: string; text: string; icon: string }> = {
    pending: { bg: "#fef3c7", text: "#92400e", icon: "⏳" },
    running: { bg: "#dbeafe", text: "#1e40af", icon: "⚙️" },
    completed: { bg: "#dcfce7", text: "#166534", icon: "✓" },
    failed: { bg: "#fee2e2", text: "#991b1b", icon: "✗" },
    crashed: { bg: "#fee2e2", text: "#7f1d1d", icon: "💥" }
  };

  const styleConfig = statusColors[run.status] || { bg: "#f3f4f6", text: "#374151", icon: "•" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "2px 10px",
        borderRadius: "12px",
        fontSize: "12px",
        fontWeight: 500,
        backgroundColor: styleConfig.bg,
        color: styleConfig.text
      }}
      title={run.errorMessage || `Mode: ${run.mode}, Run: ${run.runId}`}
    >
      <span>{styleConfig.icon}</span>
      <span style={{ textTransform: "capitalize" }}>{run.status}</span>
      {run.status === "running" && (
        <span style={{ fontSize: "10px", opacity: 0.8 }}>(live)</span>
      )}
    </span>
  );
}
