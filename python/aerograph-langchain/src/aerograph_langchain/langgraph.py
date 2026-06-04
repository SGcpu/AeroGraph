import uuid
from typing import Any, Dict, List, Optional

from aerograph_sdk.events import build_state_snapshot_event, build_checkpoint_event
from aerograph_sdk.contracts.generated import StateSnapshotEvent, CheckpointEvent
from aerograph_langchain.span_ids import derive_span_id


def map_state_snapshot(
    run_id: uuid.UUID,
    trace_id: str,
    node_name: str,
    state_hash: str,
    state_diff: Dict[str, Any],
    full_state: Dict[str, Any],
    removed_keys: Optional[List[str]] = None,
    parent_run_id: Optional[uuid.UUID] = None,
) -> StateSnapshotEvent:
    span_id = derive_span_id(run_id)
    parent_span_id = derive_span_id(parent_run_id) if parent_run_id else None

    return build_state_snapshot_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        actor_id="langgraph",
        actor_name="LangGraph",
        node_name=node_name,
        state_hash=state_hash,
        state_diff=state_diff,
        full_state=full_state,
        removed_keys=removed_keys or [],
    )


def map_checkpoint(
    run_id: uuid.UUID,
    trace_id: str,
    checkpoint_id: str,
    reason: str,
    state: Dict[str, Any],
    parent_run_id: Optional[uuid.UUID] = None,
) -> CheckpointEvent:
    span_id = derive_span_id(run_id)
    parent_span_id = derive_span_id(parent_run_id) if parent_run_id else None

    return build_checkpoint_event(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent_span_id,
        actor_id="langgraph",
        actor_name="LangGraph",
        checkpoint_id=checkpoint_id,
        reason=reason,
        state=state,
    )
