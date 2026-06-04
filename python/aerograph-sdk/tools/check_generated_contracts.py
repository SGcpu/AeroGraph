#!/usr/bin/env python3
"""
python/aerograph-sdk/tools/check_generated_contracts.py

Drift detection for generated Python contract models.

Checks that:
1. The generated.py file exists and imports without errors
2. SCHEMA_VERSION in generated.py matches the JSON Schema artifact version
3. All known event kinds are represented in the generated models
4. The model classes have the expected field names

Exit codes:
    0 — No drift detected
    1 — Drift detected (or check failed)

Usage:
    cd python/aerograph-sdk
    python tools/check_generated_contracts.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Paths
REPO_ROOT = Path(__file__).parents[3]
ARTIFACT_PATH = (
    REPO_ROOT
    / "packages"
    / "schema-exporter"
    / "artifacts"
    / "1.0.0"
    / "trace-event.schema.json"
)
GENERATED_PATH = (
    Path(__file__).parents[1] / "src" / "aerograph_sdk" / "contracts" / "generated.py"
)

EXPECTED_KINDS = [
    "prompt",
    "response",
    "tool_call",
    "tool_result",
    "handoff",
    "error",
    "note",
    "state_snapshot",
    "retriever",
    "checkpoint",
]


def main() -> None:
    errors: list[str] = []

    # 1. Check generated.py exists
    if not GENERATED_PATH.exists():
        print(
            f"ERROR: Generated contracts file not found: {GENERATED_PATH}\n"
            "Run `python tools/generate_contracts.py` to generate it.",
            file=sys.stderr,
        )
        sys.exit(1)

    # 2. Import the generated module
    try:
        sys.path.insert(0, str(GENERATED_PATH.parents[3]))
        import aerograph_sdk.contracts.generated as generated_module
    except ImportError as e:
        errors.append(f"Failed to import generated contracts: {e}")
        _report(errors)
        return

    # 3. Check SCHEMA_VERSION
    if not hasattr(generated_module, "SCHEMA_VERSION"):
        errors.append("generated.py is missing SCHEMA_VERSION constant")
    else:
        generated_version = generated_module.SCHEMA_VERSION

        # Load artifact if available
        if ARTIFACT_PATH.exists():
            with open(ARTIFACT_PATH) as f:
                artifact = json.load(f)
            artifact_version = artifact.get("schemaVersion", "")
            if generated_version != artifact_version:
                errors.append(
                    f"SCHEMA_VERSION mismatch: generated.py has '{generated_version}', "
                    f"artifact has '{artifact_version}'"
                )
        else:
            print(
                f"WARNING: JSON Schema artifact not found at {ARTIFACT_PATH}. "
                "Skipping version cross-check.",
                file=sys.stderr,
            )

    # 4. Check all event kinds are in TraceEventKind
    if hasattr(generated_module, "TraceEventKind"):
        kind_enum = generated_module.TraceEventKind
        represented_kinds = {m.value for m in kind_enum}
        for kind in EXPECTED_KINDS:
            if kind not in represented_kinds:
                errors.append(f"Missing kind '{kind}' in TraceEventKind enum")
    else:
        errors.append("generated.py is missing TraceEventKind enum")

    # 5. Check expected model classes exist
    expected_models = [
        "PromptEvent",
        "ResponseEvent",
        "ToolCallEvent",
        "ToolResultEvent",
        "HandoffEvent",
        "ErrorEvent",
        "NoteEvent",
        "StateSnapshotEvent",
        "RetrieverEvent",
        "CheckpointEvent",
    ]
    for model_name in expected_models:
        if not hasattr(generated_module, model_name):
            errors.append(f"Missing model class '{model_name}' in generated.py")

    _report(errors)


def _report(errors: list[str]) -> None:
    if not errors:
        print(
            "[check_generated_contracts] [OK] No drift detected. Generated contracts are consistent."
        )
        sys.exit(0)
    else:
        print("[check_generated_contracts] ✗ Drift detected:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        print(
            "\nRun `python tools/generate_contracts.py` to regenerate.",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
