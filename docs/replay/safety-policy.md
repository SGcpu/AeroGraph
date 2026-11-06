# Tool Safety Policy (`aerograph.replay.yaml`)

The Tool Safety Policy defines how external network requests made by tools and model providers are handled during **Replay** and **Fork-and-Resume** runs.

JSON Schema validation is available at `apps/web/public/schemas/aerograph-replay-yaml.schema.json`.

## Safety Classes

Each URL rule maps to one of two safety classes:

| Class | Replay Behavior | Typical Usage |
|-------|-----------------|---------------|
| `replay_safe` | **Served from cache**: Replays the recorded response from the cassette without making an outbound network call. | Idempotent LLM completion endpoints, search APIs, read-only GET queries. |
| `must_execute` | **Executed live**: Outbound network call is made live to the remote host even during replay. | Write endpoints with real-world side effects (payment gateways, Slack messages, database mutations). |

## Key Policy Invariants

1. **Default Deny (FR-022)**: If an outbound request does not match any rule in `aerograph.replay.yaml`, it automatically defaults to `must_execute`. Replay-safe behavior must be explicitly opted into.
2. **First-Match Top-to-Bottom Resolution**: Rules are evaluated strictly in the order they appear. The first rule whose glob pattern matches the request URL is selected.
3. **Span Annotations**: Every routing decision is logged in the SQLite store and surfaced in the UI:
   - `decision`: `"cache"` | `"live"` | `"must_execute_override"`
   - `matchedPattern`: The glob rule string that matched (or `null` if unclassified)
   - `effectiveClass`: `"replay_safe"` | `"must_execute"`

## Example Configuration

```yaml
tools:
  # Specific read-only endpoint is replay-safe
  - match: "https://api.github.com/repos/*/issues"
    class: "replay_safe"

  # All other GitHub API calls (e.g. creating issues) must execute live
  - match: "https://api.github.com/*"
    class: "must_execute"

  # Standard LLM providers
  - match: "https://api.openai.com/*"
    class: "replay_safe"
  - match: "https://api.anthropic.com/*"
    class: "replay_safe"

  # Payment gateways always execute live
  - match: "https://api.stripe.com/*"
    class: "must_execute"
```
