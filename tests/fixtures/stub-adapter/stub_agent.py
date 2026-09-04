"""
Stub agent demonstrating framework-agnostic telemetry emission.
Emits canonical TraceEvent events using aerograph_sdk.FlightRecorder.
Crucially contains zero replay-specific imports or logic; deterministic replay
is inherited automatically via AeroGraph proxy and cassette infrastructure.
"""

import sys
import json
import urllib.request
from aerograph_sdk.recorder import FlightRecorder

def run_agent():
    recorder = FlightRecorder(
        endpoint="http://localhost:4317",
        project_id="stub-project",
        actor={"kind": "agent", "id": "stub-agent-1", "name": "StubAgent"}
    )

    # 1. Prompt event
    prompt_span_id = "span-prompt-1"
    recorder.emit(
        kind="prompt",
        span_id=prompt_span_id,
        payload={"text": "Explain deterministic replay"}
    )

    # 2. Tool call event
    tool_span_id = "span-tool-1"
    recorder.emit(
        kind="tool_call",
        span_id=tool_span_id,
        parent_span_id=prompt_span_id,
        payload={"tool_name": "web_search", "query": "deterministic replay definition"}
    )

    # Simulated external tool execution / HTTP request
    try:
        req = urllib.request.Request("http://127.0.0.1:4317/v1/health")
        with urllib.request.urlopen(req, timeout=1) as resp:
            data = resp.read().decode("utf-8")
    except Exception as e:
        data = f"Simulated mock response: {e}"

    # 3. Tool result event
    recorder.emit(
        kind="tool_result",
        span_id=f"{tool_span_id}-result",
        parent_span_id=tool_span_id,
        payload={"result": data}
    )

    # 4. Final Response event
    recorder.emit(
        kind="response",
        span_id="span-resp-1",
        parent_span_id=prompt_span_id,
        payload={"text": "Deterministic replay captures and reproduces exact execution states."}
    )

    recorder.flush()

if __name__ == "__main__":
    run_agent()
