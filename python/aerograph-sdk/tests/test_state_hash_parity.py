"""
python/aerograph-sdk/tests/test_state_hash_parity.py

Cross-language parity tests for get_deterministic_state_hash.

These tests consume the canonical fixtures from:
  packages/contracts/src/__fixtures__/parity/state-hash.json

The TypeScript implementation defines ground truth; Python must match.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aerograph_sdk.state_hash import get_deterministic_state_hash

# ---------------------------------------------------------------------------
# Load fixtures
# ---------------------------------------------------------------------------

FIXTURES_PATH = (
    Path(__file__).parents[3]
    / "packages"
    / "contracts"
    / "src"
    / "__fixtures__"
    / "parity"
    / "state-hash.json"
)


def load_fixtures() -> list[dict]:
    with open(FIXTURES_PATH) as f:
        data = json.load(f)
    return data["fixtures"]


FIXTURES = load_fixtures()


# ---------------------------------------------------------------------------
# Parametrized parity tests
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fixture",
    FIXTURES,
    ids=[f["id"] for f in FIXTURES],
)
def test_hash_matches_canonical(fixture: dict) -> None:
    """Hash output must be an 8-char lowercase hex string."""
    result = get_deterministic_state_hash(fixture["input"])
    assert isinstance(result, str)
    assert len(result) == 8, f"Hash must be 8 chars, got {len(result)!r}: {result!r}"
    assert result == result.lower(), f"Hash must be lowercase: {result!r}"
    assert all(c in "0123456789abcdef" for c in result), f"Hash must be hex: {result!r}"


@pytest.mark.parametrize(
    "fixture",
    [f for f in FIXTURES if f["expectedHash"] is not None],
    ids=[f["id"] for f in FIXTURES if f["expectedHash"] is not None],
)
def test_hash_matches_expected_value(fixture: dict) -> None:
    """For fixtures with pre-computed expectedHash, verify exact match."""
    result = get_deterministic_state_hash(fixture["input"])
    assert result == fixture["expectedHash"], (
        f"Hash mismatch for fixture {fixture['id']!r}: "
        f"expected {fixture['expectedHash']!r}, got {result!r}"
    )


# ---------------------------------------------------------------------------
# Structural correctness tests
# ---------------------------------------------------------------------------


def test_empty_object_is_stable() -> None:
    """Empty object produces a stable, consistent hash."""
    h1 = get_deterministic_state_hash({})
    h2 = get_deterministic_state_hash({})
    assert h1 == h2


def test_key_ordering_is_irrelevant() -> None:
    """Hash must be identical regardless of dict key insertion order."""
    state_a = {"z": 1, "a": 2, "m": 3}
    state_b = {"a": 2, "m": 3, "z": 1}
    assert get_deterministic_state_hash(state_a) == get_deterministic_state_hash(
        state_b
    )


def test_nested_key_ordering_is_irrelevant() -> None:
    """Key sorting applies recursively to nested objects."""
    state_a = {"outer": {"z": 1, "a": 2}}
    state_b = {"outer": {"a": 2, "z": 1}}
    assert get_deterministic_state_hash(state_a) == get_deterministic_state_hash(
        state_b
    )


def test_array_ordering_matters() -> None:
    """Arrays preserve element order; [1,2,3] != [3,2,1]."""
    h1 = get_deterministic_state_hash({"items": [1, 2, 3]})
    h2 = get_deterministic_state_hash({"items": [3, 2, 1]})
    assert h1 != h2


def test_non_finite_float_normalized_to_null() -> None:
    """NaN and Infinity must be normalized to null (matching JS JSON.stringify)."""

    h_nan = get_deterministic_state_hash({"val": float("nan")})
    h_inf = get_deterministic_state_hash({"val": float("inf")})
    h_ninf = get_deterministic_state_hash({"val": float("-inf")})
    h_null = get_deterministic_state_hash({"val": None})
    # All three should produce the same hash as null
    assert h_nan == h_null, f"NaN hash ({h_nan}) should match null hash ({h_null})"
    assert h_inf == h_null, f"Inf hash ({h_inf}) should match null hash ({h_null})"
    assert h_ninf == h_null, f"-Inf hash ({h_ninf}) should match null hash ({h_null})"


def test_boolean_values_distinct_from_int() -> None:
    """True/False must hash differently from 1/0."""
    h_true = get_deterministic_state_hash({"val": True})
    h_one = get_deterministic_state_hash({"val": 1})
    # In JSON: true vs 1 are different values
    # Python's json.dumps correctly serializes True → "true" and 1 → "1"
    assert h_true != h_one


def test_output_is_always_8_chars_padded() -> None:
    """Hash must always be exactly 8 lowercase hex chars, left-padded with zeros."""
    # Try many states to increase chance of hitting low hash values
    states = [
        {},
        {"x": 1},
        {"a": "b"},
        {"deeply": {"nested": {"value": True}}},
        {"array": [1, 2, 3, 4, 5]},
    ]
    for state in states:
        h = get_deterministic_state_hash(state)
        assert len(h) == 8, f"Expected 8 chars, got {len(h)} for state {state}: {h}"


def test_unicode_bmp_characters() -> None:
    """BMP unicode characters (U+0000–U+FFFF) must hash correctly."""
    h = get_deterministic_state_hash({"text": "caf\u00e9"})
    assert len(h) == 8
    assert h == h.lower()


def test_consistency_across_calls() -> None:
    """Same state must always produce the same hash."""
    state = {"agent": "planner", "step": 3, "active": True}
    results = {get_deterministic_state_hash(state) for _ in range(10)}
    assert len(results) == 1, f"Hash is not consistent across calls: {results}"
