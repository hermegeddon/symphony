# Kanban Phase 7 follow-up

Phase 7 from `a private operator implementation plan (not shipped)` asked whether the legacy in-process Linear/Codex scheduler should be migrated, deprecated, or kept as a compatibility backend after the first Kanban milestone.

## Current decision

Resolved: Kanban-first compatibility.

Hermes Kanban is the canonical Symphony work engine. New workflows, canaries, and live evidence should prefer `backend.kind: hermes_kanban`. The legacy `backend.kind: in_process_linear_codex` path and direct `symphony-codex-*` CLIs remain available as compatibility/recovery surfaces until a separate reviewed removal slice retires them.

See `docs/kanban-first-migration.md` for the durable policy packet.

## Why not delete the legacy backend immediately

- Existing Linear/Codex tests and docs still protect historical local/fake and gated-live behavior.
- Deleting the legacy orchestrator in the same slice as the policy flip would mix backend direction with compatibility cleanup.
- Real-board Kanban worker/gateway dispatch evidence remains gated.
- The Kanban-first service path intentionally uses Symphony as a facade and refuses to run a second dispatcher; gateway dispatch remains a Hermes Kanban/operator concern.

## Evidence now in place

- `src/linear-kanban-canary.ts` and `tests/linear-kanban-canary.test.ts` cover blocked/unassigned no-worker materialization and dry-run no-spawn/default-assignment safeguards.
- `src/service.ts` and `tests/service.test.ts` cover Kanban service startup without requiring legacy Linear tracker or Codex runner config.
- `docs/hermes-kanban-backend.md`, `README.md`, `AGENTS.md`, and `src/index.ts` record Kanban-first policy.

## Exact gate needed before removal

Before removing the legacy backend or `symphony-codex-*` bins, create a reviewed removal packet that names:

1. validated Kanban replacement evidence for every removed public workflow/CLI use case;
2. compatibility expectations for existing package consumers;
3. migration notes for any external operator scripts;
4. evidence from `npm run check`, `npm run build`, Kanban focused tests, temp-home integration smoke, and any approved real-board canary;
5. explicit non-actions: no push, PR, publish, deploy, service restart, real-board mutation, or worker dispatch outside the reviewed packet.

Until then, keep legacy code working but do not use direct Codex issue-runs as evidence for Kanban readiness.
