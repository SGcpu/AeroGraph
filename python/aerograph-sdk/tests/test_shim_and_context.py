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


def test_thread_pool_executor_context_propagation() -> None:
    from concurrent.futures import ThreadPoolExecutor
    from aerograph_sdk.shim import sitecustomize as shim

    shim._patch_concurrent(None)
    reset_branch_counters()

    def worker() -> tuple[str | None, str, int]:
        return get_current_span_id(), get_current_branch_id(), next_local_seq()

    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = []
        for idx in range(3):
            with span_context(f"sp_thread_{idx}", f"root.pool[{idx}]"):
                futures.append(pool.submit(worker))
        results = [f.result() for f in futures]

    assert results == [
        ("sp_thread_0", "root.pool[0]", 0),
        ("sp_thread_1", "root.pool[1]", 0),
        ("sp_thread_2", "root.pool[2]", 0),
    ]


def test_5_branch_asyncio_gather_o1_correlation(monkeypatch: pytest.MonkeyPatch) -> None:
    """WP-1 + WP-2: 5 concurrent asyncio.gather branches correlate 100% via O(1) headers."""
    from aerograph_sdk.shim import sitecustomize as shim

    reset_branch_counters()
    shim._patch_httpx(httpx)

    seen_by_branch: dict[str, dict[str, str]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        bid = request.headers.get("x-aerograph-branch-id", "")
        seen_by_branch[bid] = {
            "span_id": request.headers.get("x-aerograph-span-id", ""),
            "branch_id": bid,
            "local_seq": request.headers.get("x-aerograph-local-seq", ""),
        }
        return httpx.Response(200, json={"branch": bid})

    transport = httpx.MockTransport(handler)

    async def branch_call(client: httpx.AsyncClient, idx: int) -> None:
        branch = child_branch_id("rag_fanout", idx)
        with span_context(f"sp_rag_{idx}", branch):
            await asyncio.sleep(0.005 * (5 - idx))
            await client.post("https://api.openai.com/v1/embeddings", json={"input": "same query"})

    async def main() -> None:
        async with httpx.AsyncClient(transport=transport) as client:
            await asyncio.gather(*(branch_call(client, i) for i in range(5)))

    asyncio.run(main())

    assert len(seen_by_branch) == 5
    for idx in range(5):
        bid = f"root.rag_fanout[{idx}]"
        assert seen_by_branch[bid]["span_id"] == f"sp_rag_{idx}"
        assert seen_by_branch[bid]["local_seq"] == "0"


def test_wp4_local_vector_db_replay_after_deletion(monkeypatch: pytest.MonkeyPatch) -> None:
    """WP-4: Local vector DB query records to Orchestrator and replays identically after DB deletion."""
    import types
    from aerograph_sdk.shim import sitecustomize as shim

    recorded_store: list[dict[str, object]] = []

    def fake_http_json(method: str, url: str, payload=None, timeout: float = 5.0):
        if method == "POST" and url.endswith("/local-retrievals") and payload is not None:
            recorded_store.append(payload)
            return {"ok": True}
        if method == "GET" and url.endswith("/local-retrievals"):
            return {"localRetrievals": recorded_store}
        return {}

    monkeypatch.setattr(shim, "_http_json", fake_http_json)
    monkeypatch.setenv("AFR_RUN_ID", "run_vec_1")
    monkeypatch.setenv("AEROGRAPH_CASSETTE_RUN_ID", "run_vec_1")

    db_alive = {"docs": [["AeroGraph deterministic replay"]]}

    class FakeCollection:
        name = "test_col"

        def query(self, query_texts, n_results=1):
            if not db_alive:
                raise RuntimeError("Local Chroma directory deleted!")
            return {"ids": [["id_1"]], "documents": db_alive["docs"], "distances": [[0.1]]}

    fake_col_mod = types.ModuleType("chromadb.api.models.Collection")
    fake_col_mod.Collection = FakeCollection  # type: ignore[attr-defined]
    monkeypatch.setitem(
        __import__("sys").modules, "chromadb.api.models.Collection", fake_col_mod
    )

    shim._patch_chromadb(None)
    col = FakeCollection()

    # Record mode
    monkeypatch.setenv("AEROGRAPH_MODE", "record")
    res_rec = col.query(query_texts=["replay"], n_results=1)
    assert res_rec["documents"] == [["AeroGraph deterministic replay"]]
    assert len(recorded_store) == 1

    # Delete local DB & replay
    db_alive.clear()
    shim._cached_retrievals = None
    shim._retrieval_used.clear()
    monkeypatch.setenv("AEROGRAPH_MODE", "replay")
    res_rep = col.query(query_texts=["replay"], n_results=1)
    assert res_rep == res_rec

