import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSymphonyGraphSyncLinearApplyCli } from '../src/cli/graph-sync-materialize-linear.js';
import { buildGraphSyncReadOnlyDiffReceipt } from '../src/graph-sync-ledger.js';
import type { CreateLinearIssueRelationInput } from '../src/tracker.js';

const receiptInput = {
  workflowId: 'symphony-linear-kanban-bridge',
  runId: 'graph-run-linear-live-apply',
  generatedAt: '2026-06-30T16:40:00.000Z',
  completedAt: '2026-06-30T16:40:01.000Z',
  scope: { tracker: 'linear', kanbanBoard: 'linear' },
  nodeMappings: [
    {
      linearIssue: { id: 'lin_A', identifier: 'HER-301', stateName: 'Backlog' },
      kanbanTask: { id: 't_A', status: 'blocked' },
    },
    {
      linearIssue: { id: 'lin_B', identifier: 'HER-302', stateName: 'Backlog' },
      kanbanTask: { id: 't_B', status: 'blocked' },
    },
  ],
  linearRelations: [],
  kanbanEdges: [
    {
      parentTaskId: 't_A',
      childTaskId: 't_B',
      kind: 'blocks',
      blocking: true,
      requiredParentStatuses: ['done'],
      source: 'symphony-graph-sync',
      createdBy: 'symphony-ts',
      metadata: {},
    },
  ],
} as const;

describe('symphony-graph-sync-materialize-linear CLI', () => {
  it('refuses live Linear apply unless the explicit allow flag is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-linear-refuse-'));
    const inputPath = join(root, 'read-only-receipt.json');
    const outputPath = join(root, 'apply-receipt.json');
    await writeFile(inputPath, JSON.stringify(buildGraphSyncReadOnlyDiffReceipt(receiptInput), null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    let factoryCalled = false;

    const exitCode = await runSymphonyGraphSyncLinearApplyCli([
      '--mode',
      'kanban_authoritative_apply',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--approved-scope',
      'linear relation t_A -> t_B',
    ], {
      processEnv: { LINEAR_API_KEY: 'fake-key' },
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      linearClientFactory: () => {
        factoryCalled = true;
        throw new Error('factory should not be called');
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('--allow-live-linear-apply is required');
    expect(factoryCalled).toBe(false);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses the real-client path when LINEAR_API_KEY is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-linear-env-'));
    const inputPath = join(root, 'read-only-receipt.json');
    const outputPath = join(root, 'apply-receipt.json');
    await writeFile(inputPath, JSON.stringify(buildGraphSyncReadOnlyDiffReceipt(receiptInput), null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyGraphSyncLinearApplyCli([
      '--mode',
      'kanban_authoritative_apply',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--approved-scope',
      'linear relation t_A -> t_B',
      '--allow-live-linear-apply',
    ], {
      processEnv: {},
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('LINEAR_API_KEY environment variable is required');
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies missing Kanban-authoritative blocking relations to Linear and writes readback receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-linear-apply-'));
    const inputPath = join(root, 'read-only-receipt.json');
    const outputPath = join(root, 'apply-receipt.json');
    await writeFile(inputPath, JSON.stringify(buildGraphSyncReadOnlyDiffReceipt(receiptInput), null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const createCalls: CreateLinearIssueRelationInput[] = [];
    const createdRelationIds: string[] = [];

    const exitCode = await runSymphonyGraphSyncLinearApplyCli([
      '--mode',
      'kanban_authoritative_apply',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--approved-scope',
      'board=linear edge=t_A->t_B source=graph-run-linear-live-apply',
      '--max-created',
      '1',
      '--allow-live-linear-apply',
    ], {
      processEnv: { LINEAR_API_KEY: 'fake-key' },
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      linearClientFactory: ({ apiKey }) => {
        expect(apiKey).toBe('fake-key');
        return {
          createIssueRelation: (input) => {
            createCalls.push(input);
            createdRelationIds.push('rel_lin_A_lin_B');
            return Promise.resolve({
              relation_id: 'rel_lin_A_lin_B',
              type: input.type,
              issue_id: input.issueId,
              related_issue_id: input.relatedIssueId,
            });
          },
          hasIssueRelation: (input) => Promise.resolve(
            input.issueId === 'lin_A'
              && input.relatedIssueId === 'lin_B'
              && createdRelationIds.includes('rel_lin_A_lin_B'),
          ),
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(createCalls).toEqual([{ issueId: 'lin_A', relatedIssueId: 'lin_B', type: 'blocks' }]);
    const summary = JSON.parse(stdout.join('')) as GraphSyncLiveLinearApplySummary;
    expect(summary).toMatchObject({
      ok: true,
      effect: 'graph_sync_live_linear_blocking_relation_apply_artifact',
      mode: 'kanban_authoritative_apply',
      input_path: inputPath,
      receipt_path: outputPath,
      approved_scope: 'board=linear edge=t_A->t_B source=graph-run-linear-live-apply',
      summary: { candidate_missing_linear_relations: 1, created_linear_relations: 1, readback_verified: 1 },
    });
    const receipt = JSON.parse(await readFile(outputPath, 'utf8')) as GraphSyncLiveLinearApplyReceipt;
    expect(receipt).toMatchObject({
      ok: true,
      effect: 'graph_sync_live_linear_blocking_relation_apply',
      mode: 'kanban_authoritative_apply',
      boundary: 'live_apply',
      approved_scope: 'board=linear edge=t_A->t_B source=graph-run-linear-live-apply',
      source_receipt_run_id: 'graph-run-linear-live-apply',
      suppressed_writes: false,
      actions: ['created_live_linear_blocking_relations'],
      summary: { created_linear_relations: 1, readback_verified: 1 },
      created_relations: [expect.objectContaining({ parent_issue_id: 'lin_A', child_issue_id: 'lin_B', relation_id: 'rel_lin_A_lin_B', readback_verified: true })],
    });
    expect(receipt.non_actions).toEqual([
      'did_not_query_or_mutate_hermes_kanban',
      'did_not_create_update_delete_kanban_links',
      'did_not_move_linear_issue_states',
      'did_not_start_or_restart_services_or_timers',
      'did_not_dispatch_workers_or_gateway',
      'did_not_push_publish_deploy_or_open_pr',
      'did_not_expose_raw_linear_token_or_authorization_header',
    ]);
  });

  it('refuses before live Linear writes when candidate count exceeds the max-created cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-linear-cap-'));
    const inputPath = join(root, 'read-only-receipt.json');
    const outputPath = join(root, 'apply-receipt.json');
    await writeFile(inputPath, JSON.stringify(buildGraphSyncReadOnlyDiffReceipt({
      ...receiptInput,
      runId: 'graph-run-linear-live-cap',
      nodeMappings: [
        ...receiptInput.nodeMappings,
        {
          linearIssue: { id: 'lin_C', identifier: 'HER-303', stateName: 'Backlog' },
          kanbanTask: { id: 't_C', status: 'blocked' },
        },
      ],
      kanbanEdges: [
        ...receiptInput.kanbanEdges,
        {
          parentTaskId: 't_B',
          childTaskId: 't_C',
          kind: 'blocks',
          blocking: true,
          requiredParentStatuses: ['done'],
          source: 'symphony-graph-sync',
          createdBy: 'symphony-ts',
          metadata: {},
        },
      ],
    }), null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const createCalls: CreateLinearIssueRelationInput[] = [];

    const exitCode = await runSymphonyGraphSyncLinearApplyCli([
      '--mode',
      'kanban_authoritative_apply',
      '--input',
      inputPath,
      '--output',
      outputPath,
      '--approved-scope',
      'two relations would exceed cap',
      '--max-created',
      '1',
      '--allow-live-linear-apply',
    ], {
      processEnv: { LINEAR_API_KEY: 'fake-key' },
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
      linearClientFactory: () => ({
        createIssueRelation: (input) => {
          createCalls.push(input);
          return Promise.resolve({ relation_id: 'unexpected', type: input.type, issue_id: input.issueId, related_issue_id: input.relatedIssueId });
        },
        hasIssueRelation: () => Promise.resolve(false),
      }),
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('')).toContain('candidate count 2 exceeds maxCreatedRelations 1');
    expect(createCalls).toEqual([]);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

interface GraphSyncLiveLinearApplySummary {
  readonly ok: boolean;
  readonly effect: string;
  readonly mode: string;
  readonly input_path: string;
  readonly receipt_path: string;
  readonly approved_scope: string;
  readonly summary: {
    readonly candidate_missing_linear_relations: number;
    readonly created_linear_relations: number;
    readonly readback_verified: number;
  };
}

interface GraphSyncLiveLinearApplyReceipt {
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
    readonly created_linear_relations: number;
    readonly readback_verified: number;
  };
  readonly created_relations: readonly {
    readonly parent_issue_id: string;
    readonly child_issue_id: string;
    readonly relation_id: string | null;
    readonly readback_verified: boolean;
  }[];
}
