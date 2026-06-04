"""
python/aerograph-sdk/tests/test_event_ordering.py

Cross-language ordering parity tests.

These tests consume the canonical fixtures from:
  packages/contracts/src/__fixtures__/parity/event-ordering.json

The TypeScript compareTraceEvents defines ground truth; Python must match.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aerograph_sdk.events import compare_trace_events, sort_trace_events_deterministic

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
    / "event-ordering.json"
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
def test_ordering_matches_canonical(fixture: dict) -> None:
    """Python sort must produce same order as TypeScript sortTraceEventsDeterministic."""
    sorted_events = sort_trace_events_deterministic(fixture["input"])
    result_keys = [
        f"{e['occurredAt']}|{e['spanId']}|{e['kind']}" for e in sorted_events
    ]
    expected_keys = [
        f"{e['occurredAt']}|{e['spanId']}|{e['kind']}" for e in fixture["expected"]
    ]
    assert result_keys == expected_keys, (
        f"Ordering mismatch for fixture {fixture['id']!r}:\n"
        f"  expected: {expected_keys}\n"
        f"  got:      {result_keys}"
    )


# ---------------------------------------------------------------------------
# Unit tests for compare_trace_events
# ---------------------------------------------------------------------------


def test_compare_different_timestamps() -> None:
    """Earlier occurredAt sorts before later."""
    a = {"occurredAt": "2026-01-01T00:00:00.000Z", "spanId": "s1", "kind": "prompt"}
    b = {"occurredAt": "2026-01-02T00:00:00.000Z", "spanId": "s1", "kind": "prompt"}
    assert compare_trace_events(a, b) < 0
    assert compare_trace_events(b, a) > 0


def test_compare_same_timestamp_different_spanid() -> None:
    """When timestamps equal, sort by spanId ascending."""
    ts = "2026-05-31T00:00:00.000Z"
    a = {"occurredAt": ts, "spanId": "s_aaa", "kind": "prompt"}
    b = {"occurredAt": ts, "spanId": "s_zzz", "kind": "prompt"}
    assert compare_trace_events(a, b) < 0
    assert compare_trace_events(b, a) > 0


def test_compare_same_timestamp_same_spanid_different_kind() -> None:
    """When timestamps and spanId equal, sort by kind ascending."""
    ts = "2026-05-31T00:00:00.000Z"
    sid = "s_1"
    a = {"occurredAt": ts, "spanId": sid, "kind": "note"}
    b = {"occurredAt": ts, "spanId": sid, "kind": "prompt"}
    assert compare_trace_events(a, b) < 0  # note < prompt lexicographically
    assert compare_trace_events(b, a) > 0


def test_compare_identical_returns_zero() -> None:
    """Identical events compare as equal."""
    e = {"occurredAt": "2026-05-31T00:00:00.000Z", "spanId": "s1", "kind": "prompt"}
    assert compare_trace_events(e, e) == 0


def test_sort_is_stable_for_same_key() -> None:
    """Events with identical (occurredAt, spanId, kind) maintain relative order (stable sort)."""
    ts = "2026-05-31T00:00:00.000Z"
    events = [
        {"occurredAt": ts, "spanId": "s1", "kind": "prompt", "n": 1},
        {"occurredAt": ts, "spanId": "s1", "kind": "prompt", "n": 2},
    ]
    sorted_events = sort_trace_events_deterministic(events)  # type: ignore[arg-type]
    # Python's sort is stable; order within equal elements is preserved
    assert sorted_events[0]["n"] == 1
    assert sorted_events[1]["n"] == 2


def test_sort_empty_list() -> None:
    """Sorting an empty list returns an empty list."""
    assert sort_trace_events_deterministic([]) == []


def test_sort_single_event() -> None:
    """Sorting a single-event list returns it unchanged."""
    events = [
        {"occurredAt": "2026-05-31T00:00:00.000Z", "spanId": "s1", "kind": "prompt"}
    ]
    result = sort_trace_events_deterministic(events)  # type: ignore[arg-type]
    assert len(result) == 1
    assert result[0]["spanId"] == "s1"
