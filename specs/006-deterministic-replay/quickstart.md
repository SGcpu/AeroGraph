# Quickstart Validation Guide: Feature 006 Deterministic Replay

**Feature 006 — Phase 1 Quickstart**
**Purpose**: Runnable scenarios to prove the feature works end-to-end

---

## Prerequisites

### System Requirements

| Requirement | Note |
|-------------|------|
| Node.js >= 18.18 | Existing workspace requirement |
| npm >= 11.x | Existing workspace requirement |
| Python >= 3.10 | Existing Python SDK requirement |
| Go >= 1.21 | **NEW**: Required to compile `aerograph-replay-core` |
| mkcert installed | **NEW**: Required by the vendored fork for TLS interception. CA cert is ephemeral — the hardened fork writes it to a temp directory and removes it after each run (FR-037). |
| `aerograph.project.yaml` in agent project root | **NEW**: Developer creates this for each agent project |

> **Security note**: The Orchestrator will not invoke `aerograph-replay-core` unattended unless FR-037 (CA key lifecycle) is implemented in the fork. Verify this with the setup check below before running any replay scenarios.

### AeroGraph Services Running

```bash
# Terminal 1: Start the collector + Orchestrator (combined in development)
npm run dev -w apps-collector

# Terminal 2: Start the web UI
npm run dev -w apps-web
```

The Replay Orchestrator starts as a sub-service on port 4318 when the collector starts in dev mode.

### Setup Check

```bash
# Verify replay core binary was compiled (must be the hardened fork build, not upstream)
ls packages/replay-core/bin/aerograph-replay-core

# Verify collector health
curl http://localhost:4317/health

# Verify Orchestrator health
curl http://localhost:4318/health

# Verify CA lifecycle: after any test run, .agent-replay/ca/ should be absent or empty
# (The hardened fork cleans it up. If it persists, the Security Gate is not satisfied.)
ls -la .agent-replay/ca/ 2>/dev/null && echo "WARNING: CA dir persists — check FR-037 implementation" || echo "OK: no persistent CA"
```

---

## Scenario 1: Record a New Run

**Goal**: Verify that running an agent through `aerorepl record` captures a cassette and emits events.

### Setup

Create a minimal test agent at `tests/fixtures/simple-agent.py`:
```python
from aerograph_sdk import FlightRecorder
import httpx

recorder = FlightRecorder(
    endpoint="http://localhost:4317",
    actor={"id": "test-agent"}
)
# Agent makes LLM calls — these should be intercepted by agrepl
resp = httpx.get("https://api.openai.com/v1/models")  # Not actually called in CI
```

Create `tests/fixtures/aerograph.project.yaml`:
```yaml
version: "1"
command: ["python", "simple-agent.py"]
```

### Commands

```bash
cd tests/fixtures

# Option A: via aerorepl CLI
npx aerorepl record python simple-agent.py

# Option B: via Orchestrator API
curl -X POST http://localhost:4318/v1/runs \
  -H "content-type: application/json" \
  -d '{"mode":"record","command":["python","simple-agent.py"]}'

# Wait for completion, then verify:
TRACE_ID=$(curl http://localhost:4318/v1/runs/<runId> | jq -r .traceId)
curl http://localhost:4317/v1/traces/$TRACE_ID
```

### Expected Outcomes

- [ ] `GET /v1/runs/<runId>` → `status: "completed"`
- [ ] Cassette exists at `.aerograph/cassettes/<runId>.json`
- [ ] `GET /v1/traces/<traceId>/events` → trace has events with `replaySource: null` (record run)
- [ ] Cassette has `entries` with at least one entry per HTTP call made by agent

---

## Scenario 2: Replay a Recorded Run

**Goal**: Verify deterministic replay produces identical events with zero network calls.

### Commands

```bash
# Get the runId from Scenario 1
RUN_ID=<runId from above>

# Trigger replay
curl -X POST http://localhost:4318/v1/runs \
  -H "content-type: application/json" \
  -d "{\"mode\":\"replay\",\"cassetteRunId\":\"$RUN_ID\"}"

# Or via aerorepl
npx aerorepl replay $RUN_ID
```

### Expected Outcomes

- [ ] New trace created with matching event structure
- [ ] Events have `replaySource: "cache"` on LLM call spans
- [ ] `replayLatencyMs` < 5ms (per SC-001) on each hydrated span
- [ ] No actual HTTP calls made to LLM endpoints (verify via network monitor or mock)
- [ ] `tokensSaved` field populated on LLM response spans

---

## Scenario 3: Fork and Resume from a Specific Span

**Goal**: Verify that clicking "Fork and Resume" in the Web UI re-invokes the agent from a given point.

### Commands

```bash
# From the Web UI:
# 1. Select a trace with multiple events
# 2. Click on a "prompt" event node
# 3. Click "⑂ Fork and Resume" button in the right panel
# 4. Optionally enter a prompt override in the modal
# 5. Click "Launch"

# Or via Orchestrator API:
BASE_TRACE_ID=<existing-trace-id>
FORK_SPAN_ID=<a-prompt-span-id>

curl -X POST http://localhost:4317/v1/traces/$BASE_TRACE_ID/fork-and-resume \
  -H "content-type: application/json" \
  -d "{\"forkFromSpanId\":\"$FORK_SPAN_ID\",\"overrides\":{\"promptText\":\"Alternative prompt\"}}"
```

### Expected Outcomes

- [ ] Response contains `childTraceId` and `runId` and `status: "running"`
- [ ] `GET /v1/traces/<childTraceId>` shows prefix events matching base trace up to fork span
- [ ] After run completes, child trace has additional events beyond the fork point
- [ ] `GET /v1/traces/<childTraceId>/lineage` shows edge from `baseTraceId` to `childTraceId`
- [ ] Web UI auto-switches to child trace view
- [ ] Events before fork point show `replaySource: "cache"`, events after show `replaySource: null` or `"live"`

---

## Scenario 4: Tool Safety Policy Enforcement

**Goal**: Verify that `must_execute` URLs are never served from cassette.

### Setup

Create `aerograph.replay.yaml` in agent project root:
```yaml
version: "1"
tools:
  - match: "https://api.stripe.com/*"
    class: must_execute
  - match: "https://api.openai.com/*"
    class: replay_safe
```

### Commands

```bash
# Run replay with policy file
npx aerorepl replay $RUN_ID

# Check spans for Stripe calls
curl http://localhost:4317/v1/traces/<newTraceId> | \
  jq '[.events[] | select(.payload.toolName | test("stripe"; "i"))]'
```

### Expected Outcomes

- [ ] Stripe API calls have `replaySource: "live"` (not `"cache"`)
- [ ] OpenAI calls have `replaySource: "cache"`
- [ ] Orchestrator log shows `[REPLAY-ROUTE] stripe.com → must_execute (live)`
- [ ] Orchestrator log shows `[REPLAY-ROUTE] openai.com → replay_safe (cache)`

---

## Scenario 5: Replay Mode Badge in Web UI

**Goal**: Verify replay-sourced spans are visually distinguishable.

### Steps

1. Open Web UI at `http://localhost:5173`
2. Select a trace produced by Scenario 2 (replay run)
3. Click on any node with `replaySource: "cache"`
4. In the right panel → Span Info section:

### Expected Outcomes

- [ ] "♻ Replay (cache)" badge visible in span detail panel
- [ ] `tokensSaved`, `replayLatencyMs` shown in "Trace Timing & Tokens" section
- [ ] `streamingPreserved: false` shows amber warning banner if applicable

---

## Scenario 6: aerorepl CLI Roundtrip

**Goal**: Validate the `aerorepl` CLI produces the same results as the Orchestrator API.

```bash
# Install aerorepl globally from workspace
npm install -g packages/aerorepl

# Record
aerorepl record python agent.py
# → outputs: run-id: run-<id>
# → outputs: trace-id: t_<id>

# Replay
aerorepl replay run-<id>
# → outputs: new trace-id

# List runs
aerorepl list
# → tabular output: run-id | mode | status | trace-id | date
```

### Expected Outcomes

- [ ] All CLI commands exit 0
- [ ] Output matches Orchestrator API responses
- [ ] `aerorepl --help` shows all subcommands with descriptions
- [ ] `aerorepl list` shows at least the two runs created above

---

## Automated Test Commands

```bash
# Full test suite (after npm run build)
npm test

# Collector-only tests (includes new replay/orchestrator routes)
npm run test -w apps-collector

# Contracts tests (new schema validation)
npm run test -w @aerograph/contracts

# aerorepl tests
npm run test -w packages/aerorepl
```

---

## Known Limitations for Initial Release

| Limitation | Workaround |
|-----------|-----------|
| gRPC calls not intercepted | Agent must use HTTP for LLM APIs |
| SSE streaming chunk fidelity TBD until Phase 0 spike | `streamingPreserved: false` warning shown in UI |
| Only one concurrent record/replay run per Orchestrator | Queue future requests |
| `--live-hosts` requires fork of agrepl | Handled by vendored `packages/replay-core` |
