import React from "react";

export type GlobalFilterBarProps = {
  projectId: string;
  environment: string;
  onFilterChange: (filters: { projectId: string; environment: string }) => void;
  onClearProject?: () => void;
};

export function GlobalFilterBar({ projectId, environment, onFilterChange, onClearProject }: GlobalFilterBarProps) {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      alignItems: "stretch",
      padding: "8px 12px",
      background: "var(--bg-surface)",
      borderBottom: "1px solid var(--border-subtle)"
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-sans)" }}>Project:</label>
        <input 
          type="text" 
          placeholder="All projects"
          value={projectId}
          onChange={(e) => onFilterChange({ projectId: e.target.value, environment })}
          style={{
            padding: "4px 8px",
            borderRadius: "4px",
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            fontSize: "12px",
            outline: "none",
            width: "120px"
          }}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <label style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "var(--font-sans)" }}>Environment:</label>
        <input 
          type="text" 
          placeholder="All environments"
          value={environment}
          onChange={(e) => onFilterChange({ projectId, environment: e.target.value })}
          style={{
            padding: "4px 8px",
            borderRadius: "4px",
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-base)",
            color: "var(--text-primary)",
            fontSize: "12px",
            outline: "none",
            width: "120px"
          }}
        />
      </div>
      {onClearProject && (
        <button 
          onClick={onClearProject}
          style={{
            marginTop: "4px",
            padding: "4px 8px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "4px",
            color: "var(--text-primary)",
            fontSize: "11px",
            cursor: "pointer"
          }}
        >
          ← Back to Projects
        </button>
      )}
    </div>
  );
}
