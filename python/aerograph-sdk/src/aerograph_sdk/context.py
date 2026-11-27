"""
python/aerograph-sdk/src/aerograph_sdk/context.py

Span & branch context propagation for WP-1 (X-AeroGraph-Span-Id,
X-AeroGraph-Branch-Id, X-AeroGraph-Local-Seq) using contextvars.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

_current_span_id: ContextVar[Optional[str]] = ContextVar("aerograph_span_id", default=None)
_current_branch_id: ContextVar[str] = ContextVar("aerograph_branch_id", default="root")
_seq_lock = threading.Lock()
_branch_seq_counters: dict[str, int] = {}


def get_current_span_id() -> Optional[str]:
    """Return the active span ID in the current async/thread context."""
    return _current_span_id.get()


def get_current_branch_id() -> str:
    """Return the active deterministic branch path in the current context."""
    return _current_branch_id.get()


def next_local_seq(branch_id: Optional[str] = None) -> int:
    """Return and increment the monotonic per-branch sequence counter."""
    bid = branch_id or get_current_branch_id()
    with _seq_lock:
        seq = _branch_seq_counters.get(bid, 0)
        _branch_seq_counters[bid] = seq + 1
        return seq


def reset_branch_counters() -> None:
    """Reset per-branch sequence counters (primarily for tests)."""
    with _seq_lock:
        _branch_seq_counters.clear()


def child_branch_id(
    name: str,
    index: Optional[int] = None,
    parent_branch: Optional[str] = None,
) -> str:
    """Build a deterministic branch path (e.g. root.rag_fanout[0])."""
    parent = parent_branch or get_current_branch_id()
    suffix = f"[{index}]" if index is not None else ""
    return f"{parent}.{name}{suffix}"


@contextmanager
def span_context(
    span_id: Optional[str],
    branch_id: Optional[str] = None,
) -> Iterator[None]:
    """Bind span_id (and optional branch_id) for the duration of a block."""
    t_span = _current_span_id.set(span_id)
    t_branch = _current_branch_id.set(branch_id) if branch_id is not None else None
    try:
        yield
    finally:
        _current_span_id.reset(t_span)
        if t_branch is not None:
            _current_branch_id.reset(t_branch)
