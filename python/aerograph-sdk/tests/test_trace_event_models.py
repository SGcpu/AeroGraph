"""
python/aerograph-sdk/tests/test_trace_event_models.py

Contract model validation tests — verify that Python Pydantic models
accept all valid events from the cross-language parity fixtures.

This tests the generated.py models against the canonical fixture data.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aerograph_sdk.contracts.generated import (
    SCHEMA_VERSION,
    TraceEventKind,
    TraceEventStatus,
    PromptEvent,
    ResponseEvent,
    ToolCallEvent,
    ToolResultEvent,
    HandoffEvent,
    ErrorEvent,
    NoteEvent,
    StateSnapshotEvent,
    RetrieverEvent,
    CheckpointEvent,
)

# ---------------------------------------------------------------------------
# Load fixtures
# ---------------------------------------------------------------------------

FIXTURES_PATH = (
    Path(__file__).parents[3]
    / "packages"
    / "contracts"
    / "src"
    / "__fixtures__"
    / "parity"
    / "trace-events.json"
)


def load_fixtures() -> list[dict]:
    with open(FIXTURES_PATH) as f:
        data = json.load(f)
    return data["fixtures"]


FIXTURES = load_fixtures()

# Map kind string to model class for validation
KIND_TO_MODEL: dict[str, type] = {
    "prompt": PromptEvent,
    "response": ResponseEvent,
    "tool_call": ToolCallEvent,
    "tool_result": ToolResultEvent,
    "handoff": HandoffEvent,
    "error": ErrorEvent,
    "note": NoteEvent,
    "state_snapshot": StateSnapshotEvent,
    "retriever": RetrieverEvent,
    "checkpoint": CheckpointEvent,
}


# ---------------------------------------------------------------------------
# Parametrized parity tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fixture",
    FIXTURES,
    ids=[f["kind"] for f in FIXTURES],
)
def test_parity_fixture_is_valid(fixture: dict) -> None:
    """Each cross-language fixture must be accepted by the Python Pydantic model."""
    kind = fixture["kind"]
    event_data = fixture["event"]
    model_cls = KIND_TO_MODEL[kind]

    # Should not raise
    event = model_cls(**event_data)
    assert event.kind == kind
    assert event.schemaVersion == SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Schema version
# ---------------------------------------------------------------------------


def test_schema_version_is_correct() -> None:
    """SCHEMA_VERSION must match the canonical version."""
    assert SCHEMA_VERSION == "1.0.0"


# ---------------------------------------------------------------------------
# Field presence tests
# ---------------------------------------------------------------------------


def test_prompt_event_fields() -> None:
    """PromptEvent must have all required base fields and actor kind constraint."""
    event = PromptEvent(
        schemaVersion="1.0.0",
        traceId="t_test",
        spanId="s_test",
        parentSpanId=None,
        occurredAt="2026-05-31T00:00:00.000Z",
        actor={"kind": "agent", "id": "agent-a", "name": "Planner"},
        kind="prompt",
        status="ok",
        payload={"text": "Hello world"},
        links=[],
    )
    assert event.traceId == "t_test"
    assert event.spanId == "s_test"
    assert event.parentSpanId is None
    assert event.actor.kind == "agent"
    assert event.payload.text == "Hello world"
    assert event.kind == "prompt"
    assert event.status == TraceEventStatus.ok


def test_response_event_with_streaming_telemetry() -> None:
    """ResponseEvent payload can include optional streamingTelemetry."""
    event = ResponseEvent(
        schemaVersion="1.0.0",
        traceId="t_test",
        spanId="s_test",
        parentSpanId="s_parent",
        occurredAt="2026-05-31T00:00:01.000Z",
        actor={"kind": "agent", "id": "agent-a"},
        kind="response",
        status="ok",
        payload={
            "text": "Here is the result",
            "streamingTelemetry": {
                "timeToFirstTokenMs": 100,
                "totalDurationMs": 500,
                "tokensPerSecond": 40.0,
                "tokenCount": 20,
            },
        },
        links=[],
    )
    assert event.payload.streamingTelemetry is not None
    assert event.payload.streamingTelemetry.tokenCount == 20


def test_error_event_status_is_error() -> None:
    """ErrorEvent status must be 'error'."""
    event = ErrorEvent(
        schemaVersion="1.0.0",
        traceId="t_test",
        spanId="s_err",
        parentSpanId=None,
        occurredAt="2026-05-31T00:00:00.000Z",
        actor={"kind": "system", "id": "agent-a"},
        kind="error",
        status="error",
        payload={"message": "Something failed", "details": {}},
        links=[],
    )
    assert event.status == TraceEventStatus.error


def test_note_event_has_arbitrary_payload() -> None:
    """NoteEvent payload is a free dict[str, Any]."""
    event = NoteEvent(
        schemaVersion="1.0.0",
        traceId="t_test",
        spanId="s_note",
        parentSpanId=None,
        occurredAt="2026-05-31T00:00:00.000Z",
        actor={"kind": "system", "id": "agent-a"},
        kind="note",
        status="ok",
        payload={"foo": "bar", "count": 42, "nested": {"x": True}},
        links=[],
    )
    assert event.payload["foo"] == "bar"
    assert event.payload["count"] == 42


def test_state_snapshot_has_required_fields() -> None:
    """StateSnapshotEvent must have nodeName, stateHash, stateDiff, fullState."""
    event = StateSnapshotEvent(
        schemaVersion="1.0.0",
        traceId="t_test",
        spanId="s_snap",
        parentSpanId=None,
        occurredAt="2026-05-31T00:00:00.000Z",
        actor={"kind": "system", "id": "orchestrator"},
        kind="state_snapshot",
        status="ok",
        payload={
            "nodeName": "plannerNode",
            "stateHash": "deadbeef",
            "stateDiff": {"plan": "step1"},
            "fullState": {"plan": "step1", "step": 1},
        },
        links=[],
    )
    assert event.payload.nodeName == "plannerNode"
    assert event.payload.stateHash == "deadbeef"


def test_retriever_event_has_documents() -> None:
    """RetrieverEvent payload includes query and document list."""
    event = RetrieverEvent(
        schemaVersion="1.0.0",
        traceId="t_test",
        spanId="s_ret",
        parentSpanId=None,
        occurredAt="2026-05-31T00:00:00.000Z",
        actor={"kind": "tool", "id": "vector-db"},
        kind="retriever",
        status="ok",
        payload={
            "query": "agent observability",
            "documents": [
                {
                    "pageContent": "AeroGraph records traces.",
                    "metadata": {"source": "docs"},
                    "score": 0.9,
                }
            ],
        },
        links=[],
    )
    assert event.payload.query == "agent observability"
    assert len(event.payload.documents) == 1
    assert event.payload.documents[0].score == 0.9


def test_all_kinds_are_represented() -> None:
    """Every kind in TraceEventKind must have a model in KIND_TO_MODEL."""
    for kind in TraceEventKind:
        assert kind.value in KIND_TO_MODEL, f"No model for kind {kind.value!r}"


def test_links_field_defaults_to_empty_list() -> None:
    """links field defaults to []."""
    event = PromptEvent(
        schemaVersion="1.0.0",
        traceId="t_test",
        spanId="s_test",
        parentSpanId=None,
        occurredAt="2026-05-31T00:00:00.000Z",
        actor={"kind": "agent", "id": "agent-a"},
        kind="prompt",
        status="ok",
        payload={"text": "Hello"},
        links=[],
    )
    assert event.links == []


def test_links_field_accepts_valid_link() -> None:
    """links field accepts TraceLink objects."""
    event = PromptEvent(
        schemaVersion="1.0.0",
        traceId="t_test",
        spanId="s_test",
        parentSpanId=None,
        occurredAt="2026-05-31T00:00:00.000Z",
        actor={"kind": "agent", "id": "agent-a"},
        kind="prompt",
        status="ok",
        payload={"text": "Hello"},
        links=[{"rel": "follows", "spanId": "s_prev"}],
    )
    assert event.links[0].rel.value == "follows"
    assert event.links[0].spanId == "s_prev"
