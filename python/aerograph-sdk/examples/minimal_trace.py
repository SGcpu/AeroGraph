"""
python/aerograph-sdk/examples/minimal_trace.py

Minimal runnable example demonstrating the AeroGraph Python SDK.

Usage:
    # Start the collector first:
    #   npm run dev -w apps-collector (from repo root)

    cd python/aerograph-sdk
    pip install -e .
    python examples/minimal_trace.py

Expected output:
    [AeroGraph] Trace ID: t_...
    [AeroGraph] Emitted prompt   → s_...
    [AeroGraph] Emitted response → s_...
    [AeroGraph] Done. View trace at: http://localhost:5173/traces/t_...
"""

from __future__ import annotations

import sys

from aerograph_sdk import FlightRecorder

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

COLLECTOR_URL = "http://localhost:4317"
ACTOR = {"id": "demo-agent", "name": "Demo Agent"}


def run() -> None:
    recorder = FlightRecorder(
        endpoint=COLLECTOR_URL,
        actor=ACTOR,
    )
    print(f"[AeroGraph] Trace ID: {recorder.trace_id}")

    # --- Emit a minimal prompt/response trace ---
    root_span = recorder.new_span_id()

    try:
        prompt_event = recorder.prompt(
            parent_span_id=None,
            span_id=root_span,
            text="What is AeroGraph?",
            title="User query",
        )
        print(f"[AeroGraph] Emitted prompt   → {prompt_event.spanId}")

        response_event = recorder.response(
            parent_span_id=root_span,
            text=(
                "AeroGraph is an open-source flight recorder for AI agent workflows. "
                "It captures every prompt, response, tool call, and handoff as a "
                "structured trace you can visualize and inspect."
            ),
            title="Agent response",
        )
        print(f"[AeroGraph] Emitted response → {response_event.spanId}")

        # --- Emit a tool call + result ---
        tool_call_event = recorder.tool_call(
            parent_span_id=root_span,
            tool_id="search-tool",
            tool_name="SearchTool",
            input={"query": "AeroGraph observability"},
        )
        print(f"[AeroGraph] Emitted tool_call → {tool_call_event.spanId}")

        recorder.tool_result(
            parent_span_id=tool_call_event.spanId,
            tool_id="search-tool",
            tool_name="SearchTool",
            output={"results": ["result1", "result2"]},
        )
        print("[AeroGraph] Emitted tool_result")

        # --- Emit a state snapshot with hash ---
        full_state = {"question": "What is AeroGraph?", "step": 1, "complete": True}
        snap_event = recorder.state_snapshot(
            parent_span_id=root_span,
            node_name="answerNode",
            full_state=full_state,
        )
        print(
            f"[AeroGraph] Emitted state_snapshot (hash={snap_event.payload.stateHash})"
        )

        print(
            f"\n[AeroGraph] Done. View trace at: http://localhost:5173/traces/{recorder.trace_id}"
        )

    except Exception as e:
        print(f"[AeroGraph] Error: {e}", file=sys.stderr)
        print(
            "[AeroGraph] Is the collector running? "
            "Start it with: npm run dev -w apps-collector",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    run()
