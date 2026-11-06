## Summary of Changes

<!-- Describe what this PR changes, why it is needed, and any context relevant to reviewers. -->

## Type of Change

- [ ] 🐛 Bug fix (non-breaking change fixing an issue)
- [ ] ✨ New feature (non-breaking change adding functionality)
- [ ] 💥 Breaking change (fix or feature that alters existing contract or schema)
- [ ] 📝 Documentation update
- [ ] 🧹 Refactoring or maintenance
- [ ] 🧪 Test suite enhancement

---

## Constitution v1.1.0 Compliance Checklist

> All pull requests must satisfy the [AeroGraph Constitution](.specify/memory/constitution.md) before merging.

- [ ] **I. Schema Source of Truth**:
  - `npm run drift:check` passes locally with zero drift.
  - If `@aerograph/contracts` changed, `npm run schema:export` was run and JSON schemas were committed.
- [ ] **II. Shared Contracts (No Bypasses)**:
  - All UI, CLI, and collector endpoints derive types directly from `@aerograph/contracts`.
- [ ] **III. Replayability & Cassette Fidelity**:
  - Strict replay remains 100% deterministic ($0.00 network cost).
  - Pre-fork steps replay from cassette, and live fork steps are recorded accurately.
- [ ] **IV. Adapter Normalization**:
  - Trace events emitted by adapters adhere to the canonical platform schema.
- [ ] **V. Mandatory Automated Tests**:
  - [ ] Node.js: `npm test` passed across all workspaces.
  - [ ] Node.js Integration: `npm run test:integration` passed.
  - [ ] Python: `pytest` passed across Python SDK and adapters.
- [ ] **VI. Ephemeral Security & Credential Hygiene**:
  - [ ] `npm run security:check` passed locally.
  - [ ] No private keys (`BEGIN PRIVATE KEY`) committed.
  - [ ] Outbound authentication headers in cassettes are redacted (`[REDACTED]`).
  - [ ] No raw live API keys (`sk-...`) in codebase or test fixtures.
- [ ] **VII. Cross-Language Parity**:
  - Telemetry features added to TypeScript have a semantically equivalent Python counterpart.
- [ ] **Persistence & Historical Immutability**:
  - SQLite database changes are strictly additive migrations in `schema_migrations`.
  - Historical traces and existing columns remain valid.

---

## Verification & Screenshots

<!-- Describe how you verified your changes (commands, test output, or UI screenshots for frontend changes). -->
