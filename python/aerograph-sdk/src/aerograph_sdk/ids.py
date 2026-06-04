"""
python/aerograph-sdk/src/aerograph_sdk/ids.py

ID generation helpers for trace and span identifiers.

Mirrors the TypeScript SDK behavior:
- traceId: "t_" + random token
- spanId:  "s_" + random token

Uses secrets.token_urlsafe for cryptographically secure random IDs.
"""

from __future__ import annotations

import secrets


_ID_BYTES = 16  # 128 bits → 22 chars base64url (same entropy as nanoid's default)


def new_trace_id() -> str:
    """
    Generate a new unique trace identifier.

    Returns a string of the form ``t_<random>`` where the random part
    is a URL-safe base64 token with ~128 bits of entropy.
    """
    return f"t_{secrets.token_urlsafe(_ID_BYTES)}"


def new_span_id() -> str:
    """
    Generate a new unique span identifier.

    Returns a string of the form ``s_<random>`` where the random part
    is a URL-safe base64 token with ~128 bits of entropy.
    """
    return f"s_{secrets.token_urlsafe(_ID_BYTES)}"
