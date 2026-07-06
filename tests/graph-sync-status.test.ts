import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateGraphSyncStatus } from '../src/graph-sync-status.js';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-graph-sync-status-'));
}

async function writeLastRun(lastRunPath: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    lastRunPath,
    `${JSON.stringify({
      ok: true,
      effect: 'recurring_graphsync_readonly_snapshot_wrapper_run',
      mode: 'read_only_snapshot',
      status: 'PASS',
      cli_exit_code: 0,
      started_at: '2026-07-04T02:34:00Z',
      completed_at: '2026-07-04T02:35:00Z',
      service_root: join(lastRunPath, '..'),
      run_dir: join(lastRunPath, '..', 'runs', '20260704T023400Z-123'),
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
      non_actions: [
        'did_not_create_update_delete_linear_relations',
        'did_not_create_update_delete_kanban_links',
        'did_not_dispatch_workers_or_gateway',
      ],
      ...overrides,
    }, null, 2)}\n`,
    'utf8',
  );
}

describe('GraphSync status watchdog', () => {
  it('reports a fresh PASS last-run wrapper as ok and non-mutating', async () => {
    const root = await tempRoot();
    const lastRunPath = join(root, 'last-run.json');
    await writeLastRun(lastRunPath);

    const status = await evaluateGraphSyncStatus({
      lastRunPath,
      now: new Date('2026-07-04T02:36:00Z'),
      maxAgeMs: 300000,
    });

    expect(status.ok).toBe(true);
    expect(status.status).toBe('PASS');
    expect(status.effect).toBe('graph_sync_status_watchdog');
    expect(status.last_run.path).toBe(lastRunPath);
    expect(status.last_run.age_ms).toBe(60000);
    expect(status.last_run.stale).toBe(false);
    expect(status.last_run.stale_reason).toBeNull();
    expect(status.summary?.mappings_resolved).toBe(15);
    expect(status.summary?.proposed_operations).toBe(0);
    expect(status.warnings).toEqual([]);
    expect(status.non_actions).toContain('did_not_dispatch_workers_or_gateway');
    expect(status.non_actions).toContain('did_not_create_update_delete_linear_relations');
    expect(status.non_actions).toContain('did_not_create_update_delete_kanban_links');
  });

  it('reports REVIEW when the latest run produced suppressed proposals', async () => {
    const root = await tempRoot();
    const lastRunPath = join(root, 'last-run.json');
    await writeLastRun(lastRunPath, {
      status: 'REVIEW',
      summary: {
        linear_issues_read: 2,
        kanban_tasks_read: 2,
        mappings_resolved: 2,
        linear_edges_seen: 1,
        kanban_edges_seen: 0,
        matched_edges: 0,
        missing_kanban_edges: 1,
        missing_linear_relations: 0,
        endpoint_policies: 0,
        cycles_detected: 0,
        proposed_operations: 1,
      },
    });

    const status = await evaluateGraphSyncStatus({
      lastRunPath,
      now: new Date('2026-07-04T02:36:00Z'),
      maxAgeMs: 300000,
    });

    expect(status.ok).toBe(true);
    expect(status.status).toBe('REVIEW');
    expect(status.summary?.proposed_operations).toBe(1);
    expect(status.warnings).toContain('GraphSync proposed operations require operator review');
    expect(status.warnings).toContain('GraphSync observed missing Kanban edges');
  });

  it('reports BLOCK when the latest run is stale', async () => {
    const root = await tempRoot();
    const lastRunPath = join(root, 'last-run.json');
    await writeLastRun(lastRunPath);

    const status = await evaluateGraphSyncStatus({
      lastRunPath,
      now: new Date('2026-07-04T02:45:01Z'),
      maxAgeMs: 300000,
    });

    expect(status.ok).toBe(false);
    expect(status.status).toBe('BLOCK');
    expect(status.last_run.stale).toBe(true);
    expect(status.last_run.stale_reason).toContain('exceeds max_age_ms');
    expect(status.warnings).toContain(status.last_run.stale_reason);
  });

  it('reports structured BLOCK when last-run.json is missing', async () => {
    const root = await tempRoot();
    const lastRunPath = join(root, 'last-run.json');

    const status = await evaluateGraphSyncStatus({
      lastRunPath,
      now: new Date('2026-07-04T02:36:00Z'),
      maxAgeMs: 300000,
    });

    expect(status.ok).toBe(false);
    expect(status.status).toBe('BLOCK');
    expect(status.last_run.exists).toBe(false);
    expect(status.last_run.stale).toBe(true);
    expect(status.last_run.stale_reason).toBe('last-run.json does not exist');
    expect(status.warnings).toContain('last-run.json does not exist');
  });
});
