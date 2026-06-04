import uuid
from typing import Any, Dict, List, Optional
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult
from langchain_core.messages import BaseMessage
from langchain_core.documents import Document

from aerograph_sdk.recorder import FlightRecorder
from aerograph_sdk.ids import new_trace_id

from .mapping import map_llm_start, map_llm_end, map_tool_start, map_tool_end, map_error
from .streaming import StreamingTracker
from .retriever import RetrieverTracker
from .langgraph import map_state_snapshot, map_checkpoint


class AeroGraphCallbackHandler(BaseCallbackHandler):
    """Callback Handler that records LangChain runs to AeroGraph."""

    def __init__(
        self, recorder: FlightRecorder, trace_id: Optional[str] = None
    ) -> None:
        super().__init__()
        self.recorder = recorder
        self.trace_id = trace_id or new_trace_id()
        self.streaming_tracker = StreamingTracker()
        self.retriever_tracker = RetrieverTracker()

    def on_llm_start(
        self,
        serialized: Dict[str, Any],
        prompts: List[str],
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        event = map_llm_start(
            serialized=serialized,
            prompts=prompts,
            run_id=run_id,
            parent_run_id=parent_run_id,
            trace_id=self.trace_id,
        )
        self.recorder.emit(event)
        self.streaming_tracker.on_llm_start(run_id)

    def on_chat_model_start(
        self,
        serialized: Dict[str, Any],
        messages: List[List[BaseMessage]],
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        event = map_llm_start(
            serialized=serialized,
            messages=messages,
            run_id=run_id,
            parent_run_id=parent_run_id,
            trace_id=self.trace_id,
        )
        self.recorder.emit(event)
        self.streaming_tracker.on_llm_start(run_id)

    def on_llm_new_token(
        self,
        token: str,
        *,
        chunk: Optional[Any] = None,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        **kwargs: Any,
    ) -> Any:
        self.streaming_tracker.on_llm_new_token(run_id)

    def on_llm_end(
        self,
        response: LLMResult,
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        **kwargs: Any,
    ) -> Any:
        event = map_llm_end(
            serialized={
                "name": "LLM"
            },  # Best effort, LangChain doesn't pass serialized to end
            response=response,
            run_id=run_id,
            parent_run_id=parent_run_id,
            trace_id=self.trace_id,
        )
        telemetry = self.streaming_tracker.on_llm_end(run_id)
        if telemetry:
            # We recreate the payload with telemetry
            event.payload.streamingTelemetry = telemetry
        self.recorder.emit(event)

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        inputs: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        event = map_tool_start(
            serialized=serialized,
            input_str=input_str,
            run_id=run_id,
            parent_run_id=parent_run_id,
            trace_id=self.trace_id,
            inputs=inputs,
        )
        self.recorder.emit(event)

    def on_tool_end(
        self,
        output: Any,
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        **kwargs: Any,
    ) -> Any:
        event = map_tool_end(
            serialized={"name": "Tool"},  # Best effort
            output=output,
            run_id=run_id,
            parent_run_id=parent_run_id,
            trace_id=self.trace_id,
        )
        self.recorder.emit(event)

    def on_retriever_start(
        self,
        serialized: Dict[str, Any],
        query: str,
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        self.retriever_tracker.on_retriever_start(run_id, query, serialized)

    def on_retriever_end(
        self,
        documents: List[Document],
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        **kwargs: Any,
    ) -> Any:
        event = self.retriever_tracker.on_retriever_end(
            run_id=run_id,
            documents=documents,
            trace_id=self.trace_id,
            parent_run_id=parent_run_id,
        )
        if event:
            self.recorder.emit(event)

    def on_custom_event(
        self,
        name: str,
        data: Any,
        *,
        run_id: uuid.UUID,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        """Handle custom events, particularly LangGraph state emissions if mapped here."""
        if name == "langgraph_state_snapshot":
            event = map_state_snapshot(
                run_id=run_id,
                trace_id=self.trace_id,
                node_name=data.get("node_name", "unknown"),
                state_hash=data.get("state_hash", ""),
                state_diff=data.get("state_diff", {}),
                full_state=data.get("full_state", {}),
                removed_keys=data.get("removed_keys", []),
            )
            self.recorder.emit(event)
        elif name == "langgraph_checkpoint":
            event = map_checkpoint(
                run_id=run_id,
                trace_id=self.trace_id,
                checkpoint_id=data.get("checkpoint_id", ""),
                reason=data.get("reason", ""),
                state=data.get("state", {}),
            )
            self.recorder.emit(event)

    def on_llm_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        **kwargs: Any,
    ) -> Any:
        event = map_error(
            error=error,
            run_id=run_id,
            trace_id=self.trace_id,
            parent_run_id=parent_run_id
        )
        self.recorder.emit(event)

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        **kwargs: Any,
    ) -> Any:
        event = map_error(
            error=error,
            run_id=run_id,
            trace_id=self.trace_id,
            parent_run_id=parent_run_id
        )
        self.recorder.emit(event)

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: uuid.UUID,
        parent_run_id: Optional[uuid.UUID] = None,
        **kwargs: Any,
    ) -> Any:
        event = map_error(
            error=error,
            run_id=run_id,
            trace_id=self.trace_id,
            parent_run_id=parent_run_id
        )
        self.recorder.emit(event)
