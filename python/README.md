# Python Packages

This directory contains the Python distribution packages for AeroGraph.

## Packages

| Package | Directory | PyPI Name | Description |
|---------|-----------|-----------|-------------|
| aerograph-sdk | `aerograph-sdk/` | `aerograph-sdk` | Core Python SDK for emitting AeroGraph trace events |
| aerograph-langchain | `aerograph-langchain/` | `aerograph-langchain` | LangChain callback adapter for AeroGraph |

## Architecture

Python packages are **strictly isolated** from the Node.js workspace:

- Python code does **not** become a runtime dependency of Node packages.
- Python packages do **not** require Node.js to install or run.
- Python packages import `aerograph_sdk` (Python) not `@aerograph/sdk` (npm).
- Contract governance is maintained via JSON Schema artifacts exported by `packages/schema-exporter`.

## Quickstart (Contributors)

```bash
# Install the Python SDK in editable mode
cd python/aerograph-sdk
pip install -e ".[dev]"

# Install the LangChain adapter (also installs aerograph-sdk from the local repo)
cd python/aerograph-langchain
pip install -e ".[dev]"
```

## Running Python Tests

```bash
# From repo root, run all Python SDK tests
cd python/aerograph-sdk
pytest

# Run integration tests (requires collector running)
pytest tests_integration/

# From repo root, run langchain adapter tests
cd python/aerograph-langchain
pytest
```

## Contract Governance

Python models are **generated** from the JSON Schema artifacts produced by `packages/schema-exporter`. 

To regenerate Python models after a schema change:

```bash
# 1. Regenerate JSON Schema artifacts
npm run schema:export -w @aerograph/schema-exporter

# 2. Regenerate Python Pydantic models
cd python/aerograph-sdk
python tools/generate_contracts.py

# 3. Verify no drift
python tools/check_generated_contracts.py
```

See `docs/architecture/contract-governance.md` for the full governance workflow.

## Package Boundaries

```
@aerograph/contracts   (TypeScript, Zod) — canonical source of truth
       ↓
packages/schema-exporter  (generates)
       ↓
packages/schema-exporter/artifacts/1.0.0/trace-event.schema.json  (JSON Schema)
       ↓
python/aerograph-sdk/tools/generate_contracts.py  (generates)
       ↓
python/aerograph-sdk/src/aerograph_sdk/contracts/generated.py  (Pydantic v2)
       ↓
python/aerograph-sdk/   (imports)
python/aerograph-langchain/  (imports via aerograph-sdk)
```
