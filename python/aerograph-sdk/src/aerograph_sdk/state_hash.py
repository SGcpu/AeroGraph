"""
python/aerograph-sdk/src/aerograph_sdk/state_hash.py

Deterministic state hashing — JS UTF-16 FNV-1a parity implementation.

Contract (from specs/003-python-support/contracts/deterministic-hashing.md):

1. Recursively sort object keys ascending (arrays preserve order).
2. serialized = json.dumps(sorted_state, separators=(',', ':'))
3. Compute 32-bit FNV-1a over the string's UTF-16 code units via JS charCodeAt().
4. Return lowercase hex string padded to 8 characters.

This MUST produce byte-for-byte identical output to
@aerograph/contracts:getDeterministicStateHash for the same input.
"""

from __future__ import annotations

import json
import math
from typing import Any, Mapping


# ---------------------------------------------------------------------------
# Canonical serialization
# ---------------------------------------------------------------------------


def _sort_keys_recursive(obj: Any) -> Any:
    """
    Recursively sort dict keys lexicographically (matching JS Array.prototype.sort).
    Arrays preserve their order; each element is recursively sorted.
    """
    if obj is None:
        return None
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, (int, float, str)):
        return obj
    if isinstance(obj, dict):
        return {k: _sort_keys_recursive(obj[k]) for k in sorted(obj.keys())}
    if isinstance(obj, (list, tuple)):
        return [_sort_keys_recursive(item) for item in obj]
    return obj


def _normalize_float(value: float) -> Any:
    """
    Normalize non-finite floats to None, matching JS JSON.stringify behavior.
    """
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def _normalize_for_hash(obj: Any) -> Any:
    """
    Normalize values for deterministic hashing, handling non-finite floats.
    """
    if obj is None:
        return None
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        return _normalize_float(obj)
    if isinstance(obj, int):
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        sorted_obj = {k: _normalize_for_hash(obj[k]) for k in sorted(obj.keys())}
        return sorted_obj
    if isinstance(obj, (list, tuple)):
        return [_normalize_for_hash(item) for item in obj]
    return obj


def _canonicalize(state: Mapping[str, Any]) -> str:
    """
    Produce the canonical JSON string for a state mapping.

    Rules:
    - Sort keys lexicographically at every level (ascending)
    - Preserve array ordering
    - No whitespace separators (compact output matching JS JSON.stringify)
    - Non-finite floats → null
    """
    normalized = _normalize_for_hash(dict(state))
    return json.dumps(normalized, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# FNV-1a 32-bit over UTF-16 code units
# ---------------------------------------------------------------------------


def _fnv1a_32_utf16(s: str) -> int:
    """
    Compute 32-bit FNV-1a over the UTF-16 code units of a Python string.

    JavaScript's String.prototype.charCodeAt(i) returns UTF-16 code units:
    - For BMP characters (U+0000 to U+FFFF): single code unit (same as ord())
    - For supplementary characters (above U+FFFF): two surrogate code units

    Python's encode('utf-16-le') produces the same two-byte-per-code-unit
    representation. We read each pair of bytes as a little-endian 16-bit uint,
    matching charCodeAt().
    """
    # Encode to UTF-16 LE (no BOM) — each code unit is 2 bytes, little-endian
    encoded = s.encode("utf-16-le")

    h = 0x811C9DC5  # FNV offset basis

    for i in range(0, len(encoded), 2):
        # Read little-endian 16-bit code unit
        code_unit = encoded[i] | (encoded[i + 1] << 8)
        h ^= code_unit
        # Multiply by FNV prime, keep only 32 bits (unsigned)
        h = (h * 0x01000193) & 0xFFFFFFFF

    return h


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_deterministic_state_hash(state: Mapping[str, Any]) -> str:
    """
    Compute a deterministic 32-bit hash of the given state mapping.

    This function MUST produce byte-for-byte identical output to
    ``getDeterministicStateHash`` in ``@aerograph/contracts``.

    Args:
        state: A JSON-compatible mapping (dict with string keys).
               Non-finite floats are normalized to null.
               Non-JSON-native values (bytes, datetimes, custom classes)
               must be converted by the caller before calling this function.

    Returns:
        A lowercase 8-character hexadecimal string (e.g. ``"deadbeef"``).

    Raises:
        TypeError: If state contains non-JSON-native values.
    """
    canonical = _canonicalize(state)
    h = _fnv1a_32_utf16(canonical)
    return format(h, "08x")


def compute_state_diff(
    prev_state: Mapping[str, Any],
    current_state: Mapping[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    """
    Compute a diff between two state snapshots.

    Returns:
        (state_diff, removed_keys) where:
        - state_diff: dict of changed/added keys with their new values
        - removed_keys: list of keys present in prev_state but absent in current_state
    """
    diff: dict[str, Any] = {}
    removed_keys: list[str] = []

    # Find added and changed keys
    for key, value in current_state.items():
        prev_value = prev_state.get(key)
        current_canonical = _canonicalize({key: value}) if value is not None else "null"
        prev_canonical = (
            _canonicalize({key: prev_value}) if prev_value is not None else "null"
        )
        if current_canonical != prev_canonical:
            diff[key] = value

    # Find removed keys
    for key in prev_state:
        if key not in current_state:
            removed_keys.append(key)

    return diff, removed_keys
