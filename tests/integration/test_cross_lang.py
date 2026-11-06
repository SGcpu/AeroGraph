import json
import pytest
from aerograph_sdk.recorder import FlightRecorder
from aerograph_sdk.events import (
    build_prompt_event,
    build_response_event,
    build_tool_call_event,
    build_tool_result_event
)


def to_json_dict(model):
    """Serialize model to canonical JSON dict with camelCase aliases."""
    return json.loads(model.model_dump_json(by_alias=True, exclude_none=True))


def test_python_events_match_canonical_contract_schema():
    """
    T092: Python agent -> aerograph_sdk.FlightRecorder -> Canonical schema verification.
    Asserts that TraceEvent fields serialized by Python SDK match the canonical TypeScript schema.
    """
    trace_id = "t_cross_lang_py"
    prompt_span_id = "s_prompt_py"

    # 1. Prompt Event
    prompt_event = build_prompt_event(
        trace_id=trace_id,
        span_id=prompt_span_id,
        parent_span_id=None,
        actor_id="py-agent-1",
        actor_name="PythonAgent",
        text="What is deterministic replay?"
    )

    data = to_json_dict(prompt_event)

    assert data["schemaVersion"] == "1.1.0"
    assert data["traceId"] == trace_id
    assert data["spanId"] == prompt_span_id
    assert data["kind"] == "prompt"
    assert data["status"] == "ok"
    assert data["actor"]["kind"] == "agent"
    assert data["actor"]["id"] == "py-agent-1"
    assert data["payload"]["text"] == "What is deterministic replay?"

    # 2. Tool Call Event
    tool_span_id = "s_tool_py"
    tool_event = build_tool_call_event(
        trace_id=trace_id,
        span_id=tool_span_id,
        parent_span_id=prompt_span_id,
        tool_id="tool_calculator",
        tool_name="calculator",
        input={"operation": "add", "a": 2, "b": 3}
    )

    tool_data = to_json_dict(tool_event)

    assert tool_data["kind"] == "tool_call"
    assert tool_data["parentSpanId"] == prompt_span_id
    assert tool_data["actor"]["kind"] == "tool"
    assert tool_data["actor"]["id"] == "tool_calculator"
    assert tool_data["payload"]["input"] == {"operation": "add", "a": 2, "b": 3}

    # 3. Tool Result Event
    tool_result_event = build_tool_result_event(
        trace_id=trace_id,
        span_id=f"{tool_span_id}-res",
        parent_span_id=tool_span_id,
        tool_id="tool_calculator",
        tool_name="calculator",
        output={"result": 5}
    )

    result_data = to_json_dict(tool_result_event)
    assert result_data["kind"] == "tool_result"
    assert result_data["payload"]["output"] == {"result": 5}

    # 4. Response Event
    resp_event = build_response_event(
        trace_id=trace_id,
        span_id="s_resp_py",
        parent_span_id=prompt_span_id,
        actor_id="py-agent-1",
        text="The sum is 5."
    )

    resp_data = to_json_dict(resp_event)

    assert resp_data["kind"] == "response"
    assert resp_data["payload"]["text"] == "The sum is 5."
