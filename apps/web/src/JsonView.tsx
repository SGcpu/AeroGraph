import { useState } from "react";

export function JsonView({ data, maxLines = 10 }: { data: any; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);

  if (data === undefined) return null;

  // Serialize the data. When collapsed, truncate large strings/arrays for perf.
  const fullStr =
    typeof data === "string"
      ? data
      : JSON.stringify(data, null, 2);

  const collapsedStr =
    typeof data === "string"
      ? data
      : JSON.stringify(
          data,
          (_k, v) => {
            if (Array.isArray(v) && v.length > 50) return `[Array(${v.length})]`;
            if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "...";
            return v;
          },
          2,
        );

  const activeStr = expanded ? fullStr : collapsedStr;
  const lines = activeStr.split("\n");
  const needsTruncation = !expanded && lines.length > maxLines;
  const displayText = needsTruncation
    ? lines.slice(0, maxLines).join("\n") + "\n..."
    : activeStr;

  return (
    <div style={{ position: "relative" }}>
      <pre
        className="code-block"
        style={{
          margin: 0,
          padding: 10,
          overflow: needsTruncation ? "hidden" : "auto",
          maxHeight: expanded ? "60vh" : undefined,
          overflowY: expanded ? "auto" : undefined,
        }}
      >
        {displayText}
      </pre>

      {needsTruncation && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            position: "absolute",
            bottom: 8,
            right: 8,
            fontSize: 10,
            background: "var(--accent)",
            border: "none",
            color: "#fff",
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: 4,
          }}
        >
          Expand ({lines.length - maxLines} more lines)
        </button>
      )}

      {expanded && (
        <button
          onClick={() => setExpanded(false)}
          style={{
            position: "absolute",
            bottom: 8,
            right: 8,
            fontSize: 10,
            background: "rgba(255,255,255,0.1)",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: 4,
          }}
        >
          Collapse
        </button>
      )}
    </div>
  );
}
