# Local Codex issue-run receipt harness

`runCodexIssueRun` in `src/codex-issue-run.ts` turns the one-off HER-1 live wrapper pattern into a reusable local API for a single explicit issue run. It wraps `CodexAppServerRunner`, writes a local receipt packet, and keeps live use behind a separate human gate.

`runCodexIssueRunInEphemeralGitWorktree` adds the selected P5 workspace lifecycle policy for callers that need an isolated local git workspace: each run creates a temporary detached git worktree, runs the same issue-run harness inside it, records lifecycle evidence, exports a patch/status artifact, and removes the worktree afterward. It does **not** create a persistent branch; durable local branch/commit creation is handled only by the separate patch-promotion surface described below.

`buildCodexIssueRunOperatorConfirmation` adds the first operator-confirmation product slice: it builds a print-only packet for an already-resolved single-issue workspace and expected receipt directory. It starts no Codex process, writes no receipt files, creates no branch/worktree, and exists so callers can display the exact issue, workspace, Codex policy, expected artifacts, hook flag, and explicit non-actions before any separately approved live dispatch.

`symphony-codex-issue-run-confirm` exposes that same packet as a print-only CLI over explicit local argv flags. It is intentionally not a live issue-run command.

This is an **API-first, fake-tested** product surface. It is not a standing authorization to run live Codex, push code, mutate Linear, deploy, restart services, create PRs, or dispatch multiple issues. The patch-promotion path is local-only and stops at a local branch/commit.

> **Legacy / quarantine posture.** The `symphony-codex-*` CLIs and the underlying `CodexAppServerRunner` surface are retained only as legacy compatibility and operator-recovery paths. A successful direct Codex issue-run proves only that the legacy runner seam can spawn an app-server for the exact approved issue. It does **not** prove that the Kanban-first work engine (`backend.kind: hermes_kanban`) is ready for live dispatch, nor that a Kanban task graph can materialize, no-worker-canary, dry-run, or worker-gateway path is safe. Do not cite Codex issue-run receipts as evidence for Kanban readiness; cite Kanban canary, bridge, or integration receipts instead. A future reviewed removal slice may retire these CLIs when equivalent or better Kanban-first evidence exists for all supported workflows.

## Public API

```ts
import {
  runCodexIssueRun,
  runCodexIssueRunInEphemeralGitWorktree,
  buildCodexIssueRunOperatorConfirmation,
  promoteCodexIssueRunPatch,
  type RunCodexIssueRunInput,
  type RunCodexIssueRunInEphemeralGitWorktreeInput,
  type BuildCodexIssueRunOperatorConfirmationInput,
  type PromoteCodexIssueRunPatchInput,
  type CodexIssueRunOutcome,
  type CodexIssueRunEphemeralGitWorktreeOutcome,
  type CodexIssueRunOperatorConfirmation,
  type CodexPatchPromotionOutcome,
} from '@hermegeddon/symphony-ts';
```

`RunCodexIssueRunInput` requires explicit local inputs:

- `workspacePath` — exact local workspace/cwd for the Codex app-server process; this raw API does not create, sync, branch, or clean up a workspace;
- `receiptDir` — local directory where the receipt packet is written;
- `issue` — a normalized Symphony issue with a non-empty exact `identifier`;
- `workflow` — workflow variables used by the prompt template;
- `promptTemplate` — the rendered issue prompt sent through the runner;
- `runnerConfig` — the same `CodexRunnerConfig` used by `CodexAppServerRunner`;
- `maxAppServerProcesses` — optional spawn-count ceiling, defaulting to `1`.

`RunCodexIssueRunInEphemeralGitWorktreeInput` keeps those issue-run fields but replaces `workspacePath` with lifecycle inputs:

- `sourceRepoPath` — existing local git repository used as the source for `git worktree add`;
- `tempRoot` — optional parent directory for temporary worktrees, defaulting to the OS temp directory;
- `baseRef` — optional ref for the detached worktree, defaulting to `HEAD`;
- `gitCommand` — optional git executable name/path, defaulting to `git`.

Both runner APIs are exported from `src/index.ts` and covered by `tests/codex-issue-run.test.ts`.

`PromoteCodexIssueRunPatchInput` is the local-only patch-promotion surface for a pre-existing `codex-issue-run-worktree.patch` artifact. It requires:

- `sourceRepoPath` — clean local git repository that owns the durable branch namespace;
- `patchPath` — existing exported patch artifact, usually `codex-issue-run-worktree.patch` from the ephemeral wrapper;
- `receiptDir` — local directory where promotion outcome, patch/status export, summary, and manifest are written;
- `tempRoot` — optional parent for the fresh promotion worktree;
- `branchName` — explicit safe local branch name;
- `commitMessage` — explicit local commit message;
- `verificationCommands` — one or more local commands that must pass before the commit is created;
- `baseRef` and `gitCommand` — optional, defaulting to `HEAD` and `git`.

`promoteCodexIssueRunPatch` creates a fresh local branch/worktree, applies the patch with `git apply --3way --index`, runs verification commands, commits only after all verification passes, and writes review artifacts. It never pushes, creates PRs, mutates Linear, deploys, restarts services, or broad-dispatches.

`BuildCodexIssueRunOperatorConfirmationInput` uses the raw issue-run input shape for an already-resolved `workspacePath`, plus `hooksWillRun`. It returns a `CodexIssueRunOperatorConfirmation` with `effect: "print_only"` and `requires_operator_confirmation: true`. The packet includes:

- exact issue identifier, title, and optional team key / URL;
- resolved workspace path and caller-provided lifecycle label;
- redacted/truncated Codex command preview, approval mode, sandbox mode, and protocol schema source;
- whether hooks are expected to run;
- expected receipt artifact names under the supplied receipt directory;
- explicit non-actions: Codex not started, receipt files not written, no Linear mutation, no git push, no deploy, no service restart, no broad dispatch, no persistent branch, and no PR creation.

The print-only builder reuses the same pre-spawn guardrails as the runner: non-empty exact issue identifier, fail-closed approval mode, and disabled Linear GraphQL tool exposure. A packet is therefore not a waiver for unsafe runner configuration.

## Receipt packet

A successful or fail-closed run writes these files under `receiptDir`:

| File | Purpose |
|------|---------|
| `codex-issue-run-redacted-receipts.json` | Redacted local receipt stream, including runner protocol receipts, runtime events, and a terminal `codex_issue_run_result`. |
| `codex-issue-run-receipt-validation.json` | Secret-pattern validation result for the redacted receipt stream. |
| `codex-issue-run-outcome.json` | Machine-readable status, result, validation, safety summary, safety findings, receipt count, artifact paths, and, for the ephemeral wrapper, workspace lifecycle evidence. |
| `codex-issue-run-worktree-lifecycle.json` | Ephemeral-wrapper-only lifecycle evidence: policy, source repo, base ref, temp root, worktree path, detached-head flag, persistent-branch flag, and cleanup result. |
| `codex-issue-run-worktree.patch` | Ephemeral-wrapper-only `git diff --binary` export captured before cleanup so useful fake/local worktree changes survive removal. |
| `codex-issue-run-worktree-status.txt` | Ephemeral-wrapper-only `git status --short` export captured before cleanup, deterministic even when empty. |
| `LIVE-<issue>-codex-issue-run-summary.md` | Human-readable local summary of outcome, exact issue scope, spawn count, validation, lifecycle details when present, and non-authorizations. |
| `artifact-manifest.json` | SHA-256 manifest for finalized packet artifacts, excluding the manifest itself to avoid self-referential hashing. |

`CodexIssueRunOutcome.status` is `pass` only when the runner result passes, receipt validation has no findings, and safety validation has no findings. `CodexIssueRunEphemeralGitWorktreeOutcome.status` additionally requires successful worktree cleanup.

## Ephemeral git worktree lifecycle

The selected P5 lifecycle policy is:

```bash
git worktree add --detach "$WORKTREE_PATH" "$BASE_REF"
# run Codex app-server with cwd exactly equal to $WORKTREE_PATH
git worktree remove --force "$WORKTREE_PATH"
```

The wrapper:

- creates a temporary parent directory under `tempRoot` or the OS temp directory;
- uses `git worktree add --detach`, so `git branch --show-current` is empty inside the run workspace;
- never creates a project-generated persistent branch;
- delegates to `runCodexIssueRun` with `workspacePath` set to the temporary worktree;
- attempts `git worktree remove --force` in both pass and fail-closed runner outcomes;
- records cleanup `attempted`, `ok`, `exit_code`, and redacted error details when cleanup fails;
- captures `git status --short` and `git diff --binary` before cleanup and writes them as `codex-issue-run-worktree-status.txt` and `codex-issue-run-worktree.patch`;
- rewrites/finalizes the outcome, summary, and manifest after lifecycle evidence is written so manifest hashes cover the final artifact set.

The detached worktree wrapper intentionally does not promote its exported patch. Promotion is a separate operator step so review, branch naming, verification commands, and commit metadata stay explicit.

## Local patch promotion lifecycle

The selected local-only promotion policy is:

```bash
git status --porcelain=v1  # must be clean
git worktree add -b "$BRANCH_NAME" "$PROMOTION_WORKTREE" "$BASE_REF"
git -C "$PROMOTION_WORKTREE" apply --3way --index "$PATCH_PATH"
# run approved local verification commands with cwd exactly equal to $PROMOTION_WORKTREE
git -C "$PROMOTION_WORKTREE" commit -m "$COMMIT_MESSAGE"
```

The promotion API/CLI:

- refuses dirty source repositories before creating the promotion worktree;
- rejects unsafe branch names before git side effects;
- creates a fresh local branch/worktree from the approved base ref;
- applies the exported patch with `git apply --index`;
- runs all configured local verification commands before commit;
- creates the local commit only when verification passes;
- leaves the source worktree unchanged;
- writes `codex-patch-promotion-outcome.json`, `codex-patch-promotion.patch`, `codex-patch-promotion-status.txt`, `codex-patch-promotion-summary.md`, and `artifact-manifest.json` under `receiptDir`;
- records explicit non-actions: no git push, no PR creation, no Linear mutation, no deployment, no service restart, and no broad dispatch.

If verification fails after the patch is applied, the outcome is `fail`, `commit_sha` is `null`, review artifacts are still written, and the branch remains at the base commit for operator inspection.

## Guardrails enforced before spawn

The wrappers fail before launching `codex.command` when:

1. `issue.identifier` is empty or whitespace;
2. `runnerConfig.approval.mode` is anything other than fail-closed `fail`;
3. `runnerConfig.tools.linearGraphql.enabled` is true.

Those pre-spawn failures intentionally do not write receipt packets, because no app-server process was launched. In the ephemeral wrapper, those checks also run before creating a temporary git worktree.

## Guardrails validated after spawn

The receipt packet records and validates:

- exact issue identifier;
- app-server spawn count;
- maximum allowed app-server process count;
- effective approval and sandbox modes;
- expected Codex wire policies;
- Linear GraphQL exposure;
- hard-coded non-authorizations for git push, deployment, Linear mutation, and destructive hooks;
- secret-like payload absence after redaction;
- when using the ephemeral wrapper, detached temporary worktree lifecycle and cleanup outcome.

If the app-server schema is missing required IDs, the wrapper returns a fail-closed outcome with the runner error serialized in `codex_issue_run_result.error` and still writes the local packet.

If the app-server spawn count exceeds `maxAppServerProcesses`, the run status is `fail` and `safety_findings` includes `process_limit_exceeded`.

## Redaction and validation

The wrapper reuses the Codex runner receipt minimization strategy and applies recursive redaction to issue-run runtime receipts and errors before artifact writes. Tests cover synthetic payloads containing bearer authorization text, OpenAI-style secret-key strings, Codex session-token-like strings, and Linear token-like strings.

Receipt validation is a last gate, not a substitute for pre-emission sanitization. A future live run that injects real credentials must also verify, inside the secret-exec boundary, that exact injected values are absent from written artifacts.

## Operator confirmation and local CLI boundary

There are three CLI surfaces:

- `symphony-codex-issue-run-confirm` remains print-only for callers that already have a concrete workspace path and receipt directory.
- `symphony-codex-issue-run` is the local single-issue operator CLI. It has three explicit modes:
  - `--print-confirmation` prints the operator packet only;
  - `--check` prints structured local readiness only and does not spawn Codex, create worktrees, or write run receipts;
  - `--yes` executes exactly one local issue run through `runCodexIssueRunInEphemeralGitWorktree` after explicit operator confirmation.
- `symphony-codex-promote-patch` is the local-only patch-promotion CLI. It has two explicit modes:
  - `--check` prints structured readiness only and does not apply the patch, create a branch/worktree, write receipts, or commit;
    - it validates source repo cleanliness, patch readability, receipt/temp writability, branch-name safety, local branch availability, promotion worktree-path availability, and verification-command presence;
  - `--yes` promotes one existing patch into a fresh local branch/worktree and commits only after local verification passes.

Example print-only confirmation for an already-resolved workspace:

```bash
symphony-codex-issue-run-confirm \
  --workspace /absolute/approved/workspace \
  --receipt-dir /absolute/local/receipt-dir \
  --issue TEAM-123 \
  --title "Exact issue title" \
  --team HER \
  --codex-command "node /path/to/fake-app-server.mjs" \
  --schema-source "fake-jsonl-v1 fixture" \
  --approval-mode fail \
  --sandbox-mode workspace_write \
  --hooks-will-run false
```

Example local operator sequence using the ephemeral worktree CLI:

```bash
symphony-codex-issue-run \
  --print-confirmation \
  --source-repo /absolute/source/repo \
  --artifact-root ~/.local/state/symphony-ts/operator-runs \
  --issue TEAM-123 \
  --title "Exact issue title" \
  --codex-command "node /path/to/fake-app-server.mjs" \
  --schema-source "fake-jsonl-v1 fixture" \
  --approval-mode fail \
  --sandbox-mode workspace_write \
  --hooks-will-run false

symphony-codex-issue-run \
  --check \
  --source-repo /absolute/source/repo \
  --artifact-root ~/.local/state/symphony-ts/operator-runs \
  --temp-root /tmp/symphony-worktrees \
  --issue TEAM-123 \
  --title "Exact issue title" \
  --codex-command "node /path/to/fake-app-server.mjs" \
  --schema-source "fake-jsonl-v1 fixture" \
  --approval-mode fail \
  --sandbox-mode workspace_write \
  --hooks-will-run false

symphony-codex-issue-run \
  --yes \
  --source-repo /absolute/source/repo \
  --artifact-root ~/.local/state/symphony-ts/operator-runs \
  --temp-root /tmp/symphony-worktrees \
  --issue TEAM-123 \
  --title "Exact issue title" \
  --codex-command "node /path/to/fake-app-server.mjs" \
  --schema-source "fake-jsonl-v1 fixture" \
  --approval-mode fail \
  --sandbox-mode workspace_write \
  --hooks-will-run false
```

Example local patch promotion after reviewing an exported patch artifact:

```bash
VERIFY_JSON='[{"name":"project checks","command":"npm","args":["run","check"]}]'

symphony-codex-promote-patch \
  --check \
  --source-repo /absolute/source/repo \
  --patch-path /absolute/receipt/codex-issue-run-worktree.patch \
  --receipt-dir /absolute/promotion-receipt \
  --temp-root /tmp/symphony-promotion-worktrees \
  --branch-name symphony/promote-TEAM-123 \
  --commit-message "Promote TEAM-123 Codex patch" \
  --verification-command-json "$VERIFY_JSON"

symphony-codex-promote-patch \
  --yes \
  --source-repo /absolute/source/repo \
  --patch-path /absolute/receipt/codex-issue-run-worktree.patch \
  --receipt-dir /absolute/promotion-receipt \
  --temp-root /tmp/symphony-promotion-worktrees \
  --branch-name symphony/promote-TEAM-123 \
  --commit-message "Promote TEAM-123 Codex patch" \
  --verification-command-json "$VERIFY_JSON"
```

`--verification-command-json` is a JSON array of `{ "name"?: string, "command": string, "args"?: string[] }` objects. Each command runs locally with cwd set to the fresh promotion worktree. Prefer deterministic project-local commands such as `npm run check`; do not place secrets in command strings because command metadata is recorded in receipts.

For real `codex app-server` runs, prefer passing an explicit `--workflow` artifact that sets live-appropriate `codex.read_timeout_ms` and `codex.turn_timeout_ms`. Without a workflow, the operator CLI uses short no-workflow defaults intended for local/fake command paths (`readTimeoutMs: 1000`, `turnTimeoutMs: 1000`). A 2026-06-22 HER-1 local-live canary initialized Codex successfully but failed at `thread/start` under the 1s default; the successful retry used `read_timeout_ms: 30000` and `turn_timeout_ms: 300000`. The workflow prompt should also restate the exact bounded task and non-actions for the canary.

`--receipt-dir` supplies an exact receipt directory and is preferred for deterministic tests. Without `--receipt-dir`, the CLI derives a run directory under `--artifact-root` or the default `~/.local/state/symphony-ts/operator-runs/` using `<timestamp>-<issue>`. Tests can pass `--run-id <safe-id>` to make that directory deterministic, for example `<artifact-root>/20260622T010203Z-TEAM-123`. Run IDs and issue path segments are restricted to safe non-traversing `[A-Za-z0-9._-]`-style names, and artifact-root derived execution refuses to overwrite an existing run directory.

For commands that look like live `codex` or OpenAI invocations, `--check` and `--yes` fail closed by default. The only CLI override is intentionally verbose and digest-bound: first run `--print-confirmation` with the exact same deterministic inputs (`--receipt-dir` or `--artifact-root` plus `--run-id`, exact issue/title/team, sandbox, approval, hook flag, temp root, and command), then copy `operator_confirmation.confirmation_digest` into `--confirmation-digest` and add `--allow-live-codex-openai-command`. The digest is `sha256-json-v1` over the confirmation packet without the digest field, so changing any reviewed input invalidates the acknowledgement. This override path is covered only with fake live-looking app-server fixtures in tests; it is not standing authorization for a real Codex/OpenAI process.

Example fake live-looking override sequence, still local-only:

```bash
symphony-codex-issue-run \
  --print-confirmation \
  --source-repo /absolute/source/repo \
  --artifact-root ~/.local/state/symphony-ts/operator-runs \
  --run-id 20260622T010203Z \
  --temp-root /tmp/symphony-worktrees \
  --issue TEAM-123 \
  --title "Exact issue title" \
  --codex-command "node /path/to/fake-codex-app-server.mjs" \
  --schema-source "fake-jsonl-v1 fixture" \
  --approval-mode fail \
  --sandbox-mode workspace_write \
  --hooks-will-run false

symphony-codex-issue-run \
  --check \
  --allow-live-codex-openai-command \
  --confirmation-digest <digest-from-print-confirmation> \
  --source-repo /absolute/source/repo \
  --artifact-root ~/.local/state/symphony-ts/operator-runs \
  --run-id 20260622T010203Z \
  --temp-root /tmp/symphony-worktrees \
  --issue TEAM-123 \
  --title "Exact issue title" \
  --codex-command "node /path/to/fake-codex-app-server.mjs" \
  --schema-source "fake-jsonl-v1 fixture" \
  --approval-mode fail \
  --sandbox-mode workspace_write \
  --hooks-will-run false
```

A real `codex app-server` command still needs a fresh human gate naming the exact issue, source repository, receipt/artifact path, temp-root, approval mode, sandbox mode, Codex/OpenAI credential boundary, hook behavior, and non-actions. The override does not authorize Linear mutation, git push, PR creation, deployment, service restart, broad dispatch, or multi-issue autonomy.

`--workflow WORKFLOW.md` can supply `codex.command`, Codex read/turn timeouts, and the prompt template. It does not fetch Linear candidates or mutate Linear; exact `--issue` and `--title` are still required.

The local operator CLIs deliberately have no flags for Linear mutation, git push, PR creation, deployment, service restart, broad dispatch, live credential injection, or multi-issue autonomy. Unknown flags fail closed. Patch promotion is limited to a local branch/worktree/commit and records those non-actions in its receipt.

## Local verification

Focused fake-only verification:

```bash
npm test -- tests/codex-issue-run.test.ts
npm test -- tests/cli-codex-issue-run.test.ts
npm test -- tests/codex-patch-promotion.test.ts tests/cli-codex-promote-patch.test.ts
```

Full local verification remains:

```bash
npm run check
npm run build
```

These commands must not require live credentials, network access, or a real Codex/OpenAI process.
