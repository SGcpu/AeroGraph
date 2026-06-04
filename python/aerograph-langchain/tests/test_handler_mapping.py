import uuid
from langchain_core.outputs import LLMResult, Generation
from langchain_core.messages import HumanMessage

from aerograph_langchain.mapping import (
    map_llm_start,
    map_llm_end,
    map_tool_start,
    map_tool_end,
)
from aerograph_sdk.contracts.generated import (
    PromptEvent,
    ResponseEvent,
    ToolCallEvent,
    ToolResultEvent,
)
from aerograph_langchain.span_ids import derive_span_id


def test_map_llm_start():
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()

    # Prompt string
    event = map_llm_start(
        serialized={"name": "OpenAI"},
        prompts=["Say hello"],
        run_id=run_id,
        parent_run_id=parent_run_id,
        trace_id="t_123",
    )

    assert isinstance(event, PromptEvent)
    assert event.traceId == "t_123"
    assert event.spanId == derive_span_id(run_id)
    assert (event.parentSpanId.root if event.parentSpanId else None) == derive_span_id(
        parent_run_id
    )
    assert event.payload.text == "Say hello"
    assert event.actor.name == "OpenAI"


def test_map_llm_start_chat_messages():
    run_id = uuid.uuid4()
    messages = [[HumanMessage(content="Hello world")]]

    event = map_llm_start(
        serialized={"name": "ChatOpenAI"},
        prompts=None,
        run_id=run_id,
        parent_run_id=None,
        trace_id="t_123",
        messages=messages,
    )

    assert isinstance(event, PromptEvent)
    assert "Hello world" in event.payload.text
    assert event.parentSpanId is None


def test_map_llm_end():
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()

    response = LLMResult(generations=[[Generation(text="Hello to you too!")]])

    event = map_llm_end(
        serialized={"name": "OpenAI"},
        response=response,
        run_id=run_id,
        parent_run_id=parent_run_id,
        trace_id="t_123",
    )

    assert isinstance(event, ResponseEvent)
    assert event.traceId == "t_123"
    assert (
        event.spanId == derive_span_id(run_id) + "_end"
    )  # _end suffix to differentiate from prompt span if needed, or maybe it's the same span? Wait, in aerograph-sdk response is a child of prompt or a new event. The fixture says ResponseEvent has parentSpanId = s_parity_001 (prompt spanId).
    # Actually, we should map them according to the TraceEvent model.
    # Response event should have parentSpanId = prompt's spanId.
    assert (event.parentSpanId.root if event.parentSpanId else None) == derive_span_id(
        run_id
    )
    assert event.payload.text == "Hello to you too!"


def test_map_tool_start():
    run_id = uuid.uuid4()
    parent_run_id = uuid.uuid4()

    event = map_tool_start(
        serialized={"name": "SearchTool"},
        input_str="query string",
        run_id=run_id,
        parent_run_id=parent_run_id,
        trace_id="t_123",
        inputs={"query": "query string"},
    )

    assert isinstance(event, ToolCallEvent)
    assert event.spanId == derive_span_id(run_id)
    assert (event.parentSpanId.root if event.parentSpanId else None) == derive_span_id(
        parent_run_id
    )
    assert event.payload.input == {"query": "query string"}
    assert event.actor.name == "SearchTool"


def test_map_tool_end():
    run_id = uuid.uuid4()

    event = map_tool_end(
        serialized={"name": "SearchTool"},
        output="Search results here",
        run_id=run_id,
        parent_run_id=None,
        trace_id="t_123",
    )

    assert isinstance(event, ToolResultEvent)
    assert (event.parentSpanId.root if event.parentSpanId else None) == derive_span_id(
        run_id
    )
    assert event.payload.output == {"output": "Search results here"}
