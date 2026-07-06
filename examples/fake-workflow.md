---
tracker:
  kind: linear
  api_key: FAKE_API_KEY
  project_slug: FAKE
  # For an approved live canary, set require_canary: true and one of:
  #   canary_issue_identifier: TEAM-123
  #   canary_labels:
  #     - symphony-canary-20260619
workspace:
  root: /tmp/symphony-demo
  # hooks are intentionally left empty in the checked-in sample; add them explicitly in your own WORKFLOW.md.
codex:
  command: echo "Codex would run here"
polling:
  interval_ms: 60000
agent:
  max_concurrent_agents: 1
  max_turns: 3
---
# Demo workflow

Render an issue with identifier {{ issue.identifier }} and title {{ issue.title }}.
