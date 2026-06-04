import pytest
import httpx
from langchain_core.messages import HumanMessage
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.outputs import ChatGeneration, ChatResult

from aerograph_sdk.recorder import FlightRecorder
from aerograph_langchain.handler import AeroGraphCallbackHandler


class MockChatModel(BaseChatModel):
    @property
    def _llm_type(self) -> str:
        return "mock-chat"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        text = "Integration test response"
        message = ChatGeneration(text=text, message={"content": text, "type": "ai"})
        return ChatResult(generations=[message])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return self._generate(messages, stop, run_manager, **kwargs)


@pytest.mark.integration
@pytest.mark.asyncio
async def test_end_to_end_langchain():
    # Only run if a local collector is running
    try:
        httpx.get("http://localhost:4317/health")
    except httpx.ConnectError:
        pytest.skip("Collector not running on localhost:4317")

    recorder = FlightRecorder(endpoint="http://localhost:4317", actor={"id": "integration-test"})
    handler = AeroGraphCallbackHandler(recorder)
    model = MockChatModel()

    messages = [HumanMessage(content="Hello integration")]
    await model.ainvoke(messages, config={"callbacks": [handler]})

    # We'd ideally verify the trace was recorded using the collector's API
    # For now, just assert it didn't crash.
    assert handler.trace_id is not None
