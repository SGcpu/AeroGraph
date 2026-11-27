"""
python/aerograph-sdk/src/aerograph_sdk/shim/sitecustomize.py

Zero-refactor, zero-dependency, chain-safe runtime shim for AeroGraph v0.5.0.
Injected by AeroGraph Runner via PYTHONPATH during record/replay/fork runs.

Features:
1. Chain-loads any downstream sitecustomize.py on sys.path.
2. Auto-loads project .env without overwriting proxy/CA/AeroGraph env vars.
3. WP-1: Propagates X-AeroGraph-Span-Id, X-AeroGraph-Branch-Id, X-AeroGraph-Local-Seq
   across httpx, requests, and aiohttp (via wrapt if available, else functools.wraps + sys.meta_path).
4. WP-3: Hooks builtins.input for TTY record, headless UI long-poll, and 0ms replay.
   Never writes to cassette files directly — always communicates via Orchestrator (:4318).
5. WP-4: Lazily hooks chromadb, faiss, and lancedb in-process vector queries.
"""

from __future__ import annotations

import builtins
import contextvars
import functools
import hashlib
import importlib.machinery
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

_SHIM_DIR = os.path.dirname(os.path.abspath(__file__))

# Env vars that .env must NEVER overwrite
_PROTECTED_ENV_KEYS = {
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "AEROREPL_MODE",
    "AEROREPL_RUN_ID",
    "AFR_RUN_ID",
    "AFR_TRACE_ID",
    "AEROGRAPH_MODE",
    "AEROGRAPH_ORCHESTRATOR_URL",
    "AEROGRAPH_ENDPOINT",
    "AEROGRAPH_CASSETTE_RUN_ID",
    "AEROGRAPH_THREAD_ID",
}


def _chain_load_downstream_sitecustomize() -> None:
    """Execute any downstream sitecustomize.py on sys.path (e.g. Conda/OS)."""
    try:
        removed: list[str] = []
        while _SHIM_DIR in sys.path:
            sys.path.remove(_SHIM_DIR)
            removed.append(_SHIM_DIR)
        spec = importlib.util.find_spec("sitecustomize")
        if spec and spec.origin and os.path.abspath(spec.origin) != os.path.abspath(__file__):
            module = importlib.util.module_from_spec(spec)
            if spec.loader:
                spec.loader.exec_module(module)
    except Exception:
        pass
    finally:
        for d in reversed(removed):
            if d not in sys.path:
                sys.path.insert(0, d)


def _load_dotenv_with_proxy_precedence() -> None:
    """Auto-load .env from cwd without overwriting proxy/CA/AeroGraph vars."""
    try:
        env_path = os.path.join(os.getcwd(), ".env")
        if not os.path.isfile(env_path):
            return
        with open(env_path, "r", encoding="utf-8") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[7:].strip()
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip()
                if len(val) >= 2 and ((val[0] == val[-1] == '"') or (val[0] == val[-1] == "'")):
                    val = val[1:-1]
                if not key or key in _PROTECTED_ENV_KEYS or key in os.environ:
                    continue
                if key.startswith(("AEROGRAPH_", "AFR_", "AEROREPL_")):
                    continue
                os.environ[key] = val
    except Exception:
        pass


def _orch_url() -> str:
    return (os.environ.get("AEROGRAPH_ORCHESTRATOR_URL") or "http://127.0.0.1:4318").rstrip("/")


def _collector_url() -> str:
    return (os.environ.get("AEROGRAPH_ENDPOINT") or "http://127.0.0.1:4317").rstrip("/")


def _run_id() -> str:
    return os.environ.get("AFR_RUN_ID") or os.environ.get("AEROREPL_RUN_ID") or ""


def _cassette_run_id() -> str:
    return os.environ.get("AEROGRAPH_CASSETTE_RUN_ID") or _run_id()


def _mode() -> str:
    return (os.environ.get("AEROGRAPH_MODE") or os.environ.get("AEROREPL_MODE") or "").lower()


def _http_json(method: str, url: str, payload: Optional[dict[str, Any]] = None, timeout: float = 5.0) -> Optional[dict[str, Any]]:
    """Stdlib-only JSON HTTP helper bypassing HTTP_PROXY for localhost Orchestrator/Collector."""
    try:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        headers = {"Content-Type": "application/json"} if data is not None else {}
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except Exception:
        return None


def _is_internal_url(url_str: str) -> bool:
    return (
        url_str.startswith(_orch_url())
        or url_str.startswith(_collector_url())
        or "127.0.0.1:4317" in url_str
        or "127.0.0.1:4318" in url_str
        or "localhost:4317" in url_str
        or "localhost:4318" in url_str
    )


def _get_context_headers() -> dict[str, str]:
    headers: dict[str, str] = {}
    try:
        from aerograph_sdk.context import get_current_branch_id, get_current_span_id, next_local_seq

        span_id = get_current_span_id()
        branch_id = get_current_branch_id()
        seq = next_local_seq(branch_id)
        if span_id:
            headers["X-AeroGraph-Span-Id"] = span_id
        if branch_id:
            headers["X-AeroGraph-Branch-Id"] = branch_id
        headers["X-AeroGraph-Local-Seq"] = str(seq)
    except Exception:
        pass
    return headers


def _wrap_func(target: Any, attr: str, wrapper_fn: Callable[..., Any]) -> None:
    """Wrap target.attr using wrapt if installed, else stdlib functools.wraps."""
    try:
        import wrapt  # type: ignore

        wrapt.wrap_function_wrapper(target, attr, wrapper_fn)
        return
    except ImportError:
        pass
    orig = getattr(target, attr)
    if getattr(orig, "_aerograph_wrapped", False):
        return

    @functools.wraps(orig)
    def _wrapped(*args: Any, **kwargs: Any) -> Any:
        return wrapper_fn(orig, args[0] if args else None, args[1:] if args else (), kwargs) if isinstance(orig, type) else wrapper_fn(orig, None, args, kwargs)

    # For unbound methods on classes, preserve descriptor binding
    if hasattr(orig, "__get__"):
        @functools.wraps(orig)
        def _method_wrapped(self_obj: Any, *args: Any, **kwargs: Any) -> Any:
            return wrapper_fn(orig.__get__(self_obj, type(self_obj)), self_obj, args, kwargs)
        _method_wrapped._aerograph_wrapped = True  # type: ignore[attr-defined]
        setattr(target, attr, _method_wrapped)
    else:
        _wrapped._aerograph_wrapped = True  # type: ignore[attr-defined]
        setattr(target, attr, _wrapped)


# ---------------------------------------------------------------------------
# WP-3: builtins.input() Hook
# ---------------------------------------------------------------------------

_original_input = builtins.input
_input_turn_counter = 0
_cached_inbound: Optional[list[dict[str, Any]]] = None


def _get_recorded_inbound() -> list[dict[str, Any]]:
    global _cached_inbound
    if _cached_inbound is not None:
        return _cached_inbound
    cid = _cassette_run_id()
    if cid:
        res = _http_json("GET", f"{_orch_url()}/v1/runs/{cid}/inbound")
        if isinstance(res, dict) and isinstance(res.get("inbound"), list):
            _cached_inbound = res["inbound"]
            return _cached_inbound
    _cached_inbound = []
    return _cached_inbound


def _aerograph_input(prompt: Any = "") -> str:
    global _input_turn_counter
    turn = _input_turn_counter
    _input_turn_counter += 1
    prompt_str = "" if prompt is None else str(prompt)
    mode = _mode()
    rid = _run_id()

    span_id: Optional[str] = None
    try:
        from aerograph_sdk.context import get_current_span_id
        span_id = get_current_span_id()
    except Exception:
        pass

    # Replay / Fork pre-recorded turn lookup
    if mode in ("replay", "fork"):
        try:
            overrides_raw = os.environ.get("AEROGRAPH_INBOUND_OVERRIDES")
            if overrides_raw:
                overrides = json.loads(overrides_raw)
                if str(turn) in overrides:
                    return str(overrides[str(turn)])
        except Exception:
            pass

        inbound = _get_recorded_inbound()
        for entry in inbound:
            if entry.get("turn") == turn:
                return str(entry.get("payload", ""))
        if turn < len(inbound):
            return str(inbound[turn].get("payload", ""))

        if mode == "replay":
            raise EOFError(f"AeroGraph replay: no recorded human_input for turn {turn}")

    # Record or live-fork turn
    is_tty = False
    try:
        is_tty = bool(sys.stdin and sys.stdin.isatty())
    except Exception:
        is_tty = False

    if is_tty:
        value = _original_input(prompt)
    elif rid:
        # Headless Web UI long-poll via Orchestrator
        _http_json(
            "POST",
            f"{_orch_url()}/v1/runs/{rid}/input-wait",
            {"turn": turn, "prompt": prompt_str, "spanId": span_id},
        )
        value = ""
        while True:
            state = _http_json("GET", f"{_orch_url()}/v1/runs/{rid}/input-wait")
            if state is not None and not state.get("waiting", True):
                value = str(state.get("payload", ""))
                break
            time.sleep(0.2)
    else:
        value = _original_input(prompt)

    if rid:
        _http_json(
            "POST",
            f"{_orch_url()}/v1/runs/{rid}/inbound",
            {
                "channel": "stdin",
                "turn": turn,
                "prompt": prompt_str,
                "payload": value,
                "spanId": span_id,
            },
        )
    return value


def _install_input_hook() -> None:
    if _mode() in ("record", "replay", "fork"):
        builtins.input = _aerograph_input


# ---------------------------------------------------------------------------
# WP-1 & WP-4: Lazy HTTP & Vector DB Interception via sys.meta_path
# ---------------------------------------------------------------------------

_PATCHED_MODULES: set[str] = set()
_cached_retrievals: Optional[list[dict[str, Any]]] = None
_retrieval_used: set[int] = set()


def _get_recorded_retrievals() -> list[dict[str, Any]]:
    global _cached_retrievals
    if _cached_retrievals is not None:
        return _cached_retrievals
    cid = _cassette_run_id()
    if cid:
        res = _http_json("GET", f"{_orch_url()}/v1/runs/{cid}/local-retrievals")
        if isinstance(res, dict) and isinstance(res.get("localRetrievals"), list):
            _cached_retrievals = res["localRetrievals"]
            return _cached_retrievals
    _cached_retrievals = []
    return _cached_retrievals


def _canonical_query_key(provider: str, collection: str, args_obj: Any) -> str:
    raw = json.dumps(
        {"provider": provider, "collection": collection, "args": args_obj},
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _lookup_retrieval(query_key: str) -> Optional[dict[str, Any]]:
    items = _get_recorded_retrievals()
    for idx, item in enumerate(items):
        if idx not in _retrieval_used and item.get("queryKey") == query_key:
            _retrieval_used.add(idx)
            return item.get("result")
    return None


def _record_retrieval(provider: str, collection: str, query_key: str, query_args: dict[str, Any], result: dict[str, Any]) -> None:
    rid = _run_id()
    if not rid:
        return
    span_id = None
    branch_id = "root"
    local_seq = 0
    try:
        from aerograph_sdk.context import get_current_branch_id, get_current_span_id, next_local_seq
        span_id = get_current_span_id()
        branch_id = get_current_branch_id()
        local_seq = next_local_seq(branch_id)
    except Exception:
        pass
    _http_json(
        "POST",
        f"{_orch_url()}/v1/runs/{rid}/local-retrievals",
        {
            "provider": provider,
            "queryKey": query_key,
            "collection": collection,
            "queryArgs": query_args,
            "result": result,
            "spanId": span_id,
            "branchId": branch_id,
            "localSeq": local_seq,
        },
    )


def _patch_httpx(mod: Any) -> None:
    def _inject(req: Any) -> None:
        if _is_internal_url(str(getattr(req, "url", ""))):
            return
        for k, v in _get_context_headers().items():
            if k not in req.headers:
                req.headers[k] = v

    if hasattr(mod, "Client"):
        def _sync_send(wrapped: Any, instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            if args:
                _inject(args[0])
            return wrapped(*args, **kwargs)
        _wrap_func(mod.Client, "send", _sync_send)

    if hasattr(mod, "AsyncClient"):
        async def _async_send(wrapped: Any, instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            if args:
                _inject(args[0])
            return await wrapped(*args, **kwargs)
        _wrap_func(mod.AsyncClient, "send", _async_send)


def _patch_requests(mod: Any) -> None:
    if hasattr(mod, "Session"):
        def _send(wrapped: Any, instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            if args and not _is_internal_url(str(getattr(args[0], "url", ""))):
                for k, v in _get_context_headers().items():
                    if k not in args[0].headers:
                        args[0].headers[k] = v
            return wrapped(*args, **kwargs)
        _wrap_func(mod.Session, "send", _send)


def _patch_aiohttp(mod: Any) -> None:
    if hasattr(mod, "ClientSession"):
        async def _req(wrapped: Any, instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            url_str = str(args[1]) if len(args) > 1 else ""
            if not _is_internal_url(url_str):
                hdrs = dict(kwargs.get("headers") or {})
                for k, v in _get_context_headers().items():
                    hdrs.setdefault(k, v)
                kwargs["headers"] = hdrs
            return await wrapped(*args, **kwargs)
        _wrap_func(mod.ClientSession, "_request", _req)


def _patch_chromadb(mod: Any) -> None:
    try:
        from chromadb.api.models.Collection import Collection  # type: ignore

        for method_name in ("query", "get"):
            def _make_wrapper(mname: str) -> Callable[..., Any]:
                def _wrapper(wrapped: Any, instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
                    col_name = getattr(instance, "name", "default")
                    q_args = {"method": mname, "args": args, "kwargs": kwargs}
                    q_key = _canonical_query_key("chromadb", col_name, q_args)
                    if _mode() in ("replay", "fork"):
                        cached = _lookup_retrieval(q_key)
                        if cached is not None:
                            return cached
                    res = wrapped(*args, **kwargs)
                    if _mode() in ("record", "fork") and isinstance(res, dict):
                        _record_retrieval("chromadb", col_name, q_key, q_args, res)
                    return res
                return _wrapper

            _wrap_func(Collection, method_name, _make_wrapper(method_name))
    except Exception:
        pass


def _patch_faiss(mod: Any) -> None:
    try:
        if hasattr(mod, "Index"):
            def _search_wrapper(wrapped: Any, instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
                q_vec = args[0].tolist() if args and hasattr(args[0], "tolist") else (args[0] if args else None)
                k = args[1] if len(args) > 1 else kwargs.get("k")
                q_args = {"x": q_vec, "k": k}
                q_key = _canonical_query_key("faiss", type(instance).__name__, q_args)
                if _mode() in ("replay", "fork"):
                    cached = _lookup_retrieval(q_key)
                    if cached is not None:
                        try:
                            import numpy as np  # type: ignore
                            return np.array(cached["distances"], dtype="float32"), np.array(cached["indices"], dtype="int64")
                        except Exception:
                            return cached["distances"], cached["indices"]
                distances, indices = wrapped(*args, **kwargs)
                if _mode() in ("record", "fork"):
                    res_dict = {
                        "distances": distances.tolist() if hasattr(distances, "tolist") else list(distances),
                        "indices": indices.tolist() if hasattr(indices, "tolist") else list(indices),
                    }
                    _record_retrieval("faiss", type(instance).__name__, q_key, q_args, res_dict)
                return distances, indices

            _wrap_func(mod.Index, "search", _search_wrapper)
    except Exception:
        pass


def _patch_lancedb(mod: Any) -> None:
    try:
        from lancedb.table import Table  # type: ignore

        def _search_wrapper(wrapped: Any, instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            tbl_name = getattr(instance, "name", "default")
            q_val = args[0].tolist() if args and hasattr(args[0], "tolist") else (args[0] if args else kwargs.get("query"))
            q_args = {"query": q_val, "kwargs": kwargs}
            q_key = _canonical_query_key("lancedb", tbl_name, q_args)
            if _mode() in ("replay", "fork"):
                cached = _lookup_retrieval(q_key)
                if cached is not None and isinstance(cached.get("rows"), list):
                    rows = cached["rows"]
                    class _CachedLanceQuery:
                        def limit(self, *_a: Any, **_kw: Any) -> "_CachedLanceQuery":
                            return self
                        def where(self, *_a: Any, **_kw: Any) -> "_CachedLanceQuery":
                            return self
                        def select(self, *_a: Any, **_kw: Any) -> "_CachedLanceQuery":
                            return self
                        def to_list(self) -> list[Any]:
                            return rows
                    return _CachedLanceQuery()

            query_obj = wrapped(*args, **kwargs)
            if _mode() in ("record", "fork") and hasattr(query_obj, "to_list"):
                orig_to_list = query_obj.to_list
                def _wrapped_to_list(*tl_args: Any, **tl_kwargs: Any) -> list[Any]:
                    rows = orig_to_list(*tl_args, **tl_kwargs)
                    _record_retrieval("lancedb", tbl_name, q_key, q_args, {"rows": rows})
                    return rows
                query_obj.to_list = _wrapped_to_list
            return query_obj

        _wrap_func(Table, "search", _search_wrapper)
    except Exception:
        pass


def _patch_concurrent(mod: Any) -> None:
    """Propagate contextvars (X-AeroGraph-Span-Id/Branch-Id) across ThreadPoolExecutor.submit."""
    try:
        import concurrent.futures as _cf  # type: ignore

        def _submit_wrapper(wrapped: Any, instance: Any, args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
            if not args:
                return wrapped(*args, **kwargs)
            fn, *rest = args
            ctx = contextvars.copy_context()

            @functools.wraps(fn)
            def _ctx_runner(*f_args: Any, **f_kwargs: Any) -> Any:
                return ctx.run(fn, *f_args, **f_kwargs)

            return wrapped(_ctx_runner, *rest, **kwargs)

        _wrap_func(_cf.ThreadPoolExecutor, "submit", _submit_wrapper)
    except Exception:
        pass


_PATCHERS: dict[str, Callable[[Any], None]] = {
    "concurrent": _patch_concurrent,
    "httpx": _patch_httpx,
    "requests": _patch_requests,
    "aiohttp": _patch_aiohttp,
    "chromadb": _patch_chromadb,
    "faiss": _patch_faiss,
    "lancedb": _patch_lancedb,
}


def _apply_patch(name: str, mod: Any) -> None:
    if name in _PATCHED_MODULES:
        return
    patcher = _PATCHERS.get(name)
    if patcher is not None:
        _PATCHED_MODULES.add(name)
        try:
            patcher(mod)
        except Exception:
            pass


class _AeroGraphImportHook:
    """Stdlib MetaPathFinder that patches HTTP/vector modules right after import."""

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        root = fullname.split(".", 1)[0]
        if root not in _PATCHERS or root in _PATCHED_MODULES:
            return None
        # Temporarily remove self to resolve real spec
        try:
            sys.meta_path.remove(self)
            spec = importlib.util.find_spec(fullname, path)
        finally:
            if self not in sys.meta_path:
                sys.meta_path.insert(0, self)
        if spec and spec.loader:
            orig_exec = getattr(spec.loader, "exec_module", None)
            if orig_exec is not None:
                def _exec_and_patch(module: Any) -> None:
                    orig_exec(module)
                    _apply_patch(root, sys.modules.get(root, module))
                spec.loader.exec_module = _exec_and_patch  # type: ignore[assignment]
        return spec


def _install_import_hooks() -> None:
    for name in list(_PATCHERS.keys()):
        if name in sys.modules:
            _apply_patch(name, sys.modules[name])
    if not any(isinstance(f, _AeroGraphImportHook) for f in sys.meta_path):
        sys.meta_path.insert(0, _AeroGraphImportHook())


def _bootstrap() -> None:
    _chain_load_downstream_sitecustomize()
    _load_dotenv_with_proxy_precedence()
    _install_input_hook()
    _install_import_hooks()


try:
    _bootstrap()
except Exception:
    pass
