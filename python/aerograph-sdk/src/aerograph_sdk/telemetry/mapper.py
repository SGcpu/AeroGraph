"""
python/aerograph-sdk/src/aerograph_sdk/telemetry/mapper.py

Generic canonical telemetry mapper utility (Python).

Provides framework-agnostic helpers to build and validate the canonical
TelemetryModelInfo, TelemetryUsage, and event-level telemetry fields
introduced in schema v1.1.0.

Design principles (from constitution):
  - Adapters call these helpers; they never invent schema fields ad-hoc.
  - All fields are optional — partial data is accepted gracefully.
  - Cost is NOT computed or stored here; it is derived by the analytics layer.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

from aerograph_sdk.contracts import TelemetryModelInfo, TelemetryUsage
from aerograph_sdk.contracts.types import CanonicalTelemetry  # noqa: F401 (re-export for convenience)


# ─── TelemetryBlock dataclass ─────────────────────────────────────────────────

@dataclass
class TelemetryBlock:
    """
    Canonical telemetry block for Python FlightRecorder methods.

    All fields are optional. Pass to prompt() or response() to attach
    canonical v1.1.0 telemetry metadata to a span.

    Usage::

        telemetry = TelemetryBlock(
            model=TelemetryModelInfo(name="gpt-4o", provider="openai"),
            usage=TelemetryUsage(inputTokens=100, outputTokens=50, totalTokens=150),
            duration_ms=1234,
            project_id="my-project",
            environment="production",
            tags={"agent_version": "1.0"},
        )
        recorder.response(text="Hello", parent_span_id=..., telemetry=telemetry)
    """
    model: Optional[TelemetryModelInfo] = None
    usage: Optional[TelemetryUsage] = None
    duration_ms: Optional[int] = None
    project_id: Optional[str] = None
    environment: Optional[str] = None
    tags: Optional[dict] = field(default=None)


# ─── Public surface types ──────────────────────────────────────────────────

RawModelInput = dict  # {name?, provider?, version?}
RawUsageInput = dict  # {inputTokens?, outputTokens?, totalTokens?, cachedTokens?,
                      #  prompt_tokens?, completion_tokens?, total_tokens?}


# ─── Model mapping ─────────────────────────────────────────────────────────

def map_model_info(raw: RawModelInput) -> Optional[TelemetryModelInfo]:
    """
    Build a validated TelemetryModelInfo from raw adapter input.

    Returns None if the input has no usable model name.
    Accepts dict keys: ``name``, ``provider``, ``version``.
    """
    name = (raw.get("name") or "").strip()
    if not name:
        return None

    provider = (raw.get("provider") or "").strip() or None
    version = (raw.get("version") or "").strip() or None

    try:
        return TelemetryModelInfo(name=name, provider=provider, version=version)
    except Exception:
        return None


# ─── Usage mapping ─────────────────────────────────────────────────────────

def map_usage(raw: RawUsageInput) -> Optional[TelemetryUsage]:
    """
    Build a validated TelemetryUsage from raw adapter input.

    Normalizes common framework aliases to canonical field names:
      - ``prompt_tokens``      → ``inputTokens``
      - ``completion_tokens``  → ``outputTokens``
      - ``total_tokens``       → ``totalTokens``

    Returns None if no token count data is available.
    """
    input_tokens = _to_nonneg_int(
        raw.get("inputTokens") if raw.get("inputTokens") is not None
        else raw.get("prompt_tokens")
    )
    output_tokens = _to_nonneg_int(
        raw.get("outputTokens") if raw.get("outputTokens") is not None
        else raw.get("completion_tokens")
    )
    total_tokens = _to_nonneg_int(
        raw.get("totalTokens") if raw.get("totalTokens") is not None
        else raw.get("total_tokens")
    )
    cached_tokens = _to_nonneg_int(raw.get("cachedTokens"))

    # Derive totalTokens if missing but input+output are present
    if total_tokens is None and (input_tokens is not None or output_tokens is not None):
        total_tokens = (input_tokens or 0) + (output_tokens or 0)

    # All fields None → nothing useful to emit
    if all(v is None for v in (input_tokens, output_tokens, total_tokens, cached_tokens)):
        return None

    try:
        return TelemetryUsage(
            inputTokens=input_tokens,
            outputTokens=output_tokens,
            totalTokens=total_tokens,
            cachedTokens=cached_tokens,
        )
    except Exception:
        return None


# ─── Composite builder ─────────────────────────────────────────────────────

def build_canonical_telemetry(
    *,
    model: Optional[RawModelInput] = None,
    usage: Optional[RawUsageInput] = None,
    duration_ms: Optional[float] = None,
    project_id: Optional[str] = None,
    environment: Optional[str] = None,
    tags: Optional[dict[str, str]] = None,
) -> dict:
    """
    Build a canonical telemetry dict ready to be unpacked into a trace event.

    Example::

        telemetry = build_canonical_telemetry(
            model={"name": "gpt-4o", "provider": "openai"},
            usage={"prompt_tokens": 100, "completion_tokens": 50},
            duration_ms=1234.5,
            project_id="my-project",
            environment="production",
            tags={"agent_version": "1.0"},
        )
        event = PromptEvent(**base_fields, **telemetry)

    :returns: Dict with keys model, usage, durationMs, projectId, environment, tags
              (any key with None/empty value is omitted).
    """
    result: dict = {}

    if model is not None:
        mapped = map_model_info(model)
        if mapped is not None:
            result["model"] = mapped

    if usage is not None:
        mapped_usage = map_usage(usage)
        if mapped_usage is not None:
            result["usage"] = mapped_usage

    if duration_ms is not None and duration_ms >= 0:
        result["durationMs"] = max(0, round(duration_ms))

    if project_id and project_id.strip():
        result["projectId"] = project_id.strip()

    if environment and environment.strip():
        result["environment"] = environment.strip()

    if tags:
        result["tags"] = tags

    return result


# ─── Duration helpers ──────────────────────────────────────────────────────

def compute_duration_ms(start_time: Optional[float]) -> Optional[int]:
    """
    Compute elapsed milliseconds from a start timestamp (seconds, as from time.time()).

    :param start_time: Start time in seconds (e.g. ``time.time()`` at span start).
    :returns: Elapsed ms as an int, or None if start_time is None.
    """
    if start_time is None:
        return None
    elapsed = time.time() - start_time
    return max(0, round(elapsed * 1000))


# ─── Internal helpers ──────────────────────────────────────────────────────

def _to_nonneg_int(value) -> Optional[int]:
    """Coerce a value to a non-negative integer, or return None."""
    if value is None:
        return None
    try:
        n = round(float(value))
        return n if n >= 0 else None
    except (TypeError, ValueError):
        return None
