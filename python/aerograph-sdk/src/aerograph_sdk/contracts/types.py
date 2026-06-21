"""
python/aerograph-sdk/src/aerograph_sdk/contracts/types.py

Canonical Telemetry Model types for AeroGraph schema v1.1.0.

These types extend every trace event with optional telemetry metadata.
All fields are Optional so that v1.0.0 events remain valid when parsed
by a v1.1.0-aware consumer (backward compatibility).

Cost fields are deliberately absent — cost is DERIVED at analytics time
from model + usage data, never stored in the event.
"""
from __future__ import annotations

from typing import Optional, TypedDict

from pydantic import BaseModel, ConfigDict, Field


class TelemetryModelInfo(BaseModel):
    """Model identity metadata captured at span emission time."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., min_length=1, description="Model name, e.g. 'gpt-4o'")
    provider: Optional[str] = Field(
        default=None, min_length=1, description="Model provider, e.g. 'openai'"
    )
    version: Optional[str] = Field(
        default=None, min_length=1, description="Model version string, e.g. '2024-05-13'"
    )


class TelemetryUsage(BaseModel):
    """Token usage breakdown for a single span.

    cachedTokens is optional: not all frameworks expose cache-hit counts.
    totalTokens should equal inputTokens + outputTokens where available.
    """

    model_config = ConfigDict(extra="forbid")

    inputTokens: Optional[int] = Field(
        default=None, ge=0, description="Number of input (prompt) tokens"
    )
    outputTokens: Optional[int] = Field(
        default=None, ge=0, description="Number of output (completion) tokens"
    )
    totalTokens: Optional[int] = Field(
        default=None, ge=0, description="Total tokens (input + output)"
    )
    cachedTokens: Optional[int] = Field(
        default=None, ge=0, description="Tokens served from cache (if available)"
    )


class TelemetryMetadata(BaseModel):
    """Canonical telemetry metadata block attached to trace events (v1.1.0+).

    All fields are optional — a v1.0.0 event that omits this block
    is handled gracefully by treating all telemetry fields as None.
    """

    model_config = ConfigDict(extra="forbid")

    model: Optional[TelemetryModelInfo] = Field(
        default=None, description="Model identity used for this span"
    )
    usage: Optional[TelemetryUsage] = Field(
        default=None, description="Token usage for this span"
    )
    durationMs: Optional[int] = Field(
        default=None, ge=0, description="Span execution duration in milliseconds"
    )
    projectId: Optional[str] = Field(
        default=None, min_length=1, description="Project identifier for multi-tenant isolation"
    )
    environment: Optional[str] = Field(
        default=None,
        min_length=1,
        description="Deployment environment, e.g. 'development', 'staging', 'production'",
    )
    tags: Optional[dict[str, str]] = Field(
        default=None, description="Arbitrary key-value telemetry tags"
    )




class CanonicalTelemetry(TypedDict, total=False):
    """Structured return type from build_canonical_telemetry.

    Can be unpacked with ``**`` into event constructor kwargs.
    All keys are optional (``total=False``).
    """

    model: TelemetryModelInfo
    usage: TelemetryUsage
    durationMs: int
    projectId: str
    environment: str
    tags: dict[str, str]


__all__ = [
    "TelemetryModelInfo",
    "TelemetryUsage",
    "TelemetryMetadata",
    "CanonicalTelemetry",
]
