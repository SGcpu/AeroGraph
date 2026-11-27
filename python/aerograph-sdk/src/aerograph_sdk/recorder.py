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

import atexit
from collections import deque
import gzip
import json
import os
import sys
import threading
import time
import warnings
from contextlib import contextmanager, asynccontextmanager
from typing import Any, Optional, Union

import httpx

from aerograph_sdk.context import get_current_branch_id
from aerograph_sdk.contracts.generated import (
    CheckpointEvent,
    ErrorEvent,
    HandoffEvent,
    HumanInputEvent,
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
    build_human_input_event,
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
from aerograph_sdk.telemetry.mapper import TelemetryBlock  # noqa: F401 (re-exported)


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
    HumanInputEvent,
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
        project_id: Optional[str] = None,
        environment: Optional[str] = None,
        http_client: Optional[httpx.Client] = None,
        async_http_client: Optional[httpx.AsyncClient] = None,
        capture_runtime: Optional[bool] = None,
        strict_telemetry: Optional[bool] = None,
        batch_size: int = 20,
        flush_interval_ms: int = 50,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.actor_id: str = actor["id"]  # type: ignore[assignment]
        self.actor_name: Optional[str] = actor.get("name")
        self.trace_id: str = trace_id or new_trace_id()
        self.project_id: Optional[str] = project_id
        self.environment: Optional[str] = environment
        self._http_client = http_client
        self._async_http_client = async_http_client
        self._runtime_metadata_registered: bool = False
        self.strict_telemetry = (
            strict_telemetry
            if strict_telemetry is not None
            else os.getenv("AEROGRAPH_STRICT_TELEMETRY", "false").lower() in ("true", "1")
        )
        self._batch_size = max(1, batch_size)
        self._flush_interval_s = max(0.01, flush_interval_ms / 1000.0)
        self._queue: deque[dict[str, Any]] = deque(maxlen=4096)
        self._queue_lock = threading.Lock()
        self._flush_event = threading.Event()
        self._stop_event = threading.Event()
        self._worker_thread: Optional[threading.Thread] = None
        if capture_runtime is None:
            is_pytest = "PYTEST_CURRENT_TEST" in os.environ
            self.capture_runtime = (not is_pytest) and os.getenv("AEROGRAPH_CAPTURE_RUNTIME", "true").lower() in ("true", "1")
        else:
            self.capture_runtime = capture_runtime

        # Enable background async ring-buffer batching only when using real HTTP transport
        self._use_background_batcher = (
            self._http_client is None
            and self._async_http_client is None
            and not self.strict_telemetry
            and "PYTEST_CURRENT_TEST" not in os.environ
        )
        if self._use_background_batcher:
            self._start_worker()
            atexit.register(self.flush)

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
        """Serialize event model to JSON string.

        Uses exclude_none=True so that optional fields that are None are omitted
        from the JSON body entirely. The collector's Zod schema uses .optional()
        (not .nullable()), meaning absent is valid but null is rejected.
        """
        import json as _json
        data = self._event_to_dict(event)
        return _json.dumps(data)

    def _event_to_dict(self, event: _TraceEventModel) -> dict:
        """Convert event to a JSON-safe dict applying Zod nullability rules.

        Uses model_dump_json (Pydantic's serializer, which handles datetime/enum
        correctly) then parses back to a dict. This avoids TypeError for datetime
        objects that plain json.dumps cannot handle.

        parentSpanId must be present as null for root spans (.nullable() in Zod).
        """
        import json as _json
        data = _json.loads(event.model_dump_json(exclude_none=True))
        if event.parentSpanId is None and "parentSpanId" not in data:
            data["parentSpanId"] = None
        
        if self.project_id is not None and "projectId" not in data:
            data["projectId"] = self.project_id
        if self.environment is not None and "environment" not in data:
            data["environment"] = self.environment
        branch_id = get_current_branch_id()
        if branch_id and branch_id != "root" and "branchId" not in data:
            data["branchId"] = branch_id

        return data

    def _get_client(self) -> httpx.Client:
        if self._http_client is not None:
            return self._http_client
        return httpx.Client()

    def _get_async_client(self) -> httpx.AsyncClient:
        if self._async_http_client is not None:
            return self._async_http_client
        return httpx.AsyncClient()

    def _collect_runtime_metadata(self) -> dict[str, Any]:
        """Collect current execution context (working dir, venv, command)."""
        project_root = os.getcwd()
        virtual_env = os.environ.get("VIRTUAL_ENV") or os.environ.get("CONDA_PREFIX")
        if not virtual_env and hasattr(sys, "base_prefix") and sys.prefix != sys.base_prefix:
            virtual_env = sys.prefix

        executable_path = sys.executable
        entrypoint: Optional[str] = None
        command: Optional[list[str]] = None

        if sys.argv and len(sys.argv) > 0 and sys.argv[0]:
            raw_entry = sys.argv[0]
            if os.path.isabs(raw_entry):
                try:
                    rel = os.path.relpath(raw_entry, project_root)
                    if not rel.startswith(".."):
                        entrypoint = rel
                    else:
                        entrypoint = raw_entry
                except Exception:
                    entrypoint = raw_entry
            else:
                entrypoint = raw_entry

            if entrypoint.endswith(".py"):
                command = ["python", entrypoint, *sys.argv[1:]]
            else:
                command = list(sys.argv)

        meta: dict[str, Any] = {
            "projectRoot": project_root,
        }
        if virtual_env:
            meta["virtualEnv"] = virtual_env
        if executable_path:
            meta["executablePath"] = executable_path
        if entrypoint:
            meta["entrypoint"] = entrypoint
        if command:
            meta["command"] = command

        return meta

    def _register_runtime_metadata_sync(self) -> None:
        """Register runtime execution metadata with the collector synchronously."""
        self._runtime_metadata_registered = True
        try:
            meta = self._collect_runtime_metadata()
            url = f"{self.endpoint}/v1/traces/{self.trace_id}/runtime-metadata"
            if self._http_client is not None:
                self._http_client.post(
                    url,
                    json=meta,
                    headers={"content-type": "application/json"},
                )
            else:
                with httpx.Client(timeout=2.0) as client:
                    client.post(
                        url,
                        json=meta,
                        headers={"content-type": "application/json"},
                    )
        except Exception:
            # Non-blocking best-effort registration
            pass

    async def _register_runtime_metadata_async(self) -> None:
        """Register runtime execution metadata with the collector asynchronously."""
        self._runtime_metadata_registered = True
        try:
            meta = self._collect_runtime_metadata()
            url = f"{self.endpoint}/v1/traces/{self.trace_id}/runtime-metadata"
            if self._async_http_client is not None:
                await self._async_http_client.post(
                    url,
                    json=meta,
                    headers={"content-type": "application/json"},
                )
            else:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    await client.post(
                        url,
                        json=meta,
                        headers={"content-type": "application/json"},
                    )
        except Exception:
            # Non-blocking best-effort registration
            pass

    def register_runtime_metadata(self) -> None:
        """Explicitly register runtime execution metadata with the collector."""
        self._register_runtime_metadata_sync()

    async def register_runtime_metadata_async(self) -> None:
        """Explicitly register runtime execution metadata with the collector asynchronously."""
        await self._register_runtime_metadata_async()

    def _start_worker(self) -> None:
        if self._worker_thread is not None and self._worker_thread.is_alive():
            return
        self._worker_thread = threading.Thread(
            target=self._batch_worker_loop,
            name="aerograph-telemetry-flush",
            daemon=True,
        )
        self._worker_thread.start()

    def _batch_worker_loop(self) -> None:
        while not self._stop_event.is_set():
            self._flush_event.wait(timeout=self._flush_interval_s)
            self._flush_event.clear()
            self._drain_and_send()
        self._drain_and_send()

    def _drain_and_send(self) -> None:
        while True:
            batch: list[dict[str, Any]] = []
            with self._queue_lock:
                while self._queue and len(batch) < self._batch_size:
                    batch.append(self._queue.popleft())
            if not batch:
                return
            self._post_batch_with_retry(batch)

    def _post_batch_with_retry(self, batch: list[dict[str, Any]]) -> None:
        payload_bytes = json.dumps({"events": batch}).encode("utf-8")
        gz_bytes = gzip.compress(payload_bytes)
        headers = {
            "content-type": "application/json",
            "content-encoding": "gzip",
        }
        url = f"{self.endpoint}/v1/events"
        delays = (0.1, 0.2, 0.4)
        for attempt in range(len(delays) + 1):
            try:
                with httpx.Client(timeout=5.0) as client:
                    resp = client.post(url, content=gz_bytes, headers=headers)
                if resp.is_success:
                    return
                if 400 <= resp.status_code < 500 and resp.status_code != 429:
                    warnings.warn(f"[AeroGraph] Dropping {len(batch)} telemetry event(s): HTTP {resp.status_code}")
                    return
            except Exception as exc:
                if attempt == len(delays):
                    warnings.warn(f"[AeroGraph] Collector unreachable, dropping {len(batch)} event(s): {exc}")
                    return
            if attempt < len(delays):
                time.sleep(delays[attempt])

    def flush(self, timeout: float = 2.0) -> None:
        """Flush any queued background telemetry events."""
        if not self._use_background_batcher:
            return
        self._drain_and_send()

    def close(self) -> None:
        """Flush and stop the background telemetry worker."""
        if not self._use_background_batcher:
            return
        self._stop_event.set()
        self._flush_event.set()
        if self._worker_thread is not None and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=2.0)

    def emit(self, event: _TraceEventModel) -> _TraceEventModel:
        """
        Emit a single event synchronously (or enqueue when background batching is active).
        """
        if self.capture_runtime and not self._runtime_metadata_registered:
            self._register_runtime_metadata_sync()

        if self._use_background_batcher:
            with self._queue_lock:
                self._queue.append(self._event_to_dict(event))
                should_signal = len(self._queue) >= self._batch_size
            if should_signal:
                self._flush_event.set()
            return event

        body = self._serialize_event(event)
        if self._http_client is not None:
            response = self._http_client.post(
                f"{self.endpoint}/v1/events",
                content=body,
                headers={"content-type": "application/json"},
            )
        else:
            with httpx.Client() as client:
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
        Emit a single event asynchronously (or enqueue when background batching is active).
        """
        if self.capture_runtime and not self._runtime_metadata_registered:
            await self._register_runtime_metadata_async()

        if self._use_background_batcher:
            with self._queue_lock:
                self._queue.append(self._event_to_dict(event))
                should_signal = len(self._queue) >= self._batch_size
            if should_signal:
                self._flush_event.set()
            return event

        body = self._serialize_event(event)
        if self._async_http_client is not None:
            response = await self._async_http_client.post(
                f"{self.endpoint}/v1/events",
                content=body,
                headers={"content-type": "application/json"},
            )
        else:
            async with httpx.AsyncClient() as client:
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
        if self.capture_runtime and not self._runtime_metadata_registered:
            self._register_runtime_metadata_sync()

        ordered = self._sort_batch(events)
        body = json.dumps([self._event_to_dict(e) for e in ordered])
        if self._http_client is not None:
            response = self._http_client.post(
                f"{self.endpoint}/v1/events",
                content=body,
                headers={"content-type": "application/json"},
            )
        else:
            with httpx.Client() as client:
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
        if self.capture_runtime and not self._runtime_metadata_registered:
            await self._register_runtime_metadata_async()

        ordered = self._sort_batch(events)
        body = json.dumps([self._event_to_dict(e) for e in ordered])
        if self._async_http_client is not None:
            response = await self._async_http_client.post(
                f"{self.endpoint}/v1/events",
                content=body,
                headers={"content-type": "application/json"},
            )
        else:
            async with httpx.AsyncClient() as client:
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
        telemetry: Optional["TelemetryBlock"] = None,
        model: Optional[Any] = None,
        **kwargs: Any,
    ) -> PromptEvent:
        """Emit a prompt event synchronously.

        Args:
            telemetry: Optional canonical telemetry block (v1.1.0). Adds
                model metadata and event-level fields (durationMs, projectId,
                environment, tags) to the emitted event.
        """
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
            telemetry=telemetry,
            model=model,
            **kwargs,
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
        telemetry: Optional["TelemetryBlock"] = None,
        model: Optional[Any] = None,
        **kwargs: Any,
    ) -> ResponseEvent:
        """Emit a response event synchronously.

        Args:
            telemetry: Optional canonical telemetry block (v1.1.0). Adds
                model metadata, token usage, and event-level fields.
        """
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
            telemetry=telemetry,
            model=model,
            **kwargs,
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
        telemetry: Optional["TelemetryBlock"] = None,
        model: Optional[Any] = None,
        **kwargs: Any,
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
            telemetry=telemetry,
            model=model,
            **kwargs,
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
        telemetry: Optional["TelemetryBlock"] = None,
        model: Optional[Any] = None,
        **kwargs: Any,
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
            telemetry=telemetry,
            model=model,
            **kwargs,
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
        branch_id: Optional[str] = None,
    ):
        """
        Context manager for tracking a span lifecycle and propagating span/branch context.
        """
        from aerograph_sdk.context import span_context

        sid = span_id or new_span_id()
        with span_context(sid, branch_id):
            yield {"span_id": sid, "parent_span_id": parent_span_id, "branch_id": branch_id}

    @asynccontextmanager
    async def async_span(
        self,
        *,
        span_id: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        branch_id: Optional[str] = None,
    ):
        """
        Async context manager for tracking a span lifecycle and propagating span/branch context.
        """
        from aerograph_sdk.context import span_context

        sid = span_id or new_span_id()
        with span_context(sid, branch_id):
            yield {"span_id": sid, "parent_span_id": parent_span_id, "branch_id": branch_id}

    def human_input(
        self,
        *,
        turn: int,
        prompt: str,
        text: str,
        channel: str = "stdin",
        edited: Optional[bool] = None,
        parent_span_id: Optional[str] = None,
        span_id: Optional[str] = None,
        occurred_at: Optional[str] = None,
        links: Optional[list[TraceLink]] = None,
    ) -> HumanInputEvent:
        """Emit a human_input event synchronously."""
        event = build_human_input_event(
            trace_id=self.trace_id,
            turn=turn,
            prompt=prompt,
            text=text,
            channel=channel,
            edited=edited,
            parent_span_id=parent_span_id,
            span_id=span_id,
            occurred_at=occurred_at,
            links=links,
        )
        self.emit(event)
        return event
