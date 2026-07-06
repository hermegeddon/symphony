import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import {
  createBridgeLedgerGraphSyncMappingReader,
  createEnrichedHermesKanbanGraphReader,
  createLinearTrackerGraphSyncLinearReader,
} from '../src/graph-sync-live-readers.js';
import type { GraphSyncKanbanGraphReader } from '../src/graph-sync-live-snapshot.js';
import type { KanbanTaskDetail, KanbanTaskLink } from '../src/kanban-types.js';
import type { GraphQLTransport } from '../src/tracker.js';
import { getEffectiveConfig, type WorkflowDefinition } from '../src/workflow.js';

function makeTransport(responses: readonly unknown[]): GraphQLTransport & { readonly calls: { query: string; variables: Readonly<Record<string, unknown>> }[] } {
  const calls: { query: string; variables: Readonly<Record<string, unknown>> }[] = [];
  const request = vi.fn((query: string, variables: Readonly<Record<string, unknown>>) => {
    calls.push({ query, variables });
    const response = responses[calls.length - 1];
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(response);
  });
  return { request, calls };
}

describe('GraphSync live read-only readers', () => {
  it('reads issue-to-task mappings from bridge materialization ledger events without mutating the ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-live-readers-'));
    const ledgerPath = join(root, 'bridge-ledger.json');
    const ledger = {
      version: 1,
      generated_by: 'symphony-ts',
      runs: {},
      events: [
        {
          at: '2026-06-30T06:00:00.000Z',
          kind: 'mutation_recorded',
          issue_id: 'lin_parent',
          issue_identifier: 'HER-26',
          run_id: null,
          details: {
            key: 'kanban:task:materialized',
            operation: 'kanban.createTask',
            task_id: 't_parent',
            board: 'linear',
          },
        },
        {
          at: '2026-06-30T06:00:01.000Z',
          kind: 'mutation_recorded',
          issue_id: 'lin_child',
          issue_identifier: 'HER-27',
          run_id: null,
          details: {
            key: 'kanban:task:materialized',
            operation: 'kanban.createTask',
            task_id: 't_child',
            board: 'linear',
          },
        },
        {
          at: '2026-06-30T06:00:02.000Z',
          kind: 'mutation_recorded',
          issue_id: 'lin_parent',
          issue_identifier: 'HER-26',
          run_id: null,
          details: {
            key: 'linear:comment:start',
            operation: 'commentCreate',
            comment_id: 'comment-start',
          },
        },
        {
          at: '2026-06-30T06:00:03.000Z',
          kind: 'mutation_recorded',
          issue_id: 'lin_other_board',
          issue_identifier: 'HER-99',
          run_id: null,
          details: {
            key: 'kanban:task:materialized',
            operation: 'kanban.createTask',
            task_id: 't_other',
            board: 'not-linear',
          },
        },
      ],
    };
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    const beforeContent = await readFile(ledgerPath, 'utf8');
    const beforeStat = await stat(ledgerPath);

    const reader = createBridgeLedgerGraphSyncMappingReader(ledgerPath);
    const mappings = await reader.readMappings({ tracker: 'linear', kanban_board: 'linear' });

    expect(mappings).toEqual([
      { linearIssueId: 'lin_parent', kanbanTaskId: 't_parent' },
      { linearIssueId: 'lin_child', kanbanTaskId: 't_child' },
    ]);
    expect(await readFile(ledgerPath, 'utf8')).toBe(beforeContent);
    expect((await stat(ledgerPath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('reads only mapped Linear issue IDs with relation fields for GraphSync snapshot capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-linear-reader-'));
    const config = getEffectiveConfig(workflow(root), {
      env: { LINEAR_API_KEY: 'test-linear-key' },
    });
    const transport = makeTransport([
      {
        issues: {
          nodes: [
            {
              id: 'lin_parent',
              identifier: 'HER-26',
              title: 'Parent',
              description: null,
              priority: null,
              state: { name: 'Backlog' },
              branchName: null,
              url: 'https://linear.app/hermegeddon/issue/HER-26/parent',
              labels: { nodes: [] },
              relations: {
                nodes: [
                  {
                    id: 'rel_blocks_parent_child',
                    type: 'blocks',
                    createdAt: '2026-06-30T05:16:33.000Z',
                    updatedAt: '2026-06-30T05:16:34.000Z',
                    archivedAt: null,
                    issue: { id: 'lin_parent', identifier: 'HER-26', state: { name: 'Backlog' } },
                    relatedIssue: { id: 'lin_child', identifier: 'HER-27', state: { name: 'Backlog' } },
                  },
                ],
              },
              inverseRelations: { nodes: [] },
              createdAt: '2026-06-30T05:16:33.000Z',
              updatedAt: '2026-06-30T05:16:34.000Z',
            },
            {
              id: 'lin_child',
              identifier: 'HER-27',
              title: 'Child',
              description: null,
              priority: null,
              state: { name: 'Backlog' },
              branchName: null,
              url: 'https://linear.app/hermegeddon/issue/HER-27/child',
              labels: { nodes: [] },
              relations: { nodes: [] },
              inverseRelations: { nodes: [] },
              createdAt: '2026-06-30T05:16:33.000Z',
              updatedAt: '2026-06-30T05:16:34.000Z',
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ]);

    const reader = createLinearTrackerGraphSyncLinearReader({ config, transport });
    const issues = await reader.readIssuesWithRelations(
      { tracker: 'linear', kanban_board: 'linear' },
      [
        { linearIssueId: 'lin_parent', kanbanTaskId: 't_parent' },
        { linearIssueId: 'lin_child', kanbanTaskId: 't_child' },
      ],
    );

    expect(issues.map((issue) => issue.id)).toEqual(['lin_parent', 'lin_child']);
    expect(issues[0]?.linear_relations).toEqual([
      {
        id: 'rel_blocks_parent_child',
        type: 'blocks',
        observed_from: 'relations',
        issue: { id: 'lin_parent', identifier: 'HER-26', state: 'Backlog' },
        related_issue: { id: 'lin_child', identifier: 'HER-27', state: 'Backlog' },
        created_at: new Date('2026-06-30T05:16:33.000Z'),
        updated_at: new Date('2026-06-30T05:16:34.000Z'),
        archived_at: null,
      },
    ]);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.query).toContain('query SymphonyIssueStatesByIds');
    expect(transport.calls[0]?.query).toContain('relations { nodes { id type createdAt updatedAt archivedAt');
    expect(transport.calls[0]?.variables).toMatchObject({
      issueIds: ['lin_parent', 'lin_child'],
      first: 2,
      after: null,
    });
  });

  it('enriches mapped Kanban task details with read-only Hermes typed dependency-registry edges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-kanban-enriched-reader-'));
    const registryPath = join(root, 'kanban', 'cross_board_dependencies.db');
    await mkdir(join(root, 'kanban'), { recursive: true });
    const db = new DatabaseSync(registryPath);
    try {
      db.exec(`
        create table cross_board_edges (
          id text primary key,
          parent_board text not null,
          parent_id text not null,
          child_board text not null,
          child_id text not null,
          kind text not null,
          blocking integer not null,
          source text,
          created_by text,
          required_parent_statuses text,
          created_at integer,
          updated_at integer,
          metadata text
        )
      `);
      db.prepare(`
        insert into cross_board_edges (
          id, parent_board, parent_id, child_board, child_id, kind, blocking,
          source, created_by, required_parent_statuses, created_at, updated_at, metadata
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'edge_1',
        'linear',
        't_parent',
        'linear',
        't_child',
        'blocks',
        1,
        'symphony-graph-sync',
        'symphony-ts',
        '["done"]',
        1782831265,
        1782831265,
        JSON.stringify({
          graph_sync_edge_key: 'blocks:linear:issue:lin_parent->linear:issue:lin_child',
          linear_relation_ids: 'rel_parent_child',
        }),
      );
    } finally {
      db.close();
    }
    const beforeStat = await stat(registryPath);
    const parentTask = kanbanTask({ id: 't_parent', status: 'done' });
    const childTask = kanbanTask({ id: 't_child', status: 'todo' });
    const inner = fakeKanbanGraphReader([parentTask, childTask]);

    const reader = createEnrichedHermesKanbanGraphReader({
      inner,
      board: 'linear',
      crossBoardDbPath: registryPath,
    });
    const details = await reader.readTaskDetails(['t_parent', 't_child']);

    const expectedLink: KanbanTaskLink = {
      parentTaskId: 't_parent',
      childTaskId: 't_child',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata: {
        graph_sync_edge_key: 'blocks:linear:issue:lin_parent->linear:issue:lin_child',
        linear_relation_ids: 'rel_parent_child',
      },
    };
    expect(details).toEqual([
      { ...parentTask, childLinks: [expectedLink] },
      { ...childTask, parentLinks: [expectedLink] },
    ]);
    expect((await stat(registryPath)).mtimeMs).toBe(beforeStat.mtimeMs);
  });
});

function kanbanTask(
  overrides: Pick<KanbanTaskDetail, 'id' | 'status'> & Partial<KanbanTaskDetail>,
): KanbanTaskDetail {
  return {
    title: overrides.id,
    assignee: null,
    body: null,
    parents: [],
    children: [],
    parentLinks: [],
    childLinks: [],
    comments: [],
    raw: {},
    ...overrides,
  };
}

function fakeKanbanGraphReader(tasks: readonly KanbanTaskDetail[]): GraphSyncKanbanGraphReader {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return {
    readTaskDetails(taskIds: readonly string[]): Promise<readonly KanbanTaskDetail[]> {
      return Promise.resolve(
        taskIds.map((taskId) => tasksById.get(taskId)).filter((task): task is KanbanTaskDetail => task !== undefined),
      );
    },
  };
}

function workflow(root: string): WorkflowDefinition {
  return {
    workflow_path: join(root, 'WORKFLOW.md'),
    prompt_template: 'GraphSync snapshot reader test',
    config: {
      backend: { kind: 'hermes_kanban' },
      tracker: {
        kind: 'linear',
        api_key: '$LINEAR_API_KEY',
        team_key: 'HER',
        active_states: ['Backlog'],
        max_issues_per_poll: 1,
      },
      kanban: {
        hermes_command: '/safe/bin/hermes',
        hermes_home: join(root, 'hermes-home'),
        board: 'linear',
        artifact_root: join(root, 'artifacts'),
      },
      service: {
        state_path: join(root, 'bridge-ledger.json'),
      },
    },
  };
}
