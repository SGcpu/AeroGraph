import React, { useState, useEffect } from "react";
import type { Api } from "./api";
import { RunStatusBadge } from "./RunStatusBadge";
import type { GetRunResponse } from "@aerograph/contracts";

export interface ForkResumeModalProps {
  api: Api;
  baseTraceId: string;
  forkFromSpanId: string;
  onClose: () => void;
  onForkCompleted: (childTraceId: string, parentTraceId: string) => void;
}

export function ForkResumeModal({
  api,
  baseTraceId,
  forkFromSpanId,
  onClose,
  onForkCompleted
}: ForkResumeModalProps): JSX.Element {
  const [promptOverride, setPromptOverride] = useState("");
  const [customConfig, setCustomConfig] = useState("");
  const [activeConfigCommand, setActiveConfigCommand] = useState<string | null>(null);
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [manualOnly, setManualOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [childTraceId, setChildTraceId] = useState<string | null>(null);
  const [manualGeneratedId, setManualGeneratedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function checkConfig() {
      try {
        const res = await api.getProjectConfig();
        if (!cancelled && res?.config?.command) {
          const cmdStr = Array.isArray(res.config.command)
            ? res.config.command.join(" ")
            : String(res.config.command);
          setActiveConfigCommand(cmdStr);
        } else if (!cancelled) {
          setShowConfigEditor(true);
        }
      } catch {
        if (!cancelled) setShowConfigEditor(true);
      }
    }
    checkConfig();
    return () => {
      cancelled = true;
    };
  }, [api]);

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
          projectConfigYaml: yamlOption
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
                  backgroundColor: "#2563eb",
                  border: "none",
                  borderRadius: "6px",
                  color: "white",
                  cursor: loading ? "not-allowed" : "pointer",
                  fontSize: "12px",
                  fontWeight: 500
                }}
              >
                {loading ? "Launching..." : manualOnly ? "Generate Fork ID" : "Launch Fork & Resume"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
