# AeroGraph Web Dashboard

The web dashboard is the visual flight recorder for AeroGraph. Built with React, ReactFlow, and Vite, it visualizes complex agent reasoning graphs, inspects event payloads, enables 1-click **Fork-and-Resume**, and performs side-by-side divergence diffing.

---

## Starting the Web UI

```bash
# Start development server (http://localhost:5173):
npm run dev -w apps/web

# Or build production assets:
npm run build -w apps/web
```

Open **`http://localhost:5173`** in your browser.

> **Note**: Ensure the AeroGraph Collector is running on port 4317 (`npm run dev -w apps/collector`) so the web dashboard can query traces and execute actions.

---

## Key Features

### 1. Interactive Trace Graph (ReactFlow)
- **DAG Visualization**: Visualizes agent execution trees and multi-agent handoffs.
- **Node Classification**: Clear iconography and styling for prompts, responses, tool calls, tool results, state snapshots, checkpoints, and errors.
- **Route Decision Badges**: Visual badges on graph nodes highlighting conditional decisions and branching logic.
- **Playback Controls**: Step through agent execution chronologically with playback scrubbing.

### 2. Fork-and-Resume Modal (`ForkResumeModal.tsx`)
- **1-Click Alternate Timelines**: Click on any node in the trace graph and select **⑂ Fork and Resume**.
- **In-Place Command & YAML Pasting**: Never drop files manually on disk. Type your command (e.g. `uv run agent.py`) or paste full `aerograph.project.yaml` directly in the modal; it automatically stores to `.aerograph/` and binds to the active project.
- **In-Place Prompt & Input Editing**: Modify the prompt, query, or tool inputs directly in the modal to test alternate agent behaviors.
- **Zero-Cost Caching**: Pre-fork steps are fulfilled from the local cassette with zero token cost (<5ms latency); post-fork steps run live.
- **Automated Divergence Diffing**: Automatically jumps into the side-by-side diff view once the alternate timeline finishes executing.
- **Manual Mode Toggle**: Offers a "Generate Fork ID Only" toggle if the Orchestrator is offline.

### 3. Project Configuration Modal (`ProjectConfigModal.tsx`)
- **Header `⚙️ Config` Button**: Manage your project execution command and binding directly from the Web UI header bar.
- **1-Click Presets**: Fast pre-filling for Python (`uv run agent.py`), Node.js (`npm run start`), and TypeScript (`npx tsx agent.ts`).
- **Zero-Manual-File Persistence**: Automatically parses and saves configuration to `.aerograph/aerograph.project.yaml` in the project root.

### 4. Divergence Diff Viewer
- **Lineage-Aware Myers Diffing**: Compares parent and child traces side-by-side.
- **Exact Point of Divergence**: Highlights the precise span where the child trace diverged from the parent.
- **State & Output Diffs**: Visual red/green diff highlighting for modified responses, altered tool parameters, and divergent state snapshots.

### 5. Event Inspector & Telemetry Panel
- **Detailed Payload Viewer**: View structured inputs, outputs, exceptions, and stack traces.
- **Streaming Metrics**: Inspect Time-to-First-Token (TTFT) and tokens/sec for streaming models.
- **Cost & Model Tracking**: Inspect token counts (input, output, total) and model names per span and across the entire trace.

### 6. Replay Control Panel (`ReplayControlPanel.tsx`)
- Trigger deterministic replay directly from the browser.
- Track active replay session status, live host passthroughs, and playback execution.

---

## Tech Stack

- **Framework**: React 18
- **Graph Engine**: `@xyflow/react` (ReactFlow)
- **Bundler**: Vite
- **Icons**: Lucide React
- **Validation**: `@aerograph/contracts`

---

## Related Documentation

- [Main AeroGraph Documentation](../../README.md)
- [Deterministic Replay Getting Started](../../docs/replay/getting-started.md)
- [Collector & Orchestrator Backend](../collector/README.md)
- [CLI (`aerorepl`)](../../packages/aerorepl/README.md)
