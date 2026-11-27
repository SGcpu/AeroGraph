import React, { useState, useEffect } from "react";
import type { Api } from "./api";

export interface HumanInputModalProps {
  api: Api;
  runId: string | null;
}

export function HumanInputModal({ api, runId }: HumanInputModalProps): JSX.Element | null {
  const [waitingState, setWaitingState] = useState<{
    waiting: boolean;
    turn: number | null;
    prompt: string | null;
  }>({ waiting: false, turn: null, prompt: null });
  const [reply, setReply] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!runId) {
      setWaitingState({ waiting: false, turn: null, prompt: null });
      return;
    }
    let cancelled = false;
    const poll = async () => {
      const state = await api.getInputWait(runId);
      if (!cancelled) {
        setWaitingState(state);
      }
    };
    void poll();
    const timer = setInterval(poll, 400);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, runId]);

  if (!runId || !waitingState.waiting) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.submitInput(runId, waitingState.turn ?? 0, reply);
      setReply("");
      setWaitingState({ waiting: false, turn: null, prompt: null });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10001,
        backdropFilter: "blur(3px)"
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          backgroundColor: "#1e293b",
          border: "1px solid rgba(59, 130, 246, 0.5)",
          borderRadius: "10px",
          width: "460px",
          maxWidth: "92vw",
          padding: "20px",
          color: "#f8fafc",
          boxShadow: "0 20px 40px rgba(0,0,0,0.5)",
          display: "flex",
          flexDirection: "column",
          gap: "12px"
        }}
      >
        <div style={{ fontSize: "14px", fontWeight: 600, color: "#93c5fd" }}>
          Agent Waiting for Input (Turn {(waitingState.turn ?? 0) + 1})
        </div>
        <div
          style={{
            backgroundColor: "#0f172a",
            padding: "10px 12px",
            borderRadius: "6px",
            fontFamily: "monospace",
            fontSize: "13px",
            color: "#e2e8f0"
          }}
        >
          {waitingState.prompt || "Enter input:"}
        </div>
        <input
          type="text"
          autoFocus
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Type your response..."
          style={{
            padding: "8px 10px",
            borderRadius: "6px",
            border: "1px solid #475569",
            backgroundColor: "#0f172a",
            color: "#f8fafc",
            fontSize: "14px"
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button
            type="submit"
            disabled={submitting}
            style={{
              padding: "7px 14px",
              borderRadius: "6px",
              border: "none",
              backgroundColor: "#2563eb",
              color: "#ffffff",
              fontWeight: 600,
              cursor: submitting ? "wait" : "pointer"
            }}
          >
            {submitting ? "Sending..." : "Send Input"}
          </button>
        </div>
      </form>
    </div>
  );
}
