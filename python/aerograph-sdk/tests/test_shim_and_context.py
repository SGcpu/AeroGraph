"""Tests for WP-1 context propagation and WP-3/WP-4 zero-dependency shim."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx
import pytest

from aerograph_sdk.context import (
    child_branch_id,
    get_current_branch_id,
    get_current_span_id,
    next_local_seq,
    reset_branch_counters,
    span_context,
)


def test_context_vars_parallel_asyncio_gather() -> None:
    reset_branch_counters()

    async def worker(idx: int) -> tuple[str | None, str, int]:
        branch = child_branch_id("rag_fanout", idx)
        with span_context(f"sp_{idx}", branch):
            await asyncio.sleep(0.01 * (3 - idx))
            return get_current_span_id(), get_current_branch_id(), next_local_seq()

    async def main() -> list[tuple[str | None, str, int]]:
        return await asyncio.gather(*(worker(i) for i in range(5)))

    results = asyncio.run(main())
    assert [r[0] for r in results] == ["sp_0", "sp_1", "sp_2", "sp_3", "sp_4"]
    assert [r[1] for r in results] == [f"root.rag_fanout[{i}]" for i in range(5)]
    assert [r[2] for r in results] == [0, 0, 0, 0, 0]


def test_shim_dotenv_respects_proxy_precedence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aerograph_sdk.shim import sitecustomize as shim

    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "HTTP_PROXY=http://evil-override:9999\n"
        "SSL_CERT_FILE=/tmp/bad.pem\n"
        "MY_CUSTOM_API_KEY=secret123\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:8888")
    monkeypatch.setenv("SSL_CERT_FILE", "/tmp/ephemeral.pem")
    monkeypatch.delenv("MY_CUSTOM_API_KEY", raising=False)

    shim._load_dotenv_with_proxy_precedence()
    assert os.environ["HTTP_PROXY"] == "http://127.0.0.1:8888"
    assert os.environ["SSL_CERT_FILE"] == "/tmp/ephemeral.pem"
    assert os.environ["MY_CUSTOM_API_KEY"] == "secret123"


def test_shim_injects_aerograph_headers_on_httpx(monkeypatch: pytest.MonkeyPatch) -> None:
    from aerograph_sdk.shim import sitecustomize as shim

    reset_branch_counters()
    shim._patch_httpx(httpx)

    captured_headers: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured_headers.update(dict(request.headers))
        return httpx.Response(200, json={"ok": True})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as client:
        with span_context("sp_rag_1", "root.rag[0]"):
            client.post("https://api.openai.com/v1/chat/completions", json={"hello": "world"})

    assert captured_headers.get("x-aerograph-span-id") == "sp_rag_1"
    assert captured_headers.get("x-aerograph-branch-id") == "root.rag[0]"
    assert captured_headers.get("x-aerograph-local-seq") == "0"


def test_shim_input_replay_uses_inbound_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    from aerograph_sdk.shim import sitecustomize as shim

    monkeypatch.setenv("AEROGRAPH_MODE", "fork")
    monkeypatch.setenv("AEROGRAPH_INBOUND_OVERRIDES", json.dumps({"0": "Goa beach trip"}))
    shim._input_turn_counter = 0

    val = shim._aerograph_input("Destination? ")
    assert val == "Goa beach trip"
