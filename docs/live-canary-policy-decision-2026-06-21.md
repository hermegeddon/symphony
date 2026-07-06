# Symphony live canary policy decision — 2026-06-21

## Inputs

- Repository checkout: `~/dev/symphony`
- Local `main` at the read-only Linear canary decision time: `911636e docs: refresh Symphony agent guidance`
- Live canary artifact directory:
  - `~/.hermes/artifacts/symphony/live-canary-2026-06-21/HER-1-redacted-receipts-2026-06-21T10-10-41-126Z/`
- Live canary summary:
  - `~/.hermes/artifacts/symphony/live-canary-2026-06-21/HER-1-redacted-receipts-2026-06-21T10-10-41-126Z/LIVE-HER-1-linear-canary-summary.md`
  - SHA-256: `b69620b21fd1b918a24a1636a75a034ab3d101c28601817a4c232aa709750ce3`
- Redacted receipt JSON:
  - `~/.hermes/artifacts/symphony/live-canary-2026-06-21/HER-1-redacted-receipts-2026-06-21T10-10-41-126Z/linear-canary-redacted-receipts.json`
  - SHA-256: `dd726eb6e66928f15b1face3bef8ad2cb191f8de42e248ff808cd3db050e7fc4`
- Artifact manifest:
  - `~/.hermes/artifacts/symphony/live-canary-2026-06-21/HER-1-redacted-receipts-2026-06-21T10-10-41-126Z/artifact-manifest.json`
  - SHA-256: `122ac71d38819c60255dde2e573faa987021b884b5a05018e918887e2fca47ab`

## Live canary result

Outcome: **PASS for bounded read-only Linear validation**.

Observed facts:

- Approved issue: `HER-1`
- Team key: `HER`
- Selected issue title: `Get familiar with Linear`
- Selected issue state: `Todo`
- Selected issue URL: `https://linear.app/hermegeddon/issue/HER-1/get-familiar-with-linear`
- Linear GraphQL POST count: `1`
- GraphQL operation: `SymphonyExactIssue`
- GraphQL variables in receipt: `{ "identifier": "HER-1" }`
- Request auth header in receipt: `[REDACTED]`
- GraphQL response outcome: `ok`, error count `0`
- Linear mutations sent: `false`
- Codex started: `false`
- Workspace hooks run: `false`
- Repository modified by canary: `false`
- Actual injected token was checked inside the secret-exec boundary and was not present in written artifacts.

## Decision

The `HER-1` canary justifies trusting the current **redacted Linear receipt hook** for a bounded exact-issue read.

It does **not** justify broader live Codex/autonomy yet.

Reasons:

1. The canary only exercised Linear read transport and receipt emission.
2. It did not exercise real Codex app-server startup, auth, approval handling, sandbox behavior, or tool-call behavior.
3. It did not exercise workspace population/synchronization beyond the current fake/local lifecycle tests.
4. It did not prove safe behavior for broad Linear selectors, multiple issues, or any Linear mutation.
5. Prior project evidence recorded a full integrated canary as needing a human decision because live Codex/OpenAI auth was blocked; this read-only Linear pass does not remove that Codex boundary.

## Selected next-phase policies

These policies govern the next live-validation phase unless Janusz explicitly changes them. They are operator gates and selected design constraints for future approved run packets; they should not be read as proof that the current code enforces every gate below.

### 1. Workspace population and synchronization

Selected policy: **hook-defined only; no built-in VCS checkout/reset/sync yet**.

- Live runs must use an explicitly approved `workspace.root`.
- Per-issue workspaces remain `<workspace.root>/<workspace_key>` with existing containment checks.
- No built-in `git clone`, `git reset`, dependency bootstrap, or repository synchronization is selected in this phase.
- Any workspace population must be provided by explicit hooks in the approved `WORKFLOW.md` and reviewed before execution.
- Destructive cleanup of non-terminal or successful workspaces remains unauthorized.

Rationale: the Linear read canary did not exercise real repository materialization. Selecting a VCS policy now would invent behavior outside the evidence.

### 2. Approval policy

Selected policy: **manual/fail-closed by default**.

- `approval.mode: auto_approve` remains valid only when explicitly configured for an approved, bounded run.
- If live Codex emits approval requests and the run is not explicitly configured for auto-approval, the run should fail/stop rather than silently approve.
- No external writes, Linear mutations, pushes, deploys, or public actions are authorized by a read-only Linear canary.

Rationale: real Codex approval behavior was not exercised by this canary.

### 3. Sandbox policy

Selected policy: **explicit pass-through only; no silent live defaults**.

- `thread_sandbox` and `turn_sandbox_policy` remain Codex-owned pass-through fields.
- A live Codex canary must name the intended sandbox policy explicitly in its reviewed `WORKFLOW.md` or run packet.
- If sandbox policy is absent for a live Codex run, treat that as a configuration blocker rather than inventing a default.

Rationale: the code currently preserves Codex sandbox values but has not proven a safe live default.

### 4. Operator confirmation behavior

Selected policy: **issue-scoped preflight confirmation before live dispatch**.

Before any live Codex dispatch, the run packet must state:

- exact Linear issue identifier and team;
- workspace root and resolved per-issue workspace path;
- Codex command and sandbox/approval settings;
- whether any hooks will run;
- expected local artifacts/receipts;
- explicit non-actions, especially no push/deploy/Linear mutation unless separately approved.

Rationale: operator confirmation is the boundary between a read-only tracker canary and real autonomous work.

### 5. Linear selector policy

Selected policy: **exact issue identifier preferred; labels only with explicit blast-radius approval**.

- Use `tracker.require_canary: true` plus `tracker.canary_issue_identifier` for live validation whenever possible.
- `tracker.canary_labels` may be used only when the active human gate approves the broader selector and its expected issue set.
- Broad project/state fan-out remains unauthorized.

Rationale: the live canary proved the exact `issue(id: ...)` path, not broad selector behavior.

### 6. Control-plane/status surface

Selected policy: **no HTTP/control-plane listener yet**.

- Continue using in-process snapshots, structured logs, and local artifact receipts.
- If a later phase adds HTTP status/control, start read-only and loopback-only by default.
- Mutating control endpoints require a separate design, tests, and approval gate.

Rationale: the current service slice intentionally avoids an external control plane, and the live canary did not require one.

## Later same-day Codex closeout

A later bounded `HER-1` live Codex app-server issue run passed on 2026-06-21 and is recorded in `docs/her-1-live-codex-run-2026-06-21.md`.

That later run updated the project state but did not broaden this decision's external-action boundaries:

- no Linear mutation;
- no git push;
- no deploy;
- no service restart;
- no broad dispatch;
- no multi-issue autonomy.

## Historical recommended next live step after the read-only Linear canary

Do **not** proceed directly to broad autonomy.

At the time of this read-only Linear decision, the next meaningful live step, if approved, was a **Codex auth/protocol preflight canary** that:

1. uses the already proven exact Linear issue scope (`HER-1` or another explicitly approved issue);
2. starts at most one real Codex app-server process;
3. uses a temp/approved workspace with no destructive hooks;
4. disables or fail-closes approval requests unless explicitly configured;
5. writes local receipts for startup/session/protocol metadata;
6. performs no git push, no deploy, no Linear mutation, and no broad issue dispatch.

That step has since been executed in bounded form and recorded in `docs/her-1-live-codex-run-2026-06-21.md`. The sequencing rule still applies: only after each bounded canary passes should Symphony consider the next explicitly reviewed step toward real autonomous issue runs.
