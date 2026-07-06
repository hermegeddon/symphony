import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSymphonyGraphSyncStatusCli } from '../src/cli/graph-sync-status.js';

async function writeLastRun(serviceRoot: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(serviceRoot, 'last-run.json'),
    `${JSON.stringify({
      ok: true,
      effect: 'recurring_graphsync_readonly_snapshot_wrapper_run',
      mode: 'read_only_snapshot',
      status: 'PASS',
      cli_exit_code: 0,
      completed_at: '2026-07-04T02:35:00Z',
      service_root: serviceRoot,
      run_dir: join(serviceRoot, 'runs', '20260704T023500Z-123'),
      suppressed_writes: true,
      summary: {
        linear_issues_read: 15,
        kanban_tasks_read: 15,
        mappings_resolved: 15,
        linear_edges_seen: 0,
        kanban_edges_seen: 0,
        matched_edges: 0,
        missing_kanban_edges: 0,
        missing_linear_relations: 0,
        endpoint_policies: 0,
        cycles_detected: 0,
        proposed_operations: 0,
      },
      non_actions: ['did_not_dispatch_workers_or_gateway'],
      ...overrides,
    }, null, 2)}\n`,
    'utf8',
  );
}

describe('symphony-graph-sync-status CLI', () => {
  it('prints the latest recurring GraphSync status from a service root', async () => {
    const serviceRoot = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-status-cli-'));
    await writeLastRun(serviceRoot);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyGraphSyncStatusCli(
      ['--service-root', serviceRoot, '--max-age-ms', '300000'],
      {
        now: new Date('2026-07-04T02:36:00Z'),
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.join('')).toBe('');
    const artifact = JSON.parse(stdout.join('')) as {
      readonly ok: boolean;
      readonly status: string;
      readonly last_run: { readonly stale: boolean; readonly age_ms: number };
      readonly summary: { readonly mappings_resolved: number };
    };
    expect(artifact.ok).toBe(true);
    expect(artifact.status).toBe('PASS');
    expect(artifact.last_run.stale).toBe(false);
    expect(artifact.last_run.age_ms).toBe(60000);
    expect(artifact.summary.mappings_resolved).toBe(15);
  });

  it('uses a fifteen-minute stale threshold by default for timer jitter', async () => {
    const serviceRoot = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-status-cli-default-age-'));
    await writeLastRun(serviceRoot);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyGraphSyncStatusCli(['--service-root', serviceRoot], {
      now: new Date('2026-07-04T02:49:00Z'),
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(0);
    expect(stderr.join('')).toBe('');
    const artifact = JSON.parse(stdout.join('')) as {
      readonly ok: boolean;
      readonly status: string;
      readonly last_run: { readonly stale: boolean; readonly age_ms: number; readonly max_age_ms: number };
    };
    expect(artifact.ok).toBe(true);
    expect(artifact.status).toBe('PASS');
    expect(artifact.last_run.age_ms).toBe(840000);
    expect(artifact.last_run.max_age_ms).toBe(900000);
    expect(artifact.last_run.stale).toBe(false);
  });
});
