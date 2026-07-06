import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Issue } from '../src/domain.js';
import { JsonFileIssueRunLedger } from '../src/issue-run-ledger.js';

const issue: Issue = {
  id: 'issue-1',
  identifier: 'HER-1',
  title: 'Test live ledger',
  description: null,
  priority: null,
  state: 'Todo',
  branch_name: null,
  url: null,
  labels: [],
  blocked_by: [],
  created_at: null,
  updated_at: null,
};

describe('JsonFileIssueRunLedger', () => {
  it('persists completed runs and mutation idempotency keys across process restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-ledger-'));
    const path = join(root, 'issue-ledger.json');
    const ledger = new JsonFileIssueRunLedger(path);

    ledger.recordRunStarted({ issue, runId: 'run-1', attempt: 0, workspacePath: join(root, 'workspace'), at: new Date('2026-06-23T00:00:00.000Z') });
    ledger.recordMutation({ issue, key: 'linear:comment:start', operation: 'commentCreate', at: new Date('2026-06-23T00:00:01.000Z'), details: { comment_id: 'comment-1' } });
    ledger.recordRunCompleted({ issue, runId: 'run-1', ok: true, error: null, at: new Date('2026-06-23T00:00:02.000Z') });

    const reloaded = new JsonFileIssueRunLedger(path);

    expect(reloaded.completedIssueIds()).toEqual(['issue-1']);
    expect(reloaded.hasMutation('issue-1', 'linear:comment:start')).toBe(true);
    expect(reloaded.snapshot().runs['issue-1']).toMatchObject({
      status: 'completed',
      run_id: 'run-1',
      mutation_keys: ['linear:comment:start'],
    });
    await expect(readFile(path, 'utf8')).resolves.toContain('run_completed');
  });

  it('marks running runs interrupted during restart recovery without marking them completed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-ledger-'));
    const path = join(root, 'issue-ledger.json');
    const ledger = new JsonFileIssueRunLedger(path);

    ledger.recordRunStarted({ issue, runId: 'run-2', attempt: 1, workspacePath: join(root, 'workspace'), at: new Date('2026-06-23T00:00:00.000Z') });

    const reloaded = new JsonFileIssueRunLedger(path);
    const interrupted = reloaded.recoverInterruptedRuns(new Date('2026-06-23T00:05:00.000Z'));

    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ issue_id: 'issue-1', status: 'interrupted', run_id: 'run-2' });
    expect(reloaded.completedIssueIds()).toEqual([]);
    expect(reloaded.snapshot().events.map((event) => event.kind)).toContain('run_interrupted');
  });

  it('normalizes legacy mutation-only records away from failed status without hiding real failed runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-ledger-legacy-'));
    const path = join(root, 'issue-ledger.json');
    await writeFile(path, `${JSON.stringify({
      version: 1,
      generated_by: 'symphony-ts',
      runs: {
        'mutation-only': {
          issue_id: 'mutation-only',
          issue_identifier: 'HER-9',
          status: 'failed',
          run_id: null,
          attempt: 0,
          workspace_path: null,
          started_at: null,
          updated_at: '2026-06-24T16:31:46.429Z',
          last_error: null,
          mutation_keys: ['kanban:task:materialized', 'linear:comment:start'],
        },
        'real-failure': {
          issue_id: 'real-failure',
          issue_identifier: 'HER-10',
          status: 'failed',
          run_id: 'HER-10-run-1',
          attempt: 1,
          workspace_path: join(root, 'workspace'),
          started_at: '2026-06-24T16:00:00.000Z',
          updated_at: '2026-06-24T16:05:00.000Z',
          last_error: 'runner launch failed',
          mutation_keys: [],
        },
      },
      events: [],
    }, null, 2)}\n`, 'utf8');

    const ledger = new JsonFileIssueRunLedger(path);

    expect(ledger.snapshot().runs['mutation-only']).toMatchObject({
      issue_id: 'mutation-only',
      issue_identifier: 'HER-9',
      status: 'mutation_only',
      run_id: null,
      last_error: null,
      mutation_keys: ['kanban:task:materialized', 'linear:comment:start'],
    });
    expect(ledger.snapshot().runs['real-failure']).toMatchObject({
      issue_id: 'real-failure',
      issue_identifier: 'HER-10',
      status: 'failed',
      run_id: 'HER-10-run-1',
      last_error: 'runner launch failed',
    });
    await expect(readFile(path, 'utf8')).resolves.toContain('"status": "mutation_only"');
  });
});
