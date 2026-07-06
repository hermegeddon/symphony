import type { Issue } from './domain.js';
import type { IssueRunLedger } from './issue-run-ledger.js';
import type { OrchestratorIssueLifecycleNotifier, OrchestratorLifecycleCompletionInput, OrchestratorLifecycleStartedInput } from './orchestrator.js';
import type { LinearIssueMutationClient } from './tracker.js';

export interface LinearIssueLifecycleMutationConfig {
  readonly enabled: boolean;
  readonly commentOnStart: boolean;
  readonly commentOnCompletion: boolean;
  readonly commentOnFailure: boolean;
  readonly startStateId: string | null;
  readonly completedStateId: string | null;
  readonly failedStateId: string | null;
  readonly commentMarker: string;
}

export class LinearIssueLifecycleNotifier implements OrchestratorIssueLifecycleNotifier {
  public constructor(
    private readonly client: LinearIssueMutationClient,
    private readonly ledger: IssueRunLedger,
    private readonly config: LinearIssueLifecycleMutationConfig,
  ) {}

  public async onIssueStarted(input: OrchestratorLifecycleStartedInput): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    // S-COMMENT-01 interlock: never echo the local workspacePath (or any absolute
    // local path) to Linear. We deliberately destructure only safe, non-local fields
    // here so a future refactor cannot accidentally thread workspacePath into the
    // comment template.
    const { issue, runId } = input;
    if (this.config.startStateId !== null) {
      await this.updateStateOnce(issue, `linear:state:start:${this.config.startStateId}`, this.config.startStateId);
    }
    if (this.config.commentOnStart) {
      await this.commentOnce(issue, 'linear:comment:start', buildStartComment(this.config.commentMarker, issue, runId));
    }
  }

  public async onIssueCompleted(input: OrchestratorLifecycleCompletionInput): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    if (!input.completion.ok) {
      await this.onIssueFailed(input);
      return;
    }
    const { issue, runId } = input;
    if (this.config.completedStateId !== null) {
      await this.updateStateOnce(issue, `linear:state:completed:${this.config.completedStateId}`, this.config.completedStateId);
    }
    if (this.config.commentOnCompletion) {
      await this.commentOnce(issue, 'linear:comment:completed', buildCompletionComment(this.config.commentMarker, issue, runId));
    }
  }

  public async onIssueCanceled(input: { readonly issue: Issue; readonly runId: string; readonly reason: string }): Promise<void> {
    if (!this.config.enabled || !this.config.commentOnFailure) {
      return;
    }
    const { issue, runId, reason } = input;
    await this.commentOnce(issue, `linear:comment:canceled:${reason}`, [
      marker(this.config.commentMarker, `linear:comment:canceled:${reason}`),
      `Symphony canceled ${issue.identifier}: ${sanitizeLinearCommentBody(reason)}`,
      `Run: ${runId}`,
    ].join('\n'));
  }

  public async onIssueFailed(input: OrchestratorLifecycleCompletionInput): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    const { issue, runId } = input;
    if (this.config.failedStateId !== null) {
      await this.updateStateOnce(issue, `linear:state:failed:${this.config.failedStateId}`, this.config.failedStateId);
    }
    if (this.config.commentOnFailure) {
      await this.commentOnce(issue, 'linear:comment:failed', [
        marker(this.config.commentMarker, 'linear:comment:failed'),
        `Symphony could not complete ${issue.identifier}.`,
        `Run: ${runId}`,
        `Reason: ${sanitizeLinearCommentBody(truncate(input.completion.error ?? 'worker failed'))}`,
      ].join('\n'));
    }
  }

  private async commentOnce(issue: Issue, key: string, body: string): Promise<void> {
    if (this.ledger.hasMutation(issue.id, key)) {
      return;
    }
    const redactedBody = sanitizeLinearCommentBody(body);
    if (redactedBody.trim() === '') {
      return;
    }
    const receipt = await this.client.createComment({ issueId: issue.id, body: redactedBody });
    this.ledger.recordMutation({
      issue,
      key,
      operation: 'commentCreate',
      at: new Date(),
      details: { comment_id: receipt.comment_id, comment_url: receipt.comment_url },
    });
  }

  private async updateStateOnce(issue: Issue, key: string, stateId: string): Promise<void> {
    if (this.ledger.hasMutation(issue.id, key)) {
      return;
    }
    await this.client.updateIssueState({ issueId: issue.id, stateId });
    this.ledger.recordMutation({
      issue,
      key,
      operation: 'issueUpdate',
      at: new Date(),
      details: { state_id: stateId },
    });
  }
}

function marker(namespace: string, key: string): string {
  return `<!-- ${namespace}:${key} -->`;
}

function buildStartComment(markerNamespace: string, issue: Issue, runId: string): string {
  return [
    marker(markerNamespace, 'linear:comment:start'),
    `Symphony picked up ${issue.identifier}.`,
    `Run: ${runId}`,
  ].join('\n');
}

function buildCompletionComment(markerNamespace: string, issue: Issue, runId: string): string {
  return [
    marker(markerNamespace, 'linear:comment:completed'),
    `Symphony completed ${issue.identifier}.`,
    `Run: ${runId}`,
  ].join('\n');
}

function truncate(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

const LOCAL_PATH_PREFIXES = [
  '/home/',
  '/Users/',
  '/root/',
  '/tmp/',
  '/var/',
  '/opt/',
  '/mnt/',
];

const PRIVATE_DOT_DIR = /\.(?:hermes|ssh|gnupg|aws|kube|env)(?:\/[^\s]*|[^\s]*)?/i;

const URL_SCHEME_PATTERN = /^(?:file|smb|nfs|afs|ftp|ftps|sftp|ssh|scp|rsync):\/\/[^\s]+$/i;
const WINDOWS_DRIVE_PATTERN = /\b[a-zA-Z]:\\/;
const UNC_PATTERN = /\\\\[^\s]+/;

/**
 * Sanitizes text that may be posted as a Linear comment so that absolute local
 * filesystem paths and private dot-directory paths do not leak to an external
 * SaaS tracker. Used by `LinearIssueLifecycleNotifier` for every outbound comment
 * body, and also by any other surface that builds Linear-visible text from local
 * runtime data.
 *
 * The function intentionally does not try to be a secret-scanner for arbitrary
 * API keys; token redaction happens earlier in receipt/transport layers. It
 * specifically targets local-path privacy (the S-COMMENT-01 acceptance
 * criteria): paths under /home, /Users, /root, /tmp, /var, /opt, /mnt, Windows
 * drive letters, UNC shares, and dot-directories such as `.hermes`, `.ssh`, `.env`.
 */
export function sanitizeLinearCommentBody(body: string): string {
  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (isAbsoluteLocalPathLine(trimmed)) {
        return '';
      }
      return line
        .split(/(\s+)/)
        .map((token, index) => {
          // Keep whitespace separators as-is; only inspect text tokens.
          if (index % 2 === 1 || token.trim() === '') {
            return token;
          }
          if (token.includes('[REDACTED')) {
            return token;
          }
          if (URL_SCHEME_PATTERN.test(token)) {
            return '[REDACTED_URL]';
          }
          if (WINDOWS_DRIVE_PATTERN.test(token)) {
            return '[REDACTED_PATH]';
          }
          if (UNC_PATTERN.test(token)) {
            return '[REDACTED_PATH]';
          }
          if (token.startsWith('/')) {
            if (PRIVATE_DOT_DIR.test(token)) {
              return '[REDACTED_PRIVATE_PATH]';
            }
            return '[REDACTED_PATH]';
          }
          return token;
        })
        .join('');
    })
    .filter((line) => line.trim() !== '')
    .join('\n');
}

function isAbsoluteLocalPathLine(trimmed: string): boolean {
  if (/^[a-zA-Z]:\\/.test(trimmed) || trimmed.startsWith('\\\\')) {
    return true;
  }
  return LOCAL_PATH_PREFIXES.some((prefix) => trimmed.toLowerCase().startsWith(prefix.toLowerCase()));
}
