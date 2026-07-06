# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses pre-1.0 semantic versioning.

## [Unreleased]

### Added

- GraphSync read-only diff artifact CLI (`symphony-graph-sync-diff`) consuming explicit local snapshots and emitting receipt-only severity/human-action metadata.
- GraphSync read-only mapped live snapshot capture (`symphony-graph-sync-snapshot`) with durable state-path persistence and checkpoint advancement.
- GraphSync status/watchdog CLI (`symphony-graph-sync-status`) classifying `PASS`/`REVIEW`/`BLOCK` from recurring `last-run.json`.
- Gated live Kanban blocking-edge apply CLI (`symphony-graph-sync-materialize-kanban`) for exact-scope missing `blocks` links from prior read-only receipts.
- Gated live Linear blocking-relation apply CLI (`symphony-graph-sync-materialize-linear`) for exact-scope missing Linear `blocks` relations from Kanban-authoritative receipts.
- Recurring lifecycle + GraphSync tick contract and fake/local-readonly CLI (`symphony-linear-kanban-graph-sync-tick`) with lifecycle-before-GraphSync ordering and `dispatch_reliance_decision` receipts.
- Recurring GraphSync lock/state/freshness substrate with atomic O_EXCL acquisition and stale-lock loser fail-closed behavior.
- Fake/local GraphSync checkpoint state-path persistence for snapshot/checkpoint flow.
- Top-level `graph_sync` workflow config schema (inert by default, fail-closed for apply/live modes).
- Operator-private exact-scope H1 dependent-worker canary evidence: Linear `blocks` relation → GraphSync Kanban edge → provider-registered parent-before-child dispatch → exactly-once Linear completion sync.
- Operator-private exact-scope GraphSync dependency canary evidence: propose-only read-only diff → exact Kanban-edge apply → post-apply PASS → dependency-aware dispatch gate proof.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`, and `.github/workflows/check.yml` CI workflow.
- README "Support and maturity" section stating experimental, best-effort maintenance posture.

### Changed

- Selected Hermes Kanban as the canonical Symphony work engine while keeping the direct in-process Linear/Codex path as legacy compatibility.
- Updated the checked-in sample workflow and operator docs toward Kanban-first facade/readback workflows.
- Private operational artifacts under `.hermes/plans/` and `artifacts/` are no longer tracked in git (untracked and `.gitignore`d).

### Security

- Private operational docs (exact Linear identifiers, local filesystem paths, rollout plans) removed from the tracked tree to prevent disclosure on public visibility.

## [0.1.0] - 2026-06-23

### Added

- Local-first TypeScript implementation of the OpenAI Symphony service specification.
- Workflow loader, Linear tracker adapter, workspace manager, Codex app-server runner abstraction, orchestrator scheduler, service CLI, and fake/demo verification fixtures.
- Durable issue-run ledger, Linear lifecycle notifier, optional loopback control plane, service readiness gates, package CLI bins, and package/bin install smoke coverage.
- Gated live-autonomy policy docs for bounded private live-service pilots with durable ledger evidence before persistent service rollout.

### Changed

- Package metadata is prepared for the owned npm scope `@hermegeddon/symphony-ts` under Apache-2.0, matching the upstream `openai/symphony` repository license posture.

### Security

- Live Linear/Codex paths remain fail-closed behind explicit private workflow artifacts, digest-bound confirmation, bounded selectors/concurrency, redacted receipts, and rollback evidence.
