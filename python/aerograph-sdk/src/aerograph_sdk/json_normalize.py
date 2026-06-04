"""
python/aerograph-sdk/src/aerograph_sdk/json_normalize.py

JSON-compatibility normalization helpers.

These functions ensure that Python values can be safely serialized to JSON
in a way compatible with JavaScript's JSON.stringify, enabling cross-language
deterministic hashing and event serialization.
"""

from __future__ import annotations

import math
from typing import Any


def normalize_for_json(value: Any) -> Any:
    """
    Recursively normalize a value to a JSON-compatible representation.

    Rules:
    - dict: keys preserved, values recursively normalized
    - list/tuple: elements recursively normalized, tuple becomes list
    - float NaN/Infinity/-Infinity: normalized to None (matching JS JSON.stringify)
    - int/bool/str/None: returned as-is
    - Unrecognized types: raise TypeError

    Note: bool must be checked before int since bool is a subclass of int.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return {str(k): normalize_for_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize_for_json(item) for item in value]
    raise TypeError(
        f"Value of type {type(value).__name__!r} is not JSON-compatible. "
        "Convert or exclude it before emission."
    )


def normalize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Normalize an event payload dict for safe JSON serialization.
    Returns a new dict with all values normalized.
    """
    result = normalize_for_json(payload)
    if not isinstance(result, dict):
        raise TypeError("Payload must be a dict")
    return result
