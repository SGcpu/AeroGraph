<!--
Sync Impact Report

- Version change: 1.0.0 → 1.1.0
- Modified principles:
	- III. Trace Replayability (NON-NEGOTIABLE) → III. Trace Replayability & Cassette Fidelity (NON-NEGOTIABLE) (expanded to cover cassette integrity, live-step persistence in forks, and determinism)
- Added principles:
	- VI. Ephemeral Security & Credential Hygiene (ephemeral CA lifecycle, zero private key persistence, sensitive header/query redaction)
	- VII. Cross-Language Parity (TypeScript & Python Equality) (first-class parity between Node/TS and Python SDKs)
- Added sections:
	- Continuous Schema Governance & Drift Prevention
	- Pre-Push & Release Hygiene Checklist (Mandatory Syncs)
- Modified sections:
	- Architecture Constraints → Architecture & Persistence Constraints (expanded to enforce immutable historical traces and additive migrations)
	- Workflow & Change Control (expanded with pre-push drift checks and CI pipeline requirements)
- Templates requiring updates:
	- ✅ .specify/templates/plan-template.md (Constitution Check gates align with VI, VII, and Pre-Push Checklist)
	- ✅ .specify/templates/tasks-template.md (Task categories align with drift checks and cross-language parity)
	- ⚠ .specify/templates/spec-template.md (no change required; already supports cross-layer constraints)
- Follow-up TODOs: none
-->

# AeroGraph Constitution

## Core Principles

### I. Event Schema Is Source of Truth
The event schema is the canonical definition of what the platform means by a
"trace event". Backend services, adapters, CLI tools, and UI MUST derive their data
models, serialization, validation, and storage from the schema.

- Any change to the schema is a contract change.
- No component may introduce ad-hoc event fields outside the schema.
- Schema changes MUST include a migration/compatibility plan and tests proving
	forward/backward compatibility as appropriate.

### II. Shared Contracts (No Bypasses)
No UI, CLI, or backend logic may bypass shared contracts.

- UI state, API calls, CLI commands, and event rendering MUST use shared contract types that
	are generated from (or directly aligned with) `@aerograph/contracts`.
- If the UI or CLI needs data that is not in the contracts, the correct fix is to
	evolve the schema/contracts—never to bypass them with unvalidated objects.
- Requirements that imply new endpoints or fields MUST be marked as
	`NEEDS CLARIFICATION` rather than invented ad-hoc.

### III. Trace Replayability & Cassette Fidelity (NON-NEGOTIABLE)
All implementation MUST preserve trace replayability and cassette fidelity.

- Trace events MUST contain enough normalized information to replay or
	reconstruct execution paths (including parent/child relationships and
	ordering).
- In strict replay mode, LLM and tool calls designated as replay-safe MUST be served
	100% deterministically from local cassettes at zero network cost ($0.00).
- Side effects MUST be represented explicitly (and, where applicable, classified
	as `must_execute` via `aerograph.replay.yaml`) so replay cannot silently diverge.
- During fork-and-resume executions, pre-fork steps are deterministically replayed
	from cassette, while newly executed live steps MUST be recorded and appended
	to the child run's cassette so the child run remains self-contained and replayable.

### IV. Adapter Normalization
All adapters MUST emit normalized trace events.

- Each adapter MUST define a deterministic mapping from the source framework's
	events/spans into the platform event schema.
- Adapters MUST not leak framework-specific semantics into the normalized layer
	unless explicitly modeled in the schema.
- When in doubt, prefer improving the schema over adding adapter-specific
	exceptions.

### V. Tests Are Mandatory Where It Matters
Tests are mandatory for the event schema, adapters, and replay behavior.

- Schema tests MUST validate (at minimum) structural validity and
	compatibility expectations.
- Adapter tests MUST include golden fixtures proving normalized output across runtimes.
- Replay tests MUST prove that a trace can be replayed/forked without breaking
	referential integrity or silently losing required context.
- PRs that touch schema, adapters, proxy interceptors, or replay runners MUST not be
	merged without automated tests.

### VI. Ephemeral Security & Credential Hygiene
The platform must never introduce security vulnerabilities through its recording or replay machinery.

- **Ephemeral CA Lifecycle**: Any MITM proxy Certificate Authority generated for HTTPS
	interception MUST be strictly ephemeral. Private keys MUST be kept in-memory or in an
	`os.MkdirTemp` temporary directory and wiped immediately on session completion.
	Process termination traps (`SIGINT`, `SIGTERM`, unhandled crashes) MUST guarantee CA
	removal. No trusted root CA private key may ever persist on disk.
- **Sensitive Credential Redaction**: All outbound authentication headers (`Authorization`,
	`Proxy-Authorization`, `X-Api-Key`, `Cookie`, `Set-Cookie`) and query parameters
	containing secrets (`?key=`, `api_key=`) MUST be redacted (`[REDACTED]`) before
	persisting to cassettes or trace stores.
- **Strict Network Isolation**: Strict replay mode MUST enforce zero outbound network leakage;
	cache misses MUST fail fast rather than silently invoking live APIs without developer consent.

### VII. Cross-Language Parity (TypeScript & Python Equality)
AeroGraph is inherently cross-language; TypeScript and Python are equal first-class citizens.

- Any telemetry capability, context propagation helper, or SDK feature added to
	`@aerograph/sdk` MUST have a semantically equivalent counterpart in `python/aerograph-sdk`.
- Trace events emitted by Python agents and Node.js agents MUST share identical schema
	shapes, camelCase serialization, and taxonomy.
- Replay cassettes recorded from a Python agent MUST be replayable by a Node.js agent
	(and vice versa) for equivalent workflow topologies.

## Architecture & Persistence Constraints

- **Modular Boundaries**: The backend, UI, CLI (`aerorepl`), and adapters MUST remain modular.
	Shared types and contracts live exclusively in `@aerograph/contracts`. Cross-module coupling
	outside shared contracts is strictly prohibited.
- **Additive Database Migrations**: The SQLite trace store (`apps/collector/src/sqlite/migrate.ts`)
	MUST use purely additive migrations registered in `schema_migrations`. Table columns and indexes
	may be added, but existing columns MUST NOT be removed or renamed in ways that invalidate
	historical traces.
- **Historical Immutability**: Past traces and recorded cassettes are immutable records. Replay runs
	and forks MUST generate new child traces with explicit lineage (`derivedFrom`), never mutating
	the events or metadata of the parent trace.
- **Process Spawning Safety**: Any background execution of agent scripts by the Orchestrator MUST
	pass command arguments as an explicit array to `child_process.spawn()`, never through a shell
	string interpolator.
- **Virtual Environment Auto-Resolution**: When executing agent processes on Windows or UNIX, the
	runner MUST resolve the active virtual environment (`virtual_env`, `executable_path`) to prevent
	unattended invocation failures.

## Continuous Schema Governance & Drift Prevention

- The TypeScript contracts in `packages/contracts/src/` are the authoritative contract source.
- Exported JSON Schema artifacts in `packages/schema-exporter/artifacts/` MUST reflect the contracts exactly.
- CI and local checks MUST execute `npm run drift:check` to ensure no committed schema has drifted.
- Breaking changes to contracts require a formal RFC, a semantic version bump, and compatibility tests.

## Pre-Push & Release Hygiene Checklist (Mandatory Syncs)

Before pushing any commit or branch to GitHub, developers and agents MUST verify and update the following common files:

| Area | Common Files to Inspect / Update | Verification Command | Rule |
| :--- | :--- | :--- | :--- |
| **1. Contracts & Schema Exporter** | `packages/contracts/src/*`<br>`packages/schema-exporter/artifacts/*` | `npm run schema:export`<br>`npm run drift:check` | If any contract or schema type was modified, re-export JSON schemas and verify zero drift. |
| **2. Public Web Schemas** | `apps/web/public/schemas/*.json` | File diff review | User-facing YAML configurations (`aerograph.project.yaml`, `aerograph.replay.yaml`) schemas must be synchronized for IDE autocomplete. |
| **3. CI Workflows** | `.github/workflows/*.yml` | Workflow review | Ensure new packages, lint checks, or test matrices are covered in `schema-governance.yml`, `parity.yml`, and `python.yml`. |
| **4. SQLite Migrations** | `apps/collector/src/sqlite/migrate.ts` | `npm test -w apps/collector` | Verify new tables/columns have an additive migration step registered in `schema_migrations`. |
| **5. Cross-Language SDKs** | `packages/sdk/*`<br>`python/aerograph-sdk/*` | `npx vitest run tests/integration/cross_lang.test.ts` | Verify SDK updates maintain cross-language parity. |
| **6. Cassette & Secret Scrubbing** | `examples/*/.aerograph/cassettes/*` | `git diff` review | Ensure no real API keys, bearer tokens, or temporary CA keys are committed in repository cassettes. |

## Workflow & Change Control

- **Do Not Invent APIs**: If a requirement is unclear, mark it `NEEDS CLARIFICATION` and request clarification before implementing.
- **Cross-Layer Mindset**: Schema or contract changes MUST be reviewed across backend, UI, CLI, and adapters.
- **Gate Enforcement**: CI MUST run schema tests, drift checks, adapter tests, and replay suites before merge.

## Governance

- This constitution supersedes other development practices in this repository.
- Amendments require:
	- A PR describing the change and rationale.
	- A version bump according to semantic versioning.
	- A migration/compatibility plan when contracts are affected.
	- Explicit confirmation that Core Principles remain satisfied.
- **Semantic Versioning for this Document**:
	- **MAJOR**: Principles removed or redefined in a way that changes governance intent.
	- **MINOR**: New principle, mandatory pre-push checklist, or materially expanded obligations added.
	- **PATCH**: Clarifications, formatting, typo fixes, or non-semantic refinements.
- **Reviews MUST check**:
	- Schema-as-truth compliance.
	- Contract boundary compliance (no bypasses).
	- Ephemeral CA security and sensitive data redaction.
	- Replayability and cassette fidelity.
	- Pre-push hygiene checklist compliance (`drift:check` passing).

**Version**: 1.1.0 | **Ratified**: 2026-05-20 | **Last Amended**: 2026-09-13
