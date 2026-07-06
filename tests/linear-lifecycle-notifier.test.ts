import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Issue } from '../src/domain.js';
import { JsonFileIssueRunLedger } from '../src/issue-run-ledger.js';
import { LinearIssueLifecycleNotifier, sanitizeLinearCommentBody } from '../src/linear-lifecycle-notifier.js';
import type { LinearIssueMutationClient } from '../src/tracker.js';

const issue: Issue = {
  id: 'issue-1',
  identifier: 'HER-1',
  title: 'Live mutation test',
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

function fakeClient() {
  const createComment = vi.fn((input: { readonly issueId: string; readonly body: string }) => Promise.resolve({ comment_id: 'comment-1', comment_url: 'https://linear.app/acme/comment/comment-1', input }));
  const updateIssueState = vi.fn(() => Promise.resolve());
  const client = { createComment, updateIssueState } as unknown as LinearIssueMutationClient;
  return { createComment, updateIssueState, client };
}

describe('LinearIssueLifecycleNotifier', () => {
  it('uses ledger mutation keys to avoid duplicate Linear comments and state transitions after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-notifier-'));
    const ledgerPath = join(root, 'ledger.json');
    const ledger = new JsonFileIssueRunLedger(ledgerPath);
    ledger.recordRunStarted({ issue, runId: 'run-1', attempt: 0, workspacePath: join(root, 'workspace'), at: new Date('2026-06-23T00:00:00.000Z') });
    const { createComment, updateIssueState, client } = fakeClient();
    const config = {
      enabled: true,
      commentOnStart: true,
      commentOnCompletion: true,
      commentOnFailure: true,
      startStateId: 'state-started',
      completedStateId: 'state-completed',
      failedStateId: 'state-failed',
      commentMarker: 'symphony-ts',
    };

    const notifier = new LinearIssueLifecycleNotifier(client, ledger, config);
    await notifier.onIssueStarted({ issue, runId: 'run-1', attempt: 0, workspacePath: join(root, 'workspace') });
    await notifier.onIssueStarted({ issue, runId: 'run-1', attempt: 0, workspacePath: join(root, 'workspace') });

    const reloadedNotifier = new LinearIssueLifecycleNotifier(client, new JsonFileIssueRunLedger(ledgerPath), config);
    await reloadedNotifier.onIssueCompleted({ issue, runId: 'run-1', completion: { ok: true } });
    await reloadedNotifier.onIssueCompleted({ issue, runId: 'run-1', completion: { ok: true } });

    expect(updateIssueState).toHaveBeenCalledTimes(2);
    expect(updateIssueState).toHaveBeenNthCalledWith(1, { issueId: 'issue-1', stateId: 'state-started' });
    expect(updateIssueState).toHaveBeenNthCalledWith(2, { issueId: 'issue-1', stateId: 'state-completed' });
    expect(createComment).toHaveBeenCalledTimes(2);
    expect(createComment).toHaveBeenNthCalledWith(1, expect.objectContaining({ issueId: 'issue-1' }));
    expect(createComment).toHaveBeenNthCalledWith(2, expect.objectContaining({ issueId: 'issue-1' }));
  });

  it('never includes the workspacePath or any absolute local path in start/complete Linear comment bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-notifier-privacy-'));
    const ledgerPath = join(root, 'ledger.json');
    const ledger = new JsonFileIssueRunLedger(ledgerPath);
    const { createComment, client } = fakeClient();
    const notifier = new LinearIssueLifecycleNotifier(client, ledger, {
      enabled: true,
      commentOnStart: true,
      commentOnCompletion: true,
      commentOnFailure: true,
      startStateId: 'state-started',
      completedStateId: 'state-completed',
      failedStateId: 'state-failed',
      commentMarker: 'symphony-ts',
    });

    await notifier.onIssueStarted({ issue, runId: 'run-1', attempt: 0, workspacePath: join(root, 'workspace') });
    await notifier.onIssueCompleted({ issue, runId: 'run-1', completion: { ok: true } });

    expect(createComment).toHaveBeenCalledTimes(2);
    const startBody = createComment.mock.calls[0]?.[0]?.body ?? '';
    const completeBody = createComment.mock.calls[1]?.[0]?.body ?? '';
    expect(startBody).toContain('Symphony picked up HER-1');
    expect(completeBody).toContain('Symphony completed HER-1');
    expect(startBody).not.toContain(root);
    expect(startBody).not.toContain('/home/');
    expect(startBody).not.toContain('/tmp/');
    expect(completeBody).not.toContain(root);
    expect(completeBody).not.toContain('/home/');
    expect(completeBody).not.toContain('/tmp/');
  });

  it('redacts local paths and private dot-directories from failure/cancel reasons before posting to Linear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-linear-notifier-sanitize-'));
    const ledgerPath = join(root, 'ledger.json');
    const ledger = new JsonFileIssueRunLedger(ledgerPath);
    const { createComment, client } = fakeClient();
    const notifier = new LinearIssueLifecycleNotifier(client, ledger, {
      enabled: true,
      commentOnStart: false,
      commentOnCompletion: false,
      commentOnFailure: true,
      startStateId: null,
      completedStateId: null,
      failedStateId: null,
      commentMarker: 'symphony-ts',
    });

    await notifier.onIssueCompleted({
      issue,
      runId: 'run-2',
      completion: { ok: false, error: `Command failed in ${join(root, 'workspace')} reading /home/symphony-user/.hermes/secrets` },
    });
    await notifier.onIssueCanceled({ issue, runId: 'run-2', reason: `Hook path ${join(root, 'hook')} is not inside /mnt/data/.hermes` });

    expect(createComment).toHaveBeenCalledTimes(2);
    const failedBody = createComment.mock.calls[0]?.[0]?.body ?? '';
    const canceledBody = createComment.mock.calls[1]?.[0]?.body ?? '';
    expect(failedBody).not.toContain(root);
    expect(failedBody).not.toContain('/home/symphony-user/.hermes/secrets');
    expect(failedBody).toContain('[REDACTED');
    expect(canceledBody).not.toContain(root);
    expect(canceledBody).not.toContain('/mnt/data/.hermes');
    expect(canceledBody).toContain('[REDACTED');
  });

  it('sanitizes arbitrary local paths and dot-directories via sanitizeLinearCommentBody', () => {
    const raw = [
      'Run failed in /home/user/projects/symphony-ts',
      'Config: C:\\Users\\user\\.hermes\\config.yaml',
      'Share: \\\\server\\share\\secrets',
      'URL: file:///home/user/.ssh/id_rsa',
      'Token already redacted: [REDACTED_TOKEN]',
      'Safe plain token stays: abc123',
    ].join('\n');
    const sanitized = sanitizeLinearCommentBody(raw);
    expect(sanitized).toContain('Run failed in [REDACTED_PATH]');
    expect(sanitized).toContain('Config: [REDACTED_PATH]');
    expect(sanitized).toContain('Share: [REDACTED_PATH]');
    expect(sanitized).toContain('URL: [REDACTED_URL]');
    expect(sanitized).toContain('Token already redacted: [REDACTED_TOKEN]');
    expect(sanitized).not.toContain('/home/user/projects/symphony-ts');
    expect(sanitized).not.toContain('C:\\Users\\user\\.hermes\\config.yaml');
    expect(sanitized).not.toContain('\\\\server\\share\\secrets');
    expect(sanitized).not.toContain('file:///home/user/.ssh/id_rsa');
    expect(sanitized).toContain('Safe plain token stays: abc123');
  });
});
