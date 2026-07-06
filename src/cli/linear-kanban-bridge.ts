#!/usr/bin/env node
import { homedir } from 'node:os';

import { JsonFileIssueRunLedger } from '../issue-run-ledger.js';
import { HermesKanbanCliClient } from '../kanban-client.js';
import type { KanbanClient, KanbanWorkspaceSpec } from '../kanban-types.js';
import {
  LINEAR_KANBAN_BRIDGE_ACTOR,
  runLinearKanbanBridgeOnce,
  type LinearKanbanBridgeTickReceipt,
  type LinearKanbanBridgeTracker,
} from '../linear-kanban-bridge.js';
import { formatStructuredLogLine } from '../observability.js';
import { LinearIssueMutationClient, LinearTrackerClient } from '../tracker.js';
import type { LinearIssueMutationClientConfig } from '../tracker.js';
import { getEffectiveConfig, loadWorkflow, type EffectiveConfig, type KanbanBackendConfig } from '../workflow.js';
import { isDirectCliExecution } from './direct-execution.js';

export type TextWriter = (chunk: string) => void;

export interface LinearKanbanBridgeTrackerFactoryContext {
  readonly config: EffectiveConfig;
}

export interface LinearKanbanBridgeKanbanFactoryContext {
  readonly config: KanbanBackendConfig;
  readonly path: string;
}

export interface SymphonyLinearKanbanBridgeCliOptions {
  readonly stdout?: TextWriter;
  readonly stderr?: TextWriter;
  readonly log?: TextWriter;
  readonly processEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly trackerFactory?: (context: LinearKanbanBridgeTrackerFactoryContext) => LinearKanbanBridgeTracker;
  readonly kanbanClientFactory?: (context: LinearKanbanBridgeKanbanFactoryContext) => KanbanClient;
  readonly mutationClientFactory?: (config: LinearIssueMutationClientConfig) => LinearIssueMutationClient;
  readonly now?: Date;
}

export interface SymphonyLinearKanbanBridgeCliRuntime {
  readonly done: Promise<void>;
  readonly stopped: boolean;
  readonly lastReceipt: LinearKanbanBridgeTickReceipt | null;
  stop(reason?: string): Promise<void>;
}

interface LoadedLinearKanbanBridgeWorkflow {
  readonly config: EffectiveConfig;
  readonly kanban: KanbanBackendConfig;
}

interface ParsedLinearKanbanBridgeFlags {
  readonly help: boolean;
  readonly once: boolean;
  readonly workflowPath?: string | undefined;
}

export async function runSymphonyLinearKanbanBridgeCli(
  argv: readonly string[],
  options: SymphonyLinearKanbanBridgeCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const env = options.processEnv ?? process.env;

  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      stdout(usage());
      return 0;
    }
    if (!flags.once) {
      const runtime = await startSymphonyLinearKanbanBridgeCli(argv, options);
      await runtime.done;
      return 0;
    }
    const receipt = await runOnceFromWorkflow(flags.workflowPath, env, options);
    stdout(`${JSON.stringify(receipt, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`${JSON.stringify({ ok: false, status: 'BLOCK', error: redactForCli(message) }, null, 2)}\n`);
    return 1;
  }
}

export async function startSymphonyLinearKanbanBridgeCli(
  argv: readonly string[],
  options: SymphonyLinearKanbanBridgeCliOptions = {},
): Promise<SymphonyLinearKanbanBridgeCliRuntime> {
  const flags = parseFlags(argv);
  if (flags.help) {
    throw new Error('help mode is handled by runSymphonyLinearKanbanBridgeCli');
  }
  if (flags.once) {
    throw new Error('--once is a one-shot mode; omit it for long-running bridge service mode');
  }
  const env = options.processEnv ?? process.env;
  const loaded = await loadBridgeWorkflow(flags.workflowPath, env);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let stopped = false;
  let lastReceipt: LinearKanbanBridgeTickReceipt | null = null;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const runTick = async (): Promise<void> => {
    const receipt = await runOnceFromLoadedWorkflow(loaded, env, options);
    lastReceipt = receipt;
    log(formatStructuredLogLine({
      level: 'info',
      event: 'linear_kanban_bridge',
      outcome: 'tick_completed',
      candidates: receipt.candidates,
      materialized: receipt.materialized.length,
      completed: receipt.completed.length,
    }));
  };
  await runTick();
  const timer = setInterval(() => {
    void runTick().catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      log(formatStructuredLogLine({ level: 'error', event: 'linear_kanban_bridge', outcome: 'tick_failed', reason: redactForCli(reason) }));
    });
  }, loaded.config.polling.intervalMs);
  return {
    done,
    get stopped(): boolean {
      return stopped;
    },
    get lastReceipt(): LinearKanbanBridgeTickReceipt | null {
      return lastReceipt;
    },
    stop: (reason = 'manual'): Promise<void> => {
      if (stopped) {
        return Promise.resolve();
      }
      stopped = true;
      clearInterval(timer);
      log(formatStructuredLogLine({ level: 'info', event: 'linear_kanban_bridge', outcome: 'stopped', reason }));
      resolveDone();
      return Promise.resolve();
    },
  };
}

async function runOnceFromWorkflow(
  workflowPath: string | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: SymphonyLinearKanbanBridgeCliOptions,
): Promise<LinearKanbanBridgeTickReceipt> {
  return runOnceFromLoadedWorkflow(await loadBridgeWorkflow(workflowPath, env), env, options);
}

async function loadBridgeWorkflow(
  workflowPath: string | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<LoadedLinearKanbanBridgeWorkflow> {
  const workflow = await loadWorkflow(workflowPath);
  const config = getEffectiveConfig(workflow, { env });
  const kanban = requireKanbanBridgeConfig(config);
  return { config, kanban };
}

async function runOnceFromLoadedWorkflow(
  loaded: LoadedLinearKanbanBridgeWorkflow,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: SymphonyLinearKanbanBridgeCliOptions,
): Promise<LinearKanbanBridgeTickReceipt> {
  const { config, kanban } = loaded;
  const ledger = new JsonFileIssueRunLedger(requireStatePath(config));
  const path = env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  const trackerApiKey = requireApiKey(config);
  const tracker = options.trackerFactory?.({ config }) ?? new LinearTrackerClient({
    apiKey: trackerApiKey,
    projectSlug: config.tracker.projectSlug,
    teamKey: config.tracker.teamKey,
    allApprovedProjects: config.tracker.allApprovedProjects,
    endpoint: config.tracker.endpoint,
    activeStates: config.tracker.activeStates,
    terminalStates: config.tracker.terminalStates,
    canaryIssueIdentifier: config.tracker.canaryIssueIdentifier,
    canaryLabels: config.tracker.canaryLabels,
    requiredLabels: config.tracker.requiredLabels,
    maxIssuesPerPoll: config.tracker.maxIssuesPerPoll,
  });
  const kanbanClient = options.kanbanClientFactory?.({ config: kanban, path }) ?? new HermesKanbanCliClient({
    command: kanban.hermesCommand,
    board: kanban.board,
    hermesHome: kanban.hermesHome,
    path,
  });
  const mutationClientConfig: LinearIssueMutationClientConfig = {
    apiKey: trackerApiKey,
    endpoint: config.tracker.endpoint,
  };
  const linearMutationClient = options.mutationClientFactory?.(mutationClientConfig)
    ?? new LinearIssueMutationClient(mutationClientConfig);

  return runLinearKanbanBridgeOnce({
    workflowId: LINEAR_KANBAN_BRIDGE_ACTOR,
    board: kanban.board,
    artifactRoot: kanban.artifactRoot,
    tracker,
    kanbanClient,
    ledger,
    linearMutationClient,
    defaultAssignee: kanban.defaultAssignee,
    dispatchPolicy: kanban.dispatchPolicy,
    workspace: kanbanWorkspaceSpec(kanban),
    startStateId: config.tracker.mutations.startStateId,
    completedStateId: config.tracker.mutations.completedStateId,
    commentMarker: config.tracker.mutations.commentMarker,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function requireKanbanBridgeConfig(config: EffectiveConfig): KanbanBackendConfig {
  if (config.backend.kind !== 'hermes_kanban' || config.kanban === null) {
    throw new Error('symphony-linear-kanban-bridge requires backend.kind: hermes_kanban');
  }
  if (config.tracker.kind !== 'linear') {
    throw new Error('symphony-linear-kanban-bridge requires tracker.kind: linear');
  }
  if (!config.tracker.mutations.enabled) {
    throw new Error('symphony-linear-kanban-bridge requires tracker.mutations.enabled: true for Linear sync');
  }
  if (config.tracker.projectSlug === null && config.tracker.teamKey === null && !config.tracker.allApprovedProjects) {
    throw new Error('symphony-linear-kanban-bridge requires tracker.project_slug, tracker.team_key, or tracker.all_approved_projects: true');
  }
  if (
    !config.tracker.requireCanary
    && config.tracker.canaryIssueIdentifier === null
    && !config.tracker.allowBroadDispatch
  ) {
    throw new Error('broad Linear→Kanban bridge polling requires tracker.allow_broad_dispatch: true or an exact canary selector');
  }
  return config.kanban;
}

function requireApiKey(config: EffectiveConfig): string {
  if (config.tracker.apiKey === null || config.tracker.apiKey.trim() === '') {
    throw new Error('symphony-linear-kanban-bridge requires tracker.api_key');
  }
  return config.tracker.apiKey;
}

function requireStatePath(config: EffectiveConfig): string {
  if (config.service.statePath === null) {
    throw new Error('symphony-linear-kanban-bridge requires service.state_path for durable idempotency');
  }
  return config.service.statePath;
}

function kanbanWorkspaceSpec(config: KanbanBackendConfig): KanbanWorkspaceSpec {
  if (config.workspace.kind === 'scratch') {
    return 'scratch';
  }
  if (config.workspace.kind === 'dir') {
    return `dir:${config.workspace.root}`;
  }
  return `worktree:${config.workspace.root}`;
}

function parseFlags(argv: readonly string[]): ParsedLinearKanbanBridgeFlags {
  let help = false;
  let once = false;
  let workflowPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--once') {
      once = true;
      continue;
    }
    if (arg === '--workflow') {
      workflowPath = readFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (!arg.startsWith('-') && workflowPath === undefined) {
      workflowPath = arg;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return { help, once, ...(workflowPath === undefined ? {} : { workflowPath }) };
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage(): string {
  return [
    'Usage: symphony-linear-kanban-bridge [--workflow WORKFLOW.md]',
    '       symphony-linear-kanban-bridge --once [--workflow WORKFLOW.md]',
    '',
    'Poll Linear through the configured tracker and materialize/sync Hermes Kanban tasks.',
    'By default, runs as a long-lived polling bridge: it performs an immediate tick, then repeats',
    'at workflow polling.interval_ms until stopped. Use --once for cron/systemd timer canaries and tests.',
    '',
    'Options:',
    '  --workflow PATH   Kanban-first Symphony workflow file to load (default: ./WORKFLOW.md)',
    '  --once            Run one Linear → Hermes Kanban sync tick and print the JSON receipt',
    '  --help, -h        Show this help text',
    '',
    `Default HERMES_HOME: ${homedir()}/.hermes`,
    '',
  ].join('\n');
}

function redactForCli(value: string): string {
  return value
    .replace(/lin_api_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]');
}

if (isDirectCliExecution(import.meta.url)) {
  process.exitCode = await runSymphonyLinearKanbanBridgeCli(process.argv.slice(2));
}
