# HER-1 local-live Codex canary — 2026-06-22

## Status

Outcome: **PASS for one bounded HER-1 local-live Codex app-server issue run** after one safe timeout retry.

This document records the exact local-live operating path validated after `ac188a7 Add local Codex patch promotion path`. It does not authorize PR creation, public publication/release, force-push, destructive cleanup, raw credential disclosure, or public network exposure.

## Exact scope

- Linear issue identifier: `HER-1`
- Team key: `HER`
- Title: `Get familiar with Linear`
- URL: `https://linear.app/hermegeddon/issue/HER-1/get-familiar-with-linear`
- Source repo: `~/dev/symphony`
- Base ref policy: clean local `main` at `ac188a7380f96a2786a591ffe91cc0a3f23b3c6a`
- Codex CLI: `codex-cli 0.141.0`
- Codex command: `codex app-server`
- Approval mode: `fail`
- Sandbox mode: `workspace_write`
- Hook behavior: `false`
- Credential boundary: minimized local environment using the persisted Codex CLI login; no raw `OPENAI_*`, `LINEAR_*`, or `CODEX_*` environment token was injected for the Codex run.

## First attempt: safe fail-closed timeout

Artifact directory:

```text
~/.hermes/artifacts/symphony/live-codex-issue-run-2026-06-22/HER-1-local-live-20260622T123150Z-HER-1
```

The first execution used the CLI without a workflow timeout override. It initialized the app-server successfully but failed waiting for `thread/start`:

```text
status: fail
error.code: response_timeout
error.message: thread/start timed out waiting for response.
receipt validation: ok, findings []
safety findings: []
app-server spawn count: 1
```

Root cause: `symphony-codex-issue-run` defaults to `readTimeoutMs: 1000` when no workflow supplies `codex.read_timeout_ms`. Real Codex `thread/start` can exceed one second.

## Successful retry

Retry scope/workflow artifacts:

```text
~/.hermes/artifacts/symphony/live-codex-issue-run-2026-06-22/HER-1-local-live-timeout30s-20260622T123558Z-scope.md
~/.hermes/artifacts/symphony/live-codex-issue-run-2026-06-22/HER-1-local-live-timeout30s-20260622T123558Z-workflow.md
```

The retry used an out-of-repo workflow artifact with:

```yaml
codex:
  command: codex app-server
  read_timeout_ms: 30000
  turn_timeout_ms: 300000
```

The prompt explicitly instructed the canary not to modify files, push, deploy, mutate Linear, create PRs, install dependencies, start daemons, use broad issue dispatch, or reveal secrets.

Live receipt directory:

```text
~/.hermes/artifacts/symphony/live-codex-issue-run-2026-06-22/HER-1-local-live-timeout30s-20260622T123558Z-HER-1
```

Selected outcome facts:

```text
status: pass
thread_id: 019eef55-9cc3-7be0-98a7-5f92f3b56e71
turn_count: 1
app-server spawn count: 1
receipt count: 145
receipt validation: ok, findings []
safety findings: []
workspace cleanup attempted/ok: true / true
workspace patch size: 0 bytes
workspace status size: 0 bytes
```

Selected artifact hashes:

| Artifact | SHA-256 |
|---|---:|
| `LIVE-HER-1-codex-issue-run-summary.md` | `24932fd0058d725db5a145b04331546b030961a42320ae6b5c3ed745255f7691` |
| `artifact-manifest.json` | `c57c4fab8632e4b751048425a1805886fdbc34ede96b47293756bdb0da50dcb7` |
| `codex-issue-run-outcome.json` | `92c6d085eb5779fb7a16ce8dd7e9dfba5328a953590b9f50b06b3103f5887880` |
| `codex-issue-run-receipt-validation.json` | `1150f123209f96c52a8de1830efaf1a957e177dcb4a804ac18501f991995e896` |
| `codex-issue-run-redacted-receipts.json` | `ac445c33560d826077ecb936a942501005dd4280310e073b8b3ebb4083144ae3` |
| `codex-issue-run-worktree-lifecycle.json` | `f0733d3f4f4e95907098327634b9c13972218a77a703b18decaa4cc0f879c30f` |
| `codex-issue-run-worktree.patch` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `codex-issue-run-worktree-status.txt` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Additional local scan:

```text
SECRET_SCAN_FINDINGS none
```

Because the canary prompt intentionally requested no file modifications, patch promotion was skipped: the exported patch and status artifacts were empty.

## Linear update

Janusz authorized Linear mutation/comment updates for this goal. A single redacted status comment was created on `HER-1`:

```text
https://linear.app/hermegeddon/issue/HER-1/get-familiar-with-linear#comment-77339e51
```

Redacted Linear mutation receipt:

```text
~/.hermes/artifacts/symphony/live-codex-issue-run-2026-06-22/HER-1-local-live-timeout30s-20260622T123558Z-linear-comment-receipt.json
SHA-256: 2effced5daff91ca908f7241b281e0b1c192d40f44eb14e1fccee3cd8e5c2d0b
```

The Linear receipt scan reported:

```text
LINEAR_RECEIPT_SECRET_SCAN none
```

## Push/deploy/restart/control-plane status

Fresh inspection found this checkout has no configured git remote/upstream and no repo-native deploy/service configuration such as `.github/`, Docker/Compose, Vercel/Netlify/Wrangler/Fly config, `Procfile`, `scripts/`, `deploy/`, or systemd files.

Therefore:

- `git push`: **skipped — no remote/upstream configured**;
- deploy: **skipped — no repo-native deployment target configured**;
- service restart: **skipped — no repo-native long-running service target configured**;
- daemon/control-plane/listener: **skipped — no documented target; no listener was invented**;
- broad project/label dispatch and multi-issue autonomy: **not started**; the single canary passed, but no reviewed selector/concurrency/stop-condition packet exists yet.

## What this proves

This canary proves that the then-current local implementation could run one exact local-live Codex app-server issue through the productized CLI using:

1. digest-bound operator confirmation;
2. no-spawn readiness check;
3. temporary detached git worktree lifecycle;
4. Codex CLI `0.141.0` app-server protocol path;
5. one successful turn with no workspace modifications;
6. receipt validation and secret-pattern scan;
7. redacted Linear comment mutation after the canary.

## What this does not prove

This canary does **not** prove:

- useful patch generation from a real issue;
- patch promotion of non-empty live Codex output;
- safe broad Linear selectors;
- safe multi-issue autonomy;
- Linear status transitions beyond one comment mutation;
- deploy or restart behavior;
- PR creation or public release/publication.

## Next recommended step

For the next live run that is expected to produce a patch, use the documented workflow-backed operator path with explicit live timeouts and a narrowly scoped issue prompt. Require the same confirmation/check/receipt validation gates, then promote only a reviewed non-empty patch through `symphony-codex-promote-patch`.
