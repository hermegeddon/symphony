import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Issue } from './domain.js';
import type { LinearReceiptJson } from './tracker.js';

export type IssueRunLedgerRunStatus = 'running' | 'completed' | 'failed' | 'canceled' | 'interrupted' | 'mutation_only';

export interface IssueRunLedgerRunRecord {
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly status: IssueRunLedgerRunStatus;
  readonly run_id: string | null;
  readonly attempt: number;
  readonly workspace_path: string | null;
  readonly started_at: string | null;
  readonly updated_at: string;
  readonly last_error: string | null;
  readonly mutation_keys: readonly string[];
}

export interface IssueRunLedgerEvent {
  readonly at: string;
  readonly kind: 'run_started' | 'run_completed' | 'run_failed' | 'run_canceled' | 'run_interrupted' | 'mutation_recorded';
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly run_id: string | null;
  readonly details: Readonly<Record<string, LinearReceiptJson>>;
}

export interface IssueRunLedgerDocument {
  readonly version: 1;
  readonly generated_by: 'symphony-ts';
  readonly runs: Readonly<Record<string, IssueRunLedgerRunRecord>>;
  readonly events: readonly IssueRunLedgerEvent[];
}

export interface RecordIssueRunStartedInput {
  readonly issue: Issue;
  readonly runId: string;
  readonly attempt: number;
  readonly workspacePath: string;
  readonly at: Date;
}

export interface RecordIssueRunCompletedInput {
  readonly issue: Issue;
  readonly runId: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly at: Date;
}

export interface RecordIssueRunCanceledInput {
  readonly issue: Issue;
  readonly runId: string;
  readonly reason: string;
  readonly at: Date;
}

export interface RecordIssueMutationInput {
  readonly issue: Issue;
  readonly key: string;
  readonly operation: string;
  readonly at: Date;
  readonly details?: Readonly<Record<string, LinearReceiptJson>>;
}

export interface IssueRunLedger {
  readonly path: string;
  createRunId(issue: Issue): string;
  completedIssueIds(): readonly string[];
  recoverInterruptedRuns(at: Date): readonly IssueRunLedgerRunRecord[];
  recordRunStarted(input: RecordIssueRunStartedInput): void;
  recordRunCompleted(input: RecordIssueRunCompletedInput): void;
  recordRunCanceled(input: RecordIssueRunCanceledInput): void;
  hasMutation(issueId: string, key: string): boolean;
  recordMutation(input: RecordIssueMutationInput): void;
  snapshot(): IssueRunLedgerDocument;
}

export class JsonFileIssueRunLedger implements IssueRunLedger {
  public readonly path: string;
  private document: IssueRunLedgerDocument;

  public constructor(path: string) {
    this.path = resolve(path);
    this.document = readLedgerDocument(this.path);
    this.write();
  }

  public createRunId(issue: Issue): string {
    return `${issue.identifier}-${randomUUID()}`;
  }

  public completedIssueIds(): readonly string[] {
    return Object.values(this.document.runs)
      .filter((record) => record.status === 'completed')
      .map((record) => record.issue_id);
  }

  public recoverInterruptedRuns(at: Date): readonly IssueRunLedgerRunRecord[] {
    const interrupted: IssueRunLedgerRunRecord[] = [];
    let changed = false;
    const runs: Record<string, IssueRunLedgerRunRecord> = { ...this.document.runs };
    for (const record of Object.values(runs)) {
      if (record.status !== 'running') {
        continue;
      }
      const nextRecord: IssueRunLedgerRunRecord = {
        ...record,
        status: 'interrupted',
        updated_at: at.toISOString(),
        last_error: 'service restarted before run completed',
      };
      runs[record.issue_id] = nextRecord;
      interrupted.push(nextRecord);
      changed = true;
      this.pushEvent({
        at,
        kind: 'run_interrupted',
        issue: { id: record.issue_id, identifier: record.issue_identifier },
        runId: record.run_id,
        details: { previous_status: record.status, reason: 'service restarted before run completed' },
      });
    }
    if (changed) {
      this.document = { ...this.document, runs };
      this.write();
    }
    return interrupted;
  }

  public recordRunStarted(input: RecordIssueRunStartedInput): void {
    const previous = this.document.runs[input.issue.id];
    const record: IssueRunLedgerRunRecord = {
      issue_id: input.issue.id,
      issue_identifier: input.issue.identifier,
      status: 'running',
      run_id: input.runId,
      attempt: input.attempt,
      workspace_path: input.workspacePath,
      started_at: input.at.toISOString(),
      updated_at: input.at.toISOString(),
      last_error: null,
      mutation_keys: previous?.mutation_keys ?? [],
    };
    this.document = {
      ...this.document,
      runs: { ...this.document.runs, [input.issue.id]: record },
    };
    this.pushEvent({
      at: input.at,
      kind: 'run_started',
      issue: input.issue,
      runId: input.runId,
      details: { attempt: input.attempt, workspace_path: input.workspacePath },
    });
    this.write();
  }

  public recordRunCompleted(input: RecordIssueRunCompletedInput): void {
    const previous = this.document.runs[input.issue.id];
    const record: IssueRunLedgerRunRecord = {
      issue_id: input.issue.id,
      issue_identifier: input.issue.identifier,
      status: input.ok ? 'completed' : 'failed',
      run_id: input.runId,
      attempt: previous?.attempt ?? 0,
      workspace_path: previous?.workspace_path ?? null,
      started_at: previous?.started_at ?? null,
      updated_at: input.at.toISOString(),
      last_error: input.error,
      mutation_keys: previous?.mutation_keys ?? [],
    };
    this.document = {
      ...this.document,
      runs: { ...this.document.runs, [input.issue.id]: record },
    };
    this.pushEvent({
      at: input.at,
      kind: input.ok ? 'run_completed' : 'run_failed',
      issue: input.issue,
      runId: input.runId,
      details: input.error === null ? {} : { error: input.error },
    });
    this.write();
  }

  public recordRunCanceled(input: RecordIssueRunCanceledInput): void {
    const previous = this.document.runs[input.issue.id];
    const record: IssueRunLedgerRunRecord = {
      issue_id: input.issue.id,
      issue_identifier: input.issue.identifier,
      status: 'canceled',
      run_id: input.runId,
      attempt: previous?.attempt ?? 0,
      workspace_path: previous?.workspace_path ?? null,
      started_at: previous?.started_at ?? null,
      updated_at: input.at.toISOString(),
      last_error: input.reason,
      mutation_keys: previous?.mutation_keys ?? [],
    };
    this.document = {
      ...this.document,
      runs: { ...this.document.runs, [input.issue.id]: record },
    };
    this.pushEvent({
      at: input.at,
      kind: 'run_canceled',
      issue: input.issue,
      runId: input.runId,
      details: { reason: input.reason },
    });
    this.write();
  }

  public hasMutation(issueId: string, key: string): boolean {
    return this.document.runs[issueId]?.mutation_keys.includes(key) ?? false;
  }

  public recordMutation(input: RecordIssueMutationInput): void {
    const previous = this.document.runs[input.issue.id] ?? emptyRunRecord(input.issue, input.at);
    const mutationKeys = previous.mutation_keys.includes(input.key)
      ? previous.mutation_keys
      : [...previous.mutation_keys, input.key];
    const record: IssueRunLedgerRunRecord = {
      ...previous,
      issue_identifier: input.issue.identifier,
      updated_at: input.at.toISOString(),
      mutation_keys: mutationKeys,
    };
    this.document = {
      ...this.document,
      runs: { ...this.document.runs, [input.issue.id]: record },
    };
    this.pushEvent({
      at: input.at,
      kind: 'mutation_recorded',
      issue: input.issue,
      runId: record.run_id,
      details: { key: input.key, operation: input.operation, ...(input.details ?? {}) },
    });
    this.write();
  }

  public snapshot(): IssueRunLedgerDocument {
    return JSON.parse(JSON.stringify(this.document)) as IssueRunLedgerDocument;
  }

  private pushEvent(input: {
    readonly at: Date;
    readonly kind: IssueRunLedgerEvent['kind'];
    readonly issue: Pick<Issue, 'id' | 'identifier'>;
    readonly runId: string | null;
    readonly details: Readonly<Record<string, LinearReceiptJson>>;
  }): void {
    const event: IssueRunLedgerEvent = {
      at: input.at.toISOString(),
      kind: input.kind,
      issue_id: input.issue.id,
      issue_identifier: input.issue.identifier,
      run_id: input.runId,
      details: input.details,
    };
    this.document = { ...this.document, events: [...this.document.events, event].slice(-1000) };
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.path);
  }
}

function readLedgerDocument(path: string): IssueRunLedgerDocument {
  if (!existsSync(path)) {
    return emptyLedgerDocument();
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isLedgerDocument(parsed)) {
    return emptyLedgerDocument();
  }
  return normalizeLedgerDocument(parsed);
}

function normalizeLedgerDocument(document: IssueRunLedgerDocument): IssueRunLedgerDocument {
  let changed = false;
  const runs: Record<string, IssueRunLedgerRunRecord> = {};
  for (const [issueId, record] of Object.entries(document.runs)) {
    if (isLegacyMutationOnlyFailedRecord(record)) {
      runs[issueId] = { ...record, status: 'mutation_only' };
      changed = true;
      continue;
    }
    runs[issueId] = record;
  }
  return changed ? { ...document, runs } : document;
}

function isLegacyMutationOnlyFailedRecord(record: IssueRunLedgerRunRecord): boolean {
  return record.status === 'failed'
    && record.run_id === null
    && record.started_at === null
    && record.last_error === null
    && record.mutation_keys.length > 0;
}

function emptyLedgerDocument(): IssueRunLedgerDocument {
  return { version: 1, generated_by: 'symphony-ts', runs: {}, events: [] };
}

function emptyRunRecord(issue: Issue, at: Date): IssueRunLedgerRunRecord {
  return {
    issue_id: issue.id,
    issue_identifier: issue.identifier,
    status: 'mutation_only',
    run_id: null,
    attempt: 0,
    workspace_path: null,
    started_at: null,
    updated_at: at.toISOString(),
    last_error: null,
    mutation_keys: [],
  };
}

function isLedgerDocument(value: unknown): value is IssueRunLedgerDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as { readonly version?: unknown; readonly generated_by?: unknown; readonly runs?: unknown; readonly events?: unknown };
  return record.version === 1
    && record.generated_by === 'symphony-ts'
    && typeof record.runs === 'object'
    && record.runs !== null
    && !Array.isArray(record.runs)
    && Array.isArray(record.events);
}
