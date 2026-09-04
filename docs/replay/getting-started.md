# Deterministic Replay: Getting Started

AeroGraph Deterministic Replay allows developers to capture, inspect, replay, and fork agent executions locally with zero external dependencies, sub-5ms lookup latency, and zero token consumption on replayed steps.

## Prerequisites

1. **Node.js**: >= 18.18.0
2. **Go**: >= 1.22 (used to compile `aerograph-replay-core`)
3. **mkcert** (Optional, for automatic TLS trust): `choco install mkcert` or `brew install mkcert`

## 1. Build Replay Core

Compile the local proxy engine once:

```bash
cd packages/replay-core
go build -o bin/aerograph-replay-core.exe main.go # Windows
# Or on macOS/Linux:
# go build -o bin/aerograph-replay-core main.go
cd ../..
```

## 2. Configure Your Project (Zero-Manual-File Setup)

You don't need to manually create YAML files in your project. You can bind your project using either the **Terminal CLI** or the **Web UI**:

### Method A: Via CLI (`aerorepl`)
```bash
npx aerorepl config set uv run agent.py
# Or check active configuration:
npx aerorepl config get
```
This automatically stores configuration in `.aerograph/aerograph.project.yaml` without cluttering your project root.

### Method B: Via Web UI
- Click the **`⚙️ Config`** button in the header of the Web UI (`http://localhost:5173`) to choose a preset or paste YAML.
- Alternatively, paste your command or YAML directly inside the **⑂ Fork and Resume** modal when forking any trace step.

### Method C: Manual File (Optional)
If you prefer managing files in Git, you can create `aerograph.project.yaml` or `.aerograph/aerograph.project.yaml`:
```yaml
version: "1.0.0"
command:
  - python
  - agent.py
collectorUrl: "http://127.0.0.1:4317"
orchestratorUrl: "http://127.0.0.1:4318"
```

## 3. Define Tool Safety Policy

Create `aerograph.replay.yaml` to specify which external API calls can be replayed from cache and which must run live:

```yaml
tools:
  - match: "https://api.openai.com/*"
    class: "replay_safe"
  - match: "https://api.anthropic.com/*"
    class: "replay_safe"
  - match: "https://api.stripe.com/*"
    class: "must_execute"
```

> **Default Deny Rule**: Any unclassified domain defaults to `must_execute` during replay to ensure safety against unintended side effects.

## 4. Record Your First Agent Run

Start the AeroGraph collector and orchestrator:
```bash
npm run dev -w apps/collector
```

In another terminal, invoke `aerorepl`:
```bash
npx aerorepl record python agent.py
```

This generates a deterministic cassette at `.aerograph/cassettes/<runId>.json` and logs full telemetry to the Collector.

## 5. Replay with Zero Token Cost

```bash
npx aerorepl replay <runId>
```

Open the Web UI (`http://localhost:5173`) to view:
- Replay badges: `Replay (cache)`
- Instant response times (<5ms)
- Tokens and cost saved
