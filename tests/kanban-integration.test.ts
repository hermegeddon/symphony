import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { startSymphonyControlPlane } from '../src/control-plane.js';
import { HermesKanbanCliClient } from '../src/kanban-client.js';
import { materializeKanbanTaskGraph } from '../src/kanban-graph-materializer.js';
import { checkKanbanReadiness } from '../src/kanban-readiness.js';
import { createKanbanServiceFacade } from '../src/kanban-service.js';
import type { KanbanBackendConfig } from '../src/workflow.js';

const HERMES_COMMAND = process.env['SYMPHONY_KANBAN_HERMES_COMMAND'] ?? 'hermes';

function kanbanConfig(hermesHome: string, board: string): KanbanBackendConfig {
  return {
    hermesCommand: HERMES_COMMAND,
    hermesHome,
    board,
    boardCreate: false,
    dispatch: 'dry_run',
    dispatchPolicy: 'dispatchable',
    defaultAssignee: 'default',
    artifactRoot: join(hermesHome, 'artifacts', board),
    workspace: { kind: 'scratch' },
    safety: {
      requireProfilePreflight: true,
      requireReviewGateForRepoMutation: true,
      requireHumanGateForExternalActions: true,
    },
  };
}

describe('Hermes Kanban CLI integration smoke', () => {
  it('uses an isolated temp HERMES_HOME for board/task/readiness/snapshot/dry-run coverage', async () => {
    if (!(await commandAvailable(HERMES_COMMAND))) {
      console.warn(`Skipping Hermes Kanban integration smoke: ${HERMES_COMMAND} is unavailable`);
      return;
    }

    const hermesHome = await mkdtemp(join(tmpdir(), 'symphony-kanban-smoke-'));
    const board = 'symphony-test-smoke';
    const config = kanbanConfig(hermesHome, board);
    const client = new HermesKanbanCliClient({
      command: HERMES_COMMAND,
      board,
      hermesHome,
      path: process.env['PATH'] ?? '',
    });

    try {
      await client.init();
      await client.createBoard({
        slug: board,
        name: 'Symphony Test Smoke',
        description: 'Temporary symphony-ts integration smoke board',
      });

      await expect(checkKanbanReadiness({
        config,
        client,
        commandExists: () => Promise.resolve(true),
      })).resolves.toMatchObject({
        ok: true,
        checks: {
          board_exists: true,
          dispatch_dry_run_ok: true,
          service_would_start: false,
          tasks_would_create: false,
          board_would_create: false,
          gateway_dispatch_would_start: false,
        },
      });

      const materialized = await materializeKanbanTaskGraph({
        client,
        workflow: {
          id: 'wf-smoke',
          board,
          planPath: '/tmp/symphony-kanban-smoke-plan.md',
          artifactRoot: config.artifactRoot,
          nonAuthorizations: ['Temp-home smoke only; do not push, dispatch live workers, restart services, or touch real boards.'],
        },
        nodes: [
          {
            key: 'K0',
            kind: 'anchor',
            title: 'K0 smoke anchor',
            goal: 'Anchor an isolated smoke DAG.',
            assignee: null,
            acceptanceCriteria: ['The card exists only in the temp Hermes home.'],
          },
          {
            key: 'K1',
            kind: 'verification',
            title: 'K1 smoke verification',
            goal: 'Verify child creation with a parent id at create time.',
            parentKeys: ['K0'],
            assignee: null,
            acceptanceCriteria: ['The card remains unassigned so dispatch dry-run cannot spawn workers.'],
          },
        ],
      });
      expect(materialized.createdTasks).toHaveLength(2);

      const tasks = await client.listTasks({ sort: 'created' });
      expect(tasks.map((task) => task.title).sort()).toEqual(['K0 smoke anchor', 'K1 smoke verification']);

      const parentId = materialized.createdTasks.find((task) => task.key === 'K0')?.taskId;
      const childId = materialized.createdTasks.find((task) => task.key === 'K1')?.taskId;
      expect(parentId).toBeDefined();
      expect(childId).toBeDefined();
      const child = await client.showTask(childId ?? 'missing');
      expect(child.parents.map((parent) => parent.id)).toEqual([parentId]);

      const service = createKanbanServiceFacade({ config, client });
      const controlPlane = await startSymphonyControlPlane({
        config: { enabled: true, host: '127.0.0.1', port: 0, authToken: 'test-control-token', allowExternalBind: false },
        kanban: { config, service },
      });
      try {
        const snapshot = await fetch(`${controlPlane.url}/snapshot`);
        const payload = await snapshot.json() as { readonly snapshot: { readonly backend: string; readonly board: string; readonly counts: { readonly total: number } } };
        expect(payload.snapshot).toMatchObject({ backend: 'hermes_kanban', board });
        expect(payload.snapshot.counts.total).toBe(2);
      } finally {
        await controlPlane.close();
      }

      const dispatch = await client.dispatchDryRun({ max: 1 });
      expect(dispatch.spawned).toEqual([]);
    } finally {
      await rm(hermesHome, { recursive: true, force: true });
    }
  }, 60_000);
});

function commandAvailable(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { windowsHide: true, timeout: 10_000 }, (error) => {
      resolve(error === null);
    });
  });
}
