# Feature 006 v2: Deterministic Replay for AeroGraph via agrepl Integration

**A feasibility assessment and full replan of the Universal Replay Engine**

Prepared from: `feature-006-plan-report.md`, *Deterministic Replay for AI Agent Systems* (Mudasiru), the live `SGcpu/AeroGraph` repository, and the live `Taiwrash/agrepl` repository.

---

## 1. Executive Summary

The original Feature 006 plan describes a "Universal Replay Engine" for AeroGraph with four capabilities: zero-cost replay of past runs, mid-trace forking with automatic live continuation, framework-agnostic adapters, and a terminal REPL (`agrepl`). Notably, the plan already borrows the name `agrepl` for its terminal tool — which turns out to be a real, independently developed open-source project (`Taiwrash/agrepl`) implementing almost exactly the record/replay mechanics the plan calls for.

**This document does three things:**

1. Verifies, against the actual codebases, what `agrepl` really does and what AeroGraph really does today (not what the marketing copy implies).
2. Identifies the gap between "what Feature 006 wants" and "what exists," precisely.
3. Replans Feature 006 as an integration of `agrepl` (as the record/replay/proxy substrate) with AeroGraph (as the observability, graph, and lineage layer), including the net-new components required to close the gap.

**Bottom line: integration is feasible and is the right architectural move — but it is not a drop-in.** `agrepl` solves interception and deterministic replay at the network layer; AeroGraph solves visualization, semantic event modeling, and lineage at the application layer. Neither currently does the other's job, and — critically — **AeroGraph's own README states outright that it is not an execution engine**, and its "fork" feature today is a manual, copy-the-trace-ID-into-your-script workflow, not an automatic replay-then-diverge pipeline. Making Scenario B (automatic fork-and-resume) real requires building a new orchestration layer that does not exist in either project today.

---

## 2. Feasibility Assessment

### 2.1 What `agrepl` actually does (verified against the repo and paper)

`Taiwrash/agrepl` is a real, MIT-licensed, Go-based CLI (alpha stage, ~30 GitHub stars). Verified capabilities:

- **Interception**: a MITM proxy (built on `goproxy`) that intercepts all outbound HTTP/HTTPS from a child process by setting `HTTP_PROXY`/`HTTPS_PROXY` env vars and installing an ephemeral local CA. This is **zero-instrumentation** — it works with any language runtime (Python, Node, Go, curl), not just JS/TS agent frameworks. LLM SDK calls (Gemini, OpenAI) are captured transparently because they're just HTTPS requests to well-known hosts.
- **Recording**: `agrepl record -- <your command>` captures every (request, response) pair to a local JSON trace under `.agrepl/runs/`.
- **Replay**: `agrepl run <run-id>` re-executes the command with the proxy in strict mode — all outbound TCP is refused, and matched requests are served from the trace with zero network calls and zero token cost.
- **Request matching**: requests are matched by a content-derived key `K(s) = SHA256(method ‖ norm(url) ‖ hash(body))`, not by position in the sequence. This means replay is **order-independent lookup**, not strict step-by-step playback.
- **Fallback mode** (`--fallback`, per the paper): unmatched requests are forwarded live instead of erroring. This is the mechanism that — although not built for this purpose — structurally enables "replay what's cached, execute live what changed."
- **Sharing**: `agrepl share`/`agrepl pull` push/pull traces via Cloudflare R2 for team reproduction.
- **What it explicitly does NOT do today** (per its own roadmap): gRPC/HTTP2 interception, official SDK wrappers, fuzzy/semantic request matching, CI/CD integration, token-cost analytics, and — importantly — **there is no concept of forking, branching, or step-level graph structure anywhere in agrepl.** It treats an execution as a flat, unordered bag of (request → response) pairs, not a DAG with named steps.

### 2.2 What AeroGraph actually does (verified against the repo)

`SGcpu/AeroGraph` is a real, Apache-2.0, contract-first TypeScript/Python monorepo (~9 stars, actively structured with CI parity checks). Verified capabilities:

- **Event model**: 10 canonical event kinds (`prompt`, `response`, `tool_call`, `tool_result`, `handoff`, `error`, `note`, `state_snapshot`, `retriever`, `checkpoint`) emitted by SDKs (`@aerograph/sdk`, `aerograph-sdk`) or the LangChain callback adapter, POSTed to a local collector (`apps/collector`) and stored append-only in SQLite.
- **Graph UI**: `apps/web` renders a ReactFlow-based trace graph with payload inspection, failure highlighting, loop-warning analysis, and a lineage/diff panel using Myers diff.
- **Forking, as it exists today, is manual**: clicking "Fork from here" in the UI copies prefix events into a new trace ID and displays that ID. **The developer then has to go back to their own code, paste the new trace ID into `FlightRecorder(trace_id=...)`, and re-run the script themselves from their terminal.** AeroGraph does not resume execution, does not know how to re-invoke the agent, and does not intercept or cache the underlying LLM/API calls at all — it only records what the SDK tells it happened, after the fact.
- **State hashing**: `state_snapshot` events compute a deterministic SHA-256 hash of full LangGraph node state, used to detect identical states across forks — but this is for **diffing**, not for **replay**.
- **Explicit self-description**: the README states, verbatim, that AeroGraph "does zero execution" and is "not an execution or orchestration engine (like a Jupyter notebook)" — it is "the Network tab in Chrome DevTools," not a re-run button.
- **No proxy layer, no HTTP interception, no request-hash caching, no tool-safety categorization (`replay_safe`/`must_execute`), and no zero-token replay** exist anywhere in the current codebase.

### 2.3 Gap analysis

| Feature 006 requirement | agrepl today | AeroGraph today | Gap |
|---|---|---|---|
| Zero-cost replay of a past run (Scenario A) | Yes — this is its core function | No — only observes, never replays | Wire agrepl as AeroGraph's execution substrate |
| Fork at step 15, auto-resume live from there (Scenario B) | Partial — `--fallback` mode structurally supports "cached-until-divergence," but has no concept of a "step" or a graph position | Partial — creates the new trace ID and copies prefix events, but resuming is a manual human action | Build a **launcher** that (a) truncates/filters the parent trace to the fork point, (b) starts agrepl in fallback mode against that truncated trace, (c) re-invokes the agent process automatically |
| Framework adapters translate state to/from JSON (Scenario C) | N/A — agrepl doesn't need adapters, it's below the framework, at the network layer | Yes — this is exactly what `packages/adapter-langchain` / `python/aerograph-langchain` already do | No gap — AeroGraph's existing adapter pattern is reusable as-is |
| Interactive terminal REPL (Scenario D) | agrepl has a CLI (`record`, `run`, `list`, `diff`, `share`, `pull`), but no `/step`, `/inspect`, `/override`, `/rewind` command surface | No REPL of any kind | Net-new CLI layer, either forked from agrepl or built as a wrapper around it |
| `replay_safe` vs `must_execute` tool categorization | Not implemented anywhere in agrepl | Not implemented; AeroGraph has no concept of "tool safety" | Net-new policy layer, most naturally added as a proxy plugin in front of or inside agrepl |
| Millisecond cache hydration | Yes — sub-millisecond local JSON lookups per the paper's benchmark (median 0.9ms replay latency, F = 1.0 fidelity across 250 replay instances) | N/A | No gap once agrepl is wired in |
| Framework-agnostic core | Yes, by construction (proxy-level, not SDK-level) | Yes, by construction (contract-first event schema); but its *fork/resume* workflow is framework-specific glue code the user writes today | Partial — see Scenario B gap |
| Visual DAG, failure localization, loop detection | N/A — agrepl has no visualization | Yes — this is AeroGraph's strength | No gap — keep AeroGraph as the UI of record |

### 2.4 Verdict

**Feasible, and the right design — with one important correction to the original plan's ambition.** The original Feature 006 plan implicitly assumed AeroGraph already had (or would build) its own replay/caching engine from scratch ("avoiding the complexity of building their own caching mechanisms" — Section 1 of the original report). Given that a working, benchmarked (F = 1.0 fidelity, 98.3% median latency reduction across 250 replay instances), MIT-licensed implementation of exactly that caching/replay mechanism already exists in `agrepl`, **building a second one from scratch inside AeroGraph would be redundant.** The correct move is composition, not reinvention:

- **agrepl becomes AeroGraph's replay/caching substrate** (record, replay, request-key matching, isolation).
- **AeroGraph remains the semantic graph, visualization, lineage, and diff layer.**
- **A new, thin orchestration layer** — not present in either project — is built to connect the two: correlating agrepl's request-level trace with AeroGraph's span-level trace, translating between agrepl's flat JSON cassette and AeroGraph's DAG, and turning today's manual "copy the trace ID" fork workflow into a genuinely one-click "fork and resume."

This also changes the constitutional claim in the original report ("Trace Replayability is NON-NEGOTIABLE") from an aspiration into something AeroGraph can now actually guarantee, because the hard part — deterministic byte-for-byte replay — is inherited from a component that has already been formally specified and empirically validated (the determinism invariant `D(E,E') = ∅` and fidelity metric `F(E,E') = 1 − |D(E,E')|/|E|`, proven and measured at F = 1.0 in the referenced paper).

---

## 3. Integration Architecture

### 3.1 Component overview

Five components make up the integrated system. The first two exist today (agrepl, AeroGraph); the third is net-new; the fourth and fifth are extensions of existing AeroGraph pieces.

1. **agrepl MITM proxy** (existing, Go binary) — intercepts, records, and replays all HTTP(S)/LLM traffic from the agent process. Runs as a local sidecar process, invoked by the orchestrator rather than directly by the developer.
2. **AeroGraph SDK + framework adapters** (existing, TS + Python) — continue to run inside the agent process exactly as today, emitting semantic events (`prompt`, `tool_call`, `state_snapshot`, etc.) to the collector. Unchanged.
3. **Replay Orchestrator** (new) — a small service (can live inside `apps/collector` as a new module, e.g. `apps/collector/src/replay/`) that is the only genuinely new piece of infrastructure required. It is responsible for:
   - Launching the agent process wrapped by `agrepl record --fallback -- <cmd>` (record phase) or `agrepl run --fallback <run-id> -- <cmd>` (replay/fork phase), instead of the developer invoking agrepl directly.
   - Injecting a correlation header (e.g. `X-AeroGraph-Span-Id`) into outbound requests so each agrepl trace step can be matched 1:1 to the AeroGraph span that triggered it. This requires a small patch to agrepl's proxy handler to pass through a header supplied by the wrapped process (agent SDKs already set custom headers on LLM calls in most frameworks; where they don't, the orchestrator can inject it via an env-var-driven request-ID scheme picked up by the AeroGraph SDK before each call).
   - After each run, ingesting the agrepl trace JSON (`.agrepl/runs/<id>.json`) into the AeroGraph collector as annotations on the existing spans: `cached: true/false`, `latency_ms`, `k_hash`, `tokens_saved`.
   - Owning the **tool-safety policy** (`replay_safe` / `must_execute`), evaluated per-request before agrepl decides to serve from cache — see 3.4.
4. **AeroGraph collector** (existing, extended) — gains a handful of new fields on existing event/span records (`replaySource: "cache" | "live"`, `requestKey`, `costSaved`) and two new endpoints (`POST /v1/traces/:id/replay`, `POST /v1/traces/:id/fork-and-resume`).
5. **AeroGraph web UI** (existing, extended) — the existing "Fork from here" button gains a second mode: instead of only displaying a new trace ID for the developer to paste, it also offers a "Fork and resume now" action that calls the orchestrator directly.

### 3.2 Why the orchestrator has to be new code, not a config change

This is the one place worth being blunt about, because it's easy to undersell: **today, nothing in either project can take a UI click and turn it into a running process.** AeroGraph's collector and web UI are pure TypeScript/Node and have no concept of spawning child processes on the developer's machine (nor should they, for a hosted deployment — see 3.5 on deployment modes). agrepl is a CLI the developer runs by hand. Bridging "click Fork in the browser" to "a new agent process is now running with the right env vars, the right proxy, and the right trace file" requires a local **agent** — a small daemon that AeroGraph's self-hosted deployment already runs adjacent to (since the collector itself is meant to run locally per the current architecture: "no distributed infrastructure ... all local SQLite"). This is the natural home for the orchestrator, and it fits AeroGraph's existing local-first philosophy without requiring any new infrastructure class (no queues, no k8s — consistent with the stated architecture principle).

### 3.3 Data flow by scenario

**Record (baseline capture).** The orchestrator starts the agent as `agrepl record --fallback -- python agent.py`, with the AeroGraph SDK/adapter active inside the process as usual. Two parallel trace streams are produced: agrepl's flat request/response cassette, and AeroGraph's semantic span DAG. The orchestrator links them via the correlation header immediately after the run completes and stores the merge in the collector.

**Replay (Scenario A, zero-cost debugging).** The orchestrator re-invokes the same command as `agrepl run --fallback <run-id> -- python agent.py`. Because the command and all inputs are byte-identical, every request key `K(s)` matches the recorded trace, so `D(E,E') = ∅` and every step hydrates from cache in under a few milliseconds (per the paper's benchmark). The AeroGraph web UI plays back the same visual trace but with a "replayed, $0.00, Nms" badge on every span instead of "live."

**Fork (Scenario B, time travel).** The developer edits a prompt on a node in the AeroGraph UI and clicks "Fork and resume." The orchestrator: (1) creates the new AeroGraph trace ID and copies prefix span events exactly as the current fork logic already does; (2) writes a filtered agrepl trace file containing only the steps before the fork point; (3) launches `agrepl run --fallback <filtered-run-id> -- <original command, with the edited prompt substituted via whatever mechanism the framework adapter exposes for prompt injection>`. Steps before the fork point still match `K(s)` and hydrate from cache. The edited prompt at the fork step produces a different request body, so its hash no longer matches anything in the trace — a guaranteed cache miss — and in fallback mode agrepl forwards it (and everything downstream) to the live network. The original trace is never touched; the new trace is fully independent and causally linked via AeroGraph's existing `derivedFrom` lineage field.

**Adapter authoring (Scenario C).** Unchanged from AeroGraph's existing "Workflow B — Adding a new adapter" process (create `packages/adapter-<name>` and `python/aerograph-<name>` mirroring the LangChain adapter's structure). agrepl requires no adapter work at all, since it operates below the framework at the transport layer — this is worth calling out to adapter authors explicitly, because it means a new framework gets replay support "for free" the moment its adapter is registered with the orchestrator, with zero replay-specific code in the adapter itself.

**Interactive REPL (Scenario D).** Rebuilt as a thin wrapper CLI (working name `aerorepl`, to avoid confusion with or trademark overlap with upstream `agrepl`) that talks to the orchestrator's local HTTP API rather than reimplementing proxy logic. `/step`, `/inspect`, `/rewind N`, `/override` become orchestrator API calls (`POST /v1/traces/:id/step`, `GET /v1/traces/:id/spans/:spanId`, `POST /v1/traces/:id/fork-and-resume`), so the REPL and the web UI are two clients of the exact same backend logic — never two divergent implementations of "what does rewind mean."

### 3.4 Tool safety: `replay_safe` vs `must_execute`

This must be implemented as a policy the orchestrator evaluates **before** deciding which agrepl mode to run in, since agrepl itself has no such concept today. Concretely: a config file (`aerograph.replay.yaml`) maps URL patterns or tool names to a safety class:

```yaml
tools:
  - match: "api.openai.com/*"
    class: replay_safe
  - match: "api.sendgrid.com/*"
    class: must_execute
  - match: "*.internal.mycompany.com/payments/*"
    class: must_execute
```

For `must_execute`-classed requests, the orchestrator runs agrepl with those specific hosts added to a **passthrough allowlist** (a small addition needed on top of agrepl's existing strict/fallback modes — currently binary per-run, not per-host) so that even during a full zero-cost replay, that one call is always forced live regardless of cache hit. This is the single piece of net-new logic inside agrepl itself that this integration requires (everything else is achievable by wrapping agrepl as-is); it should be proposed upstream as a `--live-hosts` flag, since it is generally useful outside of AeroGraph too.

### 3.5 Deployment model

AeroGraph already supports two deployment modes (self-hosted and hosted). The orchestrator changes this only for the self-hosted case, where it can freely spawn local processes on the developer's own machine — this is the primary target for Feature 006 v2. For the hosted case, the orchestrator's process-spawning role would need to run inside a customer-controlled agent (a small local daemon connecting outward to the hosted collector), since a SaaS backend should never be spawning arbitrary customer code — this should be scoped as a fast-follow, not part of the initial release, and flagged clearly to users as such.

---

## 4. Revised Feature 006 Requirements

Restating the original five system requirements against the integration design above:

1. **Framework-Agnostic Middleware** — inherited for free: agrepl is framework-agnostic by construction (proxy layer, not SDK layer), and AeroGraph's adapter pattern already handles the semantic side per-framework.
2. **Strict Immutable History** — unchanged and already true of both systems (AeroGraph's collector is append-only; agrepl never mutates a recorded trace file, only reads it during replay).
3. **Deterministic Verification despite dynamic values** — inherited directly from agrepl's noise-aware diff engine (Signal/Noise/Removed header taxonomy), which already exists and was empirically validated (0 false positives/negatives across 100 unfiltered-run pairs, precision = recall = 1.0 on 12 pairs with injected semantic changes). No new work needed beyond exposing this in the AeroGraph diff UI, which already has a diff view to extend.
4. **Tool Safety Categorization** — net new, as detailed in 3.4. This is the one genuinely unimplemented requirement anywhere in either codebase and should be treated as the highest-risk, highest-priority build item.
5. **Instantaneous Performance** — inherited and already benchmarked (median 0.9ms replay per step, 98.3% median latency reduction) rather than a target AeroGraph needs to hit on its own.

---

## 5. Implementation Roadmap

| Phase | Scope | Depends on |
|---|---|---|
| 0. Spike | Manually wrap an existing AeroGraph demo (`apps/demo`) with `agrepl record` / `agrepl run` to confirm request-key matching survives real LangChain/OpenAI traffic patterns (streaming responses, retries) | Nothing — can start immediately |
| 1. Correlation | Build the span-id ↔ request-key correlation header and the trace-merge step; surface "cached vs live" as a read-only badge in the web UI | Phase 0 |
| 2. Orchestrator (record + replay) | Build the local orchestrator service; wire Scenario A end-to-end (replay a past run at zero cost, unmodified) | Phase 1 |
| 3. Fork-and-resume | Build the filtered-trace generation + auto-relaunch logic for Scenario B; extend the "Fork from here" UI action | Phase 2 |
| 4. Tool safety policy | Add `aerograph.replay.yaml`, implement per-host passthrough in the orchestrator, propose the `--live-hosts` flag upstream to agrepl | Phase 2 (can run parallel to Phase 3) |
| 5. REPL | Build `aerorepl` as an orchestrator client | Phase 3 |
| 6. Hosted-mode agent | Package the orchestrator as a customer-run local daemon for hosted deployments | Phase 3, deprioritized |

---

## 6. Risks and Open Questions

- **Upstream dependency risk.** agrepl is alpha software (v0.1.0-alpha, single maintainer, 30 stars). Depending on it for a core AeroGraph capability means either vendoring/forking it (recommended, given MIT license permits this) or accepting upstream velocity risk. Recommend vendoring a pinned fork (`aerograph-replay-core`) rather than depending on the upstream binary directly, applying the `--live-hosts` and header-passthrough changes there, and periodically merging upstream improvements.
- **Streaming responses.** Neither the agrepl paper nor its evaluation explicitly addresses streamed LLM responses (SSE/chunked transfer) in the request-key matching model — this needs verification in Phase 0, since AeroGraph's streaming-telemetry feature (TTFT, tokens/sec) depends on exact chunk timing that a naive whole-response cache replay would flatten to zero.
- **Prompt-substitution mechanism for forking.** Scenario B's auto-resume assumes there's a clean way to re-inject an edited prompt into a running agent process at a specific point. This is straightforward for a single top-level prompt but genuinely hard for deeply nested chains/graphs (LangGraph state at step 15 may depend on more than just the prompt text). This likely needs to be scoped per-adapter rather than solved generically — LangGraph's own checkpointing mechanism may be a better foundation for "resume from state X" than pure trace replay for graph-shaped agents.
- **Header injection depends on framework cooperation.** Not every framework/SDK lets calling code set arbitrary custom headers on outbound LLM requests. Where it can't be done via header, a fallback correlation strategy (interleaving order + timestamp windowing) will be needed, with lower reliability.
- **must_execute correctness is safety-critical.** A misclassified tool (e.g., a payment or email send tool wrongly marked `replay_safe`) would silently replay a side-effecting action from cache during what a developer believes is "just debugging." The policy file should default to `must_execute` for anything unlisted, not `replay_safe`, and the orchestrator should log every live vs. cached decision loudly.

---

## 7. Recommendation

Proceed with the integration as designed in Section 3, starting with Phase 0 as a one- or two-day spike before committing engineering time to the orchestrator. The core technical bet — that agrepl's proxy-level record/replay mechanism can sit underneath AeroGraph's existing SDK/adapter/collector/UI stack without conflicting with it — is sound, because the two systems operate at different layers (network transport vs. semantic application events) and were never doing the same job to begin with. The work that remains is real but bounded: one new orchestration service, one small upstream/fork patch to agrepl for per-host passthrough, and UI wiring on an existing "Fork from here" action that already does most of what's needed except the final "actually re-run it" step.

---

## References

- `feature-006-plan-report.md` — original Feature 006 plan (user-provided)
- Mudasiru, R., *Deterministic Replay for AI Agent Systems* — agrepl's formal execution model, determinism invariant, request-key function, and empirical evaluation (user-provided PDF)
- [github.com/Taiwrash/agrepl](https://github.com/Taiwrash/agrepl) — verified live, README and roadmap reviewed 2026-08-31
- [github.com/SGcpu/AeroGraph](https://github.com/SGcpu/AeroGraph) — verified live, README, architecture, and contributing docs reviewed 2026-08-31
