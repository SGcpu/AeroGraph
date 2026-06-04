"""
python/aerograph-sdk/src/aerograph_sdk/events.py

TraceEvent builders — one per event kind.

Each builder:
- Generates a spanId if absent
- Defaults occurredAt to current UTC time (RFC 3339 / ISO 8601)
- Enforces actor kind requirements for each event kind
- Returns a validated Pydantic model

These mirror the @aerograph/sdk TypeScript helpers exactly in semantics.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from aerograph_sdk.contracts.generated import (
    SCHEMA_VERSION,
    Actor,
    AgentActor,
    ToolActor,
    SystemActor,
    CheckpointEvent,
    CheckpointPayload,
    ErrorEvent,
    ErrorPayload,
    HandoffEvent,
    HandoffPayload,
    NoteEvent,
    PromptEvent,
    PromptPayload,
    ResponseEvent,
    ResponsePayload,
    RetrieverDocument,
    RetrieverEvent,
    RetrieverPayload,
    StateSnapshotEvent,
    StateSnapshotPayload,
    StreamingTelemetry,
    ToolCallEvent,
    ToolCallPayload,
    ToolResultEvent,
    ToolResultPayload,
    TraceEventStatus,
    TraceLink,
)
from aerograph_sdk.ids import new_span_id


def _now_iso() -> str:
    """Return the current UTC time as an ISO 8601 string (RFC 3339 compatible)."""
    return (
        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    )


def _utcnow() -> str:
    """Return current UTC datetime in ISO 8601 format matching JS toISOString()."""
    now = datetime.now(timezone.utc)
    ms = now.microsecond // 1000
    return now.strftime(f"%Y-%m-%dT%H:%M:%S.{ms:03d}Z")


def build_prompt_event(
    *,
    trace_id: str,
    actor_id: str,
    actor_name: Optional[str] = None,
    text: str,
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    title: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
) -> PromptEvent:
    """Build a validated prompt event."""
    return PromptEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=AgentActor(kind="agent", id=actor_id, name=actor_name),
        kind="prompt",
        status=status,
        title=title,
        payload=PromptPayload(text=text),
        links=links or [],
    )


def build_response_event(
    *,
    trace_id: str,
    actor_id: str,
    actor_name: Optional[str] = None,
    text: str,
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    title: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
    streaming_telemetry: Optional[dict[str, Any]] = None,
) -> ResponseEvent:
    """Build a validated response event."""
    telemetry: Optional[StreamingTelemetry] = None
    if streaming_telemetry:
        telemetry = StreamingTelemetry(**streaming_telemetry)

    return ResponseEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=AgentActor(kind="agent", id=actor_id, name=actor_name),
        kind="response",
        status=status,
        title=title,
        payload=ResponsePayload(text=text, streamingTelemetry=telemetry),
        links=links or [],
    )


def build_tool_call_event(
    *,
    trace_id: str,
    tool_id: str,
    tool_name: Optional[str] = None,
    input: dict[str, Any],  # noqa: A002
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    title: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
) -> ToolCallEvent:
    """Build a validated tool_call event."""
    return ToolCallEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=ToolActor(kind="tool", id=tool_id, name=tool_name),
        kind="tool_call",
        status=status,
        title=title or tool_name,
        payload=ToolCallPayload(input=input),
        links=links or [],
    )


def build_tool_result_event(
    *,
    trace_id: str,
    tool_id: str,
    tool_name: Optional[str] = None,
    output: dict[str, Any],
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    title: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
) -> ToolResultEvent:
    """Build a validated tool_result event."""
    return ToolResultEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=ToolActor(kind="tool", id=tool_id, name=tool_name),
        kind="tool_result",
        status=status,
        title=title or tool_name,
        payload=ToolResultPayload(output=output),
        links=links or [],
    )


def build_handoff_event(
    *,
    trace_id: str,
    from_agent_id: str,
    to_agent_id: str,
    reason: Optional[str] = None,
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
) -> HandoffEvent:
    """Build a validated handoff event."""
    return HandoffEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=SystemActor(kind="system", id="handoff"),
        kind="handoff",
        status=status,
        title="handoff",
        payload=HandoffPayload(
            fromAgentId=from_agent_id, toAgentId=to_agent_id, reason=reason
        ),
        links=links or [],
    )


def build_error_event(
    *,
    trace_id: str,
    actor_id: str,
    actor_kind: str = "system",
    actor_name: Optional[str] = None,
    message: str,
    details: Optional[dict[str, Any]] = None,
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    title: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
) -> ErrorEvent:
    """Build a validated error event."""
    return ErrorEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=Actor(kind=actor_kind, id=actor_id, name=actor_name),  # type: ignore[arg-type]
        kind="error",
        status=TraceEventStatus.error,
        title=title,
        payload=ErrorPayload(message=message, details=details or {}),
        links=links or [],
    )


def build_note_event(
    *,
    trace_id: str,
    actor_id: str,
    actor_kind: str = "system",
    actor_name: Optional[str] = None,
    payload: dict[str, Any],
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    title: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
) -> NoteEvent:
    """Build a validated note event."""
    return NoteEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=Actor(kind=actor_kind, id=actor_id, name=actor_name),  # type: ignore[arg-type]
        kind="note",
        status=status,
        title=title,
        payload=payload,
        links=links or [],
    )


def build_state_snapshot_event(
    *,
    trace_id: str,
    actor_id: str,
    actor_name: Optional[str] = None,
    node_name: str,
    state_hash: str,
    state_diff: dict[str, Any],
    full_state: dict[str, Any],
    removed_keys: Optional[list[str]] = None,
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
) -> StateSnapshotEvent:
    """Build a validated state_snapshot event."""
    return StateSnapshotEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=SystemActor(kind="system", id=actor_id, name=actor_name),
        kind="state_snapshot",
        status=status,
        title=f"State: {node_name}",
        payload=StateSnapshotPayload(
            nodeName=node_name,
            stateHash=state_hash,
            stateDiff=state_diff,
            removedKeys=removed_keys,
            fullState=full_state,
        ),
        links=links or [],
    )


def build_retriever_event(
    *,
    trace_id: str,
    tool_id: str,
    tool_name: Optional[str] = None,
    query: str,
    documents: list[dict[str, Any]],
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
) -> RetrieverEvent:
    """Build a validated retriever event."""
    docs = [
        RetrieverDocument(
            pageContent=d["pageContent"],
            metadata=d.get("metadata", {}),
            score=d.get("score"),
        )
        for d in documents
    ]
    return RetrieverEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=ToolActor(kind="tool", id=tool_id, name=tool_name),
        kind="retriever",
        status=status,
        title=tool_name or "retriever",
        payload=RetrieverPayload(query=query, documents=docs),
        links=links or [],
    )


def build_checkpoint_event(
    *,
    trace_id: str,
    actor_id: str,
    actor_name: Optional[str] = None,
    checkpoint_id: str,
    reason: str,
    state: dict[str, Any],
    parent_span_id: Optional[str] = None,
    span_id: Optional[str] = None,
    occurred_at: Optional[str] = None,
    links: Optional[list[TraceLink]] = None,
    status: TraceEventStatus = TraceEventStatus.ok,
) -> CheckpointEvent:
    """Build a validated checkpoint event."""
    return CheckpointEvent(
        schemaVersion=SCHEMA_VERSION,
        traceId=trace_id,
        spanId=span_id or new_span_id(),
        parentSpanId=parent_span_id,
        occurredAt=occurred_at or _utcnow(),
        actor=SystemActor(kind="system", id=actor_id, name=actor_name),
        kind="checkpoint",
        status=status,
        title=f"Checkpoint: {checkpoint_id}",
        payload=CheckpointPayload(
            checkpointId=checkpoint_id,
            reason=reason,
            state=state,
        ),
        links=links or [],
    )


def compare_trace_events(
    a: dict[str, str],
    b: dict[str, str],
) -> int:
    """
    Compare two events for deterministic ordering.

    Primary: occurredAt (lexicographic)
    Secondary: spanId (lexicographic)
    Tertiary: kind (lexicographic)

    Mirrors compareTraceEvents from @aerograph/contracts.

    Returns:
        negative if a < b, 0 if equal, positive if a > b
    """
    t = (a["occurredAt"] > b["occurredAt"]) - (a["occurredAt"] < b["occurredAt"])
    if t != 0:
        return t
    s = (a["spanId"] > b["spanId"]) - (a["spanId"] < b["spanId"])
    if s != 0:
        return s
    return (a["kind"] > b["kind"]) - (a["kind"] < b["kind"])


def sort_trace_events_deterministic(
    events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Sort trace events using the deterministic comparator.

    Mirrors sortTraceEventsDeterministic from @aerograph/contracts.
    """
    import functools

    return sorted(events, key=functools.cmp_to_key(compare_trace_events))
