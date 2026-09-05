# aerorepl

`aerorepl` is the developer CLI and interactive stepping REPL for AeroGraph. It lets you record agent runs into deterministic, content-addressed cassettes, replay them with zero token cost (<5ms latency), step through execution spans, and execute live fork-and-resume workflows directly from your terminal.

---

## Installation

You can run `aerorepl` via `npx` or install it globally:

```bash
# Run without installing:
npx aerorepl --help

# Or install globally:
npm install -g aerorepl
```

Or run directly from the repository monorepo:
```bash
npm run build -w packages/aerorepl
node packages/aerorepl/dist/cli.js --help
```

---

## Prerequisites

- **AeroGraph Collector & Orchestrator**: Running on `http://localhost:4317` and `http://localhost:4318` (`npm run dev -w apps/collector`).
- **`aerograph-replay-core`**: The Go MITM proxy compiled at `packages/replay-core/bin/aerograph-replay-core` (or `.exe` on Windows). See [Replay Core README](../replay-core/README.md).

---

## Project Configuration

`aerorepl` automatically detects project configuration from `aerograph.project.yaml` and `aerograph.replay.yaml` in your current working directory (or ancestor directories):

### `aerograph.project.yaml`
```yaml
schemaVersion: "1.0.0"
projectId: "agent-evals"
defaultCommand: "python agent.py"
orchestratorUrl: "http://localhost:4318"
collectorUrl: "http://localhost:4317"
timeoutSeconds: 300
```

### `aerograph.replay.yaml`
```yaml
schemaVersion: "1.0.0"
safetyPolicy:
  replaySafeHosts:
    - "api.openai.com"
    - "api.anthropic.com"
  mustExecuteHosts:
    - "api.stripe.com"
    - "hooks.slack.com"
  loopTripwireThreshold: 10
```

See [Safety Policy Guide](../../docs/replay/safety-policy.md) for full details on safety rules and network enforcement.

---

## Commands

### 1. `config` (Zero-Manual-File Project Binding)
View, set, paste, or import project configuration and tool safety policies without creating or managing loose YAML files manually.

```bash
# View active configuration, command, and safety policy status:
npx aerorepl config get

# Set and store your agent command in .aerograph/aerograph.project.yaml:
npx aerorepl config set uv run agent.py
# Or for TypeScript:
npx aerorepl config set npm run start

# Interactively paste YAML configuration into terminal (type 'END' when finished):
npx aerorepl config paste

# Or pass a file directly to paste/save without interactive prompt:
npx aerorepl config paste aerograph.replay.yaml

# Import an existing YAML file directly:
npx aerorepl config import aerograph.replay.yaml
```

> **Smart Auto-Detection**: `aerorepl config paste` and `import` automatically detect whether your YAML defines a **Tool Safety Policy** (`tools: [...]` → saved to `aerograph.replay.yaml`), an **Agent Project Command** (`command: [...]` → saved to `.aerograph/aerograph.project.yaml`), or both!

### 2. `record`
Execute an agent command while intercepting all HTTP/HTTPS traffic through `aerograph-replay-core`. Generates a deterministic cassette saved to `.aerograph/cassettes/<runId>.json`.
*Note: Recording automatically binds the executed command as the project default for subsequent replays and Web UI forks.*

```bash
# Record with explicit command:
npx aerorepl record python agent.py
# Or with options:
npx aerorepl record --project eval-suite -- uv run agent.py

# If already configured with 'aerorepl config set', command is optional:
npx aerorepl record
```

### 3. `replay`
Re-run an agent execution deterministically using an existing cassette. Network requests for `replay_safe` hosts are fulfilled from cache with zero token cost (<5ms latency).

```bash
npx aerorepl replay <runId>
```

### 4. `session`
Launch an interactive stepping session for an active or recorded run. Step through spans, inspect payload states, register live mocks/overrides, rewind, or fork execution.

```bash
npx aerorepl session <runId>
```

#### Interactive Session Commands
Once inside the REPL prompt (`aerorepl> `):

| Command | Description | Example |
|---|---|---|
| `/step` | Advance execution by 1 span | `/step` |
| `/inspect <spanId>` | Print full JSON payload of a span (reflects active overrides) | `/inspect s_AaBx...` |
| `/override <spanId> [input]` | Override the prompt text or payload for a span during replay | See options below |
| `/rewind [n]` | Rewind the stepping pointer by `n` spans (default: 1) | `/rewind 1` |
| `/fork <spanId>` | Fork execution from this span: slices cassette and resumes live execution | `/fork s_AaBx...` |
| `/quit` | Exit the interactive session | `/quit` |

#### Flexible `/override` Formats:
1. **Interactive Multi-Line JSON (Auto-Balanced)**:
   ```
   aerorepl> /override s_123
   override> {
   override>   "payload": {
   override>     "text": "Your new prompt text here"
   override>   }
   override> }
   ✓ Overridden span s_123 with prompt: "Your new prompt text here"
   ```
   *The accumulator automatically tracks brace depth and will not prematurely cut off on inner closing braces!*
2. **From a File (`@file` or `--file`)**:
   ```
   aerorepl> /override s_123 @prompt.json
   aerorepl> /override s_123 --file ./prompts/eval_prompt.txt
   ```
3. **Plain Text (No JSON Quotes Needed)**:
   ```
   aerorepl> /override s_123 Analyze rover navigation algorithms in 3 bullet points.
   ```
4. **Full Trace Event Auto-Extraction**:
   If you paste a full trace event JSON (copied from `/inspect` or the Web UI), `aerorepl` automatically extracts `payload.text`, `payload.prompt`, `text`, or `promptText` without errors!

### 5. `list`
List all recorded runs and cassettes in the local project:

```bash
npx aerorepl list
```

### 6. `status`
Query the execution status and metrics of a specific run:

```bash
npx aerorepl status <runId>
```

### 7. `cancel`
Cancel an in-progress background run or replay session:

```bash
npx aerorepl cancel <runId>
```

---

## Fork-and-Resume Workflow

When an agent fails or makes a suboptimal decision at step `k`:

1. Inspect the trace using `aerorepl session <runId>` and find the target span ID (`/inspect`).
2. Run `/fork <spanId>`.
3. The Orchestrator automatically:
   - Slices the recorded cassette up to the target span (`0..k`).
   - Serves steps `0..k` from the cassette cache with **zero LLM cost**.
   - Resumes live execution from step `k+1` using your modified prompt or code.
   - Computes a Myers divergence diff against the parent run.

---

## Documentation Links

- [Deterministic Replay Getting Started](../../docs/replay/getting-started.md)
- [Safety Policy Specification](../../docs/replay/safety-policy.md)
- [Windows Setup & Troubleshooting](../../docs/replay/windows-setup.md)
- [Adapter Authoring Guide](../../docs/adapters/authoring-guide.md)
