import React, { useState, useEffect } from "react";
import type { Api } from "./api";
import { RunStatusBadge } from "./RunStatusBadge";
import type { GetRunResponse } from "@aerograph/contracts";

export interface ForkResumeModalProps {
  api: Api;
  baseTraceId: string;
  forkFromSpanId: string;
  initialPromptText?: string;
  onClose: () => void;
  onForkCompleted: (childTraceId: string, parentTraceId: string) => void;
}

export function ForkResumeModal({
  api,
  baseTraceId,
  forkFromSpanId,
  initialPromptText,
  onClose,
  onForkCompleted
}: ForkResumeModalProps): JSX.Element {
  const [promptOverride, setPromptOverride] = useState(initialPromptText || "");
  const [customConfig, setCustomConfig] = useState("");
  const [activeConfigCommand, setActiveConfigCommand] = useState<string | null>(null);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [executionMode, setExecutionMode] = useState<"fork" | "record">("fork");
  const [manualOnly, setManualOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [childTraceId, setChildTraceId] = useState<string | null>(null);
  const [manualGeneratedId, setManualGeneratedId] = useState<string | null>(null);
  const [runtimeMeta, setRuntimeMeta] = useState<{
    traceId?: string;
    projectRoot?: string;
    virtualEnv?: string | null;
    executablePath?: string | null;
    entrypoint?: string | null;
    command?: string[] | null;
    cassetteRunId?: string | null;
    hasCassette?: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadMetaAndConfig() {
      try {
        const [metaRes, configRes] = await Promise.all([
          api.getRuntimeMetadata(baseTraceId).catch(() => null),
          api.getProjectConfig().catch(() => ({ config: null }))
        ]);

        if (cancelled) return;

        if (metaRes) {
          setRuntimeMeta(metaRes);
          // Auto-select "record" if the parent trace has no cassette recorded on disk
          if (metaRes.hasCassette === false) {
            setExecutionMode("record");
          } else {
            setExecutionMode("fork");
          }
        }

        if (configRes?.config?.command) {
          const cmdStr = Array.isArray(configRes.config.command)
            ? configRes.config.command.join(" ")
            : String(configRes.config.command);
          setActiveConfigCommand(cmdStr);
        } else if (metaRes?.command && metaRes.command.length > 0) {
          setActiveConfigCommand(metaRes.command.join(" "));
        } else {
          setShowConfigEditor(true);
        }
      } catch {
        if (!cancelled) setShowConfigEditor(true);
      }
    }
    loadMetaAndConfig();
    return () => {
      cancelled = true;
    };
  }, [api, baseTraceId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (manualOnly) {
        const res = await api.forkTrace(baseTraceId, {
          forkFromSpanId,
          overrides: promptOverride.trim() ? { promptText: promptOverride.trim() } : undefined
        });
        setManualGeneratedId(res.traceId);
      } else {
        const overrides = promptOverride.trim() ? { promptText: promptOverride.trim() } : undefined;
        let commandOption: string[] | undefined;
        let yamlOption: string | undefined;

        const trimmedConfig = customConfig.trim();
        if (trimmedConfig) {
          if (trimmedConfig.includes("command:") || trimmedConfig.includes("version:") || trimmedConfig.includes("\n")) {
            yamlOption = trimmedConfig;
          } else {
            commandOption = trimmedConfig.split(/\s+/);
          }
        }

        const res = await api.forkAndResume(baseTraceId, forkFromSpanId, overrides, {
          command: commandOption,
          projectConfigYaml: yamlOption,
          projectRoot: runtimeMeta?.projectRoot,
          virtualEnv: runtimeMeta?.virtualEnv ?? undefined,
          executablePath: runtimeMeta?.executablePath ?? undefined,
          mode: executionMode
        });
        setChildTraceId(res.childTraceId);
        setActiveRunId(res.runId);
      }
    } catch (err: any) {
      setError(err?.message || "Fork failed");
    } finally {
      setLoading(false);
    }
  };

  const handleCompleted = (_run: GetRunResponse) => {
    if (childTraceId) {
      onForkCompleted(childTraceId, baseTraceId);
      onClose();
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        backdropFilter: "blur(3px)"
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#1e293b",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: "8px",
          width: "520px",
          maxWidth: "92vw",
          padding: "22px",
          boxShadow: "0 20px 30px -5px rgba(0, 0, 0, 0.55)",
          color: "#f8fafc"
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>⑂ Fork & Resume Execution</h3>
          <button
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "16px" }}
          >
            ✕
          </button>
        </div>

        <div style={{ fontSize: "12px", color: "#94a3b8", marginBottom: "16px", lineHeight: "1.5" }}>
          Fork this trace from span <code style={{ color: "#38bdf8", backgroundColor: "rgba(56, 189, 248, 0.1)", padding: "2px 5px", borderRadius: "3px" }}>{forkFromSpanId}</code>. Pre-fork steps are deterministically replayed from cassette, and subsequent steps execute live.
        </div>

        {manualGeneratedId ? (
          <div>
            <div style={{ padding: "12px", background: "rgba(34, 197, 94, 0.1)", border: "1px solid rgba(34, 197, 94, 0.3)", borderRadius: "6px", marginBottom: "14px" }}>
              <div style={{ color: "#22c55e", fontWeight: 600, fontSize: "13px", marginBottom: "6px" }}>✓ Fork ID Generated</div>
              <div style={{ fontSize: "12px", wordBreak: "break-all", fontFamily: "monospace" }}>{manualGeneratedId}</div>
            </div>
            <button
              onClick={() => {
                onForkCompleted(manualGeneratedId, baseTraceId);
                onClose();
              }}
              style={{
                width: "100%",
                padding: "8px",
                backgroundColor: "#2563eb",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: "pointer",
                fontWeight: 500
              }}
            >
              Switch to Child Trace
            </button>
          </div>
        ) : activeRunId ? (
          <div style={{ textAlign: "center", padding: "16px" }}>
            <div style={{ marginBottom: "12px", fontSize: "13px", color: "#94a3b8" }}>
              Executing replayed and resumed run...
            </div>
            <RunStatusBadge api={api} runId={activeRunId} onCompleted={handleCompleted} />
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "6px", color: "#cbd5e1" }}>
                Prompt Override (Optional)
              </label>
              <textarea
                value={promptOverride}
                onChange={(e) => setPromptOverride(e.target.value)}
                placeholder="Enter alternative prompt or instructions for the agent to resume with..."
                rows={3}
                style={{
                  width: "100%",
                  backgroundColor: "#0f172a",
                  border: "1px solid #334155",
                  borderRadius: "6px",
                  padding: "8px 10px",
                  color: "#f8fafc",
                  fontSize: "12px",
                  fontFamily: "inherit",
                  resize: "vertical",
                  boxSizing: "border-box"
                }}
              />
            </div>

            {/* Execution Strategy Selection */}
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "6px", color: "#cbd5e1" }}>
                Execution Strategy
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                {/* Option 1: Replay & Fork */}
                <div
                  onClick={() => setExecutionMode("fork")}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "6px",
                    border: `1px solid ${executionMode === "fork" ? "#38bdf8" : "#334155"}`,
                    backgroundColor: executionMode === "fork" ? "rgba(56, 189, 248, 0.1)" : "#0f172a",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: executionMode === "fork" ? "#38bdf8" : "#e2e8f0" }}>
                      ⚡ Replay & Fork
                    </span>
                    <input
                      type="radio"
                      name="exec-mode"
                      checked={executionMode === "fork"}
                      onChange={() => setExecutionMode("fork")}
                      style={{ cursor: "pointer", accentColor: "#38bdf8" }}
                    />
                  </div>
                  <div style={{ fontSize: "11px", color: "#94a3b8", lineHeight: "1.4" }}>
                    Replay pre-fork steps from cassette (0ms, $0.00). Overridden prompt & subsequent steps run live.
                  </div>
                  {runtimeMeta?.hasCassette && (
                    <span style={{ fontSize: "10px", color: "#4ade80", fontWeight: 500, marginTop: "2px" }}>
                      ✓ Cassette available
                    </span>
                  )}
                </div>

                {/* Option 2: Record as New Baseline */}
                <div
                  onClick={() => setExecutionMode("record")}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "6px",
                    border: `1px solid ${executionMode === "record" ? "#a855f7" : "#334155"}`,
                    backgroundColor: executionMode === "record" ? "rgba(168, 85, 247, 0.1)" : "#0f172a",
                    cursor: "pointer",
                    transition: "all 0.15s ease",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, color: executionMode === "record" ? "#c084fc" : "#e2e8f0" }}>
                      ⏺ Record as Baseline
                    </span>
                    <input
                      type="radio"
                      name="exec-mode"
                      checked={executionMode === "record"}
                      onChange={() => setExecutionMode("record")}
                      style={{ cursor: "pointer", accentColor: "#a855f7" }}
                    />
                  </div>
                  <div style={{ fontSize: "11px", color: "#94a3b8", lineHeight: "1.4" }}>
                    Runs through recorder proxy and saves a complete new cassette. All future forks are 100% cached.
                  </div>
                  {!runtimeMeta?.hasCassette && (
                    <span style={{ fontSize: "10px", color: "#facc15", fontWeight: 500, marginTop: "2px" }}>
                      ★ Recommended (no parent cassette)
                    </span>
                  )}
                </div>
              </div>

              {/* Advisory note when no cassette exists */}
              {!runtimeMeta?.hasCassette && executionMode === "record" && (
                <div style={{ marginTop: "8px", padding: "8px 10px", backgroundColor: "rgba(168, 85, 247, 0.08)", border: "1px solid rgba(168, 85, 247, 0.25)", borderRadius: "5px", fontSize: "11px", color: "#e9d5ff", lineHeight: "1.4" }}>
                  💡 <strong>Recommendation</strong>: The parent trace was run directly without a proxy recorder cassette. Recording this run will generate a new cassette so all future replays/forks will show <strong>⚡ CACHE</strong>.
                </div>
              )}

              {!runtimeMeta?.hasCassette && executionMode === "fork" && (
                <div style={{ marginTop: "8px", padding: "8px 10px", backgroundColor: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", borderRadius: "5px", fontSize: "11px", color: "#fef3c7", lineHeight: "1.4" }}>
                  ⚠️ <strong>Notice</strong>: The parent trace has no recorded cassette. Replaying will fall back to live network for all steps. Switch to <strong>Record as Baseline</strong> to create a reusable cassette.
                </div>
              )}
            </div>

            {/* Recorded Execution Environment Card */}
            {runtimeMeta && (runtimeMeta.projectRoot || runtimeMeta.virtualEnv) && (
              <div
                style={{
                  background: "rgba(15, 23, 42, 0.7)",
                  border: "1px solid rgba(56, 189, 248, 0.25)",
                  borderRadius: "6px",
                  padding: "10px 12px",
                  fontSize: "11px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px"
                }}
              >
                <div style={{ fontWeight: 600, color: "#38bdf8", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>🔍</span>
                  <span>Recorded Execution Environment</span>
                </div>
                {runtimeMeta.projectRoot && (
                  <div style={{ color: "#94a3b8", display: "flex", gap: "6px", alignItems: "baseline" }}>
                    <span style={{ color: "#cbd5e1", minWidth: "80px" }}>📁 Working Dir:</span>
                    <code style={{ color: "#e2e8f0", fontFamily: "monospace", wordBreak: "break-all" }}>
                      {runtimeMeta.projectRoot}
                    </code>
                  </div>
                )}
                {runtimeMeta.virtualEnv && (
                  <div style={{ color: "#94a3b8", display: "flex", gap: "6px", alignItems: "baseline" }}>
                    <span style={{ color: "#cbd5e1", minWidth: "80px" }}>🐍 Virtual Env:</span>
                    <code style={{ color: "#4ade80", fontFamily: "monospace", wordBreak: "break-all" }}>
                      {runtimeMeta.virtualEnv}
                    </code>
                  </div>
                )}
                {runtimeMeta.command && runtimeMeta.command.length > 0 && (
                  <div style={{ color: "#94a3b8", display: "flex", gap: "6px", alignItems: "baseline" }}>
                    <span style={{ color: "#cbd5e1", minWidth: "80px" }}>⚡ Command:</span>
                    <code style={{ color: "#facc15", fontFamily: "monospace", wordBreak: "break-all" }}>
                      {runtimeMeta.command.join(" ")}
                    </code>
                  </div>
                )}
              </div>
            )}

            {/* Config & Command section */}
            <div style={{ background: "rgba(15, 23, 42, 0.6)", border: "1px solid #334155", borderRadius: "6px", padding: "10px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: showConfigEditor ? "8px" : "0" }}>
                <div style={{ fontSize: "12px", fontWeight: 500, color: "#cbd5e1", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>⚙️</span>
                  <span>Agent Command / Project Binding</span>
                </div>
                {activeConfigCommand && (
                  <button
                    type="button"
                    onClick={() => setShowConfigEditor(!showConfigEditor)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#38bdf8",
                      fontSize: "11px",
                      cursor: "pointer",
                      textDecoration: "underline"
                    }}
                  >
                    {showConfigEditor ? "Hide Editor" : "Change Command / YAML"}
                  </button>
                )}
              </div>

              {activeConfigCommand && !showConfigEditor ? (
                <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "4px" }}>
                  Bound command: <code style={{ color: "#38bdf8", fontFamily: "monospace" }}>{activeConfigCommand}</code>
                </div>
              ) : (
                <div style={{ marginTop: "6px" }}>
                  <div style={{ fontSize: "11px", color: "#94a3b8", marginBottom: "6px" }}>
                    Enter a command (e.g. <code>uv run agent.py</code>) or paste full <code>aerograph.project.yaml</code>. It will be stored and bound automatically.
                  </div>
                  <textarea
                    value={customConfig}
                    onChange={(e) => setCustomConfig(e.target.value)}
                    placeholder={`e.g. uv run agent.py\n\n# OR paste YAML content:\ncommand:\n  - uv\n  - run\n  - agent.py`}
                    rows={4}
                    style={{
                      width: "100%",
                      backgroundColor: "#020617",
                      border: "1px solid #475569",
                      borderRadius: "4px",
                      padding: "8px",
                      color: "#f8fafc",
                      fontSize: "12px",
                      fontFamily: "monospace",
                      resize: "vertical",
                      boxSizing: "border-box"
                    }}
                  />
                </div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="checkbox"
                id="manual-mode-chk"
                checked={manualOnly}
                onChange={(e) => setManualOnly(e.target.checked)}
              />
              <label htmlFor="manual-mode-chk" style={{ fontSize: "12px", color: "#94a3b8", cursor: "pointer" }}>
                Generate Fork ID only (manual terminal resume)
              </label>
            </div>

            {error && (
              <div style={{ color: "#ef4444", fontSize: "12px", backgroundColor: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "4px", padding: "8px 10px" }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "4px" }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "6px 12px",
                  backgroundColor: "transparent",
                  border: "1px solid #475569",
                  borderRadius: "6px",
                  color: "#cbd5e1",
                  cursor: "pointer",
                  fontSize: "12px"
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                style={{
                  padding: "6px 16px",
                  backgroundColor: executionMode === "record" ? "#9333ea" : "#2563eb",
                  border: "none",
                  borderRadius: "6px",
                  color: "white",
                  cursor: loading ? "not-allowed" : "pointer",
                  fontSize: "12px",
                  fontWeight: 500,
                  transition: "background-color 0.15s ease"
                }}
              >
                {loading
                  ? "Launching..."
                  : manualOnly
                  ? "Generate Fork ID"
                  : executionMode === "record"
                  ? "⏺ Record & Resume"
                  : "⚡ Replay Cache & Fork"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
