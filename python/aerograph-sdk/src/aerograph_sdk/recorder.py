"""
python/aerograph-sdk/src/aerograph_sdk/recorder.py

FlightRecorder — core sync + async + batching event emission.

This is the primary SDK entry point for Python users. It mirrors the
TypeScript FlightRecorder class from @aerograph/sdk with Pythonic conventions.

Usage (sync):
    recorder = FlightRecorder(endpoint="http://localhost:4317", actor={"id": "agent-1"})
    recorder.prompt(parent_span_id=None, text="Hello")

Usage (async):
    recorder = FlightRecorder(endpoint="http://localhost:4317", actor={"id": "agent-1"})
    await recorder.prompt_async(parent_span_id=None, text="Hello")
"""

from __future__ import annotations

import json
from contextlib import contextmanager, asynccontextmanager
from typing import Any, Optional, Union

import httpx

from aerograph_sdk.contracts.generated import (
    CheckpointEvent,
    ErrorEvent,
    HandoffEvent,
    NoteEvent,
    PromptEvent,
    ResponseEvent,
    RetrieverEvent,
    StateSnapshotEvent,
    ToolCallEvent,
    ToolResultEvent,
    TraceEventStatus,
    TraceLink,
)
from aerograph_sdk.events import (
    build_checkpoint_event,
    build_error_event,
    build_handoff_event,
    build_note_event,
    build_prompt_event,
    build_response_event,
    build_retriever_event,
    build_state_snapshot_event,
    build_tool_call_event,
    build_tool_result_event,
    sort_trace_events_deterministic,
)
from aerograph_sdk.ids import new_span_id, new_trace_id
from aerograph_sdk.state_hash import get_deterministic_state_hash


# Type alias for any emittable event model
_TraceEventModel = Union[
    PromptEvent,
    ResponseEvent,
    ToolCallEvent,
    ToolResultEvent,
    HandoffEvent,
    ErrorEvent,
    NoteEvent,
    StateSnapshotEvent,
    RetrieverEvent,
    CheckpointEvent,
]


class EmissionError(Exception):
    """Raised when an event fails to be delivered to the collector."""

    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(f"Failed to emit event: {status_code} {body}")
        self.status_code = status_code
        self.body = body


class FlightRecorder:
    """
    Python SDK entry point for emitting AeroGraph trace events.

    Scoped to a single trace (trace_id). All emitted events share the
    same trace_id and actor identity.

    Args:
        endpoint: Collector base URL (e.g. "http://localhost:4317")
        actor: Agent identity dict with required "id" and optional "name".
        trace_id: Optional stable trace ID. Auto-generated if absent.
        http_client: Optional httpx.Client for testing injection.
        async_http_client: Optional httpx.AsyncClient for async testing injection.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        actor: dict[str, Optional[str]],
        trace_id: Optional[str] = None,
        http_client: Optional[httpx.Client] = None,
        async_http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.actor_id: str = actor["id"]  # type: ignore[assignment]
        self.actor_name: Optional[str] = actor.get("name")
        self.trace_id: str = trace_id or new_trace_id()
        self._http_client = http_client
        self._async_http_client = async_http_client

    # ------------------------------------------------------------------
    # ID helpers
    # ------------------------------------------------------------------

    def new_span_id(self) -> str:
        """Generate a new unique span identifier."""
        return new_span_id()

    def new_trace_id(self) -> str:
        """Generate a new unique trace identifier."""
        return new_trace_id()

    # ------------------------------------------------------------------
    # Low-level emission
    # ------------------------------------------------------------------

    def _serialize_event(self, event: _TraceEventModel) -> str:
        """Serialize event model to JSON string."""
        return event.model_dump_json(exclude_none=False)

    def _get_client(self) -> httpx.Client:
        if self._http_client is not None:
            return self._http_client
        return httpx.Client()

    def _get_async_client(self) -> httpx.AsyncClient:
        if self._async_http_client is not None:
            return self._async_http_client
        return httpx.AsyncClient()

    def emit(self, event: _TraceEventModel) -> _TraceEventModel:
        """
        Emit a single event synchronously.

        Args:
            event: A validated TraceEvent model.

        Returns:
            The same event (for chaining).

        Raises:
            EmissionError: On non-2xx HTTP response.
        """
        body = self._serialize_event(event)
        with self._get_client() as client:
            response = client.post(
                f"{self.endpoint}/v1/events",
                content=body,
                headers={"content-type": "application/json"},
            )
        if not response.is_success:
            raise EmissionError(response.status_code, response.text)
        return event

    async def emit_async(self, event: _TraceEventModel) -> _TraceEventModel:
        """
        Emit a single event asynchronously.

        Args:
            event: A validated TraceEvent model.

        Returns:
            The same event (for chaining).

        Raises:
            EmissionError: On non-2xx HTTP response.
        """
        body = self._serialize_event(event)
        async with self._get_async_client() as client:
            response = await client.post(
                f"{self.endpoint}/v1/events",
                content=body,
                headers={"content-type": "application/json"},
            )
        if not response.is_success:
            raise EmissionError(response.status_code, response.text)
        return event

    def emit_batch(self, events: list[_TraceEventModel]) -> list[_TraceEventModel]:
        """
        Emit multiple events as a single batch request (sync).

        Events are ordered deterministically before sending.

        Args:
            events: List of validated TraceEvent models.

        Returns:
            The same events in deterministic order.

        Raises:
            EmissionError: On non-2xx HTTP response.
        """
        ordered = self._sort_batch(events)
        body = json.dumps([json.loads(e.model_dump_json()) for e in ordered])
        with self._get_client() as client:
            response = client.post(
                f"{self.endpoint}/v1/events",
                content=body,
                headers={"content-type": "application/json"},
            )
        if not response.is_success:
            raise EmissionError(response.status_code, response.text)
        return ordered

    async def emit_batch_async(
        self, events: list[_TraceEventModel]
    ) -> list[_TraceEventModel]:
        """
        Emit multiple events as a single batch request (async).

        Events are ordered deterministically before sending.

        Args:
            events: List of validated TraceEvent models.

        Returns:
            The same events in deterministic order.

        Raises:
            EmissionError: On non-2xx HTTP response.
        """
        ordered = self._sort_batch(events)
        body = json.dumps([json.loads(e.model_dump_json()) for e in ordered])
        async with self._get_async_client() as client:
            response = await client.post(
                f"{self.endpoint}/v1/events",
                content=body,
                headers={"content-type": "application/json"},
            )
        if not response.is_success:
            raise EmissionError(response.status_code, response.text)
        return ordered

    def _sort_batch(self, events: list[_TraceEventModel]) -> list[_TraceEventModel]:
        """Sort events deterministically: occurredAt → spanId → kind."""
        raw = [
            {
                "occurredAt": e.occurredAt,
                "spanId": e.spanId,
                "kind": e.kind,
                "_event": e,
            }
            for e in events
        ]
        sorted_raw = sort_trace_events_deterministic(raw)  # type: ignore[arg-type]
        return [r["_event"] for r in sorted_raw]  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Convenience methods — sync
    # ------------------------------------------------------------------

    def prompt(
        self,
        *,
        text: str,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
    ) -> PromptEvent:
        """Emit a prompt event synchronously."""
        event = build_prompt_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            text=text,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
        )
        self.emit(event)
        return event

    def response(
        self,
        *,
        text: str,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
        status: TraceEventStatus = TraceEventStatus.ok,
        streaming_telemetry: Optional[dict[str, Any]] = None,
    ) -> ResponseEvent:
        """Emit a response event synchronously."""
        event = build_response_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            text=text,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
            status=status,
            streaming_telemetry=streaming_telemetry,
        )
        self.emit(event)
        return event

    def tool_call(
        self,
        *,
        tool_id: str,
        tool_name: Optional[str] = None,
        input: dict[str, Any],  # noqa: A002
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
        status: TraceEventStatus = TraceEventStatus.ok,
    ) -> ToolCallEvent:
        """Emit a tool_call event synchronously."""
        event = build_tool_call_event(
            trace_id=self.trace_id,
            tool_id=tool_id,
            tool_name=tool_name,
            input=input,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
            status=status,
        )
        self.emit(event)
        return event

    def tool_result(
        self,
        *,
        tool_id: str,
        tool_name: Optional[str] = None,
        output: dict[str, Any],
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
        status: TraceEventStatus = TraceEventStatus.ok,
    ) -> ToolResultEvent:
        """Emit a tool_result event synchronously."""
        event = build_tool_result_event(
            trace_id=self.trace_id,
            tool_id=tool_id,
            tool_name=tool_name,
            output=output,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
            status=status,
        )
        self.emit(event)
        return event

    def handoff(
        self,
        *,
        from_agent_id: str,
        to_agent_id: str,
        reason: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
    ) -> HandoffEvent:
        """Emit a handoff event synchronously."""
        event = build_handoff_event(
            trace_id=self.trace_id,
            from_agent_id=from_agent_id,
            to_agent_id=to_agent_id,
            reason=reason,
            parent_span_id=parent_span_id,
            span_id=span_id,
            occurred_at=occurred_at,
            links=links,
        )
        self.emit(event)
        return event

    def error(
        self,
        *,
        message: str,
        details: Optional[dict[str, Any]] = None,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
    ) -> ErrorEvent:
        """Emit an error event synchronously."""
        event = build_error_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            message=message,
            details=details,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
        )
        self.emit(event)
        return event

    def note(
        self,
        *,
        payload: dict[str, Any],
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
        status: TraceEventStatus = TraceEventStatus.ok,
    ) -> NoteEvent:
        """Emit a note event synchronously."""
        event = build_note_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            payload=payload,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
            status=status,
        )
        self.emit(event)
        return event

    def state_snapshot(
        self,
        *,
        node_name: str,
        full_state: dict[str, Any],
        state_diff: Optional[dict[str, Any]] = None,
        removed_keys: Optional[list[str]] = None,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
        status: TraceEventStatus = TraceEventStatus.ok,
    ) -> StateSnapshotEvent:
        """Emit a state_snapshot event synchronously. Computes stateHash automatically."""
        state_hash = get_deterministic_state_hash(full_state)
        event = build_state_snapshot_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            node_name=node_name,
            state_hash=state_hash,
            state_diff=state_diff or {},
            full_state=full_state,
            removed_keys=removed_keys,
            parent_span_id=parent_span_id,
            span_id=span_id,
            occurred_at=occurred_at,
            links=links,
            status=status,
        )
        self.emit(event)
        return event

    def retriever(
        self,
        *,
        tool_id: str,
        tool_name: Optional[str] = None,
        query: str,
        documents: list[dict[str, Any]],
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
        status: TraceEventStatus = TraceEventStatus.ok,
    ) -> RetrieverEvent:
        """Emit a retriever event synchronously."""
        event = build_retriever_event(
            trace_id=self.trace_id,
            tool_id=tool_id,
            tool_name=tool_name,
            query=query,
            documents=documents,
            parent_span_id=parent_span_id,
            span_id=span_id,
            occurred_at=occurred_at,
            links=links,
            status=status,
        )
        self.emit(event)
        return event

    def checkpoint(
        self,
        *,
        checkpoint_id: str,
        reason: str,
        state: dict[str, Any],
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
        status: TraceEventStatus = TraceEventStatus.ok,
    ) -> CheckpointEvent:
        """Emit a checkpoint event synchronously."""
        event = build_checkpoint_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            checkpoint_id=checkpoint_id,
            reason=reason,
            state=state,
            parent_span_id=parent_span_id,
            span_id=span_id,
            occurred_at=occurred_at,
            links=links,
            status=status,
        )
        self.emit(event)
        return event

    # ------------------------------------------------------------------
    # Convenience methods — async
    # ------------------------------------------------------------------

    async def prompt_async(
        self,
        *,
        text: str,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
    ) -> PromptEvent:
        """Emit a prompt event asynchronously."""
        event = build_prompt_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            text=text,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
        )
        await self.emit_async(event)
        return event

    async def response_async(
        self,
        *,
        text: str,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
        status: TraceEventStatus = TraceEventStatus.ok,
        streaming_telemetry: Optional[dict[str, Any]] = None,
    ) -> ResponseEvent:
        """Emit a response event asynchronously."""
        event = build_response_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            text=text,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
            status=status,
            streaming_telemetry=streaming_telemetry,
        )
        await self.emit_async(event)
        return event

    async def error_async(
        self,
        *,
        message: str,
        details: Optional[dict[str, Any]] = None,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        title: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
    ) -> ErrorEvent:
        """Emit an error event asynchronously."""
        event = build_error_event(
            trace_id=self.trace_id,
            actor_id=self.actor_id,
            actor_name=self.actor_name,
            message=message,
            details=details,
            parent_span_id=parent_span_id,
            span_id=span_id,
            title=title,
            occurred_at=occurred_at,
            links=links,
        )
        await self.emit_async(event)
        return event

    # ------------------------------------------------------------------
    # Context manager span helpers
    # ------------------------------------------------------------------

    @contextmanager
    def span(
        self,
        *,
        span_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
    ):
        """
        Context manager for tracking a span lifecycle.

        Yields a dict with ``span_id`` and ``parent_span_id`` for use
        in event builders. Does not emit events automatically — callers
        emit via recorder methods.

        Example:
            with recorder.span(parent_span_id=root_span) as ctx:
                recorder.prompt(parent_span_id=ctx["parent_span_id"], ...)
        """
        sid = span_id or new_span_id()
        yield {"span_id": sid, "parent_span_id": parent_span_id}

    @asynccontextmanager
    async def async_span(
        self,
        *,
        span_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
    ):
        """
        Async context manager for tracking a span lifecycle.

        Yields a dict with ``span_id`` and ``parent_span_id``.
        """
        sid = span_id or new_span_id()
        yield {"span_id": sid, "parent_span_id": parent_span_id}
