import { describe, expect, it } from 'vitest';

import { checkKanbanReadiness, type KanbanReadinessProbeClient } from '../src/kanban-readiness.js';
import type { KanbanBackendConfig } from '../src/workflow.js';

function kanbanConfig(overrides: Partial<KanbanBackendConfig> = {}): KanbanBackendConfig {
  return {
    hermesCommand: '/safe/bin/hermes',
    hermesHome: '/tmp/hermes-home',
    board: 'symphony-test',
    boardCreate: false,
    dispatch: 'dry_run',
    dispatchPolicy: 'dispatchable',
    defaultAssignee: 'default',
    artifactRoot: '/tmp/artifacts/symphony-test',
    workspace: { kind: 'worktree', root: '/tmp/worktrees/symphony-test' },
    safety: {
      requireProfilePreflight: true,
      requireReviewGateForRepoMutation: true,
      requireHumanGateForExternalActions: true,
    },
    ...overrides,
  };
}

function fakeReadinessClient(overrides: Partial<KanbanReadinessProbeClient> = {}) {
  const calls: string[] = [];
  const client: KanbanReadinessProbeClient = {
    boardsList: () => {
      calls.push('boardsList');
      return Promise.resolve([{ slug: 'symphony-test', name: 'Symphony Test', archived: false }]);
    },
    assigneesList: () => {
      calls.push('assigneesList');
      return Promise.resolve([{ name: 'default', onDisk: true }]);
    },
    dispatchDryRun: () => {
      calls.push('dispatchDryRun');
      return Promise.resolve({ spawned: [], autoAssignedDefault: [], skippedNonspawnable: [] });
    },
    ...overrides,
  };
  return { calls, client };
}

describe('Kanban backend readiness checks', () => {
  it('reports a read-only ready state for an existing board and validated default assignee', async () => {
    const { calls, client } = fakeReadinessClient();

    await expect(checkKanbanReadiness({
      config: kanbanConfig(),
      client,
      commandExists: () => Promise.resolve(true),
    })).resolves.toEqual({
      effect: 'check_only',
      ok: true,
      checks: {
        hermes_command_available: true,
        board: 'symphony-test',
        board_exists: true,
        board_create_configured: false,
        board_create_allowed_for_temp_scope: false,
        board_setup_required: false,
        default_assignee: 'default',
        default_assignee_available: true,
        dispatch_mode: 'dry_run',
        dispatch_dry_run_ok: true,
        dispatch_would_spawn: false,
        service_would_start: false,
        tasks_would_create: false,
        board_would_create: false,
        gateway_dispatch_would_start: false,
      },
      errors: [],
    });
    expect(calls).toEqual(['boardsList', 'assigneesList', 'dispatchDryRun']);
  });

  it('fails closed without creating a missing board or touching dispatch when board setup is still required', async () => {
    const { calls, client } = fakeReadinessClient({
      boardsList: () => {
        calls.push('boardsList');
        return Promise.resolve([]);
      },
    });

    const readiness = await checkKanbanReadiness({
      config: kanbanConfig({ board: 'tmp-symphony-smoke', boardCreate: true }),
      client,
      commandExists: () => Promise.resolve(true),
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks).toMatchObject({
      board: 'tmp-symphony-smoke',
      board_exists: false,
      board_create_configured: true,
      board_create_allowed_for_temp_scope: true,
      board_setup_required: true,
      tasks_would_create: false,
      board_would_create: false,
      dispatch_would_spawn: false,
    });
    expect(readiness.errors).toContainEqual({
      code: 'kanban_board_missing',
      field: 'kanban.board',
      message: 'Kanban board tmp-symphony-smoke does not exist; create it in an explicit setup/apply step before service use',
    });
    expect(calls).toEqual(['boardsList', 'assigneesList']);
  });

  it('fails closed when profile preflight is required and the configured assignee is not available on disk', async () => {
    const { client } = fakeReadinessClient({
      assigneesList: () => Promise.resolve([{ name: 'default', onDisk: false }]),
    });

    const readiness = await checkKanbanReadiness({
      config: kanbanConfig(),
      client,
      commandExists: () => Promise.resolve(true),
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.checks.default_assignee_available).toBe(false);
    expect(readiness.errors).toContainEqual({
      code: 'kanban_default_assignee_unavailable',
      field: 'kanban.default_assignee',
      message: 'Kanban default assignee default is not available on disk',
    });
  });
});
