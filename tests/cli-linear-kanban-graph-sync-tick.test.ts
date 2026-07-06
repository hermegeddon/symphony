import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSymphonyLinearKanbanGraphSyncTickCli, type LinearKanbanGraphSyncTickCliOptions } from '../src/cli/linear-kanban-graph-sync-tick.js';

async function writeWorkflow(root: string): Promise<string> {
  const workflowPath = join(root, 'WORKFLOW.md');
  await writeFile(
    workflowPath,
    `---\nbackend:\n  kind: hermes_kanban\ntracker:\n  kind: linear\n  api_key: $LINEAR_API_KEY\n  team_key: HER\nkanban:\n  hermes_command: /safe/bin/hermes\n  hermes_home: ./hermes-home\n  board: testflight\n  artifact_root: ${JSON.stringify(join(root, 'kanban-artifacts'))}\n  workspace:\n    kind: worktree\n    root: ${JSON.stringify(join(root, 'worktrees'))}\ngraph_sync:\n  enabled: true\n  mode: read_only_diff\n  artifact_root: ./artifacts\n  state_path: ./state.json\n---\nTick workflow\n`,
    'utf8',
  );
  return workflowPath;
}

interface CaptureStdio {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly getStdout: () => string;
  readonly getStderr: () => string;
}

function captureStdio(): CaptureStdio {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    getStdout: () => stdout.join(''),
    getStderr: () => stderr.join(''),
  };
}

function buildOptions(stdout: string[], stderr: string[]): LinearKanbanGraphSyncTickCliOptions {
  const pushStdout = (chunk: string): void => {
    stdout.push(chunk);
  };
  const pushStderr = (chunk: string): void => {
    stderr.push(chunk);
  };
  return {
    stdout: pushStdout,
    stderr: pushStderr,
  };
}

describe('symphony-linear-kanban-graph-sync-tick CLI', () => {
  it('shows help and exits 0', async () => {
    const stdio = captureStdio();
    const exitCode = await runSymphonyLinearKanbanGraphSyncTickCli(['--help'], buildOptions(stdio.stdout, stdio.stderr));
    expect(exitCode).toBe(0);
    expect(stdio.getStdout()).toContain('symphony-linear-kanban-graph-sync-tick');
    expect(stdio.getStdout()).toContain('--mode fake_local_readonly');
    expect(stdio.getStderr()).toBe('');
  });

  it('rejects an unsupported mode', async () => {
    const stdio = captureStdio();
    const exitCode = await runSymphonyLinearKanbanGraphSyncTickCli(['--mode', 'read_only_snapshot'], buildOptions(stdio.stdout, stdio.stderr));
    expect(exitCode).toBe(1);
    expect(stdio.getStderr()).toContain('fake_local_readonly');
  });

  it('exits 0 in fake_local_readonly mode, writes artifacts, and reports mutation non-actions false', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-tick-cli-'));
    const workflowPath = await writeWorkflow(root);
    const artifactRoot = join(root, 'tick-artifacts');

    const stdio = captureStdio();
    const exitCode = await runSymphonyLinearKanbanGraphSyncTickCli(
      [
        '--mode', 'fake_local_readonly',
        '--workflow', workflowPath,
        '--artifact-root', artifactRoot,
      ],
      {
        ...buildOptions(stdio.stdout, stdio.stderr),
        processEnv: { PATH: '/safe/bin' },
        lifecycleTickFactory: () => () => Promise.resolve({
          ok: true,
          effect: 'linear_kanban_bridge_tick',
          workflow_id: 'workflow-1',
          board: 'linear',
          artifact_root: artifactRoot,
          dispatch_policy: 'no_worker',
          candidates: 0,
          materialized: [],
          skipped: [],
          completed: [],
          provenance_warnings: [],
        }),
        graphSyncSnapshotFactory: () => () => Promise.resolve({
          ok: true,
          effect: 'graph_sync_read_only_snapshot_capture',
          status: 'PASS',
          workflow_id: 'fake',
          run_id: 'fake-run',
          generated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          mode: 'read_only_snapshot',
          suppressed_writes: true,
          snapshot: {
            runId: 'fake-run',
            scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
            completeness: {
              linear_issues: 'complete',
              linear_relations: 'complete',
              linear_inverse_relations: 'complete',
              dependency_closure: 'complete',
              kanban_tasks: 'complete',
              kanban_links: 'complete',
              max_nodes_reached: false,
              max_depth_reached: false,
              max_pages_reached: false,
              inaccessible_or_deleted_endpoint_count: 0,
              archived_endpoint_count: 0,
              reader_errors: [],
              rate_limited: false,
              apply_eligible: true,
            },
            issues: [],
            kanbanTasks: [],
            nodeMappings: [],
            non_actions: ['did_not_create_update_delete_linear_relations'],
          },
          receipt: {
            ok: true,
            effect: 'graph_sync_read_only_diff',
            workflow_id: 'fake',
            run_id: 'fake-run',
            generated_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            mode: 'read_only_diff',
            suppressed_writes: true,
            ledger: {
              version: 1,
              generated_by: 'symphony-linear-kanban-bridge',
              workflow_id: 'fake',
              generated_at: new Date().toISOString(),
              scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
              nodes: {},
              edges: {},
              conflicts: {},
              semantic_events: {},
              runs: [],
            },
            diff: { matched_edges: [], missing_kanban_edges: [], missing_linear_relations: [], endpoint_policies: [], cycles: [] },
            summary: {
              linear_edges_seen: 0,
              kanban_edges_seen: 0,
              matched_edges: 0,
              missing_kanban_edges: 0,
              missing_linear_relations: 0,
              endpoint_policies: 0,
              cycles_detected: 0,
              conflicts: 0,
              semantic_events: 0,
            },
            proposed_operations: [],
            non_actions: [],
          },
          summary: {
            linear_issues_read: 0,
            kanban_tasks_read: 0,
            mappings_resolved: 0,
            linear_edges_seen: 0,
            kanban_edges_seen: 0,
            matched_edges: 0,
            missing_kanban_edges: 0,
            missing_linear_relations: 0,
            endpoint_policies: 0,
            cycles_detected: 0,
            proposed_operations: 0,
          },
          non_actions: [],
        } as unknown as import('../src/graph-sync-live-snapshot.js').CaptureGraphSyncReadOnlySnapshotResult),
      },
    );

    try {
      if (exitCode !== 0 || stdio.getStderr() !== '') {
        console.error('CLI debug:', { exitCode, stdout: stdio.getStdout(), stderr: stdio.getStderr() });
      }

      expect(exitCode).toBe(0);
      expect(stdio.getStderr()).toBe('');

      const artifact = JSON.parse(stdio.getStdout()) as {
        readonly ok: boolean;
        readonly status: string;
        readonly effect: string;
        readonly receipt_path: string;
        readonly status_path: string;
        readonly summary_path: string;
        readonly lifecycle_mutations_attempted: boolean;
        readonly kanban_mutations_attempted: boolean;
        readonly linear_mutations_attempted: boolean;
        readonly dispatch_reliance_attempted: boolean;
        readonly dispatch_reliance_suppressed: boolean;
        readonly dispatch_reliance_decision: string;
        readonly non_actions: readonly string[];
      };

      expect(artifact.ok).toBe(true);
      expect(artifact.status).toBe('PASS');
      expect(artifact.effect).toBe('linear_kanban_graph_sync_tick_cli');
      expect(artifact.lifecycle_mutations_attempted).toBe(false);
      expect(artifact.kanban_mutations_attempted).toBe(false);
      expect(artifact.linear_mutations_attempted).toBe(false);
      expect(artifact.dispatch_reliance_attempted).toBe(true);
      expect(artifact.dispatch_reliance_suppressed).toBe(false);
      expect(artifact.dispatch_reliance_decision).toBe('allowed');
      expect(artifact.non_actions).toContain('did_not_edit_restart_or_disable_services_or_timers');
      expect(artifact.non_actions).toContain('did_not_dispatch_workers_or_gateway');
      expect(artifact.non_actions).toContain('did_not_push_publish_deploy_or_open_pr');

      expect(artifact.receipt_path).toContain(artifactRoot);
      expect(artifact.status_path).toContain(artifactRoot);
      expect(artifact.summary_path).toContain(artifactRoot);

      const fullReceipt = JSON.parse(await readFile(artifact.receipt_path, 'utf8')) as {
        readonly ok: boolean;
        readonly effect: string;
        readonly status: string;
        readonly workflow_id: string;
        readonly run_id: string;
        readonly lock_receipt: { readonly acquired: boolean } | null;
        readonly state_read: { readonly generation: number; readonly receipt_fresh: boolean } | null;
        readonly state_write: { readonly previous_generation: number; readonly next_generation: number } | null;
      };
      expect(fullReceipt.ok).toBe(true);
      expect(fullReceipt.effect).toBe('linear_kanban_graph_sync_recurring_canary');
      expect(fullReceipt.status).toBe('PASS');
      expect(fullReceipt.workflow_id).toContain('symphony-linear-kanban-graph-sync-tick');
      expect(fullReceipt.lock_receipt?.acquired).toBe(true);
      expect(fullReceipt.state_read?.generation).toBe(0);
      expect(fullReceipt.state_read?.receipt_fresh).toBe(false);
      expect(fullReceipt.state_write?.previous_generation).toBe(0);
      expect(fullReceipt.state_write?.next_generation).toBe(1);

      const status = JSON.parse(await readFile(artifact.status_path, 'utf8')) as {
        readonly ok: boolean;
        readonly effect: string;
        readonly status: string;
        readonly dispatch_reliance_suppressed: boolean;
        readonly dependency_readiness_state: string;
      };
      expect(status.ok).toBe(true);
      expect(status.effect).toBe('linear_kanban_graph_sync_recurring_canary_status');
      expect(status.status).toBe('PASS');
      expect(status.dispatch_reliance_suppressed).toBe(false);
      expect(status.dependency_readiness_state).toBe('fresh_and_clean');

      const summary = await readFile(artifact.summary_path, 'utf8');
      expect(summary).toContain('Operator status: `PASS`');
      expect(summary).toContain('No worker/gateway dispatch was performed.');

      // Ensure fake/local output stays redacted and bounded: no raw tokens in stdout or artifacts
      const allOutput = stdio.getStdout() + stdio.getStderr() + JSON.stringify(fullReceipt) + summary;
      expect(allOutput).not.toMatch(/lin_api_[A-Za-z0-9_-]+/);
      expect(allOutput).not.toMatch(/sk-[A-Za-z0-9_-]+/);
      expect(allOutput).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/=-]+/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exits 2 when dependency readiness is deferred (REVIEW)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-tick-cli-'));
    const workflowPath = await writeWorkflow(root);
    const artifactRoot = join(root, 'tick-artifacts');

    const stdio = captureStdio();
    const exitCode = await runSymphonyLinearKanbanGraphSyncTickCli(
      ['--mode', 'fake_local_readonly', '--workflow', workflowPath, '--artifact-root', artifactRoot],
      {
        ...buildOptions(stdio.stdout, stdio.stderr),
        processEnv: { PATH: '/safe/bin' },
        graphSyncSnapshotFactory: () => () => Promise.resolve({
          ok: true,
          effect: 'graph_sync_read_only_snapshot_capture',
          status: 'REVIEW',
          workflow_id: 'fake',
          run_id: 'fake-run',
          generated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          mode: 'read_only_snapshot',
          suppressed_writes: true,
          snapshot: {
            runId: 'fake-run',
            scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
            completeness: {
              linear_issues: 'complete',
              linear_relations: 'complete',
              linear_inverse_relations: 'complete',
              dependency_closure: 'complete',
              kanban_tasks: 'complete',
              kanban_links: 'complete',
              max_nodes_reached: false,
              max_depth_reached: false,
              max_pages_reached: false,
              inaccessible_or_deleted_endpoint_count: 0,
              archived_endpoint_count: 0,
              reader_errors: [],
              rate_limited: false,
              apply_eligible: true,
            },
            issues: [],
            kanbanTasks: [],
            nodeMappings: [],
            non_actions: ['did_not_create_update_delete_linear_relations'],
          },
          receipt: {
            ok: true,
            effect: 'graph_sync_read_only_diff',
            workflow_id: 'fake',
            run_id: 'fake-run',
            generated_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            mode: 'read_only_diff',
            suppressed_writes: true,
            ledger: {
              version: 1,
              generated_by: 'symphony-linear-kanban-bridge',
              workflow_id: 'fake',
              generated_at: new Date().toISOString(),
              scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
              nodes: {},
              edges: {},
              conflicts: {},
              semantic_events: {},
              runs: [],
            },
            diff: { matched_edges: [], missing_kanban_edges: [], missing_linear_relations: [], endpoint_policies: [], cycles: [] },
            summary: {
              linear_edges_seen: 0,
              kanban_edges_seen: 0,
              matched_edges: 0,
              missing_kanban_edges: 0,
              missing_linear_relations: 0,
              endpoint_policies: 0,
              cycles_detected: 0,
              conflicts: 0,
              semantic_events: 0,
            },
            proposed_operations: [],
            non_actions: [],
          },
          summary: {
            linear_issues_read: 0,
            kanban_tasks_read: 0,
            mappings_resolved: 0,
            linear_edges_seen: 0,
            kanban_edges_seen: 0,
            matched_edges: 0,
            missing_kanban_edges: 0,
            missing_linear_relations: 0,
            endpoint_policies: 0,
            cycles_detected: 0,
            proposed_operations: 0,
          },
          non_actions: [],
        } as unknown as import('../src/graph-sync-live-snapshot.js').CaptureGraphSyncReadOnlySnapshotResult),
      },
    );

    try {
      expect(exitCode).toBe(2);
      const artifact = JSON.parse(stdio.getStdout()) as { readonly ok: boolean; readonly status: string; readonly dispatch_reliance_suppressed: boolean };
      expect(artifact.ok).toBe(true);
      expect(artifact.status).toBe('REVIEW');
      expect(artifact.dispatch_reliance_suppressed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exits 3 when dependency readiness is blocked (BLOCK)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-tick-cli-'));
    const workflowPath = await writeWorkflow(root);
    const artifactRoot = join(root, 'tick-artifacts');

    const stdio = captureStdio();
    const exitCode = await runSymphonyLinearKanbanGraphSyncTickCli(
      ['--mode', 'fake_local_readonly', '--workflow', workflowPath, '--artifact-root', artifactRoot],
      {
        ...buildOptions(stdio.stdout, stdio.stderr),
        processEnv: { PATH: '/safe/bin' },
        graphSyncSnapshotFactory: () => () => Promise.resolve({
          ok: false,
          effect: 'graph_sync_read_only_snapshot_capture',
          error: 'blocked by test',
          non_actions: ['did_not_create_update_delete_linear_relations'],
        } as unknown as import('../src/graph-sync-live-snapshot.js').CaptureGraphSyncReadOnlySnapshotResult),
      },
    );

    try {
      expect(exitCode).toBe(3);
      const artifact = JSON.parse(stdio.getStdout()) as { readonly ok: boolean; readonly status: string; readonly dispatch_reliance_suppressed: boolean };
      expect(artifact.ok).toBe(true);
      expect(artifact.status).toBe('BLOCK');
      expect(artifact.dispatch_reliance_suppressed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
