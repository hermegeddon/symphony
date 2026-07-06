import { access, constants } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { delimiter } from 'node:path';

import type { KanbanBackendConfig } from './workflow.js';
import type { KanbanAssignee, KanbanBoard, KanbanDispatchDryRun } from './kanban-types.js';

export interface KanbanReadinessProbeClient {
  boardsList(): Promise<readonly KanbanBoard[]>;
  assigneesList(): Promise<readonly KanbanAssignee[]>;
  dispatchDryRun(input?: { readonly max?: number }): Promise<KanbanDispatchDryRun>;
}

export type KanbanReadinessErrorCode =
  | 'kanban_hermes_command_unavailable'
  | 'kanban_board_missing'
  | 'kanban_default_assignee_unavailable'
  | 'kanban_dispatch_probe_failed';

export interface KanbanReadinessError {
  readonly code: KanbanReadinessErrorCode;
  readonly field: string;
  readonly message: string;
}

export interface KanbanReadinessResult {
  readonly effect: 'check_only';
  readonly ok: boolean;
  readonly checks: {
    readonly hermes_command_available: boolean;
    readonly board: string;
    readonly board_exists: boolean;
    readonly board_create_configured: boolean;
    readonly board_create_allowed_for_temp_scope: boolean;
    readonly board_setup_required: boolean;
    readonly default_assignee: string | null;
    readonly default_assignee_available: boolean | null;
    readonly dispatch_mode: KanbanBackendConfig['dispatch'];
    readonly dispatch_dry_run_ok: boolean | null;
    readonly dispatch_would_spawn: boolean;
    readonly service_would_start: false;
    readonly tasks_would_create: false;
    readonly board_would_create: false;
    readonly gateway_dispatch_would_start: false;
  };
  readonly errors: readonly KanbanReadinessError[];
}

export interface CheckKanbanReadinessInput {
  readonly config: KanbanBackendConfig;
  readonly client: KanbanReadinessProbeClient;
  readonly commandExists?: (command: string) => Promise<boolean>;
}

export async function checkKanbanReadiness(input: CheckKanbanReadinessInput): Promise<KanbanReadinessResult> {
  const commandExists = input.commandExists ?? defaultCommandExists;
  const errors: KanbanReadinessError[] = [];
  const hermesCommandAvailable = await commandExists(input.config.hermesCommand);
  if (!hermesCommandAvailable) {
    errors.push({
      code: 'kanban_hermes_command_unavailable',
      field: 'kanban.hermes_command',
      message: `Hermes command is not available: ${input.config.hermesCommand}`,
    });
  }

  let boardExists = false;
  try {
    const boards = await input.client.boardsList();
    boardExists = boards.some((board) => board.slug === input.config.board && !board.archived);
  } catch (error) {
    errors.push({
      code: 'kanban_board_missing',
      field: 'kanban.board',
      message: `Unable to list Kanban boards: ${errorMessage(error)}`,
    });
  }

  const boardCreateAllowed = input.config.boardCreate && isTempOrTestBoardSlug(input.config.board);
  const boardSetupRequired = !boardExists;
  if (!boardExists) {
    errors.push({
      code: 'kanban_board_missing',
      field: 'kanban.board',
      message: `Kanban board ${input.config.board} does not exist; create it in an explicit setup/apply step before service use`,
    });
  }

  let defaultAssigneeAvailable: boolean | null = input.config.defaultAssignee === null ? null : false;
  if (input.config.safety.requireProfilePreflight && input.config.defaultAssignee !== null) {
    try {
      const assignees = await input.client.assigneesList();
      defaultAssigneeAvailable = assignees.some((assignee) => assignee.name === input.config.defaultAssignee && assignee.onDisk !== false);
      if (!defaultAssigneeAvailable) {
        errors.push({
          code: 'kanban_default_assignee_unavailable',
          field: 'kanban.default_assignee',
          message: `Kanban default assignee ${input.config.defaultAssignee} is not available on disk`,
        });
      }
    } catch (error) {
      errors.push({
        code: 'kanban_default_assignee_unavailable',
        field: 'kanban.default_assignee',
        message: `Unable to list Kanban assignees: ${errorMessage(error)}`,
      });
    }
  }

  let dispatchDryRunOk: boolean | null = null;
  let dispatchWouldSpawn = false;
  if (boardExists && input.config.dispatch === 'dry_run') {
    try {
      const probe = await input.client.dispatchDryRun({ max: 1 });
      dispatchDryRunOk = true;
      dispatchWouldSpawn = probe.spawned.length > 0;
    } catch (error) {
      dispatchDryRunOk = false;
      errors.push({
        code: 'kanban_dispatch_probe_failed',
        field: 'kanban.dispatch',
        message: `Kanban dispatch dry-run failed: ${errorMessage(error)}`,
      });
    }
  }

  const ok = hermesCommandAvailable
    && boardExists
    && (input.config.defaultAssignee === null || defaultAssigneeAvailable === true || !input.config.safety.requireProfilePreflight)
    && !dispatchWouldSpawn
    && dispatchDryRunOk !== false
    && errors.length === 0;

  return {
    effect: 'check_only',
    ok,
    checks: {
      hermes_command_available: hermesCommandAvailable,
      board: input.config.board,
      board_exists: boardExists,
      board_create_configured: input.config.boardCreate,
      board_create_allowed_for_temp_scope: boardCreateAllowed,
      board_setup_required: boardSetupRequired,
      default_assignee: input.config.defaultAssignee,
      default_assignee_available: defaultAssigneeAvailable,
      dispatch_mode: input.config.dispatch,
      dispatch_dry_run_ok: dispatchDryRunOk,
      dispatch_would_spawn: dispatchWouldSpawn,
      service_would_start: false,
      tasks_would_create: false,
      board_would_create: false,
      gateway_dispatch_would_start: false,
    },
    errors,
  };
}

async function defaultCommandExists(command: string): Promise<boolean> {
  if (command.includes('/') || command.startsWith('.')) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathValue = process.env['PATH'] ?? '';
  for (const directory of pathValue.split(delimiter)) {
    if (directory.trim() === '') {
      continue;
    }
    try {
      await access(`${directory}/${command}`, constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH entries.
    }
  }

  return new Promise((resolve) => {
    execFile(command, ['--version'], { windowsHide: true, timeout: 5000 }, (error) => {
      resolve(error === null);
    });
  });
}

function isTempOrTestBoardSlug(value: string): boolean {
  return /^(?:tmp|temp|test|sandbox|smoke|fixture|symphony-test)(?:-|$)/.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
