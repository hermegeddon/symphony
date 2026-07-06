# HER-1 live Codex issue run — 2026-06-21

## Status

Outcome: **PASS for one bounded HER-1 live Codex app-server issue run**.

This document records what the run proved, what it did not prove, and the local merge-readiness evidence for the resulting code changes.

## Scope and non-actions

The approved live scope was intentionally narrow:

- exact issue identifier: `HER-1`;
- at most one real Codex app-server process;
- no Linear mutation;
- no git push;
- no deploy;
- no service restart;
- no dependency install;
- no broad selector;
- no multi-issue autonomy;
- no destructive hooks.

These non-actions remain policy boundaries. Passing this run does **not** authorize broad autonomous dispatch.

## Live run evidence

Live artifact directory:

```text
~/.hermes/artifacts/symphony/live-codex-issue-run-2026-06-21/HER-1-fixed-turn-sandbox-20260621T123120Z
```

Selected artifacts:

| Artifact | SHA-256 |
|---|---:|
| `LIVE-HER-1-codex-issue-run-summary.md` | `8ffaa0c4726a38d00d1af459e92cb6874526194e00f87d48d12bc5eba15c93aa` |
| `artifact-manifest.json` | `cca53ce56f57b9643090ff7cd14e55c9ea0a91c40ce66a2c901a960a83eb7f2e` |
| `codex-issue-run-outcome.json` | `f35e908e8b60d1cc8aa9e24c2df4b96f04ae542ea81a9e2f4d3e5cebfe298414` |
| `codex-issue-run-receipt-validation.json` | `1150f123209f96c52a8de1830efaf1a957e177dcb4a804ac18501f991995e896` |
| `codex-issue-run-redacted-receipts.json` | `489c380f9f6c196d3c428b9b52592d2b452513e4327dad35240970bd0308ed9d` |
| `wrapper-stdout.json` | `4910d22ec8525bfbdcb032e3d95c11aa3871b5ff9f676ef42c40d97bef27a915` |

Key facts from the outcome receipt:

- status: `pass`;
- started: `2026-06-21T12:31:35.141Z`;
- ended: `2026-06-21T12:32:16.685Z`;
- base commit: `4676555e81a17724db88943809c6b4c03b964db8`;
- Codex schema source: `codex-cli 0.141.0 app-server --stdio live HER-1 issue run, 2026-06-21`;
- app-server spawn count: `1`;
- receipt count: `435`;
- receipt validation: `ok: true`, findings `[]`;
- raw `OPENAI_API_KEY` present in wrapper environment: `false`;
- raw `OPENAI_API_KEY` found in receipts: `false`;
- protocol methods included `initialize`, `thread/start`, and `turn/start`;
- Linear GraphQL enabled: `false`;
- git push/deploy/Linear mutation authorized: `false` / `false` / `false`.

## Codex 0.141 protocol correction

The live run exposed a protocol-shape mismatch in the runner's sandbox mapping for Codex CLI `0.141.0`.

The corrected wire shape is:

- `thread/start` uses the CLI-style string sandbox field:

  ```json
  {
    "approvalPolicy": "never",
    "sandbox": "workspace-write"
  }
  ```

- `turn/start` uses object-shaped `sandboxPolicy`:

  ```json
  {
    "approvalPolicy": "never",
    "sandboxPolicy": {
      "type": "workspaceWrite",
      "networkAccess": false,
      "writableRoots": ["/absolute/approved/workspace"]
    }
  }
  ```

The runner now maps Symphony's `workspace_write` mode to `workspace-write` for `thread/start`, while `turn/start` receives the object-shaped policy with `writableRoots` scoped to the approved workspace path.

## Shutdown-drain correction

Post-run integration validation found an order-sensitive shutdown race in the fake app-server test harness:

1. the app-server could emit `tool/call` immediately before `turn/completed`;
2. the runner sent a `tool/result` asynchronously;
3. normal shutdown immediately sent `SIGTERM`;
4. the fake app-server could exit before reading/logging the pending `tool/result`.

The runner now closes stdin on normal app-server completion so pending input can drain. Abort/error paths still terminate the process tree immediately.

Regression coverage:

```bash
npm test -- tests/codex-runner.test.ts -t "drains pending tool results before normal shutdown"
```

## Local integration evidence

Local integration artifact directory:

```text
~/.hermes/artifacts/symphony/her-1-local-integration-20260621T130550Z
```

Local closeout commits on `main`:

- `d098ffaca0217f4565eb34c15858b7c765476902` — `Fix Codex app-server sandbox policy mapping`;
- `e37ffcfc35b23070133c1042f1fcc9af0bcd152d` — `Fix Codex app-server graceful shutdown drain`.

The second commit was made after fresh P0 validation. The asynchronous reviewer `deleg_de6973eb` had not returned a verdict in-chat; Janusz's instruction to continue the plan was recorded as a waiver of waiting for that reviewer only. This waiver did not authorize external actions.

Canonical `main` was then fast-forwarded locally to:

```text
e37ffcfc35b23070133c1042f1fcc9af0bcd152d
```

Selected local evidence:

| Artifact | SHA-256 |
|---|---:|
| `p0-postcommit-receipt.log` | `bfafe7e1838cdea9ebc5474ea65e4eafd34729079c0959f9677c10f559d1ac0e` |
| `p1-post-ff-validation-summary.log` | `00c673ed01d5ba5a5a32c91b0cde39ad45370407c145a5703c9776d68dc48d43` |
| `p1-canonical-npm-check.log` | `57745fc4092aa8aa8a611f6a974c2e6de29eb7d43148fcbae53cafed2fbebfc3` |
| `p1-canonical-npm-build.log` | `7f54ad0c6e4faf8164e717a8785bd520aca4b6f6bc2158e72fabd8fd1b20afbc` |
| `p1-canonical-range-secret-scan.log` | `1b100759048fc02d98b5f50482955dcaf3d61911954f7b2ee13c319e2fb37a74` |

P1 canonical validation summary:

```text
range_diff_check_exit=0
check_exit=0
build_exit=0
secret_scan_exit=0
```

## What this proves

This closeout proves that the current local `main` can:

1. run the local fake-only Codex tests and full local verification after the HER-1 live-run fixes;
2. emit Codex app-server receipts that validate cleanly for the bounded HER-1 live run;
3. send Codex CLI `0.141.0` sandbox policy fields in the observed live-compatible shape;
4. keep normal app-server shutdown from dropping pending `tool/result` input in the regression fixture;
5. preserve the no-push/no-Linear-mutation/no-deploy boundary during the live canary and local merge-readiness closeout.

It does **not** prove or authorize Kanban readiness. The bounded HER-1 Codex run is legacy runner evidence, not Kanban work-engine evidence. Do not cite this document as proof that the Kanban-first path (`backend.kind: hermes_kanban`) is ready for no-worker canary or live worker/gateway dispatch; cite Kanban canary, bridge, or integration receipts instead. A future reviewed removal slice may retire the direct `CodexAppServerRunner` path when equivalent or better Kanban-first evidence exists.

## What this does not prove

This closeout does **not** prove or authorize:

- broad autonomous dispatch;
- multi-issue scheduling with real Codex;
- Linear mutation;
- broad Linear selectors;
- new live Codex runs;
- workspace population/synchronization policy;
- deployment or long-lived service operation;
- push/remote publication;
- public package publication.

Those remain separate approval and design gates.

## Recommended next local product step

The next local product step is to productize the live-run wrapper pattern into a first-class, tested command/API before adding new live risk.

The productized path should require exact issue scope, exact workspace scope, explicit approval/sandbox policy, explicit tool policy, redacted receipts, post-run process cleanup checks, and validation that no raw secrets are written to artifacts.
