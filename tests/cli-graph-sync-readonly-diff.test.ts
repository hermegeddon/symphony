import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runSymphonyGraphSyncReadOnlyDiffCli } from '../src/cli/graph-sync-readonly-diff.js';

describe('symphony-graph-sync-diff CLI', () => {
  it('writes a local read-only graph diff receipt artifact from an explicit snapshot file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-diff-cli-'));
    const inputPath = join(root, 'graph-snapshot.json');
    const outputPath = join(root, 'graph-receipt.json');
    await writeFile(inputPath, JSON.stringify({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-cli-run-001',
      generatedAt: '2026-06-28T04:00:00.000Z',
      completedAt: '2026-06-28T04:00:01.000Z',
      scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'DEMO-21', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'DEMO-22', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'ready' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'DEMO-21', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'DEMO-22', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [],
    }, null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyGraphSyncReadOnlyDiffCli([
      '--mode',
      'read_only_diff',
      '--input',
      inputPath,
      '--output',
      outputPath,
    ], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const summary = JSON.parse(stdout.join('')) as GraphSyncDiffCliSummary;
    expect(summary).toMatchObject({
      ok: true,
      effect: 'graph_sync_read_only_diff_artifact',
      mode: 'read_only_diff',
      input_path: inputPath,
      receipt_path: outputPath,
      suppressed_writes: true,
      summary: { missing_kanban_edges: 1, proposed_operations: 1 },
    });
    expect(summary.non_actions).toEqual(readOnlyNonActions);

    const receipt = JSON.parse(await readFile(outputPath, 'utf8')) as GraphSyncDiffReceiptAssertion;
    expect(receipt).toMatchObject({
      effect: 'graph_sync_read_only_diff',
      mode: 'read_only_diff',
      suppressed_writes: true,
      summary: { missing_kanban_edges: 1 },
    });
    expect(receipt.proposed_operations).toEqual([
      expect.objectContaining({
        operation: 'create_kanban_edge',
        severity: 'warning',
        human_action_recommendation: 'review',
        suppressed: true,
      }),
    ]);
  });

  it('writes declared operator summary and status artifacts without enabling writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-diff-artifacts-'));
    const inputPath = join(root, 'graph-snapshot.json');
    const receiptPath = join(root, 'graph-receipt.json');
    const summaryPath = join(root, 'summary.md');
    const statusPath = join(root, 'status.json');
    await writeFile(inputPath, JSON.stringify({
      workflowId: 'symphony-linear-kanban-bridge',
      runId: 'graph-cli-run-operator-artifacts',
      generatedAt: '2026-06-28T04:10:00.000Z',
      completedAt: '2026-06-28T04:10:01.000Z',
      scope: { tracker: 'linear', selector: 'all_approved_projects', kanbanBoard: 'linear' },
      nodeMappings: [
        {
          linearIssue: { id: 'lin_A', identifier: 'DEMO-31', stateName: 'Done' },
          kanbanTask: { id: 't_A', status: 'done' },
        },
        {
          linearIssue: { id: 'lin_B', identifier: 'DEMO-32', stateName: 'Todo' },
          kanbanTask: { id: 't_B', status: 'ready' },
        },
      ],
      linearRelations: [
        {
          relation: {
            id: 'rel_blocks_A_B',
            type: 'blocks',
            issue: { id: 'lin_A', identifier: 'DEMO-31', stateName: 'Done' },
            relatedIssue: { id: 'lin_B', identifier: 'DEMO-32', stateName: 'Todo' },
            createdAt: '2026-06-27T18:00:00.000Z',
            updatedAt: '2026-06-27T18:05:00.000Z',
            archivedAt: null,
          },
          observedFrom: 'relations',
        },
      ],
      kanbanEdges: [],
    }, null, 2), 'utf8');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runSymphonyGraphSyncReadOnlyDiffCli([
      '--mode',
      'read_only_diff',
      '--input',
      inputPath,
      '--output',
      receiptPath,
      '--summary-output',
      summaryPath,
      '--status-output',
      statusPath,
    ], {
      stdout: (chunk) => stdout.push(chunk),
      stderr: (chunk) => stderr.push(chunk),
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const cliSummary = JSON.parse(stdout.join('')) as GraphSyncDiffCliSummary;
    expect(cliSummary).toMatchObject({
      ok: true,
      effect: 'graph_sync_read_only_diff_artifact',
      receipt_path: receiptPath,
      summary_md_path: summaryPath,
      status_json_path: statusPath,
      suppressed_writes: true,
    });

    const status = JSON.parse(await readFile(statusPath, 'utf8')) as GraphSyncStatusArtifactAssertion;
    expect(status).toMatchObject({
      ok: true,
      effect: 'graph_sync_read_only_diff_status',
      status: 'REVIEW',
      mode: 'read_only_diff',
      input_path: inputPath,
      receipt_path: receiptPath,
      suppressed_writes: true,
      summary: {
        missing_kanban_edges: 1,
        proposed_operations: 1,
      },
      findings: {
        errors: 0,
        warnings: 1,
        conflicts: 0,
        cycles: 0,
        endpoint_policies: 0,
        suppressed_proposed_operations: 1,
      },
    });
    expect(status.findings.human_action_recommendations.review).toBe(1);
    expect(status.non_actions).toEqual(readOnlyNonActions);

    const markdownSummary = await readFile(summaryPath, 'utf8');
    expect(markdownSummary).toContain('# GraphSync read-only diff summary');
    expect(markdownSummary).toContain('Operator status: `REVIEW`');
    expect(markdownSummary).toContain(
      'No Linear relation writes, Kanban link writes, service/timer changes, or MCP apply actions were performed.',
    );
    expect(markdownSummary).toContain('| Missing Kanban edges | 1 |');
    expect(markdownSummary).toContain('| Suppressed proposed operations | 1 |');
    expect(markdownSummary).toContain('| review | 1 |');
  });

  it('keeps checked-in snapshot examples executable through the local read-only CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-graph-sync-diff-examples-'));
    const examples = [
      {
        fileName: 'matched-edge.snapshot.json',
        expectedSummary: {
          linear_edges_seen: 1,
          kanban_edges_seen: 1,
          matched_edges: 1,
          missing_kanban_edges: 0,
          missing_linear_relations: 0,
          endpoint_policies: 0,
          cycles_detected: 0,
        },
        expectedOperations: [],
      },
      {
        fileName: 'missing-kanban-edge.snapshot.json',
        expectedSummary: {
          linear_edges_seen: 1,
          kanban_edges_seen: 0,
          matched_edges: 0,
          missing_kanban_edges: 1,
          missing_linear_relations: 0,
          endpoint_policies: 0,
          cycles_detected: 0,
        },
        expectedOperations: ['create_kanban_edge'],
      },
      {
        fileName: 'unmapped-kanban-endpoint.snapshot.json',
        expectedSummary: {
          linear_edges_seen: 0,
          kanban_edges_seen: 1,
          matched_edges: 0,
          missing_kanban_edges: 0,
          missing_linear_relations: 1,
          endpoint_policies: 1,
          cycles_detected: 0,
        },
        expectedOperations: [],
      },
    ] as const;

    for (const example of examples) {
      const inputPath = join(process.cwd(), 'examples', 'graph-sync-readonly-diff', example.fileName);
      const outputPath = join(root, example.fileName.replace('.snapshot.json', '.receipt.json'));
      const stdout: string[] = [];
      const stderr: string[] = [];

      const exitCode = await runSymphonyGraphSyncReadOnlyDiffCli([
        '--mode',
        'read_only_diff',
        '--input',
        inputPath,
        '--output',
        outputPath,
      ], {
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
      });

      expect(exitCode, example.fileName).toBe(0);
      expect(stderr, example.fileName).toEqual([]);
      const summary = JSON.parse(stdout.join('')) as GraphSyncDiffCliSummary;
      expect(summary.summary, example.fileName).toMatchObject({
        ...example.expectedSummary,
        proposed_operations: example.expectedOperations.length,
      });
      expect(summary.non_actions, example.fileName).toEqual(readOnlyNonActions);

      const receipt = JSON.parse(await readFile(outputPath, 'utf8')) as GraphSyncDiffReceiptAssertion;
      expect(receipt.summary, example.fileName).toMatchObject(example.expectedSummary);
      expect(receipt.suppressed_writes, example.fileName).toBe(true);
      expect(receipt.non_actions, example.fileName).toEqual(readOnlyNonActions);
      expect(receipt.proposed_operations.map((operation) => operation.operation), example.fileName).toEqual(
        example.expectedOperations,
      );
      for (const operation of receipt.proposed_operations) {
        expect(operation, example.fileName).toMatchObject({
          severity: 'warning',
          human_action_recommendation: 'review',
          suppressed: true,
        });
      }
      if (example.expectedSummary.endpoint_policies > 0) {
        expect(receipt.diff.endpoint_policies, example.fileName).toEqual([
          expect.objectContaining({
            severity: 'warning',
            human_action_recommendation: 'inspect_endpoint_policy',
            policy: 'record_only_no_apply',
          }),
        ]);
      }
    }
  });
});

const readOnlyNonActions = [
  'linear_relation_create_update_delete_suppressed',
  'kanban_link_create_update_delete_suppressed',
  'service_timer_restart_suppressed',
  'mcp_apply_surface_suppressed',
] as const;

interface GraphSyncDiffCliSummary {
  readonly ok: boolean;
  readonly effect: string;
  readonly mode: string;
  readonly input_path: string;
  readonly receipt_path: string;
  readonly summary_md_path?: string;
  readonly status_json_path?: string;
  readonly suppressed_writes: boolean;
  readonly summary: GraphSyncSummaryAssertion & { readonly proposed_operations: number };
  readonly non_actions: readonly string[];
}

interface GraphSyncStatusArtifactAssertion {
  readonly ok: boolean;
  readonly effect: string;
  readonly status: string;
  readonly mode: string;
  readonly input_path: string;
  readonly receipt_path: string;
  readonly suppressed_writes: boolean;
  readonly summary: GraphSyncSummaryAssertion & { readonly proposed_operations: number };
  readonly findings: {
    readonly errors: number;
    readonly warnings: number;
    readonly conflicts: number;
    readonly cycles: number;
    readonly endpoint_policies: number;
    readonly suppressed_proposed_operations: number;
    readonly human_action_recommendations: {
      readonly none: number;
      readonly review: number;
      readonly inspect_endpoint_policy: number;
      readonly resolve_cycle: number;
      readonly human_decision_required: number;
    };
  };
  readonly non_actions: readonly string[];
}

interface GraphSyncDiffReceiptAssertion {
  readonly effect: string;
  readonly mode: string;
  readonly suppressed_writes: boolean;
  readonly non_actions: readonly string[];
  readonly proposed_operations: readonly GraphSyncProposedOperationAssertion[];
  readonly summary: GraphSyncSummaryAssertion;
  readonly diff: {
    readonly endpoint_policies: readonly GraphSyncEndpointPolicyAssertion[];
  };
}

interface GraphSyncProposedOperationAssertion {
  readonly operation: string;
  readonly severity: string;
  readonly human_action_recommendation: string;
  readonly suppressed: boolean;
}

interface GraphSyncEndpointPolicyAssertion {
  readonly severity: string;
  readonly human_action_recommendation: string;
  readonly policy: string;
}

interface GraphSyncSummaryAssertion {
  readonly linear_edges_seen: number;
  readonly kanban_edges_seen: number;
  readonly matched_edges: number;
  readonly missing_kanban_edges: number;
  readonly missing_linear_relations: number;
  readonly endpoint_policies: number;
  readonly cycles_detected: number;
}
