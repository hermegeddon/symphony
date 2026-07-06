import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  buildCodexIssueRunOperatorConfirmation as exportedBuildCodexIssueRunOperatorConfirmation,
  runCodexIssueRun as exportedRunCodexIssueRun,
  runCodexIssueRunInEphemeralGitWorktree as exportedRunCodexIssueRunInEphemeralGitWorktree,
} from '../src/index.js';
import {
  buildCodexIssueRunOperatorConfirmation,
  runCodexIssueRun,
  runCodexIssueRunInEphemeralGitWorktree,
  type RunCodexIssueRunInput,
} from '../src/codex-issue-run.js';

const execFileAsync = promisify(execFile);

async function makeFakeServer(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-codex-issue-run-fake-'));
  const scriptPath = join(dir, 'fake-app-server.mjs');
  await writeFile(scriptPath, script, 'utf8');
  return scriptPath;
}

type RunnerConfig = RunCodexIssueRunInput['runnerConfig'];

function fakeRunnerConfig(fakeServerPath: string, linearGraphqlEnabled = false): RunnerConfig {
  return {
    codex: { command: `node ${JSON.stringify(fakeServerPath)}`, readTimeoutMs: 1_000, turnTimeoutMs: 1_000 },
    protocol: { schemaSource: 'fake-jsonl-v1 fixture for issue run' },
    approval: { mode: 'fail' },
    sandbox: { mode: 'workspace_write' },
    tools: { linearGraphql: { enabled: linearGraphqlEnabled } },
  };
}

function fakeIssueRunInput(overrides: {
  readonly workspacePath: string;
  readonly receiptDir: string;
  readonly fakeServerPath: string;
  readonly identifier?: string;
  readonly title?: string;
  readonly runnerConfig?: RunnerConfig;
  readonly maxAppServerProcesses?: number;
}): RunCodexIssueRunInput {
  return {
    workspacePath: overrides.workspacePath,
    receiptDir: overrides.receiptDir,
    issue: { identifier: overrides.identifier ?? 'HER-99', title: overrides.title ?? 'Fake issue run' },
    workflow: { run: 'fake' },
    promptTemplate: 'Issue {{issue.identifier}}: {{issue.title}}',
    runnerConfig: overrides.runnerConfig ?? fakeRunnerConfig(overrides.fakeServerPath),
    ...(overrides.maxAppServerProcesses === undefined ? {} : { maxAppServerProcesses: overrides.maxAppServerProcesses }),
  };
}

function successfulFakeServerScript(notification?: unknown): string {
  const notificationLine = notification === undefined ? '' : `send(${JSON.stringify(notification)});`;
  return `
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_issue_run' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_issue_run' }, session: { id: 'session_issue_run' } } });
    ${notificationLine}
    send({ method: 'turn/completed', params: { thread: { id: 'thread_issue_run' }, turn: { id: 'turn_issue_run' } } });
  }
});
`;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

async function makeGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'symphony-issue-run-source-repo-'));
  await git(repo, ['init']);
  await writeFile(join(repo, 'README.md'), 'fixture repo\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['-c', 'user.name=Symphony Test', '-c', 'user.email=symphony@example.test', 'commit', '-m', 'initial']);
  return repo;
}

describe('runCodexIssueRun', () => {
  it('exports the issue-run wrappers from the package API', () => {
    expect(exportedBuildCodexIssueRunOperatorConfirmation).toBe(buildCodexIssueRunOperatorConfirmation);
    expect(exportedRunCodexIssueRun).toBe(runCodexIssueRun);
    expect(exportedRunCodexIssueRunInEphemeralGitWorktree).toBe(runCodexIssueRunInEphemeralGitWorktree);
  });

  it('builds a print-only operator confirmation packet without spawning Codex or writing receipts', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-issue-run-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const spawnMarkerPath = join(workspacePath, 'spawned.txt');
    const fakeServerPath = await makeFakeServer(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`);

    const packet = buildCodexIssueRunOperatorConfirmation({
      ...fakeIssueRunInput({ workspacePath, receiptDir, fakeServerPath }),
      issue: { identifier: 'HER-101', title: 'Confirm operator packet', team_key: 'HER' },
      hooksWillRun: false,
    });

    expect(packet).toEqual({
      effect: 'print_only',
      requires_operator_confirmation: true,
      exact_issue: { identifier: 'HER-101', title: 'Confirm operator packet', team_key: 'HER' },
      workspace: { path: workspacePath, lifecycle: 'caller_provided' },
      codex: {
        command_preview: `node ${JSON.stringify(fakeServerPath)}`,
        approval_mode: 'fail',
        sandbox_mode: 'workspace_write',
        protocol_schema_source: 'fake-jsonl-v1 fixture for issue run',
      },
      hooks: { will_run: false },
      expected_artifacts: {
        receipt_dir: receiptDir,
        receipts: 'codex-issue-run-redacted-receipts.json',
        validation: 'codex-issue-run-receipt-validation.json',
        outcome: 'codex-issue-run-outcome.json',
        summary: 'LIVE-HER-101-codex-issue-run-summary.md',
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
    });
    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs inside a detached ephemeral git worktree and cleans it up without creating a branch', async () => {
    const sourceRepoPath = await makeGitRepo();
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-issue-run-worktree-root-'));
    const markerPath = join(tempRoot, 'fake-server-cwd.json');
    const fakeServerPath = await makeFakeServer(`
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: process.cwd(), encoding: 'utf8' });
writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ cwd: process.cwd(), branch: branch.stdout.trim(), branchExit: branch.status }));
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_issue_run' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_issue_run' }, session: { id: 'session_issue_run' } } });
    send({ method: 'turn/completed', params: { thread: { id: 'thread_issue_run' }, turn: { id: 'turn_issue_run' } } });
  }
});
`);

    const outcome = await runCodexIssueRunInEphemeralGitWorktree({
      sourceRepoPath,
      tempRoot,
      receiptDir,
      issue: { identifier: 'HER-100', title: 'Ephemeral worktree run' },
      workflow: { run: 'fake' },
      promptTemplate: 'Issue {{issue.identifier}}: {{issue.title}}',
      runnerConfig: fakeRunnerConfig(fakeServerPath),
    });

    expect(outcome.status).toBe('pass');
    expect(outcome.workspace_lifecycle).toMatchObject({
      policy: 'ephemeral_git_worktree',
      base_ref: 'HEAD',
      source_repo_path: sourceRepoPath,
      persistent_branch_created: false,
      cleanup: { attempted: true, ok: true },
    });

    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { readonly cwd: string; readonly branch: string; readonly branchExit: number };
    expect(marker.cwd).toBe(outcome.workspace_lifecycle.worktree_path);
    expect(marker.branch).toBe('');
    expect(marker.branchExit).toBe(0);
    await expect(access(outcome.workspace_lifecycle.worktree_path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(git(sourceRepoPath, ['worktree', 'list', '--porcelain'])).resolves.not.toContain(outcome.workspace_lifecycle.worktree_path);
    await expect(git(sourceRepoPath, ['branch', '--list', 'symphony-codex-*'])).resolves.toBe('');

    const lifecycle = JSON.parse(await readFile(outcome.artifacts.workspace_lifecycle, 'utf8')) as typeof outcome.workspace_lifecycle;
    expect(lifecycle).toEqual(outcome.workspace_lifecycle);
    const persistedOutcome = JSON.parse(await readFile(outcome.artifacts.outcome, 'utf8')) as typeof outcome;
    expect(persistedOutcome.workspace_lifecycle).toEqual(outcome.workspace_lifecycle);

    const manifest = JSON.parse(await readFile(outcome.artifacts.manifest, 'utf8')) as {
      readonly artifacts: Readonly<Record<string, { readonly path: string; readonly sha256: string }>>;
    };
    expect(manifest.artifacts['workspace_lifecycle']?.sha256).toBe(await sha256File(outcome.artifacts.workspace_lifecycle));
    expect(manifest.artifacts['outcome']?.sha256).toBe(await sha256File(outcome.artifacts.outcome));
    expect(manifest.artifacts['summary']?.sha256).toBe(await sha256File(outcome.artifacts.summary));

    const summary = await readFile(outcome.artifacts.summary, 'utf8');
    expect(summary).toContain('- Workspace lifecycle: ephemeral_git_worktree');
    expect(summary).toContain('- Persistent branch created: false');
  });

  it('exports patch and status artifacts from the ephemeral worktree before cleanup', async () => {
    const sourceRepoPath = await makeGitRepo();
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const tempRoot = await mkdtemp(join(tmpdir(), 'symphony-issue-run-worktree-root-'));
    const fakeServerPath = await makeFakeServer(`
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
writeFileSync(join(process.cwd(), 'README.md'), 'fixture repo\\nmodified by fake issue run\\n', 'utf8');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_issue_run' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_issue_run' }, session: { id: 'session_issue_run' } } });
    send({ method: 'turn/completed', params: { thread: { id: 'thread_issue_run' }, turn: { id: 'turn_issue_run' } } });
  }
});
`);

    const outcome = await runCodexIssueRunInEphemeralGitWorktree({
      sourceRepoPath,
      tempRoot,
      receiptDir,
      issue: { identifier: 'HER-107', title: 'Export ephemeral patch' },
      workflow: { run: 'fake' },
      promptTemplate: 'Issue {{issue.identifier}}: {{issue.title}}',
      runnerConfig: fakeRunnerConfig(fakeServerPath),
    });

    expect(outcome.status).toBe('pass');
    expect(outcome.artifacts.workspace_patch).toBe(join(receiptDir, 'codex-issue-run-worktree.patch'));
    expect(outcome.artifacts.workspace_status).toBe(join(receiptDir, 'codex-issue-run-worktree-status.txt'));

    const patch = await readFile(outcome.artifacts.workspace_patch, 'utf8');
    expect(patch).toContain('diff --git a/README.md b/README.md');
    expect(patch).toContain('modified by fake issue run');

    const status = await readFile(outcome.artifacts.workspace_status, 'utf8');
    expect(status).toContain('M README.md');
    await expect(access(outcome.workspace_lifecycle.worktree_path)).rejects.toMatchObject({ code: 'ENOENT' });

    const persistedOutcome = JSON.parse(await readFile(outcome.artifacts.outcome, 'utf8')) as typeof outcome;
    expect(persistedOutcome.artifacts.workspace_patch).toBe(outcome.artifacts.workspace_patch);
    expect(persistedOutcome.artifacts.workspace_status).toBe(outcome.artifacts.workspace_status);

    const manifest = JSON.parse(await readFile(outcome.artifacts.manifest, 'utf8')) as {
      readonly artifacts: Readonly<Record<string, { readonly path: string; readonly sha256: string }>>;
    };
    expect(manifest.artifacts['workspace_patch']?.sha256).toBe(await sha256File(outcome.artifacts.workspace_patch));
    expect(manifest.artifacts['workspace_status']?.sha256).toBe(await sha256File(outcome.artifacts.workspace_status));
  });

  it('rejects missing exact issue identifiers before spawning codex.command', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-issue-run-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const spawnMarkerPath = join(workspacePath, 'spawned.txt');
    const fakeServerPath = await makeFakeServer(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`);

    await expect(runCodexIssueRun(fakeIssueRunInput({
      workspacePath,
      receiptDir,
      fakeServerPath,
      identifier: '',
    }))).rejects.toMatchObject({ code: 'missing_exact_issue_identifier' });

    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unapproved Linear tool exposure before spawning codex.command', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-issue-run-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const spawnMarkerPath = join(workspacePath, 'spawned.txt');
    const fakeServerPath = await makeFakeServer(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`);

    await expect(runCodexIssueRun(fakeIssueRunInput({
      workspacePath,
      receiptDir,
      fakeServerPath,
      title: 'Tool exposure',
      runnerConfig: fakeRunnerConfig(fakeServerPath, true),
    }))).rejects.toMatchObject({ code: 'unapproved_tool_enabled' });

    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unapproved auto-approval mode before spawning codex.command', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-issue-run-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const spawnMarkerPath = join(workspacePath, 'spawned.txt');
    const fakeServerPath = await makeFakeServer(`
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(spawnMarkerPath)}, 'spawned');
`);
    const runnerConfig: RunnerConfig = {
      ...fakeRunnerConfig(fakeServerPath),
      approval: { mode: 'auto_approve' },
    };

    await expect(runCodexIssueRun(fakeIssueRunInput({
      workspacePath,
      receiptDir,
      fakeServerPath,
      title: 'Auto approval',
      runnerConfig,
    }))).rejects.toMatchObject({ code: 'unapproved_approval_mode' });

    await expect(readFile(spawnMarkerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a fail-closed receipt packet when the app-server schema is missing required IDs', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-issue-run-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const fakeServerPath = await makeFakeServer(`
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  if (message.method === 'thread/start') send({ id: message.id, result: {} });
});
`);

    const outcome = await runCodexIssueRun(fakeIssueRunInput({ workspacePath, receiptDir, fakeServerPath }));

    expect(outcome.status).toBe('fail');
    expect(outcome.result).toMatchObject({
      outcome: 'fail',
      error: { code: 'response_error', message: 'thread/start did not return thread.id' },
    });

    const persistedOutcome = JSON.parse(await readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')) as typeof outcome;
    expect(persistedOutcome).toMatchObject({ status: 'fail', result: { outcome: 'fail' } });
  });

  it('marks the outcome failed when the app-server process limit is exceeded', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-issue-run-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const fakeServerPath = await makeFakeServer(successfulFakeServerScript());

    const outcome = await runCodexIssueRun(fakeIssueRunInput({
      workspacePath,
      receiptDir,
      fakeServerPath,
      maxAppServerProcesses: 0,
    }));

    expect(outcome.status).toBe('fail');
    expect(outcome.safety.app_server_spawn_count).toBe(1);
    expect(outcome.safety_findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'process_limit_exceeded' }),
    ]));
  });

  it('redacts synthetic secret-bearing runtime payloads before writing receipt artifacts', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-issue-run-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const rawBearer = ['abc1234567890', 'SECRET'].join('');
    const rawOpenAiKey = ['sk', 'testabcdefghijklmnop1234'].join('-');
    const rawSessionToken = ['sess', '1234567890abcdef'].join('_');
    const rawLinearToken = ['lin', 'api', '1234567890abcdef'].join('_');
    const fakeServerPath = await makeFakeServer(successfulFakeServerScript({
      method: 'agent/update',
      params: {
        thread: { id: 'thread_issue_run' },
        turn: { id: 'turn_issue_run' },
        message: `Authorization: Bearer ${rawBearer}`,
        openaiApiKey: rawOpenAiKey,
        nested: { sessionToken: rawSessionToken, linearToken: rawLinearToken },
      },
    }));

    const outcome = await runCodexIssueRun(fakeIssueRunInput({ workspacePath, receiptDir, fakeServerPath }));

    expect(outcome.status).toBe('pass');
    expect(outcome.validation).toEqual({ ok: true, findings: [] });
    const receiptsText = await readFile(join(receiptDir, 'codex-issue-run-redacted-receipts.json'), 'utf8');
    expect(receiptsText).not.toContain(rawBearer);
    expect(receiptsText).not.toContain(rawOpenAiKey);
    expect(receiptsText).not.toContain(rawSessionToken);
    expect(receiptsText).not.toContain(rawLinearToken);
    expect(receiptsText).toContain('[REDACTED]');
  });

  it('writes a local receipt packet for a bounded fake issue run', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-issue-run-workspace-'));
    const receiptDir = await mkdtemp(join(tmpdir(), 'symphony-issue-run-receipts-'));
    const fakeServerPath = await makeFakeServer(successfulFakeServerScript());

    const outcome = await runCodexIssueRun(fakeIssueRunInput({ workspacePath, receiptDir, fakeServerPath }));

    expect(outcome.status).toBe('pass');
    expect(outcome.safety).toMatchObject({
      exact_issue_identifier: 'HER-99',
      app_server_spawn_count: 1,
      max_app_server_processes_allowed: 1,
      linear_graphql_enabled: false,
      git_push_authorized: false,
      deploy_authorized: false,
      linear_mutation_authorized: false,
    });
    expect(outcome.safety_findings).toEqual([]);

    const receipts = JSON.parse(await readFile(join(receiptDir, 'codex-issue-run-redacted-receipts.json'), 'utf8')) as { readonly kind?: string; readonly method?: string }[];
    expect(receipts.map((receipt) => receipt.kind)).toEqual(expect.arrayContaining([
      'codex_app_server_spawn',
      'codex_protocol_request_response',
      'codex_runtime_event',
      'codex_issue_run_result',
    ]));
    expect(receipts.map((receipt) => receipt.method).filter((method) => method !== undefined)).toEqual(expect.arrayContaining([
      'initialize',
      'thread/start',
      'turn/start',
    ]));

    const persistedOutcome = JSON.parse(await readFile(join(receiptDir, 'codex-issue-run-outcome.json'), 'utf8')) as typeof outcome;
    expect(persistedOutcome).toMatchObject({ status: 'pass', result: { issue_identifier: 'HER-99' } });

    const manifest = JSON.parse(await readFile(join(receiptDir, 'artifact-manifest.json'), 'utf8')) as {
      readonly artifacts: Readonly<Record<string, { readonly path: string; readonly sha256: string }>>;
    };
    expect(manifest.artifacts['manifest']).toBeUndefined();
    for (const entry of Object.values(manifest.artifacts)) {
      expect(entry.sha256).toBe(await sha256File(entry.path));
    }

    const validation = JSON.parse(await readFile(join(receiptDir, 'codex-issue-run-receipt-validation.json'), 'utf8')) as { readonly ok: boolean; readonly findings: unknown[] };
    expect(validation).toEqual({ ok: true, findings: [] });

    const summary = await readFile(join(receiptDir, 'LIVE-HER-99-codex-issue-run-summary.md'), 'utf8');
    expect(summary).toContain('- Outcome: pass');
    expect(summary).toContain('- Exact issue identifier: HER-99');
  });
});
