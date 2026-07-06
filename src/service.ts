import { stat } from 'node:fs/promises';

import { CodexAppServerRunner } from './codex-runner.js';
import { startSymphonyControlPlane, type SymphonyControlPlane } from './control-plane.js';
import type { Issue } from './domain.js';
import { HermesKanbanCliClient } from './kanban-client.js';
import { createKanbanServiceFacade } from './kanban-service.js';
import type { KanbanClient } from './kanban-types.js';
import {
  SymphonyOrchestrator,
  type OrchestratorAgentRunner,
  type OrchestratorIssueTracker,
  type OrchestratorRuntimeDependencies,
  type OrchestratorWorkspaceManager,
  type RunCompletion,
} from './orchestrator.js';
import { JsonFileIssueRunLedger } from './issue-run-ledger.js';
import { LinearIssueLifecycleNotifier } from './linear-lifecycle-notifier.js';
import { formatStructuredLogLine } from './observability.js';
import { LinearIssueMutationClient, LinearTrackerClient, type LinearTrackerReceiptSink } from './tracker.js';
import { getEffectiveConfig, loadWorkflow, validateDispatchPreflight, type WorkflowDefinition } from './workflow.js';
import { WorkspaceManager, type PreparedWorkspace } from './workspace.js';

export type SymphonyServiceFactory = (workflow: WorkflowDefinition) => SymphonyOrchestrator;

export interface SymphonyService {
  readonly workflow: WorkflowDefinition;
  readonly orchestrator: SymphonyOrchestrator;
  readonly controlPlane: SymphonyControlPlane | null;
  stop(): void;
}

export interface StartSymphonyServiceOptions {
  readonly workflowPath?: string;
  readonly factory?: SymphonyServiceFactory;
  readonly tracker?: OrchestratorIssueTracker;
  readonly workspaceManager?: OrchestratorWorkspaceManager;
  readonly runner?: OrchestratorAgentRunner;
  readonly kanbanClient?: Pick<KanbanClient, 'listTasks'>;
  readonly log?: (line: string) => void;
  readonly trackerReceiptSink?: LinearTrackerReceiptSink;
}

export async function startSymphonyService(options: StartSymphonyServiceOptions = {}): Promise<SymphonyService> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const safeLog = (line: string): void => {
    try {
      log(line);
    } catch {
      // Logging sink failures must not abort service startup or the run loop.
    }
  };
  let workflow = await loadWorkflow(options.workflowPath);
  let workflowMtimeMs = await getMtimeMs(workflow.workflow_path);
  safeLog(formatStructuredLogLine({ level: 'info', event: 'workflow_load', outcome: 'completed', workflow_path: workflow.workflow_path }));

  const preflightErrors = validateDispatchPreflight(workflow);
  if (preflightErrors.length > 0) {
    const reason = preflightErrors.map((error) => `${error.code} ${error.field}`).join('; ');
    safeLog(formatStructuredLogLine({ level: 'error', event: 'startup_validation', outcome: 'failed', reason }));
    throw new Error(`startup validation failed: ${reason}`);
  }
  safeLog(formatStructuredLogLine({ level: 'info', event: 'startup_validation', outcome: 'completed' }));

  const orchestrator = options.factory?.(workflow) ?? createDefaultSymphonyOrchestrator(workflow, options);

  await orchestrator.startupCleanup();
  safeLog(formatStructuredLogLine({ level: 'info', event: 'startup_cleanup', outcome: 'completed' }));
  safeLog(formatStructuredLogLine({ level: 'info', event: 'tick', outcome: 'scheduled', reason: 'immediate startup tick' }));
  await orchestrator.tick();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const reloadWorkflowIfChanged = async (): Promise<void> => {
    const nextMtimeMs = await getMtimeMs(workflow.workflow_path);
    if (nextMtimeMs === null || workflowMtimeMs === null || nextMtimeMs <= workflowMtimeMs) {
      return;
    }
    try {
      const nextWorkflow = await loadWorkflow(workflow.workflow_path);
      const reloadErrors = validateDispatchPreflight(nextWorkflow);
      if (reloadErrors.length > 0) {
        throw new Error(reloadErrors.map((error) => `${error.code} ${error.field}`).join('; '));
      }
      if (options.factory === undefined) {
        orchestrator.updateWorkflowRuntime({
          workflow: nextWorkflow,
          ...createDefaultSymphonyRuntimeDependencies(nextWorkflow, options),
        });
      } else {
        orchestrator.updateWorkflow(nextWorkflow);
      }
      workflow = nextWorkflow;
      workflowMtimeMs = nextMtimeMs;
      safeLog(formatStructuredLogLine({ level: 'info', event: 'workflow_reload', outcome: 'completed', workflow_path: workflow.workflow_path }));
    } catch (error) {
      safeLog(formatStructuredLogLine({ level: 'error', event: 'workflow_reload', outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }));
    }
  };
  let controlPlane: SymphonyControlPlane | null = null;
  const stopService = (reason = 'manual'): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const activeControlPlane = controlPlane;
    controlPlane = null;
    if (activeControlPlane !== null) {
      void activeControlPlane.close().catch((error: unknown) => {
        safeLog(formatStructuredLogLine({ level: 'error', event: 'control_plane', outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }));
      });
    }
    safeLog(formatStructuredLogLine({ level: 'info', event: 'service', outcome: 'stopped', reason }));
  };
  const controlPlaneEffectiveConfig = getEffectiveConfig(workflow);
  const controlPlaneConfig = controlPlaneEffectiveConfig.service.controlPlane;
  if (controlPlaneConfig.enabled) {
    if (controlPlaneEffectiveConfig.backend.kind === 'hermes_kanban' && controlPlaneEffectiveConfig.kanban !== null) {
      const kanbanClient = options.kanbanClient ?? new HermesKanbanCliClient({
        command: controlPlaneEffectiveConfig.kanban.hermesCommand,
        board: controlPlaneEffectiveConfig.kanban.board,
        hermesHome: controlPlaneEffectiveConfig.kanban.hermesHome,
      });
      const kanbanService = createKanbanServiceFacade({
        config: controlPlaneEffectiveConfig.kanban,
        client: kanbanClient,
      });
      controlPlane = await startSymphonyControlPlane({
        config: controlPlaneConfig,
        kanban: { config: controlPlaneEffectiveConfig.kanban, service: kanbanService },
        log: safeLog,
        stopService,
      });
    } else {
      controlPlane = await startSymphonyControlPlane({
        config: controlPlaneConfig,
        orchestrator,
        log: safeLog,
        stopService,
      });
    }
  }
  const scheduleNextTick = (): void => {
    if (stopped) {
      return;
    }
    const delayMs = getEffectiveConfig(workflow).polling.intervalMs;
    timer = setTimeout(() => {
      void reloadWorkflowIfChanged()
        .then(() => {
          if (stopped) {
            return undefined;
          }
          return orchestrator.tick();
        })
        .finally(scheduleNextTick);
    }, delayMs);
    timer.unref();
  };
  scheduleNextTick();
  safeLog(formatStructuredLogLine({ level: 'info', event: 'startup', outcome: 'completed' }));

  return {
    get workflow(): WorkflowDefinition {
      return workflow;
    },
    orchestrator,
    get controlPlane(): SymphonyControlPlane | null {
      return controlPlane;
    },
    stop: (): void => {
      stopService('manual');
    },
  };
}

async function getMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

export function createDefaultSymphonyOrchestrator(
  workflow: WorkflowDefinition,
  overrides: Pick<StartSymphonyServiceOptions, 'tracker' | 'workspaceManager' | 'runner' | 'log' | 'trackerReceiptSink'> = {},
): SymphonyOrchestrator {
  const dependencies = createDefaultSymphonyRuntimeDependencies(workflow, overrides);

  return new SymphonyOrchestrator({
    workflow,
    ...dependencies,
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
  });
}

export function createDefaultSymphonyRuntimeDependencies(
  workflow: WorkflowDefinition,
  overrides: Pick<StartSymphonyServiceOptions, 'tracker' | 'workspaceManager' | 'runner' | 'trackerReceiptSink'> = {},
): OrchestratorRuntimeDependencies {
  const config = getEffectiveConfig(workflow);
  if (config.backend.kind === 'hermes_kanban') {
    return createKanbanFacadeRuntimeDependencies();
  }
  const tracker = overrides.tracker ?? new LinearTrackerClient({
    apiKey: requiredString(config.tracker.apiKey, 'tracker.api_key'),
    projectSlug: config.tracker.projectSlug,
    teamKey: config.tracker.teamKey,
    allApprovedProjects: config.tracker.allApprovedProjects,
    endpoint: config.tracker.endpoint,
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
    canaryIssueIdentifier: config.tracker.canaryIssueIdentifier,
    canaryLabels: config.tracker.canaryLabels,
    maxIssuesPerPoll: config.tracker.maxIssuesPerPoll,
    ...(overrides.trackerReceiptSink === undefined ? {} : { receiptSink: overrides.trackerReceiptSink }),
  });
  const workspaceManager = overrides.workspaceManager ?? new WorkspaceManagerAdapter(new WorkspaceManager({
    root: config.workspace.root,
    source: config.workspace.source,
    hooks: {
      ...(config.hooks.afterCreate === null ? {} : { after_create: config.hooks.afterCreate }),
      ...(config.hooks.beforeRun === null ? {} : { before_run: config.hooks.beforeRun }),
      ...(config.hooks.afterRun === null ? {} : { after_run: config.hooks.afterRun }),
      ...(config.hooks.beforeRemove === null ? {} : { before_remove: config.hooks.beforeRemove }),
      timeoutMs: config.hooks.timeoutMs,
    },
  }));
  const runner = overrides.runner ?? new CodexOrchestratorRunner(new CodexAppServerRunner({
    codex: {
      command: config.codex.command,
      readTimeoutMs: config.codex.readTimeoutMs,
      turnTimeoutMs: config.codex.turnTimeoutMs,
    },
    protocol: { schemaSource: 'configured Codex app-server protocol' },
    approval: { mode: config.codex.approvalPolicy === 'auto_approve' ? 'auto_approve' : 'fail' },
    sandbox: { mode: typeof config.codex.turnSandboxPolicy === 'string' ? config.codex.turnSandboxPolicy : 'workspace_write' },
    tools: { linearGraphql: { enabled: false } },
  }), config);
  const issueLedger = config.service.statePath === null ? undefined : new JsonFileIssueRunLedger(config.service.statePath);
  const lifecycleNotifier = config.tracker.mutations.enabled && issueLedger !== undefined
    ? new LinearIssueLifecycleNotifier(new LinearIssueMutationClient({
      apiKey: requiredString(config.tracker.apiKey, 'tracker.api_key'),
      endpoint: config.tracker.endpoint,
      ...(overrides.trackerReceiptSink === undefined ? {} : { receiptSink: overrides.trackerReceiptSink }),
    }), issueLedger, config.tracker.mutations)
    : undefined;

  return {
    tracker,
    workspaceManager,
    runner,
    ...(issueLedger === undefined ? {} : { issueLedger }),
    ...(lifecycleNotifier === undefined ? {} : { lifecycleNotifier }),
  };
}

function createKanbanFacadeRuntimeDependencies(): OrchestratorRuntimeDependencies {
  return {
    tracker: {
      fetch_candidate_issues: () => Promise.resolve([]),
      fetch_terminal_issues: () => Promise.resolve([]),
      fetch_issue_states_by_ids: () => Promise.resolve([]),
    },
    workspaceManager: {
      prepareWorkspace: () => Promise.reject(new Error('Kanban facade mode does not prepare legacy workspaces')),
      runAfterRunHook: () => Promise.resolve(),
      cleanupTerminalWorkspace: () => Promise.resolve(),
    },
    runner: {
      runIssue: () => {
        throw new Error('Kanban facade mode does not run the legacy Codex agent runner');
      },
    },
  };
}

class WorkspaceManagerAdapter implements OrchestratorWorkspaceManager {
  private readonly prepared = new Map<string, PreparedWorkspace>();

  public constructor(private readonly manager: WorkspaceManager) {}

  public async prepareWorkspace(issue: Issue): Promise<{ readonly workspacePath: string }> {
    const workspace = await this.manager.prepareWorkspace(issue);
    await this.manager.runBeforeRunHook(workspace);
    this.prepared.set(issue.id, workspace);
    return { workspacePath: workspace.workspacePath };
  }

  public async runAfterRunHook(issue: Issue): Promise<void> {
    const workspace = this.prepared.get(issue.id) ?? await this.manager.prepareWorkspace(issue);
    await this.manager.runAfterRunHook(workspace);
  }

  public async cleanupTerminalWorkspace(issue: Issue): Promise<void> {
    const workspace = this.prepared.get(issue.id) ?? await this.manager.prepareWorkspace(issue);
    await this.manager.cleanupTerminalWorkspace(workspace);
    this.prepared.delete(issue.id);
  }
}

class CodexOrchestratorRunner implements OrchestratorAgentRunner {
  public constructor(
    private readonly runner: CodexAppServerRunner,
    private readonly config: ReturnType<typeof getEffectiveConfig>,
  ) {}

  public runIssue(input: Parameters<OrchestratorAgentRunner['runIssue']>[0]): { readonly completion: Promise<RunCompletion>; readonly cancel: (reason: string) => Promise<void> } {
    const controller = new AbortController();
    const completion = this.runner.runIssue({
      workspacePath: input.workspacePath,
      issue: {
        identifier: input.issue.identifier,
        title: input.issue.title,
        ...(input.issue.description === null ? {} : { description: input.issue.description }),
      },
      workflow: { maxTurns: this.config.agent.maxTurns },
      promptTemplate: input.promptTemplate,
      continuationGuidance: input.retryAttempt === null ? [] : [`Continuation attempt ${String(input.retryAttempt)}; continue on the existing work item and preserve prior context where available.`],
      signal: controller.signal,
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    }).then((): RunCompletion => ({ ok: true }), (error: unknown): RunCompletion => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));

    return {
      completion,
      cancel: (reason: string): Promise<void> => {
        controller.abort(reason);
        return completion.then(() => undefined, () => undefined);
      },
    };
  }
}

function requiredString(value: string | null, field: string): string {
  if (value === null || value.trim() === '') {
    throw new Error(`Missing required config field: ${field}`);
  }
  return value;
}
