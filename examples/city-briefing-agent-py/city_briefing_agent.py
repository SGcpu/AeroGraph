"""
AeroGraph Example: Live City Briefing Agent (Parallel Fan-Out + input() + Multi-API)
===================================================================================

Demonstrates AeroGraph v0.5.0 capabilities in real time:
1. Zero-refactor `input()`: works in CLI TTY, headless Web UI modal, and 0ms replay.
2. Parallel `asyncio.gather` fan-out (OpenWeather + Tavily Search) with automatic
   `X-AeroGraph-Span-Id`, `X-AeroGraph-Branch-Id`, and `X-AeroGraph-Local-Seq` injection.
3. Transient token masking (`datetime.now()` + `uuid.uuid4()` in system prompt) for
   100% deterministic replay without false cache misses.
4. OpenRouter LLM synthesis with full trace + cassette recording.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

# Windows UTF-8 console guard
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Optional python-dotenv fallback when run standalone (shim auto-loads .env with proxy precedence)
try:
    from dotenv import load_dotenv

    for candidate in (Path.cwd() / ".env", Path(__file__).resolve().parents[2] / ".env"):
        if candidate.is_file():
            load_dotenv(candidate, override=False)
            break
except ImportError:
    pass

from aerograph_sdk import FlightRecorder, child_branch_id, new_trace_id  # noqa: E402


async def fetch_weather(
    client: httpx.AsyncClient,
    recorder: FlightRecorder,
    root_span_id: str,
    city: str,
) -> dict[str, Any]:
    api_key = os.getenv("OPENWEATHER_API_KEY", "")
    branch = child_branch_id("fanout", 0)
    async with recorder.async_span(parent_span_id=root_span_id, branch_id=branch) as ctx:
        recorder.tool_call(
            span_id=ctx["span_id"],
            parent_span_id=root_span_id,
            tool_id="openweather",
            tool_name="OpenWeather Current Weather",
            input={"city": city},
        )
        if not api_key:
            out: dict[str, Any] = {"error": "OPENWEATHER_API_KEY not set"}
        else:
            resp = await client.get(
                "https://api.openweathermap.org/data/2.5/weather",
                params={"q": city, "appid": api_key, "units": "metric"},
                timeout=15.0,
            )
            data = resp.json()
            if resp.is_success:
                out = {
                    "city": data.get("name", city),
                    "temp_c": data.get("main", {}).get("temp"),
                    "feels_like_c": data.get("main", {}).get("feels_like"),
                    "condition": (data.get("weather") or [{}])[0].get("description"),
                    "humidity": data.get("main", {}).get("humidity"),
                }
            else:
                out = {"status": resp.status_code, "error": data.get("message", resp.text)}

        recorder.tool_result(
            parent_span_id=ctx["span_id"],
            tool_id="openweather",
            tool_name="OpenWeather Current Weather",
            output=out,
        )
        return out


async def fetch_tavily_news(
    client: httpx.AsyncClient,
    recorder: FlightRecorder,
    root_span_id: str,
    city: str,
) -> dict[str, Any]:
    api_key = os.getenv("TAVILY_API_KEY", "")
    branch = child_branch_id("fanout", 1)
    async with recorder.async_span(parent_span_id=root_span_id, branch_id=branch) as ctx:
        recorder.tool_call(
            span_id=ctx["span_id"],
            parent_span_id=root_span_id,
            tool_id="tavily",
            tool_name="Tavily City Highlights",
            input={"query": f"top travel news and events in {city}"},
        )
        if not api_key:
            out: dict[str, Any] = {"error": "TAVILY_API_KEY not set"}
        else:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": api_key,
                    "query": f"top travel highlights and current events in {city}",
                    "max_results": 3,
                    "search_depth": "basic",
                },
                timeout=20.0,
            )
            data = resp.json()
            if resp.is_success:
                results = [
                    {"title": r.get("title"), "url": r.get("url"), "snippet": (r.get("content") or "")[:200]}
                    for r in data.get("results", [])
                ]
                out = {"results": results}
            else:
                out = {"status": resp.status_code, "error": data}

        recorder.tool_result(
            parent_span_id=ctx["span_id"],
            tool_id="tavily",
            tool_name="Tavily City Highlights",
            output=out,
        )
        return out


async def synthesize_briefing(
    client: httpx.AsyncClient,
    recorder: FlightRecorder,
    root_span_id: str,
    city: str,
    weather: dict[str, Any],
    news: dict[str, Any],
) -> str:
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    model = os.getenv("OPENROUTER_MODEL", "openrouter/free")
    base_url = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")

    # Dynamic timestamp & UUID to verify WP-2 transient token masking on replay
    system_prompt = (
        f"You are a concise travel briefing assistant. "
        f"[run_ts={datetime.now(timezone.utc).isoformat()} req_id={uuid.uuid4()}]"
    )
    user_prompt = (
        f"Create a short 4-bullet live briefing for {city}.\n"
        f"Weather: {weather}\n"
        f"Highlights: {news}"
    )

    async with recorder.async_span(parent_span_id=root_span_id, branch_id="root.synthesize") as ctx:
        await recorder.prompt_async(
            span_id=ctx["span_id"],
            parent_span_id=root_span_id,
            title="Synthesize City Briefing",
            text=user_prompt,
        )

        if not api_key:
            reply = f"[Mock Briefing for {city}] Weather: {weather} | Highlights: {news}"
        else:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "HTTP-Referer": "https://aerograph.dev",
                    "X-Title": "AeroGraph City Briefing Agent",
                },
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    "temperature": 0.3,
                },
                timeout=30.0,
            )
            data = resp.json()
            if resp.is_success and data.get("choices"):
                reply = data["choices"][0]["message"]["content"]
            else:
                reply = f"OpenRouter error ({resp.status_code}): {data}"

        await recorder.response_async(
            parent_span_id=ctx["span_id"],
            title="City Briefing Response",
            text=reply,
        )
        return reply


async def run_agent() -> None:
    city = sys.argv[1] if len(sys.argv) > 1 else input("Which city would you like a live briefing for? ").strip()
    if not city:
        city = "Tokyo"

    trace_id = os.getenv("AFR_TRACE_ID") or new_trace_id()
    endpoint = os.getenv("AEROGRAPH_ENDPOINT", "http://127.0.0.1:4317")

    recorder = FlightRecorder(
        endpoint=endpoint,
        trace_id=trace_id,
        project_id="city-briefing",
        environment="development",
        actor={"id": "city-briefing-agent", "name": "City Briefing Agent"},
    )

    print(f"Fetching live briefing for: {city} (trace: {trace_id})")

    # Emit human_input as the true root span so all child nodes connect cleanly in the DAG
    root_event = recorder.human_input(
        parent_span_id=None,
        turn=0,
        prompt="Which city would you like a live briefing for? ",
        text=city,
    )
    root_span_id = root_event.spanId

    async with recorder.async_span(span_id=root_span_id, branch_id="root"):
        async with httpx.AsyncClient() as client:
            weather, news = await asyncio.gather(
                fetch_weather(client, recorder, root_span_id, city),
                fetch_tavily_news(client, recorder, root_span_id, city),
            )
            briefing = await synthesize_briefing(client, recorder, root_span_id, city, weather, news)

    recorder.flush()

    print("\n" + "=" * 60)
    print(f"CITY BRIEFING: {city}")
    print("=" * 60)
    print(briefing)
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(run_agent())
