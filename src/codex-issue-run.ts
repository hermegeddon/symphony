import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CodexAppServerRunner,
  CodexRunnerError,
  type CodexRunResult,
  type CodexRunnerConfig,
  type CodexRunnerReceipt,
  type CodexRunnerReceiptSink,
  type CodexRuntimeEvent,
  type JsonObject,
  type JsonValue,
  type SymphonyIssue,
  type WorkflowVariables,
} from './codex-runner.js';
import { validateCodexPreflightReceipts, type CodexPreflightReceiptValidation } from './codex-preflight.js';

export type CodexIssueRunReceipt = CodexRunnerReceipt | CodexIssueRunRuntimeEventReceipt | CodexIssueRunResultReceipt;

export interface RunCodexIssueRunInput {
  readonly workspacePath: string;
  readonly receiptDir: string;
  readonly issue: SymphonyIssue;
  readonly workflow: WorkflowVariables;
  readonly promptTemplate: string;
  readonly runnerConfig: CodexRunnerConfig;
  readonly maxAppServerProcesses?: number;
}

export interface RunCodexIssueRunInEphemeralGitWorktreeInput extends Omit<RunCodexIssueRunInput, 'workspacePath'> {
  readonly sourceRepoPath: string;
  readonly tempRoot?: string;
  readonly baseRef?: string;
  readonly gitCommand?: string;
}

export interface CodexIssueRunConfirmationIssue extends SymphonyIssue {
  readonly team_key?: string;
  readonly url?: string;
}

export interface BuildCodexIssueRunOperatorConfirmationInput extends Omit<RunCodexIssueRunInput, 'issue'> {
  readonly issue: CodexIssueRunConfirmationIssue;
  readonly hooksWillRun: boolean;
}

export interface CodexIssueRunOperatorConfirmation {
  readonly effect: 'print_only';
  readonly requires_operator_confirmation: true;
  readonly exact_issue: {
    readonly identifier: string;
    readonly title: string;
    readonly team_key?: string;
    readonly url?: string;
  };
  readonly workspace: {
    readonly path: string;
    readonly lifecycle: 'caller_provided';
  };
  readonly codex: {
    readonly command_preview: string;
    readonly approval_mode: CodexRunnerConfig['approval']['mode'];
    readonly sandbox_mode: string;
    readonly protocol_schema_source: string;
  };
  readonly hooks: {
    readonly will_run: boolean;
  };
  readonly expected_artifacts: {
    readonly receipt_dir: string;
    readonly receipts: string;
    readonly validation: string;
    readonly outcome: string;
    readonly summary: string;
    readonly manifest: string;
  };
  readonly non_actions: {
    readonly codex_started: false;
    readonly receipt_files_written: false;
    readonly linear_mutation_authorized: false;
    readonly git_push_authorized: false;
    readonly deploy_authorized: false;
    readonly service_restart_authorized: false;
    readonly broad_dispatch_authorized: false;
    readonly persistent_branch_created: false;
    readonly pull_request_created: false;
  };
}

export interface CodexIssueRunArtifacts extends Readonly<Record<string, string>> {
  readonly receipts: string;
  readonly validation: string;
  readonly outcome: string;
  readonly summary: string;
  readonly manifest: string;
}

export interface CodexIssueRunEphemeralGitWorktreeArtifacts extends CodexIssueRunArtifacts {
  readonly workspace_lifecycle: string;
  readonly workspace_patch: string;
  readonly workspace_status: string;
}

export interface CodexIssueRunWorkspaceCleanup {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly exit_code?: number | null;
  readonly error?: JsonObject;
}

export interface CodexIssueRunWorkspaceLifecycle {
  readonly policy: 'ephemeral_git_worktree';
  readonly source_repo_path: string;
  readonly base_ref: string;
  readonly temp_root: string;
  readonly worktree_path: string;
  readonly created_detached_head: true;
  readonly persistent_branch_created: false;
  readonly cleanup: CodexIssueRunWorkspaceCleanup;
}

export interface CodexIssueRunEphemeralGitWorktreeOutcome extends CodexIssueRunOutcome {
  readonly workspace_lifecycle: CodexIssueRunWorkspaceLifecycle;
  readonly artifacts: CodexIssueRunEphemeralGitWorktreeArtifacts;
}

export interface CodexIssueRunWorkspaceSnapshot {
  readonly patch: string;
  readonly status: string;
}

export interface CodexIssueRunRuntimeEventReceipt {
  readonly kind: 'codex_runtime_event';
  readonly event: string;
  readonly timestamp: string;
  readonly codex_app_server_pid?: number;
  readonly thread_id?: string;
  readonly turn_id?: string;
  readonly session_id?: string;
  readonly usage?: JsonObject;
  readonly payload?: JsonValue;
}

export interface CodexIssueRunResultReceipt {
  readonly kind: 'codex_issue_run_result';
  readonly outcome: 'pass' | 'fail';
  readonly issue_identifier: string;
  readonly thread_id: string | null;
  readonly turn_count: number;
  readonly codex_app_server_pid: number | null;
  readonly protocol?: CodexRunResult['protocol'];
  readonly error?: JsonObject;
}

export interface CodexIssueRunSafetySummary {
  readonly exact_issue_identifier: string;
  readonly app_server_spawn_count: number;
  readonly max_app_server_processes_allowed: number;
  readonly approval_mode: CodexRunnerConfig['approval']['mode'];
  readonly approval_wire_policy_expected: 'never';
  readonly sandbox_mode: string;
  readonly sandbox_wire_policy_expected: string;
  readonly linear_graphql_enabled: boolean;
  readonly git_push_authorized: false;
  readonly deploy_authorized: false;
  readonly linear_mutation_authorized: false;
  readonly destructive_hooks_configured: false;
}

export interface CodexIssueRunSafetyFinding {
  readonly code: 'process_limit_exceeded';
  readonly message: string;
  readonly details: JsonObject;
}

export interface CodexIssueRunOutcome {
  readonly status: 'pass' | 'fail';
  readonly result: CodexIssueRunResultReceipt;
  readonly validation: CodexPreflightReceiptValidation;
  readonly safety: CodexIssueRunSafetySummary;
  readonly safety_findings: readonly CodexIssueRunSafetyFinding[];
  readonly receipt_count: number;
  readonly artifacts: CodexIssueRunArtifacts;
}

export class CodexIssueRunError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'CodexIssueRunError';
  }
}

export function buildCodexIssueRunOperatorConfirmation(
  input: BuildCodexIssueRunOperatorConfirmationInput,
): CodexIssueRunOperatorConfirmation {
  assertExactIssueIdentifier(input.issue.identifier);
  assertApprovedToolPolicy(input.runnerConfig);
  return {
    effect: 'print_only',
    requires_operator_confirmation: true,
    exact_issue: {
      identifier: input.issue.identifier,
      title: input.issue.title,
      ...(input.issue.team_key === undefined ? {} : { team_key: input.issue.team_key }),
      ...(input.issue.url === undefined ? {} : { url: input.issue.url }),
    },
    workspace: {
      path: resolve(input.workspacePath),
      lifecycle: 'caller_provided',
    },
    codex: {
      command_preview: redactForReceiptText(input.runnerConfig.codex.command),
      approval_mode: input.runnerConfig.approval.mode,
      sandbox_mode: input.runnerConfig.sandbox.mode,
      protocol_schema_source: input.runnerConfig.protocol.schemaSource,
    },
    hooks: {
      will_run: input.hooksWillRun,
    },
    expected_artifacts: {
      receipt_dir: resolve(input.receiptDir),
      receipts: 'codex-issue-run-redacted-receipts.json',
      validation: 'codex-issue-run-receipt-validation.json',
      outcome: 'codex-issue-run-outcome.json',
      summary: `LIVE-${sanitizeArtifactName(input.issue.identifier)}-codex-issue-run-summary.md`,
      manifest: 'artifact-manifest.json',
    },
    non_actions: {
      codex_started: false,
      receipt_files_written: false,
      linear_mutation_authorized: false,
      git_push_authorized: false,
      deploy_authorized: false,
      service_restart_authorized: false,
      broad_dispatch_authorized: false,
      persistent_branch_created: false,
      pull_request_created: false,
    },
  };
}

export async function runCodexIssueRun(input: RunCodexIssueRunInput): Promise<CodexIssueRunOutcome> {
  assertExactIssueIdentifier(input.issue.identifier);
  assertApprovedToolPolicy(input.runnerConfig);
  const maxAppServerProcesses = input.maxAppServerProcesses ?? 1;
  const receipts: CodexIssueRunReceipt[] = [];
  const emit = (receipt: CodexIssueRunReceipt): void => {
    receipts.push(receipt);
  };
  const existingRunnerReceiptSink = input.runnerConfig.receiptSink;
  const runnerReceiptSink: CodexRunnerReceiptSink = (receipt) => {
    emit(receipt);
    invokeReceiptSink(existingRunnerReceiptSink, receipt);
  };
  const runner = new CodexAppServerRunner({ ...input.runnerConfig, receiptSink: runnerReceiptSink });

  let result: CodexIssueRunResultReceipt;
  try {
    const run = await runner.runIssue({
      workspacePath: input.workspacePath,
      issue: input.issue,
      workflow: input.workflow,
      promptTemplate: input.promptTemplate,
      onEvent: (event) => {
        emit(runtimeEventReceipt(event));
      },
    });
    result = {
      kind: 'codex_issue_run_result',
      outcome: 'pass',
      issue_identifier: input.issue.identifier,
      thread_id: redactForReceiptText(run.threadId),
      turn_count: run.turns.length,
      codex_app_server_pid: run.codexAppServerPid,
      protocol: run.protocol,
    };
  } catch (error) {
    result = {
      kind: 'codex_issue_run_result',
      outcome: 'fail',
      issue_identifier: input.issue.identifier,
      thread_id: null,
      turn_count: 0,
      codex_app_server_pid: null,
      error: serializeIssueRunError(error),
    };
  }

  emit(result);
  const validation = validateCodexPreflightReceipts(receipts);
  const safety = safetySummary(input, receipts, maxAppServerProcesses);
  const safetyFindings = validateSafety(safety);
  const status = result.outcome === 'pass' && validation.ok && safetyFindings.length === 0 ? 'pass' : 'fail';
  const artifacts = await writeIssueRunArtifacts(input.receiptDir, input.issue.identifier, receipts, {
    status,
    result,
    validation,
    safety,
    safety_findings: safetyFindings,
    receipt_count: receipts.length,
    artifacts: {},
  });
  return { status, result, validation, safety, safety_findings: safetyFindings, receipt_count: receipts.length, artifacts };
}

export async function runCodexIssueRunInEphemeralGitWorktree(
  input: RunCodexIssueRunInEphemeralGitWorktreeInput,
): Promise<CodexIssueRunEphemeralGitWorktreeOutcome> {
  assertExactIssueIdentifier(input.issue.identifier);
  assertApprovedToolPolicy(input.runnerConfig);

  const sourceRepoPath = resolve(input.sourceRepoPath);
  const tempRoot = resolve(input.tempRoot ?? tmpdir());
  const baseRef = input.baseRef ?? 'HEAD';
  const gitCommand = input.gitCommand ?? 'git';
  await mkdir(tempRoot, { recursive: true });
  const worktreeParent = await mkdtemp(join(tempRoot, `symphony-codex-${sanitizeArtifactName(input.issue.identifier)}-`));
  const worktreePath = join(worktreeParent, 'worktree');
  let worktreeAdded = false;
  let cleanup: CodexIssueRunWorkspaceCleanup = { attempted: false, ok: false };

  try {
    await runGitCommand({
      gitCommand,
      cwd: sourceRepoPath,
      args: ['worktree', 'add', '--detach', worktreePath, baseRef],
      errorCode: 'ephemeral_worktree_create_failed',
      errorMessage: 'Failed to create detached ephemeral git worktree for Codex issue run.',
    });
    worktreeAdded = true;
    const outcome = await runCodexIssueRun({ ...input, workspacePath: worktreePath });
    const workspaceSnapshot = await captureWorkspaceSnapshot({ gitCommand, worktreePath });
    cleanup = await cleanupEphemeralWorktree({ gitCommand, sourceRepoPath, worktreePath, worktreeParent });
    return await writeWorkspaceLifecycleArtifacts(input.receiptDir, outcome, {
      policy: 'ephemeral_git_worktree',
      source_repo_path: sourceRepoPath,
      base_ref: baseRef,
      temp_root: tempRoot,
      worktree_path: worktreePath,
      created_detached_head: true,
      persistent_branch_created: false,
      cleanup,
    }, workspaceSnapshot);
  } finally {
    if (worktreeAdded && !cleanup.attempted) {
      await cleanupEphemeralWorktree({ gitCommand, sourceRepoPath, worktreePath, worktreeParent });
    }
    if (!worktreeAdded) {
      await rm(worktreeParent, { recursive: true, force: true });
    }
  }
}

function assertExactIssueIdentifier(identifier: string): void {
  if (identifier.trim().length === 0) {
    throw new CodexIssueRunError('missing_exact_issue_identifier', 'A live Codex issue run requires a non-empty exact issue identifier.');
  }
}

function assertApprovedToolPolicy(config: CodexRunnerConfig): void {
  if (config.approval.mode !== 'fail') {
    throw new CodexIssueRunError('unapproved_approval_mode', 'Live Codex issue runs require fail-closed approval mode unless a separate approval design is reviewed.');
  }
  if (config.tools.linearGraphql.enabled) {
    throw new CodexIssueRunError('unapproved_tool_enabled', 'Linear GraphQL tool exposure requires a separate explicit tool-policy approval.');
  }
}

function runtimeEventReceipt(event: CodexRuntimeEvent): CodexIssueRunRuntimeEventReceipt {
  return {
    kind: 'codex_runtime_event',
    event: event.event,
    timestamp: event.timestamp,
    ...(event.codex_app_server_pid === undefined ? {} : { codex_app_server_pid: event.codex_app_server_pid }),
    ...(event.thread_id === undefined ? {} : { thread_id: redactForReceiptText(event.thread_id) }),
    ...(event.turn_id === undefined ? {} : { turn_id: redactForReceiptText(event.turn_id) }),
    ...(event.session_id === undefined ? {} : { session_id: redactForReceiptText(event.session_id) }),
    ...(event.usage === undefined ? {} : { usage: redactJsonValue(event.usage) as JsonObject }),
    ...(event.payload === undefined ? {} : { payload: redactJsonValue(event.payload) }),
  };
}

function invokeReceiptSink<TReceipt>(sink: ((receipt: TReceipt) => void | Promise<void>) | undefined, receipt: TReceipt): void {
  try {
    const result = sink?.(receipt);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Receipt sinks are observability hooks and must not change issue-run behavior.
  }
}

function safetySummary(input: RunCodexIssueRunInput, receipts: readonly CodexIssueRunReceipt[], maxAppServerProcesses: number): CodexIssueRunSafetySummary {
  return {
    exact_issue_identifier: input.issue.identifier,
    app_server_spawn_count: receipts.filter((receipt) => receipt.kind === 'codex_app_server_spawn').length,
    max_app_server_processes_allowed: maxAppServerProcesses,
    approval_mode: input.runnerConfig.approval.mode,
    approval_wire_policy_expected: 'never',
    sandbox_mode: input.runnerConfig.sandbox.mode,
    sandbox_wire_policy_expected: input.runnerConfig.sandbox.mode.split('_').join('-'),
    linear_graphql_enabled: input.runnerConfig.tools.linearGraphql.enabled,
    git_push_authorized: false,
    deploy_authorized: false,
    linear_mutation_authorized: false,
    destructive_hooks_configured: false,
  };
}

function validateSafety(safety: CodexIssueRunSafetySummary): CodexIssueRunSafetyFinding[] {
  const findings: CodexIssueRunSafetyFinding[] = [];
  if (safety.app_server_spawn_count > safety.max_app_server_processes_allowed) {
    findings.push({
      code: 'process_limit_exceeded',
      message: 'Codex issue run spawned more app-server processes than allowed.',
      details: {
        app_server_spawn_count: safety.app_server_spawn_count,
        max_app_server_processes_allowed: safety.max_app_server_processes_allowed,
      },
    });
  }
  return findings;
}

async function writeIssueRunArtifacts(
  receiptDir: string,
  issueIdentifier: string,
  receipts: readonly CodexIssueRunReceipt[],
  outcome: Omit<CodexIssueRunOutcome, 'artifacts'> & { readonly artifacts: Readonly<Record<string, string>> },
): Promise<CodexIssueRunArtifacts> {
  await mkdir(receiptDir, { recursive: true });
  const artifactNames = {
    receipts: 'codex-issue-run-redacted-receipts.json',
    outcome: 'codex-issue-run-outcome.json',
    validation: 'codex-issue-run-receipt-validation.json',
    summary: `LIVE-${sanitizeArtifactName(issueIdentifier)}-codex-issue-run-summary.md`,
    manifest: 'artifact-manifest.json',
  } as const;

  const artifacts: CodexIssueRunArtifacts = {
    receipts: join(receiptDir, artifactNames.receipts),
    validation: join(receiptDir, artifactNames.validation),
    outcome: join(receiptDir, artifactNames.outcome),
    summary: join(receiptDir, artifactNames.summary),
    manifest: join(receiptDir, artifactNames.manifest),
  };

  await writeJson(artifacts.receipts, receipts);
  await writeJson(artifacts.validation, outcome.validation);
  await writeJson(artifacts.outcome, { ...outcome, artifacts });
  await writeFile(artifacts.summary, issueRunSummary({ ...outcome, artifacts }), 'utf8');
  await writeJson(artifacts.manifest, await artifactManifest(withoutManifestArtifact(artifacts)));
  return artifacts;
}

async function writeWorkspaceLifecycleArtifacts(
  receiptDir: string,
  outcome: CodexIssueRunOutcome,
  workspaceLifecycle: CodexIssueRunWorkspaceLifecycle,
  workspaceSnapshot: CodexIssueRunWorkspaceSnapshot,
): Promise<CodexIssueRunEphemeralGitWorktreeOutcome> {
  const artifacts: CodexIssueRunEphemeralGitWorktreeArtifacts = {
    ...outcome.artifacts,
    workspace_lifecycle: join(receiptDir, 'codex-issue-run-worktree-lifecycle.json'),
    workspace_patch: join(receiptDir, 'codex-issue-run-worktree.patch'),
    workspace_status: join(receiptDir, 'codex-issue-run-worktree-status.txt'),
  };
  const enrichedOutcome: CodexIssueRunEphemeralGitWorktreeOutcome = {
    ...outcome,
    status: outcome.status === 'pass' && workspaceLifecycle.cleanup.ok ? 'pass' : 'fail',
    artifacts,
    workspace_lifecycle: workspaceLifecycle,
  };
  await writeJson(artifacts.workspace_lifecycle, workspaceLifecycle);
  await writeFile(artifacts.workspace_patch, workspaceSnapshot.patch, 'utf8');
  await writeFile(artifacts.workspace_status, workspaceSnapshot.status, 'utf8');
  await writeJson(artifacts.outcome, enrichedOutcome);
  await writeFile(artifacts.summary, issueRunSummary(enrichedOutcome), 'utf8');
  await writeJson(artifacts.manifest, await artifactManifest(withoutManifestArtifact(artifacts)));
  return enrichedOutcome;
}

async function captureWorkspaceSnapshot(input: {
  readonly gitCommand: string;
  readonly worktreePath: string;
}): Promise<CodexIssueRunWorkspaceSnapshot> {
  const patch = await runGitCaptureCommand({
    gitCommand: input.gitCommand,
    cwd: input.worktreePath,
    args: ['diff', '--binary'],
    errorCode: 'ephemeral_worktree_patch_capture_failed',
    errorMessage: 'Failed to capture ephemeral git worktree patch artifact.',
  });
  const status = await runGitCaptureCommand({
    gitCommand: input.gitCommand,
    cwd: input.worktreePath,
    args: ['status', '--short'],
    errorCode: 'ephemeral_worktree_status_capture_failed',
    errorMessage: 'Failed to capture ephemeral git worktree status artifact.',
  });
  return { patch, status };
}

async function runGitCaptureCommand(input: {
  readonly gitCommand: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly errorCode: string;
  readonly errorMessage: string;
}): Promise<string> {
  const result = await executeCommand(input.gitCommand, input.args, input.cwd);
  if (!result.ok) {
    throw new CodexIssueRunError(input.errorCode, input.errorMessage, gitCommandDetails(input.gitCommand, input.args, input.cwd, result));
  }
  return result.stdout;
}

interface GitCommandResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGitCommand(input: {
  readonly gitCommand: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly errorCode: string;
  readonly errorMessage: string;
}): Promise<void> {
  const result = await executeCommand(input.gitCommand, input.args, input.cwd);
  if (!result.ok) {
    throw new CodexIssueRunError(input.errorCode, input.errorMessage, gitCommandDetails(input.gitCommand, input.args, input.cwd, result));
  }
}

async function cleanupEphemeralWorktree(input: {
  readonly gitCommand: string;
  readonly sourceRepoPath: string;
  readonly worktreePath: string;
  readonly worktreeParent: string;
}): Promise<CodexIssueRunWorkspaceCleanup> {
  const result = await executeCommand(input.gitCommand, ['worktree', 'remove', '--force', input.worktreePath], input.sourceRepoPath);
  if (result.ok) {
    await rm(input.worktreeParent, { recursive: true, force: true });
    return { attempted: true, ok: true, exit_code: result.exitCode };
  }
  return {
    attempted: true,
    ok: false,
    exit_code: result.exitCode,
    error: gitCommandDetails(input.gitCommand, ['worktree', 'remove', '--force', input.worktreePath], input.sourceRepoPath, result),
  };
}

async function executeCommand(command: string, args: readonly string[], cwd: string): Promise<GitCommandResult> {
  return await new Promise<GitCommandResult>((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => {
      resolvePromise({ ok: false, exitCode: null, stdout: '', stderr: String(error) });
    });
    child.on('close', (exitCode) => {
      resolvePromise({
        ok: exitCode === 0,
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function gitCommandDetails(command: string, args: readonly string[], cwd: string, result: GitCommandResult): JsonObject {
  return {
    command: redactForReceiptText(command),
    args: args.map((arg) => redactForReceiptText(arg)),
    cwd: redactForReceiptText(cwd),
    exit_code: result.exitCode,
    stdout: redactForReceiptText(result.stdout),
    stderr: redactForReceiptText(result.stderr),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function withoutManifestArtifact(artifacts: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(artifacts).filter(([name]) => name !== 'manifest');
  return Object.fromEntries(entries);
}

async function artifactManifest(artifacts: Readonly<Record<string, string>>): Promise<JsonObject> {
  const entries: Record<string, JsonValue> = {};
  for (const [name, artifactPath] of Object.entries(artifacts)) {
    entries[name] = {
      path: artifactPath,
      sha256: await sha256File(artifactPath),
    };
  }
  return { artifacts: entries };
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

type IssueRunSummaryInput = Omit<CodexIssueRunOutcome, 'artifacts'> & {
  readonly artifacts: Readonly<Record<string, string>>;
  readonly workspace_lifecycle?: CodexIssueRunWorkspaceLifecycle;
};

function issueRunSummary(outcome: IssueRunSummaryInput): string {
  return [
    `# ${outcome.safety.exact_issue_identifier} Codex issue run`,
    '',
    `- Outcome: ${outcome.status}`,
    `- Exact issue identifier: ${outcome.safety.exact_issue_identifier}`,
    `- App-server spawn count: ${String(outcome.safety.app_server_spawn_count)}`,
    `- Receipt validation ok: ${String(outcome.validation.ok)}`,
    `- Receipt validation findings: ${String(outcome.validation.findings.length)}`,
    `- Safety findings: ${String(outcome.safety_findings.length)}`,
    `- Receipt count: ${String(outcome.receipt_count)}`,
    `- Linear GraphQL enabled: ${String(outcome.safety.linear_graphql_enabled)}`,
    `- Git push/deploy/Linear mutation authorized: ${String(outcome.safety.git_push_authorized)} / ${String(outcome.safety.deploy_authorized)} / ${String(outcome.safety.linear_mutation_authorized)}`,
    ...(outcome.workspace_lifecycle === undefined
      ? []
      : [
          '',
          '## Workspace lifecycle',
          '',
          `- Workspace lifecycle: ${outcome.workspace_lifecycle.policy}`,
          `- Base ref: ${outcome.workspace_lifecycle.base_ref}`,
          `- Worktree path: ${outcome.workspace_lifecycle.worktree_path}`,
          `- Detached HEAD: ${String(outcome.workspace_lifecycle.created_detached_head)}`,
          `- Persistent branch created: ${String(outcome.workspace_lifecycle.persistent_branch_created)}`,
          `- Cleanup attempted/ok: ${String(outcome.workspace_lifecycle.cleanup.attempted)} / ${String(outcome.workspace_lifecycle.cleanup.ok)}`,
        ]),
    '',
    '## Non-authorizations',
    '',
    'No Linear mutation, git push, deploy, broad dispatch, multi-issue autonomy, service restart, dependency install, or long-lived daemon is authorized by this local receipt packet.',
    '',
  ].join('\n');
}

function sanitizeArtifactName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, '_');
}

function serializeIssueRunError(error: unknown): JsonObject {
  if (error instanceof CodexRunnerError || error instanceof CodexIssueRunError) {
    return error.details === undefined
      ? { code: error.code, message: redactSecretText(error.message), name: error.name }
      : { code: error.code, message: redactSecretText(error.message), name: error.name, details: redactJsonValue(error.details) };
  }
  if (error instanceof Error) {
    return { message: redactSecretText(error.message), name: error.name };
  }
  return { message: redactSecretText(String(error)) };
}

function redactJsonValue(value: unknown, key = ''): JsonValue {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return isSecretField(key) ? '[REDACTED]' : redactForReceiptText(value);
  if (Array.isArray(value)) return value.map((entry) => redactJsonValue(entry));
  if (typeof value === 'object') {
    const redacted: Record<string, JsonValue> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[entryKey] = redactJsonValue(entryValue, entryKey);
    }
    return redacted;
  }
  return redactForReceiptText(stringifyUnknown(value));
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'undefined') return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name.length === 0 ? 'anonymous' : value.name}]`;
  try {
    const serialized: unknown = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isSecretField(key: string): boolean {
  return /(?:api[_-]?key|authorization|password|refresh|secret|session|token)/i.test(key);
}

function redactSecretText(value: string): string {
  return value
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replaceAll(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replaceAll(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1[REDACTED]')
    .replaceAll(/(--(?:api[-_]?key|token|secret|password)\s+)([^\s]+)/gi, '$1[REDACTED]')
    .replaceAll(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\bsess_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\blin_(?:api|oauth)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
}

function truncateForReceipt(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function redactForReceiptText(value: string): string {
  return truncateForReceipt(redactSecretText(value));
}
