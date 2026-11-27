"""
python/aerograph-sdk/src/aerograph_sdk/__init__.py

Public API for the aerograph-sdk package.
"""

from aerograph_sdk.recorder import FlightRecorder, EmissionError
from aerograph_sdk.context import (
    span_context,
    child_branch_id,
    get_current_span_id,
    get_current_branch_id,
)
from aerograph_sdk.ids import new_trace_id, new_span_id
from aerograph_sdk.state_hash import get_deterministic_state_hash, compute_state_diff
from aerograph_sdk.events import compare_trace_events, sort_trace_events_deterministic
from aerograph_sdk.contracts import SCHEMA_VERSION

__version__ = "0.4.0"

# Ensure HTTP/vector hooks are active whenever running under AeroGraph Orchestrator/CLI
import os as _os
if _os.environ.get("AEROGRAPH_MODE") or _os.environ.get("AEROREPL_MODE"):
    try:
        from aerograph_sdk.shim import sitecustomize as _shim  # noqa: F401
        _shim._install_import_hooks()
    except Exception:
        pass

__all__ = [
    "FlightRecorder",
    "EmissionError",
    "span_context",
    "child_branch_id",
    "get_current_span_id",
    "get_current_branch_id",
    "new_trace_id",
    "new_span_id",
    "get_deterministic_state_hash",
    "compute_state_diff",
    "compare_trace_events",
    "sort_trace_events_deterministic",
    "SCHEMA_VERSION",
]
