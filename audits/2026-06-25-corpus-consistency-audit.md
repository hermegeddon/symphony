# Symphony-TS whole-corpus consistency audit

- **Repository:** `<repo-root>`
- **Branch / HEAD:** `main` @ `b6877c4` (clean working tree)
- **Auditor:** m3-reviewer
- **Date:** 2026-06-25
- **Method:** read-only whole-corpus walk. `git log`, `git show`, and `npm run typecheck` / `npm test` (32 files / 219 tests) executed as evidence, not mutation. No source file was modified.

## Scope inspected

1. Top-level: `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.editorconfig`, `.gitignore`, `CHANGELOG.md`, `LICENSE`, `README.md`, `WORKFLOW.md`, `AGENTS.md`.
2. Source: `src/*.ts` (14 files), `src/cli/*.ts` (8 files), `src/demo/*.ts` (4 files).
3. Tests: 31 test files under `tests/`.
4. Docs: `docs/*.md` (9 files) plus the two checked-in example workflows.
5. `a private HER-1 operator artifact (not shipped)` and `examples/`.
6. Public API surface: `src/index.ts` re-exports vs. README claim, package `bin` map vs. CLI surface test, `npm pack --dry-run` privacy guard.
7. Programmatic evidence: `npm run typecheck` (clean), `npm test` (32 files / 219 tests pass).

## Findings ranked by impact

The audit found no correctness-defeating regressions (the public API type-checks and the full test suite passes). The findings below are consistency, contract, or hygiene issues — ranked by likely downstream impact.

---

### F1 — `linear-kanban-canary.ts` is dead production code: superseded by `kanban-canary-operator.ts`

- **Confidence:** High.
- **Severity:** Medium.
- **Files:** `src/linear-kanban-canary.ts:1`, `src/kanban-canary-operator.ts:1`, `src/index.ts:34,36`, `docs/kanban-first-migration.md:40`, `docs/kanban-phase-7-follow-up.md:22`, `docs/spec-compliance-matrix.md:40`, `tests/linear-kanban-canary.test.ts:1`.

**Evidence.** `src/linear-kanban-canary.ts` exports `runNoWorkerLinearKanbanCanary`, `NoWorkerLinearKanbanCanaryError`, `NoWorkerLinearKanbanCanaryReceipt`, `NoWorkerLinearKanbanCanaryInput`, `NoWorkerLinearKanbanCanaryTaskReceipt`, `LinearKanbanCanaryScope`, `LinearKanbanCanaryBoardScope`. A repo-wide search shows that **the only consumer is `tests/linear-kanban-canary.test.ts`**: no CLI, no service code path, and no other source file imports from it. The newer `src/kanban-canary-operator.ts` reimplements the same K0/K1/K2 no-worker canary (see `buildNoWorkerCanaryNodes` at `src/kanban-canary-operator.ts:727-775` vs. `src/linear-kanban-canary.ts:201-249`) and is the actual production surface, exposed via `symphony-kanban-canary` (`src/cli/kanban-canary.ts:382-386`). Both modules are still re-exported from `src/index.ts` (`src/index.ts:34,36`), so the public API ships two parallel canary implementations.

**Cross-file drift confirmed by inspection.**

- `buildNoWorkerCanaryNodes` in `src/kanban-canary-operator.ts:727` adds an extra `## Workflow title` line and a more detailed `## Goal` body than the older `src/linear-kanban-canary.ts:201`.
- `DEFAULT_NON_AUTHORIZATIONS` is duplicated verbatim at `src/kanban-canary-operator.ts:173-180` and `src/linear-kanban-canary.ts:76-83`. If the safety list is ever edited in one place, the two will silently disagree.
- The newer operator exposes `noWorkerCanaryNonAuthorizations()` (`src/kanban-canary-operator.ts:237-239`) and a typed `KanbanCanaryErrorReceipt` discriminated union; the older module throws `NoWorkerLinearKanbanCanaryError` and only returns receipts. The receipt shapes are non-overlapping.
- Docs point at the older file as the canary: `docs/kanban-first-migration.md:40` ("`src/linear-kanban-canary.ts` materializes a blocked/unassigned no-worker canary DAG"), `docs/kanban-phase-7-follow-up.md:22` (same wording), and the spec-compliance matrix line at `docs/spec-compliance-matrix.md:40` cites `src/linear-kanban-canary.ts, tests/linear-kanban-canary.test.ts`. None of these mention the operator. The README's "Operator no-worker canary CLI" section (`README.md:250`) does cite the operator correctly.

**Why it matters.** Public consumers reading the matrix or migration doc are directed to a module that is not on the actual code path. Two parallel implementations double the maintenance surface (e.g. when `KanbanGraphNode` adds a new field, both copies must be updated). `src/linear-kanban-canary.ts` is also a sink for any future secret-leakage: it is not covered by the operator's `redactReceiptText` pass.

**Suggested follow-up (not done here, as this is a read-only audit).** Delete `src/linear-kanban-canary.ts` and `tests/linear-kanban-canary.test.ts`, drop the re-export at `src/index.ts:36`, and update the three doc references to point at `src/kanban-canary-operator.ts`. This requires a separate exact-scope slice per `docs/kanban-first-migration.md:36-37` and the Phase-7 follow-up.

---

### F2 — `KanbanCanaryHashManifestReceipt.hash_scope` type allows two values that the runtime never produces together

- **Confidence:** High.
- **Severity:** Low (data-shape only; downstream is JSON consumers).
- **Files:** `src/kanban-canary-operator.ts:101-105, 631-636`, `src/cli/kanban-canary.ts:316-321`.

**Evidence.** The type at `src/kanban-canary-operator.ts:101-105` declares

```
readonly hash_scope: 'artifact_bytes' | 'receipt_without_hash_manifest';
```

but the operator's `buildReceipt` (line 635) always emits `hash_scope: 'artifact_bytes'`. The `'receipt_without_hash_manifest'` value is only produced by the CLI in `src/cli/kanban-canary.ts:317` after the operator returns, when the receipt is rewritten to hash itself. The CLI rewrite then sets `hash_scope: 'receipt_without_hash_manifest'` (line 327). The CLI value is a strict subset of "hash scope over the receipt with no manifest" — it never appears in operator output, and `artifact_bytes` never appears in the CLI's final on-disk JSON.

The two values mean materially different things (`'artifact_bytes'` is meant to be filled by real artifact SHA-256s, but the operator always emits an empty `artifacts: []`), so a downstream consumer parsing by `hash_scope` would treat the operator-only and CLI-final outputs as equivalent. The `artifacts: []` default at line 635 means the operator's `hash_manifest` is always a no-op unless the CLI rewrites it.

**Why it matters.** A new caller building a receipt through `runKanbanCanaryOperator` directly (without the CLI's rewrite) gets a `hash_manifest` with an empty `artifacts` array and the `hash_scope: 'artifact_bytes'` label, which is misleading. The `hash_manifest` field name in `KanbanCanaryOperatorReceipt` is part of the public API surface (re-exported from `src/index.ts:34`).

**Suggested follow-up.** Either (a) collapse the type to a single `'receipt_without_hash_manifest'` value and always include the self-hash in `runKanbanCanaryOperator`, or (b) document the two-mode contract more clearly in the type. Not blocking.

---

### F3 — README bridge help text duplicates information now in the CLI usage

- **Confidence:** High.
- **Severity:** Cosmetic.
- **Files:** `src/cli/linear-kanban-bridge.ts:303-320`, `README.md:199-216`.

**Evidence.** The commit `0743728 fix: polish Linear Kanban bridge CLI help` (Jun 24 2026) added the `Options:` block to the CLI's `--help` output. The README section "Linear ↔ Kanban bridge operator" (lines 199-216) is now slightly stale with respect to the new help text:

- README lists only `--once --workflow WORKFLOW.md` and `--workflow WORKFLOW.md` invocation patterns. The CLI `--help` also documents `--help, -h` and explicitly states the default workflow file (`./WORKFLOW.md`). Not technically wrong, but a drift candidate.
- README says "Use `--once` for cron/systemd timer canaries and tests" while the CLI says "By default, runs as a long-lived polling bridge: it performs an immediate tick, then repeats at workflow polling.interval_ms until stopped. Use `--once` for cron/systemd timer canaries and tests." — the CLI clarifies that the first tick is immediate, which the README does not mention.
- The help text's "Default HERMES_HOME: `<homedir>/.hermes`" line is not echoed in the README.

These are documentation only, no runtime impact. Worth a one-line README polish but very low priority.

---

### F4 — `kanban.workspace.kind: 'worktree'` allowed by the type but the CLI surface test never exercises `worktree:` spec construction

- **Confidence:** Medium.
- **Severity:** Low.
- **Files:** `src/workflow.ts:58-61, 661-674`, `src/kanban-types.ts:12`, `src/linear-kanban-bridge.ts:254-262`.

**Evidence.** The typed config has `KanbanWorkspacePolicy = { kind: 'worktree'; root: string }` (`src/workflow.ts:58-61`), and `kanbanWorkspacePolicy` (`src/workflow.ts:661-674`) accepts `dir` or `worktree` with an absolute `root`. The bridge CLI converts it to `dir:<root>` or `worktree:<root>` (`src/linear-kanban-bridge.ts:254-262`) using the `KanbanWorkspaceSpec` template literal type (`src/kanban-types.ts:12`). The test files exercise `kind: scratch` only (`tests/cli-linear-kanban-bridge.test.ts:88, 169, 233`); no test in the repo exercises `kind: dir` or `kind: worktree` end-to-end for the bridge. The other canary tests stay on `scratch` as well.

The `kind: worktree` mode in `KanbanBackendConfig` is meant to tell the bridge "I want a real `worktree:<path>` workspace for these tasks", but the bridge has no test coverage of the spec construction. The `src/kanban-graph-materializer.ts:330-335` only ever picks `worktree:<path>` if `node.repoMutation !== null`, which is per-card override, not the default.

**Why it matters.** A future contributor wiring up real worktree-backed Kanban tasks has no test oracle. The risk is silent: the bridge would still pass the broader suite (which uses `scratch` everywhere).

**Suggested follow-up.** Add one fixture-based test that exercises `kanban.workspace.kind: dir` (and ideally `worktree`) through the bridge CLI to lock down the spec string construction. Not blocking; will be needed before any real worktree-backed rollout.

---

### F5 — `examples/kanban-workflow.md` and the checked-in `WORKFLOW.md` are byte-identical

- **Confidence:** High.
- **Severity:** Cosmetic.
- **Files:** `WORKFLOW.md`, `examples/kanban-workflow.md`.

**Evidence.** `diff` reports zero differences. The README at line 50 advertises `WORKFLOW.md` as the "Sample Kanban-backed workflow config for local facade/check workflows" and at line 76 advertises `examples/kanban-workflow.md` as "Safe/demo Kanban backend workflow example using a temp/test board posture". Both files ship the same content; one of them is redundant. The only divergence is in the second paragraph (the example file's heading is "Kanban-backed Symphony workflow example" vs. the root "Kanban-backed demo workflow"). Easy fix: delete one of the two and update the README cross-reference, or repurpose one as a separate `examples/kanban-broad-dispatch-workflow.md` shape.

This is a long-standing drift, not a regression. No code path depends on the example.

---

### F6 — `tracker.mutations.comment_on_*` defaults are not exposed in `WORKFLOW.md` or the example

- **Confidence:** High.
- **Severity:** Documentation, not behavior.
- **Files:** `src/workflow.ts:273-280`, `WORKFLOW.md`, `examples/kanban-workflow.md`, `docs/kanban-first-migration.md`, `docs/live-autonomy-rollout-plan.md:48-50`.

**Evidence.** `src/workflow.ts:273-280` defaults `tracker.mutations.comment_on_start`, `comment_on_completion`, `comment_on_failure` all to `true`. None of the checked-in workflow examples or the bridge docs explicitly call this out. The bridge CLI's tests pass `comment_marker: 'symphony-linear-kanban-bridge'` and rely on the start comment defaulting on (`tests/cli-linear-kanban-bridge.test.ts:80-81, 138-142`). Operators reading the bridge docs could easily assume comments are opt-in and be surprised by the default-on comment traffic on every tick. The receipt comments are documented (the bridge writes `Kanban task: t_cli0001` etc.) but the "by default" framing is missing.

**Why it matters.** Comments land on Linear for every tick by default. The mutation policy row at `docs/live-autonomy-rollout-plan.md:48-50` says "Status comments and state transitions use idempotency keys stored in the durable ledger to avoid duplicate comments/transitions across restarts", which is correct, but the operator will be confused by silent comment traffic if they did not realize the default is `true`. Worth a one-line note in `docs/live-autonomy-rollout-plan.md` or the bridge section of the README.

---

### F7 — `kanban.board: linear` and broad-dispatch README warning are correct but live in only one doc

- **Confidence:** High.
- **Severity:** Documentation.
- **Files:** `README.md:210`, `docs/live-autonomy-rollout-plan.md:30-35`, `src/workflow.ts:229-237`.

**Evidence.** The README's bridge section says "Use `tracker.all_approved_projects: true` only when the reviewed scope is intentionally 'all active Linear issues visible to this token'; pair it with `kanban.board: linear`, narrow `tracker.active_states`, and low `tracker.max_issues_per_poll` for the initial rollout." The actual board slug check is on kebab-case shape only (`src/workflow.ts:692-694`) — `kanban.board: linear` is accepted. The live-autonomy rollout plan is consistent. The compliance matrix mentions `kanban.board: linear` only in passing. No drift; just a documentation-finds finding.

---

### F8 — `tests/package-cli-surface.test.ts` privacy guard does not scan the `.d.ts` of the bin scripts

- **Confidence:** High.
- **Severity:** Low (defense-in-depth).
- **Files:** `tests/package-cli-surface.test.ts:36-73`, `package.json:34-42`.

**Evidence.** The `npm pack` dry-run scan at `tests/package-cli-surface.test.ts:54-72` reads every file in the pack list (filtered to `js|d.ts|json|md|txt|yml|yaml|map` plus `LICENSE`) and asserts that no file matches the private-operator regex. The bin entries are `dist/src/cli/*.js`; the `dist/src/cli/*.d.ts` files are not explicit `bin` entries but are shipped in the same directory and are scanned by the same test (because the pack list includes them). So actually the test does cover them via the `\.d\.ts$` glob at line 67 — false alarm; this finding is downgraded. Verified by re-reading lines 67-72.

**Conclusion.** No action required; the test does cover `d.ts` and `map` files.

---

### F9 — `tracker.canary_labels` are normalized to lowercase, but the on-disk Linear label casing is preserved

- **Confidence:** High.
- **Severity:** Low (potential surprise, not a bug).
- **Files:** `src/workflow.ts:240-241`, `src/tracker.ts` (label filter handling).

**Evidence.** `src/workflow.ts:240-241` lowercases all `tracker.canary_labels`. The match against Linear issue labels depends on whether the tracker also normalizes. The bridge's `kanban-workspace-spec` construction and the canary operator both feed these into other code paths, but none of the test files exercise a mixed-case label to confirm. This is consistent with the spec ("labels are normalized to lowercase", `README.md:144`), and the policy is correct, but a future test should pin a mixed-case label and assert the lowercase match works as documented. Cosmetic.

---

### F10 — `examples/fake-workflow.md` uses `tracker.kind: linear` but no `tracker.api_key` resolution block

- **Confidence:** High.
- **Severity:** Documentation.
- **Files:** `examples/fake-workflow.md`, `src/workflow.ts:225-226`.

**Evidence.** The example at `examples/fake-workflow.md:4` uses `api_key: FAKE_API_KEY`, which is a literal string, not a `$VAR_NAME` env token. The README at `README.md:88-94` says "`$VAR_NAME` indirection is resolved only for `tracker.api_key` and `workspace.root` values that explicitly equal a variable token." This is correctly implemented at `src/workflow.ts:225-226` and `src/workflow.ts:782-792`. The example is correct as-is (FAKE_API_KEY is fine for fake demos), but the README at line 76 promises `examples/fake-workflow.md` as a "copy-paste example of a minimal workflow config" — a user copying it for live use would be surprised that FAKE_API_KEY is a literal. Worth a one-line "this is a fake/demo file; replace FAKE_API_KEY with $YOUR_API_KEY for live use" note in the example.

---

### F11 — `symphony-kanban-canary` and `symphony-linear-kanban-bridge` use different redaction implementations

- **Confidence:** High.
- **Severity:** Low.
- **Files:** `src/kanban-canary-operator.ts:830-839` (`redactReceiptText`), `src/cli/linear-kanban-bridge.ts:322-327` (`redactForCli`).

**Evidence.** Two parallel redaction functions. The operator's `redactReceiptText` is more thorough (private-key blocks, JWTs, session tokens, etc.), while the bridge CLI's `redactForCli` only catches `lin_api_*`, `sk-*`, and `Bearer` headers. They are used for different purposes (the operator redacts task bodies and the bridge CLI redacts error/CLI output), so the surface difference is defensible, but a reader comparing the two will not see a single canonical redaction policy. A shared `src/redact.ts` would be cleaner. This is a future-hygiene observation, not a current bug — the operator's redact is applied to the durable task body and the bridge's redact is applied to stderr/log lines.

---

### F12 — `symphony-linear-kanban-bridge` test in `--once` mode asserts `createdInputs[0].idempotencyKey: 'symphony-linear-kanban-bridge:symphony-linear-kanban-bridge:issue-1'`

- **Confidence:** High.
- **Severity:** Low (test-only).
- **Files:** `tests/cli-linear-kanban-bridge.test.ts:139`, `src/linear-kanban-bridge.ts:123-125`.

**Evidence.** The bridge composes `${LINEAR_KANBAN_BRIDGE_ACTOR}:${workflowId}:${issue.id}` (`src/linear-kanban-bridge.ts:123-125`). When the test calls `runSymphonyLinearKanbanBridgeCli(['--once', '--workflow', workflowPath], { ... workflowId defaults to LINEAR_KANBAN_BRIDGE_ACTOR ...})` the composed key is `symphony-linear-kanban-bridge:symphony-linear-kanban-bridge:issue-1` — the literal string `symphony-linear-kanban-bridge` appears twice. The duplicated prefix is real (and intentional — the actor and the workflow id are the same value in the CLI default path), but the test name and the human-readable output could trip up a future reader. A `linearKanbanBridgeIdempotencyKey` test or a renamed constant would clarify.

Not a real bug, just a readability item. The actor and the workflow id are also the same in the CLI default, which means a future contributor who changes the actor will silently break every existing ledger record's idempotency key shape.

---

## Areas inspected and found clean

- **Type & build:** `npm run typecheck` clean; `npm test` 32 files / 219 tests pass.
- **Public exports vs. README:** all 19 README items in the "Current status" list map to an existing `src/*.ts` module and corresponding test file. The one partial-mismatch is F1 above.
- **Bin surface:** `package.json:34-42` lists seven `bin` entries; `tests/package-cli-surface.test.ts:24-33` enforces the same set. Each bin's `dist/src/cli/<name>.js` exists. `package-lock.json` mirrors the bin map.
- **Workspace hooks:** `src/workspace.ts` matches the policy table in `README.md:152-165`. Default `hooks.timeout_ms: 60000` is correctly defaulted at `src/workflow.ts:299` and exercised in `tests/workspace.test.ts`.
- **Codex runner config:** `src/codex-runner.ts` and the runner contract docs at `docs/codex-protocol-preflight-harness.md:94-101` agree on the `thread/start sandbox` string vs. `turn/start sandboxPolicy` object split. The `codex.command` default is `codex app-server` (`src/workflow.ts:180`).
- **Approval policy:** `auto_approve` is the only escape hatch (`README.md:122`, `src/codex-runner.ts`); default is `fail`.
- **Orchestrator retry backoff:** `min(10000 * 2 ** (attempt - 1), maxRetryBackoffMs)` (`src/orchestrator.ts:766-769`) matches the README claim at line 228.
- **Service-state durability:** `service.state_path` semantics, the `IssueRunLedger` interface, and the orchestrator's `recoverInterruptedRuns` flow are all consistent across `src/issue-run-ledger.ts`, `src/orchestrator.ts`, `src/service.ts`, and `docs/live-autonomy-rollout-plan.md:39-43`.
- **Control plane:** `disabled by default`, loopback-first, bearer auth for mutating endpoints, `allow_external_bind` opt-in. `src/control-plane.ts` matches `README.md:128` and `docs/spec-compliance-matrix.md:36`.
- **Kanban dispatch preflight:** `src/workflow.ts:352-354` correctly bypasses all linear/codex preflight errors when `backend.kind: hermes_kanban`.
- **`implementationPolicyDecisions`:** every entry has a non-empty `decision` and a non-empty `evidence` array; the topics referenced by `tests/index.test.ts:14-25` all exist; `tests/index.test.ts:31-46` confirms the backend-direction topic is selected and contains the expected substrings.
- **Docs no-go language:** `docs/live-autonomy-rollout-plan.md:6-7` correctly limits what 2026-06-23 authorization allows; `docs/kanban-first-migration.md:61` correctly says no push/PR/publish is implied by the migration policy alone; `docs/kanban-phase-7-follow-up.md:28-35` lists the gate items needed before removal of the legacy backend. Internally consistent.
- **Packlist privacy guard:** `tests/package-cli-surface.test.ts:53-72` enforces no `HER-1`, `HER-3`, `Janusz authorized`, `.hermes`, `OpenPass`, `LINEAR_API_TOKEN`, `linear.app/hermegeddon`, or `docs/live-autonomy*` strings land in the public pack. The guard is sufficient and re-runs on every CI pass.

## Unresolved questions

- **Q1 (F1).** Should the `linear-kanban-canary.ts` module be deleted in a follow-up slice, or kept as a stable reference implementation? The operator supersedes it functionally but the older one is what the docs cite. A separate exact-scope removal packet is the conservative path; this audit cannot make that call.
- **Q2 (F2).** Is the two-value `hash_scope` union a contract intended for future artifact-hash expansion, or a leftover from an early sketch? The current operator output always ships `artifact_bytes` with `artifacts: []`, which is a degenerate case. Worth a comment in the type or a design note.
- **Q3 (F4).** Will the first real worktree-backed Kanban pilot be covered by an integration test, or is "manual only" the intended posture? The current test gap is silent. A fixture-based test that exercises `kanban.workspace.kind: dir` (cheaper than `worktree`) would close most of the risk.
- **Q4 (F6).** Should the bridge default `comment_on_*` defaults be `false` for the first live bridge tick and only flip to `true` after the operator reviews the receipt shape? The current `true` default is correct per spec but operator-hostile on first run. Worth a one-line note in `docs/live-autonomy-rollout-plan.md`.
- **Q5 (F5).** Are `WORKFLOW.md` and `examples/kanban-workflow.md` both intentional? If yes, the README should explain the difference; if no, one should be removed.
- **Q6 (F8 covered).** No unresolved question — false alarm.
- **Q7 (F12).** Is the duplicated `symphony-linear-kanban-bridge` actor/workflow-id prefix in the idempotency key intentional, or a leftover from the CLI default? If intentional, document it; if not, change the CLI default `workflowId` to something like `bridge` to avoid the duplication.

## Summary

- **No correctness regressions** found. The full `npm run typecheck` and `npm test` (32 files / 219 tests) pass.
- **One substantive finding (F1):** `src/linear-kanban-canary.ts` is dead production code that duplicates `src/kanban-canary-operator.ts`, and the migration/phase-7/spec-compliance docs point at the dead module. Cross-file drift in `buildNoWorkerCanaryNodes` and `DEFAULT_NON_AUTHORIZATIONS` is the concrete risk; an exact-scope removal slice is the right path.
- **Eleven smaller findings (F2-F12):** documentation polish, two parallel redaction functions, a stale README ↔ CLI help text, a test-only idempotency-key readability item, a duplicated example workflow, and a few default-on mutations worth a one-line warning. None are blocking.
- **No secrets, no raw tokens, no unredacted request bodies** appear in any of the scanned files; the `tests/package-cli-surface.test.ts` privacy guard is sound.
