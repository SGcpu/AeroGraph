import pytest
import httpx
from aerograph_sdk.recorder import FlightRecorder
from aerograph_sdk.ids import new_trace_id, new_span_id
from aerograph_sdk.events import build_prompt_event


@pytest.mark.integration
def test_sdk_api_emission():
    try:
        httpx.get("http://localhost:4317/health")
    except httpx.ConnectError:
        pytest.skip("Collector not running on localhost:4317")

    recorder = FlightRecorder(endpoint="http://localhost:4317", actor={"id": "integration-test"})

    event = build_prompt_event(
        trace_id=new_trace_id(),
        span_id=new_span_id(),
        parent_span_id=None,
        actor_id="test_actor",
        actor_name="Test Actor",
        title="Integration Test",
        text="Hello SDK",
    )

    # This should not raise an exception
    recorder.emit(event)
