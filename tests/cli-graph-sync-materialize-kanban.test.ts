import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSymphonyGraphSyncKanbanApplyCli } from '../src/cli/graph-sync-materialize-kanban.js';
import { buildGraphSyncReadOnlyDiffReceipt } from '../src/graph-sync-ledger.js';
import type {
  CreateKanbanTaskLinkInput,
  KanbanClient,
  KanbanTaskDetail,
  KanbanTaskLink,
} from '../src/kanban-types.js';

const receiptInput = {
  workflowId: 'symphony-linear-kanban-bridge',
  runId: 'graph-run-live-apply',
  generatedAt: '2026-06-29T00:10:00.000Z',
  completedAt: '2026-06-29T00:10:01.000Z',
  scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
  nodeMappings: [
    {
      linearIssue: { id: 'lin_A', identifier: 'DEMO-41', stateName: 'Done' },
      kanbanTask: { id: 't_A', status: 'done' },
    },
    {
      linearIssue: { id: 'lin_B', identifier: 'DEMO-42', stateName: 'Todo' },
      kanbanTask: { id: 't_B', status: 'ready' },
    },
  ],
  linearRelations: [
    {
      relation: {
        id: 'rel_blocks_A_B',
        type: 'blocks',
        issue: { id: 'lin_A', identifier: 'DEMO-41', stateName: 'Done' },
        relatedIssue: { id: 'lin_B', identifier: 'DEMO-42', stateName: 'Todo' },
        createdAt: '2026-06-28T22:00:00.000Z',
        updatedAt: '2026-06-28T22:05:00.000Z',
        archivedAt: null,
      },
      observedFrom: 'relations',
    },
  ],
  kanbanEdges: [],
} as const;

describe('symphony-graph-sync-materialize-kanban CLI', () => {
  it('refuses live Kanban apply unless the explicit allow flag and approved scope are present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-live-refuse-'));
    const inputPath = join(root, 'read-only-receipt.json');
    const outputPath = join(root, 'apply-receipt.json');
    await writeFile(inputPath, JSON.stringify(buildGraphSyncReadOnlyDiffReceipt(receiptInput), null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    let factoryCalled = false;

    const exitCode = await runSymphonyGraphSyncKanbanApplyCli([
      '--mode',
      'linear_authoritative_apply',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--board',
      'linear',
      '--hermes-command',
      '/safe/bin/hermes',
      '--hermes-home',
      root,
    ], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      kanbanClientFactory: () => {
        factoryCalled = true;
        throw new Error('factory should not be called');
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('--allow-live-kanban-apply is required');
    expect(factoryCalled).toBe(false);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies missing Linear-authoritative blocking edges to the configured Kanban board and writes readback receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-live-apply-'));
    const inputPath = join(root, 'read-only-receipt.json');
    const outputPath = join(root, 'apply-receipt.json');
    await writeFile(inputPath, JSON.stringify(buildGraphSyncReadOnlyDiffReceipt(receiptInput), null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const createCalls: CreateKanbanTaskLinkInput[] = [];
    const parentLinks: KanbanTaskLink[] = [];
    const factoryContexts: { readonly command: string; readonly board: string; readonly hermesHome: string; readonly path: string }[] = [];

    const exitCode = await runSymphonyGraphSyncKanbanApplyCli([
      '--mode',
      'linear_authoritative_apply',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--board',
      'linear',
      '--hermes-command',
      '/safe/bin/hermes',
      '--hermes-home',
      root,
      '--approved-scope',
      'board=linear edge=t_A->t_B source=graph-run-live-apply',
      '--max-created',
      '1',
      '--allow-live-kanban-apply',
    ], {
      processEnv: { PATH: '/safe/bin:/usr/bin' },
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      kanbanClientFactory: (context) => {
        factoryContexts.push(context);
        const client: Pick<KanbanClient, 'createTaskLink' | 'showTask'> = {
          createTaskLink: (input) => {
            createCalls.push(input);
            const link: KanbanTaskLink = {
              parentTaskId: input.parentId,
              childTaskId: input.childId,
              kind: input.kind ?? 'blocks',
              blocking: input.blocking ?? false,
              requiredParentStatuses: input.requiredParentStatuses ?? [],
              source: input.source ?? null,
              createdBy: input.createdBy ?? null,
              metadata: input.metadata ?? {},
            };
            parentLinks.push(link);
            return Promise.resolve(link);
          },
          showTask: (id): Promise<KanbanTaskDetail> => Promise.resolve({
            id,
            title: 'Blocked task',
            status: 'blocked',
            assignee: null,
            body: null,
            parents: [],
            children: [],
            parentLinks,
            childLinks: [],
            comments: [],
            raw: {},
          }),
        };
        return client;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(factoryContexts).toEqual([{ command: '/safe/bin/hermes', board: 'linear', hermesHome: root, path: '/safe/bin:/usr/bin' }]);
    expect(createCalls).toEqual([
      expect.objectContaining({
        parentId: 't_A',
        childId: 't_B',
        kind: 'blocks',
        blocking: true,
        requiredParentStatuses: ['done'],
        source: 'symphony-graph-sync',
        createdBy: 'symphony-ts',
      }),
    ]);
    expect(createCalls[0]?.metadata).toMatchObject({
      graph_sync_edge_key: 'blocks:linear:issue:lin_A->linear:issue:lin_B',
      linear_relation_ids: 'rel_blocks_A_B',
    });

    const summary = JSON.parse(stdout.join('')) as GraphSyncLiveApplySummary;
    expect(summary).toMatchObject({
      ok: true,
      effect: 'graph_sync_live_kanban_blocking_edge_apply_artifact',
      mode: 'linear_authoritative_apply',
      board: 'linear',
      input_path: inputPath,
      receipt_path: outputPath,
      approved_scope: 'board=linear edge=t_A->t_B source=graph-run-live-apply',
      summary: { candidate_missing_kanban_edges: 1, created_kanban_edges: 1, readback_verified: 1 },
    });

    const receipt = JSON.parse(await readFile(outputPath, 'utf8')) as GraphSyncLiveApplyReceipt;
    expect(receipt).toMatchObject({
      ok: true,
      effect: 'graph_sync_live_kanban_blocking_edge_apply',
      mode: 'linear_authoritative_apply',
      boundary: 'live_apply',
      approved_scope: 'board=linear edge=t_A->t_B source=graph-run-live-apply',
      source_receipt_run_id: 'graph-run-live-apply',
      suppressed_writes: false,
      actions: ['created_live_hermes_kanban_blocking_links'],
      summary: { created_kanban_edges: 1, readback_verified: 1 },
      created_links: [expect.objectContaining({ parent_task_id: 't_A', child_task_id: 't_B', readback_verified: true })],
    });
    expect(receipt.non_actions).toEqual([
      'did_not_query_linear',
      'did_not_create_update_delete_linear_relations',
      'did_not_start_or_restart_services_or_timers',
      'did_not_dispatch_workers_or_gateway',
      'did_not_use_mcp_mutation_tools',
      'did_not_push_publish_deploy_or_open_pr',
    ]);
  });

  it('refuses before live link writes when candidate count exceeds the max-created cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-live-cap-'));
    const inputPath = join(root, 'read-only-receipt.json');
    const outputPath = join(root, 'apply-receipt.json');
    await writeFile(inputPath, JSON.stringify(buildGraphSyncReadOnlyDiffReceipt({
      ...receiptInput,
      runId: 'graph-run-live-cap',
      nodeMappings: [
        ...receiptInput.nodeMappings,
        {
          linearIssue: { id: 'lin_C', identifier: 'DEMO-43', stateName: 'Todo' },
          kanbanTask: { id: 't_C', status: 'ready' },
        },
      ],
      linearRelations: [
        ...receiptInput.linearRelations,
        {
          relation: {
            id: 'rel_blocks_B_C',
            type: 'blocks',
            issue: { id: 'lin_B', identifier: 'DEMO-42', stateName: 'Todo' },
            relatedIssue: { id: 'lin_C', identifier: 'DEMO-43', stateName: 'Todo' },
            createdAt: '2026-06-28T22:10:00.000Z',
            updatedAt: '2026-06-28T22:15:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
    }), null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const createCalls: CreateKanbanTaskLinkInput[] = [];

    const exitCode = await runSymphonyGraphSyncKanbanApplyCli([
      '--mode',
      'linear_authoritative_apply',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--board',
      'linear',
      '--hermes-command',
      '/safe/bin/hermes',
      '--hermes-home',
      root,
      '--approved-scope',
      'board=linear edges=t_A->t_B,t_B->t_C source=graph-run-live-cap',
      '--max-created',
      '1',
      '--allow-live-kanban-apply',
    ], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      kanbanClientFactory: () => ({
        createTaskLink: (input) => {
          createCalls.push(input);
          return Promise.resolve({
            parentTaskId: input.parentId,
            childTaskId: input.childId,
            kind: input.kind ?? 'blocks',
            blocking: input.blocking ?? false,
            requiredParentStatuses: input.requiredParentStatuses ?? [],
            source: input.source ?? null,
            createdBy: input.createdBy ?? null,
            metadata: input.metadata ?? {},
          });
        },
        showTask: () => {
          throw new Error('showTask should not be called when cap fails before writes');
        },
      }),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('candidate count 2 exceeds maxCreatedLinks 1');
    expect(createCalls).toEqual([]);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

interface GraphSyncLiveApplySummary {
  readonly ok: boolean;
  readonly effect: string;
  readonly mode: string;
  readonly board: string;
  readonly input_path: string;
  readonly receipt_path: string;
  readonly approved_scope: string;
  readonly summary: {
    readonly candidate_missing_kanban_edges: number;
    readonly created_kanban_edges: number;
    readonly readback_verified: number;
  };
}

interface GraphSyncLiveApplyReceipt {
  readonly ok: boolean;
  readonly effect: string;
  readonly mode: string;
  readonly boundary: string;
  readonly approved_scope: string;
  readonly source_receipt_run_id: string;
  readonly suppressed_writes: boolean;
  readonly actions: readonly string[];
  readonly non_actions: readonly string[];
  readonly summary: {
    readonly created_kanban_edges: number;
    readonly readback_verified: number;
  };
  readonly created_links: readonly {
    readonly parent_task_id: string;
    readonly child_task_id: string;
    readonly readback_verified: boolean;
  }[];
}
