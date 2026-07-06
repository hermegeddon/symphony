---
backend:
  kind: hermes_kanban

kanban:
  hermes_command: hermes
  hermes_home: ./.symphony/hermes-home
  board: symphony-test-local
  board_create: false
  dispatch: dry_run
  dispatch_policy: dispatchable
  default_assignee: default
  artifact_root: ./.symphony/kanban-artifacts/symphony-test-local
  workspace:
    kind: scratch
  safety:
    require_profile_preflight: true
    require_review_gate_for_repo_mutation: true
    require_human_gate_for_external_actions: true

polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 3
---
# Kanban-backed Symphony workflow example

This checked-in example is safe/demo-oriented. It shows how to select the Hermes Kanban backend without supplying Linear or Codex credentials. Create and validate only temp/test boards unless a separate operator gate approves a real board.

Use `docs/hermes-kanban-backend.md` for setup, smoke-test, rollback, and authority-boundary details.
