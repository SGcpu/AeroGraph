import uuid
from aerograph_langchain.span_ids import derive_span_id


def test_derive_span_id_deterministic():
    """
    Test that the same UUID always produces the same spanId,
    and it is correctly formatted with an 's_' prefix.
    """
    run_id_1 = uuid.UUID("12345678-1234-5678-1234-567812345678")
    run_id_2 = uuid.UUID("87654321-4321-8765-4321-876543210987")

    span_id_1 = derive_span_id(run_id_1)
    span_id_2 = derive_span_id(run_id_2)

    # Must be deterministic
    assert derive_span_id(run_id_1) == span_id_1
    assert derive_span_id(run_id_2) == span_id_2

    # Must be different for different UUIDs
    assert span_id_1 != span_id_2

    # Must have the correct prefix
    assert span_id_1.startswith("s_")

    # Must not contain UUID hyphens or non-urlsafe characters
    # (Testing that it looks like a clean token, base64url or similar)
    assert "-" not in span_id_1[2:]


def test_derive_span_id_string_input():
    """
    Test that derive_span_id handles string UUIDs identically to UUID objects.
    """
    uuid_str = "12345678-1234-5678-1234-567812345678"
    run_id = uuid.UUID(uuid_str)

    assert derive_span_id(run_id) == derive_span_id(uuid_str)
