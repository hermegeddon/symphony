import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { runSymphonyServiceCli, startSymphonyServiceCli } from '../src/cli/service.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout;
}

async function makeGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'symphony-cli-service-source-repo-'));
  await git(repo, ['init']);
  await writeFile(join(repo, 'README.md'), 'fixture repo\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['-c', 'user.name=Symphony Test', '-c', 'user.email=symphony@example.test', 'commit', '-m', 'initial']);
  return repo;
}

describe('symphony-service CLI', () => {
  it('prints help documenting positional workflow path and safe default behavior', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyServiceCli(['--help'], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const help = stdout.join('');
    expect(help).toContain('Usage: symphony-service [WORKFLOW.md] [--workflow WORKFLOW.md]');
    expect(help).toContain('defaults to ./WORKFLOW.md');
    expect(help).toContain('without querying Linear, starting Codex, creating workspaces, or writing receipts');
  });

  it('starts a long-running demo service with fake dependencies until stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: fake-token\n  project_slug: FAKE\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 60000\n---\nDemo prompt for {{ issue.identifier }}\n`, 'utf8');
    const logs: string[] = [];

    const runtime = await startSymphonyServiceCli(['--demo', '--workflow', workflowPath], {
      log: (line) => logs.push(line),
    });

    try {
      await runtime.service.orchestrator.drain();
      const logText = logs.join('\n');
      expect(runtime.mode).toBe('demo');
      expect(runtime.workflowPath).toBe(workflowPath);
      expect(runtime.stopped).toBe(false);
      expect(logText).toContain('event=startup outcome=completed');
      expect(logText).toContain('event=fake_agent_run outcome=started issue_id=fake-issue-1 issue_identifier=FAKE-1');
      expect(runtime.service.orchestrator.snapshot().completed).toContain('fake-issue-1');
    } finally {
      await runtime.stop('test');
    }

    expect(runtime.stopped).toBe(true);
  });

  it('accepts a positional workflow path as an alias for --workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-positional-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: fake-token\n  project_slug: FAKE\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 60000\n---\nDemo prompt for {{ issue.identifier }}\n`, 'utf8');
    const logs: string[] = [];

    const runtime = await startSymphonyServiceCli(['--demo', workflowPath], {
      log: (line) => logs.push(line),
    });

    try {
      await runtime.service.orchestrator.drain();
      expect(runtime.mode).toBe('demo');
      expect(runtime.workflowPath).toBe(workflowPath);
      expect(logs.join('\n')).toContain(`workflow_path=${workflowPath}`);
      expect(runtime.service.orchestrator.snapshot().completed).toContain('fake-issue-1');
    } finally {
      await runtime.stop('test');
    }
  });

  it('rejects conflicting positional and --workflow paths before startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-conflict-'));
    const firstWorkflowPath = join(root, 'FIRST-WORKFLOW.md');
    const secondWorkflowPath = join(root, 'SECOND-WORKFLOW.md');
    await writeFile(firstWorkflowPath, `---\ntracker:\n  kind: linear\n  api_key: fake-token\n  project_slug: FAKE\ncodex:\n  command: fake-codex\n---\nFirst\n`, 'utf8');
    await writeFile(secondWorkflowPath, `---\ntracker:\n  kind: linear\n  api_key: fake-token\n  project_slug: FAKE\ncodex:\n  command: fake-codex\n---\nSecond\n`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyServiceCli(['--demo-idle', '--workflow', firstWorkflowPath, secondWorkflowPath], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('event=service_cli outcome=failed');
    expect(stderr.join('')).toContain('Conflicting workflow paths');
  });

  it('rejects duplicate workflow path arguments before startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-duplicate-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: fake-token\n  project_slug: FAKE\ncodex:\n  command: fake-codex\n---\nDuplicate\n`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyServiceCli(['--demo-idle', workflowPath, workflowPath], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('event=service_cli outcome=failed');
    expect(stderr.join('')).toContain('Multiple workflow paths specified');
  });

  it('reports nonexistent positional workflow path as a startup failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-missing-positional-'));
    const missingWorkflowPath = join(root, 'MISSING-WORKFLOW.md');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyServiceCli(['--demo-idle', missingWorkflowPath], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('event=service_cli outcome=failed');
    expect(stderr.join('')).toContain('Unable to read workflow file');
  });

  it('starts a long-running idle demo service without dispatching fake work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-idle-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: fake-token\n  project_slug: FAKE\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 60000\n---\nIdle demo prompt\n`, 'utf8');
    const logs: string[] = [];

    const runtime = await startSymphonyServiceCli(['--demo-idle', '--workflow', workflowPath], {
      log: (line) => logs.push(line),
    });

    try {
      await runtime.service.orchestrator.drain();
      const logText = logs.join('\n');
      expect(runtime.mode).toBe('demo-idle');
      expect(runtime.workflowPath).toBe(workflowPath);
      expect(runtime.stopped).toBe(false);
      expect(logText).toContain('event=startup outcome=completed');
      expect(logText).not.toContain('event=fake_agent_run');
      expect(runtime.service.orchestrator.snapshot().completed).toEqual([]);
    } finally {
      await runtime.stop('test');
    }

    expect(runtime.stopped).toBe(true);
  });

  it('prints a live workflow confirmation packet without starting the service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-confirm-'));
    const workflowPath = join(root, 'LIVE-WORKFLOW.md');
    const workspaceRoot = join(root, 'workspaces');
    const markerPath = join(root, 'should-not-exist.txt');
    const bearerProbe = ['Authorization:', 'Bearer', 'placeholder-redaction-probe-123456'].join(' ');
    const codexCommand = `codex app-server --marker ${JSON.stringify(markerPath)} --header ${JSON.stringify(bearerProbe)}`;
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-linear-token\n  project_slug: HER\n  require_canary: true\n  canary_issue_identifier: TEST-123\nworkspace:\n  root: ${JSON.stringify(workspaceRoot)}\ncodex:\n  command: ${JSON.stringify(codexCommand)}\n  approval_policy: fail\n  thread_sandbox: workspace-write\n  turn_sandbox_policy: workspace_write\n  read_timeout_ms: 30000\n  turn_timeout_ms: 300000\npolling:\n  interval_ms: 60000\nagent:\n  max_concurrent_agents: 1\n  max_turns: 3\n---\nLive service prompt\n`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyServiceCli(['--print-confirmation', '--workflow', workflowPath], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const packet = JSON.parse(stdout.join('')) as {
      readonly effect: string;
      readonly workflow: { readonly path: string };
      readonly tracker: {
        readonly kind: string | null;
        readonly project_slug: string | null;
        readonly team_key: string | null;
        readonly api_key_present: boolean;
        readonly require_canary: boolean;
        readonly canary_issue_identifier: string | null;
      };
      readonly workspace: { readonly root: string };
      readonly codex: {
        readonly command_preview: string;
        readonly live_command_detected: boolean;
        readonly approval_policy: string | null;
        readonly sandbox_mode: string | null;
        readonly read_timeout_ms: number;
        readonly turn_timeout_ms: number;
      };
      readonly service: { readonly mode: string; readonly max_concurrent_agents: number; readonly success_continuation_delay_ms: number };
      readonly operator_confirmation: { readonly confirmation_digest: string; readonly live_command_default_blocked: boolean };
      readonly non_actions: {
        readonly service_started: boolean;
        readonly linear_queries_sent: boolean;
        readonly codex_started: boolean;
        readonly fake_dependencies_used: boolean;
      };
    };
    expect(packet.effect).toBe('print_only');
    expect(packet.workflow.path).toBe(workflowPath);
    expect(packet.tracker).toMatchObject({
      kind: 'linear',
      project_slug: 'HER',
      team_key: null,
      api_key_present: true,
      require_canary: true,
      canary_issue_identifier: 'TEST-123',
    });
    expect(packet.workspace.root).toBe(workspaceRoot);
    expect(packet.codex).toMatchObject({
      live_command_detected: true,
      approval_policy: 'fail',
      sandbox_mode: 'workspace_write',
      read_timeout_ms: 30000,
      turn_timeout_ms: 300000,
    });
    expect(packet.codex.command_preview).not.toContain('test-linear-token');
    expect(packet.codex.command_preview).not.toContain('placeholder-redaction-probe-123456');
    expect(packet.codex.command_preview).toContain('[REDACTED]');
    expect(packet.service).toMatchObject({ mode: 'workflow', max_concurrent_agents: 1, success_continuation_delay_ms: 1000 });
    expect(packet.operator_confirmation.confirmation_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(packet.operator_confirmation.live_command_default_blocked).toBe(true);
    expect(packet.non_actions).toMatchObject({
      service_started: false,
      linear_queries_sent: false,
      codex_started: false,
      fake_dependencies_used: false,
    });
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds confirmation digest to the full redacted command beyond the displayed preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-digest-'));
    const workflowPath = join(root, 'LIVE-WORKFLOW.md');
    const workspaceRoot = join(root, 'workspaces');
    const commonCommandPrefix = `codex app-server ${'x'.repeat(320)}`;
    const printPacket = async (command: string): Promise<{
      readonly codex: { readonly command_preview: string };
      readonly operator_confirmation: { readonly confirmation_digest: string };
    }> => {
      await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-linear-token\n  project_slug: HER\n  require_canary: true\n  canary_issue_identifier: HER-128\nworkspace:\n  root: ${JSON.stringify(workspaceRoot)}\ncodex:\n  command: ${JSON.stringify(command)}\n  approval_policy: fail\n  thread_sandbox: workspace-write\n  turn_sandbox_policy: workspace_write\n  read_timeout_ms: 30000\n  turn_timeout_ms: 300000\npolling:\n  interval_ms: 60000\nagent:\n  max_concurrent_agents: 1\n  max_turns: 3\n---\nLive service prompt\n`, 'utf8');
      const stdout: string[] = [];
      const exitCode = await runSymphonyServiceCli(['--print-confirmation', '--workflow', workflowPath], {
        stdout: (chunk) => stdout.push(chunk),
        stderr: () => undefined,
      });
      expect(exitCode).toBe(0);
      return JSON.parse(stdout.join('')) as {
        readonly codex: { readonly command_preview: string };
        readonly operator_confirmation: { readonly confirmation_digest: string };
      };
    };

    const first = await printPacket(`${commonCommandPrefix} --variant first`);
    const second = await printPacket(`${commonCommandPrefix} --variant second`);

    expect(first.codex.command_preview).toBe(second.codex.command_preview);
    expect(first.operator_confirmation.confirmation_digest).not.toBe(second.operator_confirmation.confirmation_digest);
  });

  it('reports check failure for a live Codex command without the digest-bound override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-check-'));
    const workflowPath = join(root, 'LIVE-WORKFLOW.md');
    const workspaceRoot = join(root, 'workspaces');
    const markerPath = join(root, 'should-not-exist.txt');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-linear-token\n  project_slug: HER\n  require_canary: true\n  canary_issue_identifier: HER-124\nworkspace:\n  root: ${JSON.stringify(workspaceRoot)}\ncodex:\n  command: codex app-server --marker ${JSON.stringify(markerPath)}\n  approval_policy: fail\n  thread_sandbox: workspace-write\n  turn_sandbox_policy: workspace_write\n  read_timeout_ms: 30000\n  turn_timeout_ms: 300000\npolling:\n  interval_ms: 60000\nagent:\n  max_concurrent_agents: 1\n  max_turns: 3\n---\nLive service prompt\n`, 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyServiceCli(['--check', '--workflow', workflowPath], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as {
      readonly effect: string;
      readonly ok: boolean;
      readonly checks: {
        readonly dispatch_preflight_ok: boolean;
        readonly require_canary: boolean;
        readonly exact_canary_selector: boolean;
        readonly tracker_scope_configured: boolean;
        readonly approval_policy_fail_closed: boolean;
        readonly sandbox_explicit: boolean;
        readonly live_timeout_values: boolean;
        readonly max_concurrent_agents_one: boolean;
        readonly success_continuation_safe: boolean;
        readonly success_continuation_delay_ms: number;
        readonly live_codex_or_openai: boolean;
        readonly live_command_override: boolean;
        readonly confirmation_digest_matches: boolean;
        readonly service_would_start: boolean;
        readonly linear_queries_would_send: boolean;
        readonly codex_would_spawn: boolean;
        readonly fake_dependencies_used: boolean;
      };
    };
    expect(check.effect).toBe('check_only');
    expect(check.ok).toBe(false);
    expect(check.checks).toMatchObject({
      dispatch_preflight_ok: true,
      require_canary: true,
      exact_canary_selector: true,
      tracker_scope_configured: true,
      approval_policy_fail_closed: true,
      sandbox_explicit: true,
      live_timeout_values: true,
      max_concurrent_agents_one: true,
      success_continuation_safe: false,
      success_continuation_delay_ms: 1000,
      live_codex_or_openai: true,
      live_command_override: false,
      confirmation_digest_matches: false,
      service_would_start: false,
      linear_queries_would_send: false,
      codex_would_spawn: false,
      fake_dependencies_used: false,
    });
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('passes digest-bound live-readiness check with a real git worktree source without creating workspaces', async () => {
    const sourceRepoPath = await makeGitRepo();
    const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-check-pass-'));
    const workflowPath = join(root, 'LIVE-WORKFLOW.md');
    const workspaceRoot = join(root, 'workspaces');
    const markerPath = join(root, 'should-not-exist.txt');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-linear-token\n  project_slug: HER\n  require_canary: true\n  canary_issue_identifier: HER-126\nworkspace:\n  root: ${JSON.stringify(workspaceRoot)}\n  source:\n    kind: git_worktree\n    repo: ${JSON.stringify(sourceRepoPath)}\n    base_ref: HEAD\ncodex:\n  command: codex app-server --marker ${JSON.stringify(markerPath)}\n  approval_policy: fail\n  thread_sandbox: workspace-write\n  turn_sandbox_policy: workspace_write\n  read_timeout_ms: 30000\n  turn_timeout_ms: 300000\npolling:\n  interval_ms: 60000\nagent:\n  max_concurrent_agents: 1\n  max_turns: 3\n  success_continuation_delay_ms: 0\n---\nLive service prompt\n`, 'utf8');
    const confirmationStdout: string[] = [];

    const confirmationExitCode = await runSymphonyServiceCli(['--print-confirmation', '--workflow', workflowPath], {
      stdout: (chunk) => confirmationStdout.push(chunk),
      stderr: () => undefined,
    });

    expect(confirmationExitCode).toBe(0);
    const confirmation = JSON.parse(confirmationStdout.join('')) as { readonly operator_confirmation: { readonly confirmation_digest: string } };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runSymphonyServiceCli([
      '--check',
      '--workflow', workflowPath,
      '--allow-live-codex-openai-command',
      '--confirmation-digest', confirmation.operator_confirmation.confirmation_digest,
    ], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const check = JSON.parse(stdout.join('')) as {
      readonly effect: string;
      readonly ok: boolean;
      readonly checks: {
        readonly workspace_git_worktree_source: boolean;
        readonly source_repo_git: boolean;
        readonly source_repo_clean: boolean;
        readonly source_base_ref_resolves: boolean;
        readonly success_continuation_safe: boolean;
        readonly success_continuation_delay_ms: number;
        readonly live_command_override: boolean;
        readonly confirmation_digest_matches: boolean;
      };
    };
    expect(check.effect).toBe('check_only');
    expect(check.ok).toBe(true);
    expect(check.checks).toMatchObject({
      workspace_git_worktree_source: true,
      source_repo_git: true,
      source_repo_clean: true,
      source_base_ref_resolves: true,
      success_continuation_safe: true,
      success_continuation_delay_ms: 0,
      live_command_override: true,
      confirmation_digest_matches: true,
    });
    await expect(access(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('direct start helper refuses live service execution before querying Linear when the digest gate is missing', async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"errors":[{"message":"should not be called"}]}');
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const port = (server.address() as AddressInfo).port;

    try {
      const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-direct-gate-'));
      const workflowPath = join(root, 'LIVE-WORKFLOW.md');
      const workspaceRoot = join(root, 'workspaces');
      const markerPath = join(root, 'should-not-exist.txt');
      await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  endpoint: http://127.0.0.1:${String(port)}/graphql\n  api_key: test-linear-token\n  project_slug: HER\n  require_canary: true\n  canary_issue_identifier: HER-127\nworkspace:\n  root: ${JSON.stringify(workspaceRoot)}\ncodex:\n  command: codex app-server --marker ${JSON.stringify(markerPath)}\n  approval_policy: fail\n  thread_sandbox: workspace-write\n  turn_sandbox_policy: workspace_write\n  read_timeout_ms: 30000\n  turn_timeout_ms: 300000\npolling:\n  interval_ms: 60000\nagent:\n  max_concurrent_agents: 1\n  max_turns: 3\n---\nLive service prompt\n`, 'utf8');

      await expect(startSymphonyServiceCli(['--workflow', workflowPath], { log: () => undefined })).rejects.toThrow(
        /live Codex\/OpenAI command requires/,
      );
      expect(requestCount).toBe(0);
      await expect(access(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => {
        if (error === undefined) {
          resolvePromise();
          return;
        }
        reject(error);
      }));
    }
  });

  it('refuses live service execution without querying Linear when the digest gate is missing', async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"errors":[{"message":"should not be called"}]}');
    });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const port = (server.address() as AddressInfo).port;

    try {
      const root = await mkdtemp(join(tmpdir(), 'symphony-cli-service-exec-gate-'));
      const workflowPath = join(root, 'LIVE-WORKFLOW.md');
      const markerPath = join(root, 'should-not-exist.txt');
      await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  endpoint: http://127.0.0.1:${String(port)}/graphql\n  api_key: test-linear-token\n  project_slug: HER\n  require_canary: true\n  canary_issue_identifier: HER-125\nworkspace:\n  root: ${JSON.stringify(join(root, 'workspaces'))}\ncodex:\n  command: codex app-server --marker ${JSON.stringify(markerPath)}\n  approval_policy: fail\n  thread_sandbox: workspace-write\n  turn_sandbox_policy: workspace_write\n  read_timeout_ms: 30000\n  turn_timeout_ms: 300000\npolling:\n  interval_ms: 60000\nagent:\n  max_concurrent_agents: 1\n  max_turns: 3\n---\nLive service prompt\n`, 'utf8');
      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await runSymphonyServiceCli(['--workflow', workflowPath], {
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
      });

      expect(exitCode).toBe(1);
      expect(stderr).toEqual([]);
      const check = JSON.parse(stdout.join('')) as { readonly effect: string; readonly ok: boolean; readonly checks: { readonly live_codex_or_openai: boolean; readonly live_command_override: boolean } };
      expect(check.effect).toBe('check_only');
      expect(check.ok).toBe(false);
      expect(check.checks).toMatchObject({ live_codex_or_openai: true, live_command_override: false });
      expect(requestCount).toBe(0);
      await expect(readFile(markerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => {
        if (error === undefined) {
          resolvePromise();
          return;
        }
        reject(error);
      }));
    }
  });
});
