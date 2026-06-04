"""
python/aerograph-sdk/tests/test_emitter.py

SDK batching + sync/async emission unit tests with HTTP mocking.

Tests use pytest-httpx to mock HTTP responses without a real collector.
"""

from __future__ import annotations


import httpx
import pytest

from aerograph_sdk import FlightRecorder, EmissionError
from aerograph_sdk.contracts.generated import TraceEventStatus


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_recorder(
    http_client: httpx.Client | None = None,
    async_http_client: httpx.AsyncClient | None = None,
    trace_id: str = "t_test_001",
) -> FlightRecorder:
    return FlightRecorder(
        endpoint="http://localhost:4317",
        actor={"id": "agent-a", "name": "TestAgent"},
        trace_id=trace_id,
        http_client=http_client,
        async_http_client=async_http_client,
    )


# ---------------------------------------------------------------------------
# Sync emission tests
# ---------------------------------------------------------------------------


def test_emit_prompt_posts_to_collector(httpx_mock) -> None:
    """emit() sends a POST to /v1/events with JSON body."""
    httpx_mock.add_response(status_code=201)

    recorder = make_recorder()
    event = recorder.prompt(parent_span_id=None, text="Hello world")

    assert event.traceId == "t_test_001"
    assert event.payload.text == "Hello world"
    assert event.kind == "prompt"

    requests = httpx_mock.get_requests()
    assert len(requests) == 1
    req = requests[0]
    assert req.method == "POST"
    assert req.url.path == "/v1/events"
    assert req.headers["content-type"] == "application/json"

    body = req.content.decode()
    import json

    parsed = json.loads(body)
    assert parsed["kind"] == "prompt"
    assert parsed["traceId"] == "t_test_001"
    assert parsed["schemaVersion"] == "1.0.0"


def test_emit_response_posts_to_collector(httpx_mock) -> None:
    """emit() response event includes actor kind=agent."""
    httpx_mock.add_response(status_code=201)
    recorder = make_recorder()
    event = recorder.response(parent_span_id=None, text="Hi there")
    assert event.kind == "response"
    assert event.actor.kind == "agent"


def test_emit_error_event(httpx_mock) -> None:
    """Error events have status=error."""
    httpx_mock.add_response(status_code=201)
    recorder = make_recorder()
    event = recorder.error(message="Something broke", parent_span_id=None)
    assert event.status == TraceEventStatus.error
    assert event.payload.message == "Something broke"


def test_emit_raises_on_non_2xx(httpx_mock) -> None:
    """EmissionError raised on non-2xx response."""
    httpx_mock.add_response(status_code=422, text="Unprocessable Entity")
    recorder = make_recorder()

    from aerograph_sdk.events import build_prompt_event

    event = build_prompt_event(
        trace_id="t_test",
        actor_id="agent-a",
        text="Hello",
        parent_span_id=None,
    )

    with pytest.raises(EmissionError) as exc_info:
        recorder.emit(event)

    assert exc_info.value.status_code == 422


def test_emit_all_event_kinds_sync(httpx_mock) -> None:
    """All convenience methods emit without error."""
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)
    httpx_mock.add_response(status_code=201)

    recorder = make_recorder()
    root = recorder.new_span_id()

    recorder.prompt(parent_span_id=None, span_id=root, text="Q")
    recorder.response(parent_span_id=root, text="A")
    recorder.tool_call(parent_span_id=root, tool_id="t-1", input={"q": "x"})
    recorder.tool_result(parent_span_id=root, tool_id="t-1", output={"r": "y"})
    recorder.handoff(parent_span_id=root, from_agent_id="a1", to_agent_id="a2")
    recorder.error(parent_span_id=root, message="oops")
    recorder.note(parent_span_id=root, payload={"info": "test"})
    recorder.state_snapshot(parent_span_id=root, node_name="n1", full_state={"x": 1})
    recorder.retriever(
        parent_span_id=root,
        tool_id="ret-1",
        query="search",
        documents=[{"pageContent": "doc", "metadata": {}}],
    )
    recorder.checkpoint(
        parent_span_id=root, checkpoint_id="c1", reason="test", state={}
    )

    assert len(httpx_mock.get_requests()) == 10


# ---------------------------------------------------------------------------
# Batch emission tests
# ---------------------------------------------------------------------------


def test_emit_batch_sends_single_request(httpx_mock) -> None:
    """emit_batch() sends all events in a single POST."""
    httpx_mock.add_response(status_code=201)

    from aerograph_sdk.events import build_prompt_event, build_response_event

    events = [
        build_prompt_event(
            trace_id="t_test", actor_id="a1", text="Q", parent_span_id=None
        ),
        build_response_event(
            trace_id="t_test", actor_id="a1", text="A", parent_span_id=None
        ),
    ]
    recorder = make_recorder()
    recorder.emit_batch(events)

    requests = httpx_mock.get_requests()
    assert len(requests) == 1
    req = requests[0]
    import json
    payload = json.loads(req.read())
    assert len(payload) == 2
    kinds = {p["kind"] for p in payload}
    assert kinds == {"prompt", "response"}


def test_emit_batch_orders_events_deterministically(httpx_mock) -> None:
    """emit_batch() orders events by occurredAt → spanId → kind."""
    httpx_mock.add_response(status_code=201)

    from aerograph_sdk.events import build_prompt_event

    # Deliberately create in reverse timestamp order
    event_a = build_prompt_event(
        trace_id="t_test",
        actor_id="a1",
        text="Q",
        parent_span_id=None,
        occurred_at="2026-05-31T00:00:02.000Z",
        span_id="s_late",
    )
    event_b = build_prompt_event(
        trace_id="t_test",
        actor_id="a1",
        text="Q",
        parent_span_id=None,
        occurred_at="2026-05-31T00:00:01.000Z",
        span_id="s_early",
    )
    recorder = make_recorder()
    ordered = recorder.emit_batch([event_a, event_b])

    # Earlier event should come first
    assert ordered[0].spanId == "s_early"
    assert ordered[1].spanId == "s_late"


# ---------------------------------------------------------------------------
# Async emission tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_emit_async_posts_to_collector(httpx_mock) -> None:
    """emit_async() sends a POST to /v1/events."""
    httpx_mock.add_response(status_code=201)

    from aerograph_sdk.events import build_prompt_event

    recorder = make_recorder()
    event = build_prompt_event(
        trace_id="t_test",
        actor_id="agent-a",
        text="Async test",
        parent_span_id=None,
    )
    returned = await recorder.emit_async(event)
    assert returned.payload.text == "Async test"


@pytest.mark.asyncio
async def test_prompt_async_posts_correctly(httpx_mock) -> None:
    """prompt_async() convenience method works end to end."""
    httpx_mock.add_response(status_code=201)
    recorder = make_recorder()
    event = await recorder.prompt_async(parent_span_id=None, text="Async hello")
    assert event.kind == "prompt"


@pytest.mark.asyncio
async def test_emit_batch_async_sends_single_request(httpx_mock) -> None:
    """emit_batch_async() sends a single POST."""
    httpx_mock.add_response(status_code=201)

    from aerograph_sdk.events import build_prompt_event

    events = [
        build_prompt_event(
            trace_id="t_test", actor_id="a1", text="Q", parent_span_id=None
        ),
        build_prompt_event(
            trace_id="t_test", actor_id="a1", text="Q2", parent_span_id=None
        ),
    ]
    recorder = make_recorder()
    ordered = await recorder.emit_batch_async(events)
    assert len(ordered) == 2
    assert len(httpx_mock.get_requests()) == 1


@pytest.mark.asyncio
async def test_emit_async_raises_on_non_2xx(httpx_mock) -> None:
    """emit_async() raises EmissionError on non-2xx response."""
    httpx_mock.add_response(status_code=500, text="Internal Server Error")

    from aerograph_sdk.events import build_prompt_event

    recorder = make_recorder()
    event = build_prompt_event(
        trace_id="t_test",
        actor_id="agent-a",
        text="fail",
        parent_span_id=None,
    )
    with pytest.raises(EmissionError) as exc_info:
        await recorder.emit_async(event)
    assert exc_info.value.status_code == 500


# ---------------------------------------------------------------------------
# ID generation tests
# ---------------------------------------------------------------------------


def test_new_span_id_format() -> None:
    """new_span_id() returns a string starting with 's_'."""
    recorder = make_recorder()
    sid = recorder.new_span_id()
    assert sid.startswith("s_")
    assert len(sid) > 2


def test_new_trace_id_format() -> None:
    """new_trace_id() returns a string starting with 't_'."""
    recorder = make_recorder()
    tid = recorder.new_trace_id()
    assert tid.startswith("t_")
    assert len(tid) > 2


def test_trace_id_is_auto_generated() -> None:
    """FlightRecorder auto-generates a trace_id if not provided."""
    recorder = FlightRecorder(
        endpoint="http://localhost:4317",
        actor={"id": "agent-a"},
    )
    assert recorder.trace_id.startswith("t_")


def test_span_ids_are_unique() -> None:
    """new_span_id() produces unique IDs."""
    recorder = make_recorder()
    ids = {recorder.new_span_id() for _ in range(100)}
    assert len(ids) == 100


# ---------------------------------------------------------------------------
# Context manager tests
# ---------------------------------------------------------------------------


def test_span_context_manager_provides_span_id(httpx_mock) -> None:
    """span() context manager yields span context dict."""
    recorder = make_recorder()
    with recorder.span(parent_span_id="s_root") as ctx:
        assert "span_id" in ctx
        assert ctx["span_id"].startswith("s_")
        assert ctx["parent_span_id"] == "s_root"


@pytest.mark.asyncio
async def test_async_span_context_manager(httpx_mock) -> None:
    """async_span() context manager yields span context dict."""
    recorder = make_recorder()
    async with recorder.async_span(parent_span_id="s_root") as ctx:
        assert "span_id" in ctx
        assert ctx["span_id"].startswith("s_")
