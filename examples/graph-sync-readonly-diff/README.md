# GraphSync read-only diff snapshot examples

These files are public-safe, fake/local examples for `symphony-graph-sync-diff`. They are explicit JSON snapshots matching `BuildGraphSyncReadOnlyDiffReceiptInput`; the CLI consumes them from disk and writes a local receipt artifact.

```bash
npm run build
node dist/src/cli/graph-sync-readonly-diff.js \
  --mode read_only_diff \
  --input examples/graph-sync-readonly-diff/missing-kanban-edge.snapshot.json \
  --output /tmp/symphony-graph-sync-receipt.json \
  --summary-output /tmp/symphony-graph-sync-summary.md \
  --status-output /tmp/symphony-graph-sync-status.json
```

The examples do not query Linear, read or mutate Hermes Kanban, restart services/timers, or expose an MCP/apply surface. The generated receipts keep `suppressed_writes: true` and list the exact non-actions. Suppressed proposals and endpoint policies include receipt-only `severity` and `human_action_recommendation` metadata for operator triage; those fields do not authorize writes. Optional `summary.md` and `status.json` outputs are declared local operator artifacts only; `status.json` reports `PASS`, `REVIEW`, or `BLOCK` triage status without enabling apply behavior.

## Files

| File | Purpose | Expected receipt shape |
|---|---|---|
| `matched-edge.snapshot.json` | A Linear `blocks` relation and a matching Kanban blocking edge are both present. | `matched_edges: 1`, no proposed operations. |
| `missing-kanban-edge.snapshot.json` | Linear has a `blocks` relation, but the corresponding Kanban blocking edge is absent. | One suppressed `create_kanban_edge` proposal with `severity: warning` and `human_action_recommendation: review`. |
| `unmapped-kanban-endpoint.snapshot.json` | Kanban has a blocking edge whose parent task has no Linear mapping. | One endpoint policy record with `severity: warning` and `human_action_recommendation: inspect_endpoint_policy`; no apply proposal because the endpoint is unmapped. |

Focused verification:

```bash
npm test -- tests/cli-graph-sync-readonly-diff.test.ts
```
