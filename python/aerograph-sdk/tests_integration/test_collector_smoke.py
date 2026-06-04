"""
python/aerograph-sdk/tests_integration/test_collector_smoke.py

Smoke integration test: emit events from Python SDK and verify retrieval.

Requires a running collector. Skip automatically if collector is not available.

Usage:
    cd python/aerograph-sdk
    pytest tests_integration/ -v --collector-url=http://localhost:4317

Or set AEROGRAPH_COLLECTOR_URL env var.
"""

from __future__ import annotations

import os
import time

import httpx
import pytest

from aerograph_sdk import FlightRecorder, new_trace_id

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

COLLECTOR_URL = os.environ.get("AEROGRAPH_COLLECTOR_URL", "http://localhost:4317")


def is_collector_available() -> bool:
    """Check if the collector is reachable."""
    try:
        response = httpx.get(f"{COLLECTOR_URL}/v1/traces", timeout=2.0)
        return response.is_success
    except Exception:
        return False


requires_collector = pytest.mark.skipif(
    not is_collector_available(),
    reason=f"Collector not available at {COLLECTOR_URL}",
)


# ---------------------------------------------------------------------------
# Smoke tests
# ---------------------------------------------------------------------------


@requires_collector
def test_emit_and_retrieve_trace() -> None:
    """
    Emit a representative set of events and verify they are retrievable.

    Acceptance scenario (from spec.md US1):
    Given the collector is running,
    When a Python application emits valid events for a single trace,
    Then the collector persists them and the trace can be retrieved by trace ID.
    """
    trace_id = new_trace_id()
    recorder = FlightRecorder(
        endpoint=COLLECTOR_URL,
        actor={"id": "smoke-agent", "name": "SmokeTestAgent"},
        trace_id=trace_id,
    )

    # Emit representative events
    root_span = recorder.new_span_id()
    recorder.prompt(parent_span_id=None, span_id=root_span, text="Smoke test prompt")
    recorder.response(parent_span_id=root_span, text="Smoke test response")
    recorder.tool_call(
        parent_span_id=root_span, tool_id="t-smoke", input={"query": "test"}
    )
    recorder.tool_result(
        parent_span_id=root_span, tool_id="t-smoke", output={"result": "ok"}
    )
    recorder.note(parent_span_id=root_span, payload={"test": True})

    # Give collector a moment to persist
    time.sleep(0.1)

    # Retrieve and verify
    response = httpx.get(f"{COLLECTOR_URL}/v1/traces/{trace_id}")
    assert response.is_success, (
        f"Failed to retrieve trace: {response.status_code} {response.text}"
    )

    trace_data = response.json()
    events = trace_data.get("events", [])
    assert len(events) == 5, f"Expected 5 events, got {len(events)}"

    kinds = {e["kind"] for e in events}
    assert "prompt" in kinds
    assert "response" in kinds
    assert "tool_call" in kinds
    assert "tool_result" in kinds
    assert "note" in kinds


@requires_collector
def test_error_event_is_stored() -> None:
    """Error events are persisted and retrievable."""
    trace_id = new_trace_id()
    recorder = FlightRecorder(
        endpoint=COLLECTOR_URL,
        actor={"id": "smoke-agent"},
        trace_id=trace_id,
    )
    recorder.error(message="Intentional test error", parent_span_id=None)

    time.sleep(0.1)

    response = httpx.get(f"{COLLECTOR_URL}/v1/traces/{trace_id}")
    assert response.is_success
    events = response.json().get("events", [])
    error_events = [e for e in events if e["kind"] == "error"]
    assert len(error_events) == 1
    assert error_events[0]["status"] == "error"


@requires_collector
def test_state_snapshot_hash_is_stored() -> None:
    """state_snapshot event with computed hash is persisted."""
    trace_id = new_trace_id()
    recorder = FlightRecorder(
        endpoint=COLLECTOR_URL,
        actor={"id": "smoke-agent"},
        trace_id=trace_id,
    )
    full_state = {"plan": "step1", "step": 1, "active": True}
    event = recorder.state_snapshot(
        parent_span_id=None,
        node_name="plannerNode",
        full_state=full_state,
    )

    time.sleep(0.1)

    response = httpx.get(f"{COLLECTOR_URL}/v1/traces/{trace_id}")
    assert response.is_success
    events = response.json().get("events", [])
    snap_events = [e for e in events if e["kind"] == "state_snapshot"]
    assert len(snap_events) == 1
    payload = snap_events[0]["payload"]
    assert "stateHash" in payload
    assert payload["stateHash"] == event.payload.stateHash
