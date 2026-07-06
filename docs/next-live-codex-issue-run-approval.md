# Next live Codex issue-run approval packet template

This document is a **local review artifact only**. It prepares the next exact-issue live canary shape after the fake-tested CLI live-command gate. It does **not** approve or execute a real Codex/OpenAI run.

No live canary should run from this template until Janusz gives fresh exact-scope approval for every value marked `APPROVE_*` below.

## Required human approval values

Before any real `codex app-server` execution, the approving message must name these exact values:

| Field | Required approved value |
|---|---|
| Linear issue identifier | `APPROVE_ISSUE_IDENTIFIER` |
| Linear team key | `APPROVE_TEAM_KEY` |
| Linear title | `APPROVE_ISSUE_TITLE` |
| Linear URL | `APPROVE_ISSUE_URL` |
| Source repo | `APPROVE_SOURCE_REPO_ABSOLUTE_PATH` |
| Base ref policy | `APPROVE_BASE_REF_POLICY` (for example: current clean `HEAD`, specific commit, or reviewed branch) |
| Temporary worktree root | `APPROVE_TEMP_ROOT_ABSOLUTE_PATH` |
| Artifact root or exact receipt dir | `APPROVE_ARTIFACT_ROOT_ABSOLUTE_PATH` plus `APPROVE_RUN_ID`, or `APPROVE_RECEIPT_DIR_ABSOLUTE_PATH` |
| Codex command | `codex app-server` or another exact approved command string |
| Protocol/schema source | `APPROVE_SCHEMA_SOURCE` |
| Sandbox policy | `APPROVE_SANDBOX_MODE` |
| Approval policy | `fail` unless a separate reviewed approval design explicitly changes it |
| Live workflow artifact | `APPROVE_WORKFLOW_ARTIFACT_ABSOLUTE_PATH` with explicit `codex.read_timeout_ms` / `codex.turn_timeout_ms` and the exact bounded prompt |
| Credential injection boundary | `APPROVE_SECRET_EXEC_BOUNDARY` (for example: the exact local secret wrapper/reference and env names to inject) |
| Hook behavior | `APPROVE_HOOKS_WILL_RUN` (`false` unless exact hooks are reviewed) |

The approval must also restate the explicit non-actions:

- no Linear mutation;
- no git push;
- no PR creation;
- no deployment;
- no service restart;
- no broad Linear/project/label dispatch;
- no multi-issue autonomy;
- no persistent branch;
- no public package publication;
- no HTTP/control-plane listener.

## Local command sequence to review, not run yet

Build first so the operator CLI under `dist/` matches the reviewed source:

```bash
npm run check
npm run build
```

Prepare local variables from the exact approved values. The example uses `--artifact-root` plus deterministic `--run-id`; an exact `--receipt-dir` may be used instead if approved.

```bash
ISSUE_IDENTIFIER='APPROVE_ISSUE_IDENTIFIER'
ISSUE_TITLE='APPROVE_ISSUE_TITLE'
TEAM_KEY='APPROVE_TEAM_KEY'
ISSUE_URL='APPROVE_ISSUE_URL'
SOURCE_REPO='APPROVE_SOURCE_REPO_ABSOLUTE_PATH'
TEMP_ROOT='APPROVE_TEMP_ROOT_ABSOLUTE_PATH'
ARTIFACT_ROOT='APPROVE_ARTIFACT_ROOT_ABSOLUTE_PATH'
RUN_ID='APPROVE_RUN_ID'
SCHEMA_SOURCE='APPROVE_SCHEMA_SOURCE'
SANDBOX_MODE='APPROVE_SANDBOX_MODE'
CODEX_COMMAND='codex app-server'
WORKFLOW='APPROVE_WORKFLOW_ARTIFACT_ABSOLUTE_PATH'
```

For live Codex runs, the workflow artifact must set live-appropriate timeouts. A 2026-06-22 HER-1 local-live canary showed that the CLI's no-workflow default `readTimeoutMs: 1000` can time out during real `thread/start`; the successful retry used:

```yaml
codex:
  command: codex app-server
  read_timeout_ms: 30000
  turn_timeout_ms: 300000
```

The workflow prompt should also restate the exact bounded task and non-actions for the canary.

Print and review the operator confirmation packet. This mode does not spawn Codex and does not write run receipts.

```bash
node dist/src/cli/codex-issue-run.js \
  --print-confirmation \
  --source-repo "$SOURCE_REPO" \
  --artifact-root "$ARTIFACT_ROOT" \
  --run-id "$RUN_ID" \
  --temp-root "$TEMP_ROOT" \
  --issue "$ISSUE_IDENTIFIER" \
  --title "$ISSUE_TITLE" \
  --team "$TEAM_KEY" \
  --issue-url "$ISSUE_URL" \
  --codex-command "$CODEX_COMMAND" \
  --schema-source "$SCHEMA_SOURCE" \
  --approval-mode fail \
  --sandbox-mode "$SANDBOX_MODE" \
  --hooks-will-run false \
  --workflow "$WORKFLOW" \
  > live-codex-issue-run-confirmation.json
```

The operator must inspect `live-codex-issue-run-confirmation.json` before continuing. It must show:

- the exact approved issue, title, team, and URL;
- the exact approved source repo;
- the exact approved temp root;
- deterministic receipt placement (`--receipt-dir`, or `--artifact-root` plus `--run-id`);
- `codex.command_preview` matching the approved live command;
- `codex.approval_mode: "fail"`;
- the exact approved sandbox mode;
- `hooks.will_run` matching approval;
- all explicit non-actions remaining false;
- `operator_confirmation.live_command_detected: true`;
- `operator_confirmation.confirmation_digest` present.

Extract the digest only after review:

```bash
CONFIRMATION_DIGEST="$(node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("live-codex-issue-run-confirmation.json", "utf8")); process.stdout.write(p.operator_confirmation.confirmation_digest);')"
```

Run the readiness check with the digest-bound live-command override. This mode still does not spawn Codex, create worktrees, or write run receipts.

```bash
node dist/src/cli/codex-issue-run.js \
  --check \
  --allow-live-codex-openai-command \
  --confirmation-digest "$CONFIRMATION_DIGEST" \
  --source-repo "$SOURCE_REPO" \
  --artifact-root "$ARTIFACT_ROOT" \
  --run-id "$RUN_ID" \
  --temp-root "$TEMP_ROOT" \
  --issue "$ISSUE_IDENTIFIER" \
  --title "$ISSUE_TITLE" \
  --team "$TEAM_KEY" \
  --issue-url "$ISSUE_URL" \
  --codex-command "$CODEX_COMMAND" \
  --schema-source "$SCHEMA_SOURCE" \
  --approval-mode fail \
  --sandbox-mode "$SANDBOX_MODE" \
  --hooks-will-run false \
  --workflow "$WORKFLOW"
```

Only after a second explicit approval for execution should the operator run the corresponding `--yes` command inside the approved credential injection boundary:

```bash
# Pseudocode: use the exact approved local secret-exec wrapper/reference.
APPROVE_SECRET_EXEC_BOUNDARY -- \
node dist/src/cli/codex-issue-run.js \
  --yes \
  --allow-live-codex-openai-command \
  --confirmation-digest "$CONFIRMATION_DIGEST" \
  --source-repo "$SOURCE_REPO" \
  --artifact-root "$ARTIFACT_ROOT" \
  --run-id "$RUN_ID" \
  --temp-root "$TEMP_ROOT" \
  --issue "$ISSUE_IDENTIFIER" \
  --title "$ISSUE_TITLE" \
  --team "$TEAM_KEY" \
  --issue-url "$ISSUE_URL" \
  --codex-command "$CODEX_COMMAND" \
  --schema-source "$SCHEMA_SOURCE" \
  --approval-mode fail \
  --sandbox-mode "$SANDBOX_MODE" \
  --hooks-will-run false \
  --workflow "$WORKFLOW"
```

## Required receipt and secret checks after any approved live run

After an approved live canary, preserve the artifact directory and run local verification before using any generated patch:

```bash
RECEIPT_DIR="$ARTIFACT_ROOT/$RUN_ID-$ISSUE_IDENTIFIER"
sha256sum "$RECEIPT_DIR"/*
```

Required receipt checks:

1. `codex-issue-run-receipt-validation.json` reports no secret-like findings.
2. `codex-issue-run-outcome.json` records exactly one issue identifier and one app-server process.
3. `codex-issue-run-redacted-receipts.json` contains no raw Authorization headers, OpenAI tokens, Linear tokens, or injected secret values.
4. `LIVE-*-codex-issue-run-summary.md` restates the explicit non-actions.
5. `codex-issue-run-worktree.patch` and `codex-issue-run-worktree-status.txt` are reviewable and contain no secrets.

The exact injected secret non-leak check must run **inside the approved secret boundary** so the scanner can compare artifacts against the real injected values without printing them. The check should fail closed if any exact injected value appears in any artifact.

## Patch-promotion path: implemented local-only operator step

Promoting an ephemeral patch into a durable local branch/commit is now implemented as a separate local-only policy surface: `promoteCodexIssueRunPatch` and `symphony-codex-promote-patch`. This is not part of the live Codex run itself and is not authorization for external side effects.

Minimum local-only promotion design now enforced:

1. `--check` performs no side effects: it does not apply the patch, create a branch/worktree, write receipts, or commit;
2. source repo must be clean or the promotion fails closed before creating the promotion worktree;
3. branch name, branch availability, and promotion worktree-path availability must pass the local safety policy before git side effects;
4. `--yes` creates a fresh local branch/worktree from the approved base ref;
5. `--yes` applies `codex-issue-run-worktree.patch` with `git apply --3way --index`;
6. approved local verification commands run with cwd set to the fresh promotion worktree;
7. a local commit is created only after all verification commands pass;
8. promotion receipts include outcome, review patch, status, summary, manifest hashes, and explicit non-actions;
9. git push, PR creation, Linear mutation, deployment, service restart, broad dispatch, publication, and live credential use remain separately gated and unauthorized.

Example shape after a future approved live canary has produced a reviewed patch artifact:

```bash
VERIFY_JSON='[{"name":"project checks","command":"npm","args":["run","check"]}]'

symphony-codex-promote-patch \
  --check \
  --source-repo "$SOURCE_REPO" \
  --patch-path "$RECEIPT_DIR/codex-issue-run-worktree.patch" \
  --receipt-dir "$ARTIFACT_ROOT/$RUN_ID-$ISSUE_IDENTIFIER-promotion" \
  --temp-root "$TEMP_ROOT" \
  --branch-name "symphony/promote-$ISSUE_IDENTIFIER" \
  --commit-message "Promote $ISSUE_IDENTIFIER Codex patch" \
  --verification-command-json "$VERIFY_JSON"

symphony-codex-promote-patch \
  --yes \
  --source-repo "$SOURCE_REPO" \
  --patch-path "$RECEIPT_DIR/codex-issue-run-worktree.patch" \
  --receipt-dir "$ARTIFACT_ROOT/$RUN_ID-$ISSUE_IDENTIFIER-promotion" \
  --temp-root "$TEMP_ROOT" \
  --branch-name "symphony/promote-$ISSUE_IDENTIFIER" \
  --commit-message "Promote $ISSUE_IDENTIFIER Codex patch" \
  --verification-command-json "$VERIFY_JSON"
```

A later operator may inspect the local branch/commit and receipts. Pushing, opening a PR, mutating Linear, deploying, restarting services, publishing, or broad-dispatching still requires separate explicit approval.
