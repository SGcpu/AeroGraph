import uuid
from aerograph_langchain.langgraph import map_state_snapshot, map_checkpoint
from aerograph_sdk.contracts.generated import StateSnapshotEvent, CheckpointEvent
from aerograph_langchain.span_ids import derive_span_id


def test_map_state_snapshot():
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()
    trace_id = "t_123"

    event = map_state_snapshot(
        run_id=run_id,
        parent_run_id=parent_run_id,
        trace_id=trace_id,
        node_name="agent",
        state_hash="abcd123",
        state_diff={"key1": "val1"},
        full_state={"key1": "val1", "key2": "val2"},
        removed_keys=[],
    )

    assert isinstance(event, StateSnapshotEvent)
    assert event.traceId == trace_id
    assert event.spanId == derive_span_id(run_id)
    assert (event.parentSpanId.root if event.parentSpanId else None) == derive_span_id(
        parent_run_id
    )
    assert event.payload.nodeName == "agent"
    assert event.payload.stateHash == "abcd123"
    assert event.payload.stateDiff == {"key1": "val1"}
    assert event.payload.fullState == {"key1": "val1", "key2": "val2"}


def test_map_checkpoint():
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()
    trace_id = "t_123"

    event = map_checkpoint(
        run_id=run_id,
        parent_run_id=parent_run_id,
        trace_id=trace_id,
        checkpoint_id="ckpt_1",
        reason="step_end",
        state={"key1": "val1"},
    )

    assert isinstance(event, CheckpointEvent)
    assert event.traceId == trace_id
    assert event.spanId == derive_span_id(run_id)
    assert (event.parentSpanId.root if event.parentSpanId else None) == derive_span_id(
        parent_run_id
    )
    assert event.payload.checkpointId == "ckpt_1"
    assert event.payload.reason == "step_end"
    assert event.payload.state == {"key1": "val1"}
