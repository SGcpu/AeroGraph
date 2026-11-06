# Adapter Lifecycle

Adapters bridge the gap between complex, disparate AI frameworks (like LangChain, AutoGen, CrewAI) and the normalized Flight Recorder contracts.

## The Normalization Boundary
By design (ADR-0002), the collector does not understand LangChain or AutoGen concepts. It only understands `prompt`, `response`, `tool_call`, `tool_result`, `handoff`, `error`, and `note`.

### Responsibilities of an Adapter
1. **Deterministic Mapping**: Translate framework-specific states into standard `TraceEvent` payloads.
2. **Span Relationship Management**: Accurately pass `spanId` and `parentSpanId` based on the framework's internal execution tree.
3. **Loss-Aware Serialization**: If a framework provides rich metadata that doesn't fit the schema's top-level properties, serialize it into the generic `payload` map. Do not invent new top-level properties.
4. **Automatic Environment Registration**: Delegate to or ensure the underlying `FlightRecorder` registers process runtime metadata (`projectRoot`, `virtualEnv`, `executablePath`, `command`) via `POST /v1/traces/:id/runtime-metadata` on the initial event, enabling UI replay/forking for directly executed scripts (`node agent.js`, `python agent.py`).

### Initialization Example
An adapter usually accepts a configured `FlightRecorder` instance from `@afr/sdk` and returns a native callback handler or plugin:

```typescript
// Conceptual LangChain integration
const recorder = new FlightRecorder({ endpoint: "http://localhost:4317", actor: { id: "my-agent" } });
const handler = createLangChainHandler({ recorder });
const model = new ChatOpenAI({ callbacks: [handler] });
```
