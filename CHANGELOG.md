# Changelog

All notable changes to AeroGraph will be documented in this file.

## [0.3.0] - 2026-09-05

### Added - Feature 006: Deterministic Replay via aerorepl Integration
- **Deterministic Replay Core**: Integrated local MITM proxy engine (`aerograph-replay-core`) for zero-cost caching and replaying of agent network calls with <5ms lookup latency.
- **Orchestrator Sub-app**: Added Orchestrator running on port 4318 supporting `/v1/runs`, `/v1/runs/:id/cancel`, and interactive `/v1/sessions` APIs.
- **`aerorepl` CLI**: Added `@aerograph/aerorepl` package providing terminal commands (`record`, `replay`, `list`, `status`, `cancel`) and an interactive REPL session (`/step`, `/inspect`, `/override`, `/rewind`, `/fork`).
- **Fork-and-Resume**: One-click fork and automatic agent re-execution from any trace span in the Web UI and API (`POST /v1/traces/:id/fork-and-resume`).
- **Tool Safety Policy**: Configurable `aerograph.replay.yaml` supporting `replay_safe` and `must_execute` URL routing with first-match semantics and default-deny protection.
- **Web UI Enhancements**: Added `ReplayControlPanel`, `ForkResumeModal`, `ProjectConfigModal` (`⚙️ Config`), `RunStatusBadge`, routing decision badges, and divergence diff views.
- **Zero-Manual-File Auto-Binding**: Eliminated manual YAML file placement; users can set, inspect, or paste commands/YAML via `npx aerorepl config` or directly in the Web UI, with automatic storage in `.aerograph/aerograph.project.yaml`.

### Database Migrations
- **Migration `006_replay`**: Additive-only — existing databases upgrade automatically on first start.
  - Adds `runs` table to track execution runs, parent trace lineages, and run statuses.
  - Adds additive replay columns to `events` table: `replay_source`, `request_key`, `tokens_saved`, `replay_latency_ms`, `streaming_preserved`, `overridden`, `decision`, `matched_pattern`, `effective_class`.
