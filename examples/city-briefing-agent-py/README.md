# AeroGraph Example: Live City Briefing Agent (Python)

Demonstrates AeroGraph v0.5.0 end-to-end with **OpenRouter**, **Tavily Search**, and **OpenWeather**:

- **Zero-Refactor `input()`**: Prompts interactively in CLI (`aerorepl record`), pops an inline modal in the Web UI (`● Record Run`), and replays at `0ms` without a TTY.
- **Parallel Fan-Out (`asyncio.gather`)**: Concurrently calls OpenWeather and Tavily Search with automatic `X-AeroGraph-Span-Id` / `X-AeroGraph-Branch-Id` / `X-AeroGraph-Local-Seq` propagation.
- **Transient Token Masking**: Includes `datetime.now()` and `uuid.uuid4()` in the system prompt while still achieving 100% deterministic cache hits on replay.

## Quick Start

1. Ensure your root `.env` (or local `.env`) contains:
   ```env
   OPENROUTER_API_KEY=...
   TAVILY_API_KEY=...
   OPENWEATHER_API_KEY=...
   ```
2. Start AeroGraph (`npm run dev`), then either:
   - **Web UI (`http://localhost:5173`)**: Click **● Record Run**, enter a city in the popup modal when prompted, then click **▶ Replay Trace** or **Fork and Resume**.
   - **CLI**:
     ```bash
     cd examples/city-briefing-agent-py
     npx aerorepl record python city_briefing_agent.py
     npx aerorepl replay <runId>
     ```
