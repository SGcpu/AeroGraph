"""
python/aerograph-sdk/src/aerograph_sdk/__init__.py

Public API for the aerograph-sdk package.
"""

from aerograph_sdk.recorder import FlightRecorder, EmissionError
from aerograph_sdk.ids import new_trace_id, new_span_id
from aerograph_sdk.state_hash import get_deterministic_state_hash, compute_state_diff
from aerograph_sdk.events import compare_trace_events, sort_trace_events_deterministic
from aerograph_sdk.contracts import SCHEMA_VERSION

__version__ = "0.2.0"

__all__ = [
    "FlightRecorder",
    "EmissionError",
    "new_trace_id",
    "new_span_id",
    "get_deterministic_state_hash",
    "compute_state_diff",
    "compare_trace_events",
    "sort_trace_events_deterministic",
    "SCHEMA_VERSION",
]
