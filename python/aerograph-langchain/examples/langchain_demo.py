import asyncio
from langchain_core.messages import HumanMessage
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.outputs import ChatGeneration, ChatResult

from aerograph_sdk.recorder import FlightRecorder
from aerograph_langchain.handler import AeroGraphCallbackHandler


class MockChatModel(BaseChatModel):
    """A mock chat model for demonstration without an API key."""

    @property
    def _llm_type(self) -> str:
        return "mock-chat"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        text = "This is a mock response to demonstrate AeroGraph tracing."
        message = ChatGeneration(text=text, message={"content": text, "type": "ai"})
        return ChatResult(generations=[message])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        return self._generate(messages, stop, run_manager, **kwargs)


async def main():
    # 1. Initialize the flight recorder
    # By default, it connects to http://localhost:4000
    recorder = FlightRecorder(api_url="http://localhost:4000")

    # 2. Create the AeroGraph LangChain callback handler
    aerograph_handler = AeroGraphCallbackHandler(recorder)

    # 3. Create a model (mocked here, but typically ChatOpenAI etc)
    model = MockChatModel()

    print(f"Starting trace: {aerograph_handler.trace_id}")

    # 4. Invoke with the callback
    messages = [HumanMessage(content="Tell me about AeroGraph observability.")]

    print("Invoking model...")
    response = await model.ainvoke(messages, config={"callbacks": [aerograph_handler]})

    print("Response received:", response)

    # Wait a moment for background events to flush
    await asyncio.sleep(0.5)
    print("Done. Check the AeroGraph UI to view the trace.")


if __name__ == "__main__":
    asyncio.run(main())
