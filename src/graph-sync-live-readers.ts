import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import type { GraphSyncScope } from './graph-sync-ledger.js';
import type { GraphSyncKanbanGraphReader, GraphSyncLinearGraphReader, GraphSyncMappingReader } from './graph-sync-live-snapshot.js';
import type { GraphSyncObservedNodeMapping } from './graph-sync-snapshot-importer.js';
import type { KanbanTaskDetail, KanbanTaskLink, KanbanTaskLinkKind } from './kanban-types.js';
import { LinearTrackerClient, type GraphQLTransport } from './tracker.js';
import type { EffectiveConfig } from './workflow.js';

export interface CreateLinearTrackerGraphSyncLinearReaderInput {
  readonly config: EffectiveConfig;
  readonly transport?: GraphQLTransport;
}

export interface CreateEnrichedHermesKanbanGraphReaderInput {
  readonly inner: GraphSyncKanbanGraphReader;
  readonly board: string;
  readonly crossBoardDbPath: string;
}

export function createBridgeLedgerGraphSyncMappingReader(statePath: string): GraphSyncMappingReader {
  return {
    async readMappings(scope: GraphSyncScope): Promise<readonly GraphSyncObservedNodeMapping[]> {
      const document = parseBridgeLedgerDocument(await readFile(statePath, 'utf8'), statePath);
      return extractBridgeLedgerMappings(document, scope);
    },
  };
}

export function createLinearTrackerGraphSyncLinearReader(
  input: CreateLinearTrackerGraphSyncLinearReaderInput,
): GraphSyncLinearGraphReader {
  return {
    async readIssuesWithRelations(
      _scope: GraphSyncScope,
      mappings: readonly GraphSyncObservedNodeMapping[] = [],
    ) {
      const issueIds = uniqueNonEmptyStrings(mappings.map((mapping) => mapping.linearIssueId));
      if (issueIds.length === 0) {
        throw new Error('GraphSync Linear reader requires at least one bridge ledger mapping');
      }
      const client = new LinearTrackerClient({
        apiKey: requireLinearApiKey(input.config),
        endpoint: input.config.tracker.endpoint,
        projectSlug: input.config.tracker.projectSlug,
        teamKey: input.config.tracker.teamKey,
        allApprovedProjects: input.config.tracker.allApprovedProjects,
        activeStates: input.config.tracker.activeStates,
        terminalStates: input.config.tracker.terminalStates,
        requiredLabels: input.config.tracker.requiredLabels,
        pageSize: Math.max(issueIds.length, 1),
        maxIssuesPerPoll: Math.max(input.config.tracker.maxIssuesPerPoll, issueIds.length),
        ...(input.transport === undefined ? {} : { transport: input.transport }),
      });
      const issues = await client.fetch_issue_states_by_ids(issueIds);
      const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
      const missing = issueIds.filter((issueId) => !issuesById.has(issueId));
      if (missing.length > 0) {
        throw new Error(`Linear graph read did not return mapped issue ids: ${missing.join(', ')}`);
      }
      return issueIds.map((issueId) => {
        const issue = issuesById.get(issueId);
        if (issue === undefined) {
          throw new Error(`Linear graph read lost mapped issue id after validation: ${issueId}`);
        }
        return issue;
      });
    },
  };
}

export function createEnrichedHermesKanbanGraphReader(
  input: CreateEnrichedHermesKanbanGraphReaderInput,
): GraphSyncKanbanGraphReader {
  return {
    async readTaskDetails(taskIds: readonly string[]): Promise<readonly KanbanTaskDetail[]> {
      const tasks = await input.inner.readTaskDetails(taskIds);
      if (tasks.length === 0 || !existsSync(input.crossBoardDbPath)) {
        return tasks;
      }
      const taskIdSet = new Set(tasks.map((task) => task.id));
      const links = readCrossBoardDependencyLinks(input.crossBoardDbPath, input.board, taskIdSet);
      if (links.length === 0) {
        return tasks;
      }
      return tasks.map((task) => enrichTaskWithLinks(task, links));
    },
  };
}

function requireLinearApiKey(config: EffectiveConfig): string {
  const apiKey = config.tracker.apiKey;
  if (apiKey === null || apiKey.trim() === '') {
    throw new Error('GraphSync Linear reader requires tracker.api_key');
  }
  return apiKey;
}

const KANBAN_TASK_LINK_KINDS = new Set<KanbanTaskLinkKind>([
  'blocks',
  'depends_on',
  'depends_on_decision',
  'derived_from_research',
  'feeds',
  'informed_by',
  'related',
  'supersedes',
]);

interface CrossBoardDependencyRow {
  readonly parent_id: string;
  readonly child_id: string;
  readonly kind: string;
  readonly blocking: number | boolean | null;
  readonly source: string | null;
  readonly created_by: string | null;
  readonly required_parent_statuses: string | null;
  readonly metadata: string | null;
}

function readCrossBoardDependencyLinks(
  dbPath: string,
  board: string,
  taskIds: ReadonlySet<string>,
): readonly KanbanTaskLink[] {
  if (taskIds.size === 0) {
    return [];
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      select parent_id, child_id, kind, blocking, source, created_by, required_parent_statuses, metadata
      from cross_board_edges
      where parent_board = ?
        and child_board = ?
    `).all(board, board) as unknown as readonly CrossBoardDependencyRow[];
    return rows
      .filter((row) => taskIds.has(row.parent_id) && taskIds.has(row.child_id))
      .map(rowToKanbanTaskLink);
  } finally {
    db.close();
  }
}

function rowToKanbanTaskLink(row: CrossBoardDependencyRow): KanbanTaskLink {
  return {
    parentTaskId: row.parent_id,
    childTaskId: row.child_id,
    kind: parseKanbanTaskLinkKind(row.kind),
    blocking: row.blocking === true || row.blocking === 1,
    requiredParentStatuses: parseStringList(row.required_parent_statuses),
    source: optionalString(row.source),
    createdBy: optionalString(row.created_by),
    metadata: parseStringRecord(row.metadata),
  };
}

function enrichTaskWithLinks(task: KanbanTaskDetail, links: readonly KanbanTaskLink[]): KanbanTaskDetail {
  return {
    ...task,
    parentLinks: mergeLinks(task.parentLinks, links.filter((link) => link.childTaskId === task.id)),
    childLinks: mergeLinks(task.childLinks, links.filter((link) => link.parentTaskId === task.id)),
  };
}

function mergeLinks(
  existingLinks: readonly KanbanTaskLink[],
  discoveredLinks: readonly KanbanTaskLink[],
): readonly KanbanTaskLink[] {
  const merged: KanbanTaskLink[] = [];
  const seen = new Set<string>();
  for (const link of [...existingLinks, ...discoveredLinks]) {
    const fingerprint = kanbanTaskLinkFingerprint(link);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    merged.push(link);
  }
  return merged;
}

function kanbanTaskLinkFingerprint(link: KanbanTaskLink): string {
  return [link.parentTaskId, link.childTaskId, link.kind].join('\0');
}

function parseKanbanTaskLinkKind(value: string): KanbanTaskLinkKind {
  if (KANBAN_TASK_LINK_KINDS.has(value as KanbanTaskLinkKind)) {
    return value as KanbanTaskLinkKind;
  }
  throw new Error(`Unknown Hermes Kanban task link kind in dependency registry: ${value}`);
}

function parseStringList(value: string | null): readonly string[] {
  if (value === null || value.trim() === '') {
    return [];
  }
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      // Fall through to comma-separated parsing.
    }
  }
  return trimmed.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

function parseStringRecord(value: string | null): Readonly<Record<string, string>> {
  if (value === null || value.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, field] of Object.entries(parsed)) {
    if (typeof field === 'string') {
      output[key] = field;
    }
  }
  return output;
}

interface BridgeLedgerDocumentLike {
  readonly events: readonly BridgeLedgerEventLike[];
}

interface BridgeLedgerEventLike {
  readonly kind: string;
  readonly issue_id: string;
  readonly details: Readonly<Record<string, unknown>>;
}

function parseBridgeLedgerDocument(content: string, statePath: string): BridgeLedgerDocumentLike {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse bridge ledger ${statePath}: ${message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['events'])) {
    throw new Error(`Bridge ledger ${statePath} is missing events[]`);
  }
  const events: BridgeLedgerEventLike[] = [];
  for (const rawEvent of parsed['events']) {
    if (!isRecord(rawEvent)) {
      continue;
    }
    const kind = optionalString(rawEvent['kind']);
    const issueId = optionalString(rawEvent['issue_id']);
    const details = rawEvent['details'];
    if (kind === null || issueId === null || !isRecord(details)) {
      continue;
    }
    events.push({ kind, issue_id: issueId, details });
  }
  return { events };
}

function extractBridgeLedgerMappings(
  document: BridgeLedgerDocumentLike,
  scope: GraphSyncScope,
): readonly GraphSyncObservedNodeMapping[] {
  const expectedBoard = scopeKanbanBoard(scope);
  const taskByIssue = new Map<string, string>();
  for (const event of document.events) {
    if (event.kind !== 'mutation_recorded') {
      continue;
    }
    if (optionalString(event.details['key']) !== 'kanban:task:materialized') {
      continue;
    }
    const taskId = optionalString(event.details['task_id']);
    if (taskId === null) {
      continue;
    }
    const board = optionalString(event.details['board']);
    if (expectedBoard !== null && board !== null && board !== expectedBoard) {
      continue;
    }
    const existing = taskByIssue.get(event.issue_id);
    if (existing !== undefined && existing !== taskId) {
      throw new Error(`Bridge ledger has conflicting Kanban task mappings for Linear issue ${event.issue_id}: ${existing}, ${taskId}`);
    }
    taskByIssue.set(event.issue_id, taskId);
  }
  return Array.from(taskByIssue.entries()).map(([linearIssueId, kanbanTaskId]) => ({
    linearIssueId,
    kanbanTaskId,
  }));
}

function scopeKanbanBoard(scope: GraphSyncScope): string | null {
  const snake = scope['kanban_board'];
  if (typeof snake === 'string' && snake.trim() !== '') {
    return snake;
  }
  const camel = scope['kanbanBoard'];
  if (typeof camel === 'string' && camel.trim() !== '') {
    return camel;
  }
  return null;
}

function uniqueNonEmptyStrings(values: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized === '' || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
