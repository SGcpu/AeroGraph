import base64
import uuid
from typing import Union


def derive_span_id(run_id: Union[uuid.UUID, str]) -> str:
    """
    Derives a deterministic AeroGraph spanId from a LangChain run ID (UUID).

    AeroGraph span IDs are typically 's_' followed by a random url-safe base64 token.
    For LangChain, we want the span ID to be deterministic based on the run ID.
    We take the 16 bytes of the UUID and encode them as url-safe base64 without padding.

    Args:
        run_id: The LangChain run ID, either as a UUID object or a string.

    Returns:
        A deterministic span ID string starting with 's_'.
    """
    if isinstance(run_id, str):
        run_id = uuid.UUID(run_id)

    # urlsafe_b64encode returns bytes, decode to string, and strip the padding '='
    token = base64.urlsafe_b64encode(run_id.bytes).decode("ascii").rstrip("=")

    return f"s_{token}"
