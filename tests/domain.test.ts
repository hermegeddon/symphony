import { describe, expect, it } from 'vitest';

import {
  createEmptyOrchestratorRuntimeState,
  normalizeIssueStateName,
  sanitizeWorkspaceKeyFromIssue,
  toSessionId,
  type Issue,
  type LiveSession,
  type OrchestratorRuntimeState,
  type RetryEntry,
  type RunAttempt,
  type Workspace,
  type WorkflowDefinition,
} from '../src/domain.js';

describe('normalized domain model', () => {
  it('exposes tightly typed Section 4 entities without unbounded any maps', () => {
    const issue: Issue = {
      id: 'lin_1',
      identifier: 'OPS-123',
      title: 'Implement tracker reader',
      description: null,
      priority: 2,
      state: 'In Progress',
      branch_name: 'janusz/ops-123',
      url: 'https://linear.app/example/issue/OPS-123',
      labels: ['backend'],
      blocked_by: [{ id: 'lin_0', identifier: 'OPS-122', state: 'Done' }],
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
    };
    const workflow: WorkflowDefinition = { config: {}, prompt_template: 'Work on {{ issue.identifier }}.' };
    const workspace: Workspace = { path: '/tmp/symphony/OPS-123', workspace_key: 'OPS-123', created_now: true };
    const run: RunAttempt = {
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      attempt: null,
      workspace_path: workspace.path,
      started_at: new Date('2026-01-03T00:00:00.000Z'),
      status: 'PreparingWorkspace',
    };
    const session: LiveSession = {
      session_id: toSessionId('thread-a', 'turn-b'),
      thread_id: 'thread-a',
      turn_id: 'turn-b',
      codex_app_server_pid: null,
      last_codex_event: null,
      last_codex_timestamp: null,
      last_codex_message: null,
      codex_input_tokens: 0,
      codex_output_tokens: 0,
      codex_total_tokens: 0,
      last_reported_input_tokens: 0,
      last_reported_output_tokens: 0,
      last_reported_total_tokens: 0,
      turn_count: 1,
    };
    const retry: RetryEntry = {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt: 1,
      due_at_ms: 10_000,
      timer_handle: null,
      error: null,
    };
    const state: OrchestratorRuntimeState = createEmptyOrchestratorRuntimeState({
      poll_interval_ms: 30_000,
      max_concurrent_agents: 10,
    });

    expect(issue.labels).toEqual(['backend']);
    expect(workflow.prompt_template).toContain('{{ issue.identifier }}');
    expect(workspace.workspace_key).toBe('OPS-123');
    expect(run.status).toBe('PreparingWorkspace');
    expect(session.session_id).toBe('thread-a-turn-b');
    expect(retry.error).toBeNull();
    expect(state.running.size).toBe(0);
  });

  it('normalizes workspace keys and issue state comparisons per the spec', () => {
    expect(sanitizeWorkspaceKeyFromIssue('ABC/123 snowman☃')).toBe('ABC_123_snowman_');
    expect(normalizeIssueStateName('In Progress')).toBe('in progress');
    expect(toSessionId('thread-1', 'turn-2')).toBe('thread-1-turn-2');
  });
});
