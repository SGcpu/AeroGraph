import uuid
from typing import Any
from aerograph_langchain.handler import AeroGraphCallbackHandler
from aerograph_sdk.recorder import FlightRecorder

class MockRecorder(FlightRecorder):
    def __init__(self):
        super().__init__(endpoint="http://localhost", actor={"id": "test-agent"})
        self.events = []

    def emit(self, event: Any) -> Any:
        self.events.append(event)
        return event

def test_on_llm_error():
    recorder = MockRecorder()
    handler = AeroGraphCallbackHandler(recorder, trace_id="t_err_1")
    run_id = uuid.uuid4()
    
    error = ValueError("LLM generation failed")
    handler.on_llm_error(error, run_id=run_id)
    
    assert len(recorder.events) == 1
    event = recorder.events[0]
    assert event.kind == "error"
    assert event.traceId == "t_err_1"
    assert event.payload.message == "LLM generation failed"
    assert event.actor.name == "LangChain"

def test_on_tool_error():
    recorder = MockRecorder()
    handler = AeroGraphCallbackHandler(recorder, trace_id="t_err_2")
    run_id = uuid.uuid4()
    
    error = RuntimeError("Tool execution failed")
    handler.on_tool_error(error, run_id=run_id)
    
    assert len(recorder.events) == 1
    event = recorder.events[0]
    assert event.kind == "error"
    assert event.traceId == "t_err_2"
    assert event.payload.message == "Tool execution failed"

def test_on_chain_error():
    recorder = MockRecorder()
    handler = AeroGraphCallbackHandler(recorder, trace_id="t_err_3")
    run_id = uuid.uuid4()
    
    error = Exception("Chain failed")
    handler.on_chain_error(error, run_id=run_id)
    
    assert len(recorder.events) == 1
    event = recorder.events[0]
    assert event.kind == "error"
    assert event.traceId == "t_err_3"
    assert event.payload.message == "Chain failed"
