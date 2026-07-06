# Local Codex protocol preflight receipt harness

This repository includes a **local-only** Codex auth/protocol preflight harness for exercising the Symphony Codex app-server boundary before any real Codex/OpenAI run is approved.

After the later bounded `HER-1` live Codex issue run on 2026-06-21, this document remains the local preflight contract. The reusable single-issue issue-run API is documented in `docs/codex-issue-run-harness.md`; the live-run result and closeout evidence are recorded separately in `docs/her-1-live-codex-run-2026-06-21.md`.

The harness is implemented in `src/codex-preflight.ts` and wraps `CodexAppServerRunner` from `src/codex-runner.ts`.

## What it proves

A fake-only preflight can prove that Symphony can:

1. spawn a configured Codex app-server command through the existing runner seam;
2. send and summarize the protocol startup requests (`initialize`, `thread/start`, and `turn/start`);
3. capture normalized Codex runtime events;
4. produce a terminal `codex_preflight_result` receipt;
5. keep receipt-sink failures nonfatal for both synchronous throws and returned-Promise rejections;
6. fail closed when the app-server requests approval while Symphony is configured not to auto-approve;
7. validate receipt arrays for secret-like payloads before local artifacts are trusted.

It does **not** prove that live Codex/OpenAI credentials work, that a real hosted model will complete a task, that workspace hooks are safe, or that broader autonomous dispatch is authorized.

## Public API

```ts
import {
  runCodexProtocolPreflight,
  validateCodexPreflightReceipts,
  type CodexPreflightReceipt,
} from '@hermegeddon/symphony-ts';
```

`runCodexProtocolPreflight(...)` accepts:

- `workspacePath` — the local workspace/cwd used for the runner process;
- `runnerConfig` — the same `CodexRunnerConfig` used by `CodexAppServerRunner`;
- optional `issue`, `workflow`, and `promptTemplate` overrides;
- optional `signal`;
- optional `receiptSink` for local receipt capture.

The default issue and prompt are synthetic preflight values and explicitly instruct the app-server not to modify files, push, deploy, call external tools, or mutate trackers.

`validateCodexPreflightReceipts(...)` serializes a receipt array and returns:

```ts
{
  ok: boolean;
  findings: Array<{ pattern: string }>;
}
```

Current finding names include `authorization_bearer`, `openai_secret_key`, `codex_session_token`, `linear_token`, `jwt_like`, and `private_key`.

## Receipt kinds

The preflight emits a local receipt stream. Receipt sinks are observability hooks: sink failures are swallowed and do not change runner/preflight behavior.

| Kind | Source | Purpose |
|------|--------|---------|
| `codex_app_server_spawn` | `CodexAppServerRunner` | Records the launch boundary: cwd, env key names, approval/sandbox policy mapping, protocol source, a redacted/truncated command preview, and a SHA-256 hash of the configured command. |
| `codex_protocol_request_response` | `CodexAppServerRunner` | Records minimized summaries of app-server protocol request/response pairs. Raw prompts and provider responses are not dumped; turn input is represented by count/hash metadata. |
| `codex_runtime_event` | `runCodexProtocolPreflight` | Records normalized runner events with redacted payload/usage fields. |
| `codex_preflight_result` | `runCodexProtocolPreflight` | Records pass/fail, issue identifier, thread id, turn count, app-server pid, protocol metadata, and a redacted error object on failure. |

## Redaction/minimization rules

Receipts intentionally prefer stable proof over raw payloads:

- configured command is hashed, and its preview is redacted before truncation;
- environment values are never recorded; only sorted environment key names are recorded;
- secret-like object keys such as `api_key`, `authorization`, `password`, `refresh`, `secret`, `session`, and `token` are redacted recursively;
- obvious token text such as bearer authorization headers, OpenAI-style secret-key strings, Codex session-token-like strings, Linear token-like strings, and JWT-like strings is redacted from strings;
- receipt validation flags secret-like payloads before receipts are accepted as local evidence.

A future live canary that injects a real token must also validate inside the secret-exec boundary that the exact injected value is absent from written artifacts. A regex scan alone is not sufficient for real credentials.

## Local verification

The preflight harness is covered by fake JSONL app-server tests only:

```bash
npm test -- tests/codex-preflight.test.ts
```

The full local package verification remains:

```bash
npm run check
npm run build
```

These commands must not require live credentials, network access, or a real Codex/OpenAI process.

## Codex 0.141 sandbox wire shape

The bounded HER-1 live run showed that Codex CLI `0.141.0` expects different sandbox shapes at different protocol methods:

- `thread/start` receives the CLI-style string field `sandbox`, for example `"workspace-write"`.
- `turn/start` receives object-shaped `sandboxPolicy`, for example `{ "type": "workspaceWrite", "networkAccess": false, "writableRoots": ["/absolute/workspace"] }`.

Receipt and fixture tests should preserve that split. Do not replace it with one sandbox representation shared across both methods unless a later targeted Codex version proves a different schema.

## Live Codex/OpenAI gate remains narrow

This harness is preparation for approval-gated live runs. Do not run a real Codex/OpenAI preflight or issue run unless a fresh human gate approves the exact scope.

> **Legacy / quarantine posture.** `runCodexProtocolPreflight` exercises the legacy `CodexAppServerRunner` seam with fake JSONL app-server fixtures. A local preflight PASS proves only that the runner can start and exchange protocol messages under controlled local conditions. It does **not** prove live Codex/OpenAI credentials, it does not prove a real model will complete a task, and it is not evidence that the Kanban-first work engine (`backend.kind: hermes_kanban`) is ready for live dispatch. Do not cite preflight receipts as evidence for Kanban readiness; cite Kanban canary, bridge, or integration receipts instead.

Minimum constraints for any future live preflight or issue-run approval remain:

1. exact Linear issue scope only, such as `HER-1` or another explicitly approved issue;
2. at most one real Codex app-server process;
3. temporary or explicitly approved workspace with no destructive hooks;
4. approval requests disabled or fail-closed unless explicitly configured otherwise;
5. local startup/session/protocol receipts captured and validated;
6. no git push, no deploy, no Linear mutation, no broad dispatch, and no multi-issue autonomy.

After a live preflight or bounded issue run, the receipts may justify only the next explicitly reviewed step. They do not automatically authorize broad autonomous issue runs.

A future reviewed removal slice may retire `runCodexProtocolPreflight` and the direct `CodexAppServerRunner` path when equivalent or better Kanban-first evidence exists for all supported workflows.
