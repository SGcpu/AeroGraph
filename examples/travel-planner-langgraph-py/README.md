# AeroGraph Example: AI Travel Planner (LangGraph + Python)

An end-to-end autonomous travel planner agent built with **LangGraph** and instrumented with **AeroGraph**.

Demonstrates:
- **Zero-Intrusion Observability**: Simply attach `AeroGraphCallbackHandler` to your LangGraph config.
- **Automated Execution**: Non-blocking input handling via CLI arguments or environment variables.
- **Deterministic Replay**: Zero-cost, sub-5ms caching via `.aerograph/cassettes/`.
- **Time-Travel Forking**: Branch and explore alternative itineraries in the Web UI.

---

## Prerequisites

1. Active Python environment (Python $\ge 3.10$).
2. Dependencies installed:
   ```bash
   pip install -e ../../python/aerograph-sdk -e ../../python/aerograph-langchain langchain-openai langgraph langchain-core python-dotenv
   ```
3. An OpenRouter API key in `.env`:
   ```bash
   OPENROUTER_API_KEY=your_key_here
   OPENROUTER_MODEL=openrouter/free
   AEROGRAPH_ENDPOINT=http://localhost:4317
   ```

---

## 1. Run Directly (Standard Run)

Run the script directly with custom arguments:

```bash
python travel_agent.py "Plan a 4-day weekend trip to Tokyo for foodies"
```

---

## 2. Record with AeroGraph (`aerorepl record`)

Record the execution into a deterministic network cassette:

```bash
npx aerorepl record python travel_agent.py "Plan a 3-day trip to Kashmir from Mumbai"
```

**What to expect:**
- AeroGraph boots its local proxy and executes the agent.
- Every model call (`https://openrouter.ai/api/v1/chat/completions`) is saved to `.aerograph/cassettes/<runId>.json`.
- The terminal displays the assigned `runId` and `traceId`.

---

## 3. Replay at Zero Cost ($0.00)

Replay the recorded run instantly without touching the network:

```bash
npx aerorepl replay <runId>
```

**What to expect:**
- Execution completes in **~300ms** (up to 100x speedup).
- **0 live tokens billed** ($0.00 spend).
- In the Web UI, the trace receives a **`▶ STRICT REPLAY`** badge with **100% tokens saved**.

---

## 4. Fork & Resume in the Web UI

1. Open the AeroGraph Web UI (`http://localhost:5173`).
2. Click on the trace from Step 2.
3. Select the **`planner`** node in the interactive graph.
4. Click **`⑂ Fork and Resume`**.
5. Edit the prompt in the modal:
   - Change `"Kashmir"` to `"Goa luxury beach resort"`.
6. Click **`Run Fork`**.

**What to expect:**
- Step 1 (pre-fork) is hydrated instantly from the cassette.
- Step 2 and subsequent steps run live with your updated destination.
- A new derived trace appears linked to the parent run.
- Click **`⚖ Compare with Base`** to see the Myers diff showing exact divergence in tokens, costs, and itinerary output!

