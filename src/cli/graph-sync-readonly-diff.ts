#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  buildGraphSyncReadOnlyDiffReceipt,
  type BuildGraphSyncReadOnlyDiffReceiptInput,
  type GraphSyncFindingSeverity,
  type GraphSyncHumanActionRecommendation,
  type GraphSyncReadOnlyDiffReceipt,
} from '../graph-sync-ledger.js';
import { isDirectCliExecution } from './direct-execution.js';

export type GraphSyncReadOnlyDiffTextWriter = (chunk: string) => void;

export interface SymphonyGraphSyncReadOnlyDiffCliOptions {
  readonly stdout?: GraphSyncReadOnlyDiffTextWriter;
  readonly stderr?: GraphSyncReadOnlyDiffTextWriter;
}

export interface GraphSyncReadOnlyDiffArtifactSummary {
  readonly ok: true;
  readonly effect: 'graph_sync_read_only_diff_artifact';
  readonly mode: 'read_only_diff';
  readonly input_path: string;
  readonly receipt_path: string;
  readonly summary_md_path?: string;
  readonly status_json_path?: string;
  readonly suppressed_writes: true;
  readonly summary: {
    readonly linear_edges_seen: number;
    readonly kanban_edges_seen: number;
    readonly matched_edges: number;
    readonly missing_kanban_edges: number;
    readonly missing_linear_relations: number;
    readonly endpoint_policies: number;
    readonly cycles_detected: number;
    readonly proposed_operations: number;
  };
  readonly non_actions: readonly string[];
}

export type GraphSyncReadOnlyDiffOperatorStatus = 'PASS' | 'REVIEW' | 'BLOCK';

export interface GraphSyncReadOnlyDiffStatusArtifact {
  readonly ok: true;
  readonly effect: 'graph_sync_read_only_diff_status';
  readonly status: GraphSyncReadOnlyDiffOperatorStatus;
  readonly mode: 'read_only_diff';
  readonly workflow_id: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly completed_at: string;
  readonly input_path: string;
  readonly receipt_path: string;
  readonly suppressed_writes: true;
  readonly summary: GraphSyncReadOnlyDiffArtifactSummary['summary'];
  readonly findings: GraphSyncReadOnlyDiffStatusFindings;
  readonly non_actions: readonly string[];
}

export interface GraphSyncReadOnlyDiffStatusFindings {
  readonly info: number;
  readonly warnings: number;
  readonly errors: number;
  readonly conflicts: number;
  readonly cycles: number;
  readonly endpoint_policies: number;
  readonly suppressed_proposed_operations: number;
  readonly human_action_recommendations: Readonly<Record<GraphSyncHumanActionRecommendation, number>>;
}

interface ParsedGraphSyncReadOnlyDiffFlags {
  readonly help: boolean;
  readonly mode?: 'read_only_diff';
  readonly inputPath?: string;
  readonly outputPath?: string;
  readonly summaryOutputPath?: string;
  readonly statusOutputPath?: string;
}

export async function runSymphonyGraphSyncReadOnlyDiffCli(
  argv: readonly string[],
  options: SymphonyGraphSyncReadOnlyDiffCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      stdout(usage());
      return 0;
    }
    const inputPath = requireFlag(flags.inputPath, '--input');
    const outputPath = requireFlag(flags.outputPath, '--output');
    if (flags.mode !== 'read_only_diff') {
      throw new Error('symphony-graph-sync-diff only supports --mode read_only_diff');
    }
    const receipt = await buildReceiptFromSnapshotFile(inputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    if (flags.summaryOutputPath !== undefined) {
      await mkdir(dirname(flags.summaryOutputPath), { recursive: true });
      await writeFile(
        flags.summaryOutputPath,
        renderGraphSyncReadOnlyDiffSummaryMarkdown({ inputPath, receiptPath: outputPath, receipt }),
        'utf8',
      );
    }
    if (flags.statusOutputPath !== undefined) {
      await mkdir(dirname(flags.statusOutputPath), { recursive: true });
      await writeFile(
        flags.statusOutputPath,
        `${JSON.stringify(buildGraphSyncReadOnlyDiffStatusArtifact({ inputPath, receiptPath: outputPath, receipt }), null, 2)}\n`,
        'utf8',
      );
    }
    stdout(`${JSON.stringify(buildArtifactSummary({
      inputPath,
      outputPath,
      ...(flags.summaryOutputPath === undefined ? {} : { summaryOutputPath: flags.summaryOutputPath }),
      ...(flags.statusOutputPath === undefined ? {} : { statusOutputPath: flags.statusOutputPath }),
      receipt,
    }), null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${JSON.stringify({ ok: false, status: 'BLOCK', error: message }, null, 2)}\n`);
    return 1;
  }
}

async function buildReceiptFromSnapshotFile(inputPath: string): Promise<GraphSyncReadOnlyDiffReceipt> {
  const snapshot = JSON.parse(await readFile(inputPath, 'utf8')) as BuildGraphSyncReadOnlyDiffReceiptInput;
  return buildGraphSyncReadOnlyDiffReceipt(snapshot);
}

function buildArtifactSummary(input: {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly summaryOutputPath?: string;
  readonly statusOutputPath?: string;
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
}): GraphSyncReadOnlyDiffArtifactSummary {
  return {
    ok: true,
    effect: 'graph_sync_read_only_diff_artifact',
    mode: 'read_only_diff',
    input_path: input.inputPath,
    receipt_path: input.outputPath,
    ...(input.summaryOutputPath === undefined ? {} : { summary_md_path: input.summaryOutputPath }),
    ...(input.statusOutputPath === undefined ? {} : { status_json_path: input.statusOutputPath }),
    suppressed_writes: input.receipt.suppressed_writes,
    summary: buildArtifactCountSummary(input.receipt),
    non_actions: input.receipt.non_actions,
  };
}

export function buildGraphSyncReadOnlyDiffStatusArtifact(input: {
  readonly inputPath: string;
  readonly receiptPath: string;
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
}): GraphSyncReadOnlyDiffStatusArtifact {
  const findings = buildGraphSyncReadOnlyDiffStatusFindings(input.receipt);
  return {
    ok: true,
    effect: 'graph_sync_read_only_diff_status',
    status: classifyGraphSyncReadOnlyDiffOperatorStatus(findings),
    mode: 'read_only_diff',
    workflow_id: input.receipt.workflow_id,
    run_id: input.receipt.run_id,
    generated_at: input.receipt.generated_at,
    completed_at: input.receipt.completed_at,
    input_path: input.inputPath,
    receipt_path: input.receiptPath,
    suppressed_writes: input.receipt.suppressed_writes,
    summary: buildArtifactCountSummary(input.receipt),
    findings,
    non_actions: input.receipt.non_actions,
  };
}

export function renderGraphSyncReadOnlyDiffSummaryMarkdown(input: {
  readonly inputPath: string;
  readonly receiptPath: string;
  readonly receipt: GraphSyncReadOnlyDiffReceipt;
}): string {
  const status = buildGraphSyncReadOnlyDiffStatusArtifact(input);
  return `${[
    '# GraphSync read-only diff summary',
    '',
    `Operator status: \`${status.status}\``,
    '',
    'No Linear relation writes, Kanban link writes, service/timer changes, or MCP apply actions were performed.',
    '',
    '## Artifact provenance',
    '',
    `- Input snapshot: ${markdownCode(input.inputPath)}`,
    `- Receipt: ${markdownCode(input.receiptPath)}`,
    `- Workflow: ${markdownCode(status.workflow_id)}`,
    `- Run: ${markdownCode(status.run_id)}`,
    `- Mode: ${markdownCode(status.mode)}`,
    `- Suppressed writes: ${markdownCode(String(status.suppressed_writes))}`,
    '',
    '## Counts',
    '',
    '| Metric | Count |',
    '|---|---:|',
    `| Linear edges seen | ${markdownCount(status.summary.linear_edges_seen)} |`,
    `| Kanban edges seen | ${markdownCount(status.summary.kanban_edges_seen)} |`,
    `| Matched edges | ${markdownCount(status.summary.matched_edges)} |`,
    `| Missing Kanban edges | ${markdownCount(status.summary.missing_kanban_edges)} |`,
    `| Missing Linear relations | ${markdownCount(status.summary.missing_linear_relations)} |`,
    `| Endpoint policies | ${markdownCount(status.summary.endpoint_policies)} |`,
    `| Cycles detected | ${markdownCount(status.summary.cycles_detected)} |`,
    `| Suppressed proposed operations | ${markdownCount(status.summary.proposed_operations)} |`,
    '',
    '## Findings',
    '',
    '| Finding | Count |',
    '|---|---:|',
    `| Errors | ${markdownCount(status.findings.errors)} |`,
    `| Warnings | ${markdownCount(status.findings.warnings)} |`,
    `| Info | ${markdownCount(status.findings.info)} |`,
    `| Conflicts | ${markdownCount(status.findings.conflicts)} |`,
    `| Cycles | ${markdownCount(status.findings.cycles)} |`,
    `| Endpoint policies | ${markdownCount(status.findings.endpoint_policies)} |`,
    `| Suppressed proposed operations | ${markdownCount(status.findings.suppressed_proposed_operations)} |`,
    '',
    '## Human action recommendations',
    '',
    '| Recommendation | Count |',
    '|---|---:|',
    ...humanActionRecommendations.map(
      (recommendation) =>
        `| ${recommendation} | ${markdownCount(status.findings.human_action_recommendations[recommendation])} |`,
    ),
    '',
    '## Explicit non-actions',
    '',
    ...status.non_actions.map((nonAction) => `- ${nonAction}`),
    '',
  ].join('\n')}\n`;
}

function buildArtifactCountSummary(
  receipt: GraphSyncReadOnlyDiffReceipt,
): GraphSyncReadOnlyDiffArtifactSummary['summary'] {
  return {
    linear_edges_seen: receipt.summary.linear_edges_seen,
    kanban_edges_seen: receipt.summary.kanban_edges_seen,
    matched_edges: receipt.summary.matched_edges,
    missing_kanban_edges: receipt.summary.missing_kanban_edges,
    missing_linear_relations: receipt.summary.missing_linear_relations,
    endpoint_policies: receipt.summary.endpoint_policies,
    cycles_detected: receipt.summary.cycles_detected,
    proposed_operations: receipt.proposed_operations.length,
  };
}

function buildGraphSyncReadOnlyDiffStatusFindings(
  receipt: GraphSyncReadOnlyDiffReceipt,
): GraphSyncReadOnlyDiffStatusFindings {
  const severityCounts: Record<GraphSyncFindingSeverity, number> = { info: 0, warning: 0, error: 0 };
  const recommendationCounts: Record<GraphSyncHumanActionRecommendation, number> = {
    none: 0,
    review: 0,
    inspect_endpoint_policy: 0,
    resolve_cycle: 0,
    human_decision_required: 0,
  };

  for (const conflict of Object.values(receipt.ledger.conflicts)) {
    recordFinding(severityCounts, recommendationCounts, conflict);
  }
  for (const cycle of receipt.diff.cycles) {
    recordFinding(severityCounts, recommendationCounts, cycle);
  }
  for (const endpointPolicy of receipt.diff.endpoint_policies) {
    recordFinding(severityCounts, recommendationCounts, endpointPolicy);
  }
  for (const proposedOperation of receipt.proposed_operations) {
    recordFinding(severityCounts, recommendationCounts, proposedOperation);
  }

  return {
    info: severityCounts.info,
    warnings: severityCounts.warning,
    errors: severityCounts.error,
    conflicts: Object.keys(receipt.ledger.conflicts).length,
    cycles: receipt.diff.cycles.length,
    endpoint_policies: receipt.diff.endpoint_policies.length,
    suppressed_proposed_operations: receipt.proposed_operations.length,
    human_action_recommendations: recommendationCounts,
  };
}

function recordFinding(
  severityCounts: Record<GraphSyncFindingSeverity, number>,
  recommendationCounts: Record<GraphSyncHumanActionRecommendation, number>,
  finding: {
    readonly severity: GraphSyncFindingSeverity;
    readonly human_action_recommendation: GraphSyncHumanActionRecommendation;
  },
): void {
  severityCounts[finding.severity] += 1;
  recommendationCounts[finding.human_action_recommendation] += 1;
}

function classifyGraphSyncReadOnlyDiffOperatorStatus(
  findings: GraphSyncReadOnlyDiffStatusFindings,
): GraphSyncReadOnlyDiffOperatorStatus {
  if (findings.errors > 0) {
    return 'BLOCK';
  }
  if (findings.warnings > 0) {
    return 'REVIEW';
  }
  return 'PASS';
}

const humanActionRecommendations: readonly GraphSyncHumanActionRecommendation[] = [
  'none',
  'review',
  'inspect_endpoint_policy',
  'resolve_cycle',
  'human_decision_required',
];

function markdownCode(value: string): string {
  return `\`${value.replaceAll('`', '\\`')}\``;
}

function markdownCount(value: number): string {
  return String(value);
}

function parseFlags(argv: readonly string[]): ParsedGraphSyncReadOnlyDiffFlags {
  let help = false;
  let mode: 'read_only_diff' | undefined;
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let summaryOutputPath: string | undefined;
  let statusOutputPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--mode') {
      const value = readFlagValue(argv, index, arg);
      if (value !== 'read_only_diff') {
        throw new Error('symphony-graph-sync-diff only supports --mode read_only_diff');
      }
      mode = value;
      index += 1;
      continue;
    }
    if (arg === '--input') {
      inputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--output') {
      outputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--summary-output') {
      summaryOutputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--status-output') {
      statusOutputPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    help,
    ...(mode === undefined ? {} : { mode }),
    ...(inputPath === undefined ? {} : { inputPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(summaryOutputPath === undefined ? {} : { summaryOutputPath }),
    ...(statusOutputPath === undefined ? {} : { statusOutputPath }),
  };
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function requireFlag(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage: symphony-graph-sync-diff --mode read_only_diff --input graph-snapshot.json --output receipt.json',
    '',
    'Build a local read-only Linear ↔ Hermes Kanban graph-diff receipt artifact from an explicit JSON snapshot.',
    'This command does not query Linear, read or mutate Hermes Kanban, edit services/timers, or expose an MCP/apply surface.',
    '',
    'Options:',
    '  --mode read_only_diff  Required; the only supported mode',
    '  --input PATH           Local graph snapshot JSON matching BuildGraphSyncReadOnlyDiffReceiptInput',
    '  --output PATH          Local receipt artifact path to write',
    '  --summary-output PATH  Optional local Markdown summary artifact path to write',
    '  --status-output PATH   Optional local status JSON artifact path to write',
    '  --help, -h             Show this help text',
    '',
  ].join('\n');
}

if (isDirectCliExecution(import.meta.url)) {
  process.exitCode = await runSymphonyGraphSyncReadOnlyDiffCli(process.argv.slice(2));
}
