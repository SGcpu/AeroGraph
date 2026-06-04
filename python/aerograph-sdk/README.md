# aerograph-sdk

Python SDK for [AeroGraph](https://github.com/SGcpu/AeroGraph) — the open-source flight recorder for AI agent workflows.

## Installation

```bash
pip install aerograph-sdk
```

## Quickstart

```python
from aerograph_sdk import FlightRecorder

recorder = FlightRecorder(
    endpoint="http://localhost:4317",
    actor={"id": "my-agent", "name": "My Agent"},
)

# Emit events
prompt_event = recorder.prompt(parent_span_id=None, text="What is AeroGraph?")
recorder.response(parent_span_id=prompt_event.spanId, text="AeroGraph records agent traces.")
```

## Features

- Emit 10 event kinds: `prompt`, `response`, `tool_call`, `tool_result`, `handoff`, `error`, `note`, `state_snapshot`, `retriever`, `checkpoint`
- Sync and async emission via `httpx`
- Batch emission with deterministic event ordering
- Cross-language hash compatibility with the TypeScript SDK
- Pydantic v2 contract validation

## License

Apache-2.0
