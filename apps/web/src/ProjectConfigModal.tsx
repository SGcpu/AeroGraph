import { useState, useEffect } from "react";
import type { Api } from "./api";

export interface ProjectConfigModalProps {
  api: Api;
  onClose: () => void;
}

export function ProjectConfigModal({ api, onClose }: ProjectConfigModalProps): JSX.Element {
  const [configContent, setConfigContent] = useState("");
  const [activeCommand, setActiveCommand] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.getProjectConfig();
        if (!cancelled && res?.config) {
          if (res.config.command && Array.isArray(res.config.command)) {
            setActiveCommand(res.config.command.join(" "));
            setConfigContent(
              `version: "1"\ncommand:\n${res.config.command.map((c: string) => `  - "${c}"`).join("\n")}\n`
            );
          }
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMessage(null);

    const trimmed = configContent.trim();
    if (!trimmed) {
      setStatusMessage({ text: "Please enter a command or paste aerograph.project.yaml content.", type: "error" });
      setSaving(false);
      return;
    }

    try {
      let payload: { command?: string[]; yamlContent?: string };
      if (trimmed.includes("command:") || trimmed.includes("version:") || trimmed.includes("\n")) {
        payload = { yamlContent: trimmed };
      } else {
        payload = { command: trimmed.split(/\s+/) };
      }

      const res = await api.saveProjectConfig(payload);
      setStatusMessage({ text: `✓ Configuration saved and bound to project (${res.path || ".aerograph"})`, type: "success" });
      // Reload config
      const refreshed = await api.getProjectConfig();
      if (refreshed?.config?.command) {
        setActiveCommand(Array.isArray(refreshed.config.command) ? refreshed.config.command.join(" ") : String(refreshed.config.command));
      }
    } catch (err: any) {
      setStatusMessage({ text: err.message || "Failed to save project configuration.", type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleSetPreset = (cmd: string) => {
    const parts = cmd.trim().split(/\s+/);
    setConfigContent(
      `version: "1"\ncommand:\n${parts.map((c) => `  - "${c}"`).join("\n")}\n`
    );
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
        zIndex: 10000,
        backdropFilter: "blur(4px)"
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: "#1e293b",
          border: "1px solid rgba(255, 255, 255, 0.12)",
          borderRadius: "10px",
          width: "560px",
          maxWidth: "92vw",
          padding: "24px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
          color: "#f8fafc",
          display: "flex",
          flexDirection: "column",
          gap: "16px"
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600, color: "#f8fafc" }}>
              ⚙️ Project Agent Configuration
            </h3>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
              Configure or paste your agent execution command without manually managing YAML files.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#94a3b8",
              cursor: "pointer",
              fontSize: "18px",
              padding: "4px"
            }}
          >
            ✕
          </button>
        </div>

        {/* Current status pill */}
        <div
          style={{
            padding: "10px 14px",
            backgroundColor: activeCommand ? "rgba(34, 197, 94, 0.1)" : "rgba(245, 158, 11, 0.1)",
            border: `1px solid ${activeCommand ? "rgba(34, 197, 94, 0.25)" : "rgba(245, 158, 11, 0.25)"}`,
            borderRadius: "6px",
            fontSize: "12px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "14px" }}>{activeCommand ? "●" : "○"}</span>
            <span>
              {activeCommand ? (
                <span>
                  Active Command: <code style={{ color: "#38bdf8", fontFamily: "monospace" }}>{activeCommand}</code>
                </span>
              ) : (
                <span style={{ color: "#f59e0b" }}>No agent command bound to project yet</span>
              )}
            </span>
          </div>
        </div>

        {/* Quick Presets */}
        <div>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
            Quick Presets
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => handleSetPreset("python examples/openrouter-langgraph-py/agent.py")}
              style={{
                fontSize: "11px",
                padding: "4px 8px",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: "4px",
                color: "#e2e8f0",
                cursor: "pointer"
              }}
            >
              Python Example: <code style={{ color: "#38bdf8" }}>python examples/openrouter-langgraph-py/agent.py</code>
            </button>
            <button
              type="button"
              onClick={() => handleSetPreset("uv run agent.py")}
              style={{
                fontSize: "11px",
                padding: "4px 8px",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: "4px",
                color: "#e2e8f0",
                cursor: "pointer"
              }}
            >
              Python: <code style={{ color: "#38bdf8" }}>uv run agent.py</code>
            </button>
            <button
              type="button"
              onClick={() => handleSetPreset("npm run start")}
              style={{
                fontSize: "11px",
                padding: "4px 8px",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: "4px",
                color: "#e2e8f0",
                cursor: "pointer"
              }}
            >
              TypeScript: <code style={{ color: "#38bdf8" }}>npm run start</code>
            </button>
            <button
              type="button"
              onClick={() => handleSetPreset("npx tsx agent.ts")}
              style={{
                fontSize: "11px",
                padding: "4px 8px",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.15)",
                borderRadius: "4px",
                color: "#e2e8f0",
                cursor: "pointer"
              }}
            >
              TypeScript: <code style={{ color: "#38bdf8" }}>npx tsx agent.ts</code>
            </button>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 500, marginBottom: "6px", color: "#cbd5e1" }}>
              Agent Command or aerograph.project.yaml:
            </label>
            <textarea
              value={configContent}
              onChange={(e) => setConfigContent(e.target.value)}
              placeholder={`Enter command or paste YAML:\n\nuv run agent.py\n\n# OR paste YAML content:\nversion: "1"\ncommand:\n  - uv\n  - run\n  - agent.py`}
              rows={7}
              style={{
                width: "100%",
                backgroundColor: "#0f172a",
                border: "1px solid #334155",
                borderRadius: "6px",
                padding: "10px 12px",
                color: "#f8fafc",
                fontSize: "12px",
                fontFamily: "monospace",
                resize: "vertical",
                boxSizing: "border-box",
                lineHeight: "1.4"
              }}
            />
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "4px" }}>
              * You can enter a single line (e.g. <code>uv run agent.py</code>) or paste full YAML. It will be stored in <code>.aerograph/aerograph.project.yaml</code> automatically.
            </div>
          </div>

          {statusMessage && (
            <div
              style={{
                fontSize: "12px",
                color: statusMessage.type === "success" ? "#22c55e" : "#ef4444",
                padding: "8px 12px",
                borderRadius: "6px",
                backgroundColor: statusMessage.type === "success" ? "rgba(34, 197, 94, 0.1)" : "rgba(239, 68, 68, 0.1)"
              }}
            >
              {statusMessage.text}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "6px 14px",
                backgroundColor: "transparent",
                border: "1px solid #475569",
                borderRadius: "6px",
                color: "#cbd5e1",
                cursor: "pointer",
                fontSize: "12px"
              }}
            >
              Close
            </button>
            <button
              type="submit"
              disabled={saving || loading}
              style={{
                padding: "6px 16px",
                backgroundColor: "#2563eb",
                border: "none",
                borderRadius: "6px",
                color: "white",
                cursor: saving || loading ? "not-allowed" : "pointer",
                fontSize: "12px",
                fontWeight: 500
              }}
            >
              {saving ? "Saving..." : "Save & Bind to Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
