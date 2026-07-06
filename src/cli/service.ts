#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { fakeTracker } from '../demo/fixtures.js';
import { createDemoAgentRunner } from '../demo/runner.js';
import { cleanupAllDemoWorkspaces, createDemoWorkspaceManager } from '../demo/workspace.js';
import { formatStructuredLogLine } from '../observability.js';
import { startSymphonyService, type SymphonyService, type StartSymphonyServiceOptions } from '../service.js';
import { getEffectiveConfig, loadWorkflow, validateDispatchPreflight, type WorkspaceSourceConfig } from '../workflow.js';
import { isDirectCliExecution } from './direct-execution.js';

export interface SymphonyServiceCliRuntime {
  readonly mode: 'demo' | 'demo-idle' | 'workflow';
  readonly workflowPath: string | undefined;
  readonly service: SymphonyService;
  readonly done: Promise<void>;
  readonly stopped: boolean;
  stop(reason?: string): Promise<void>;
}

export type TextWriter = (chunk: string) => void;

export interface SymphonyServiceCliOptions {
  readonly log?: (line: string) => void;
  readonly stdout?: TextWriter;
  readonly stderr?: TextWriter;
}

interface ServiceCliFlags {
  readonly demo: boolean;
  readonly demoIdle: boolean;
  readonly printConfirmation: boolean;
  readonly check: boolean;
  readonly allowLiveCodexOpenaiCommand: boolean;
  readonly confirmationDigest?: string;
  readonly workflowPath?: string;
  readonly help: boolean;
}

const KEEPALIVE_INTERVAL_MS = 2_147_483_647;
const execFileAsync = promisify(execFile);
const idleDemoTracker = {
  fetch_candidate_issues: () => Promise.resolve([] as const),
  fetch_terminal_issues: () => Promise.resolve([] as const),
  fetch_issue_states_by_ids: () => Promise.resolve([] as const),
};

export async function startSymphonyServiceCli(
  argv: readonly string[],
  options: SymphonyServiceCliOptions = {},
): Promise<SymphonyServiceCliRuntime> {
  const flags = parseFlags(argv);
  if (flags.help || flags.printConfirmation || flags.check) {
    throw new Error('help, check, and print-only modes are handled by runSymphonyServiceCli');
  }

  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const preparedDemoWorkspaces = new Map<string, string>();
  const mode = flags.demoIdle ? 'demo-idle' : flags.demo ? 'demo' : 'workflow';
  if (mode === 'workflow') {
    const readiness = await runServiceReadinessCheck(flags);
    if (readiness.checks.live_codex_or_openai && !readiness.ok) {
      throw new Error(
        'live Codex/OpenAI command requires --allow-live-codex-openai-command and matching --confirmation-digest before service startup',
      );
    }
  }
  const serviceOptions: StartSymphonyServiceOptions = {
    ...(flags.workflowPath === undefined ? {} : { workflowPath: flags.workflowPath }),
    log,
    ...(flags.demo || flags.demoIdle ? {
      tracker: flags.demoIdle ? idleDemoTracker : fakeTracker,
      workspaceManager: createDemoWorkspaceManager(log, preparedDemoWorkspaces),
      runner: createDemoAgentRunner(log),
    } : {}),
  };

  const service = await startSymphonyService(serviceOptions);
  let stopped = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const keepAlive = setInterval(() => undefined, KEEPALIVE_INTERVAL_MS);

  log(formatStructuredLogLine({
    level: 'info',
    event: 'service_cli',
    outcome: 'started',
    mode,
    ...(flags.workflowPath === undefined ? {} : { workflow_path: flags.workflowPath }),
  }));

  return {
    mode,
    workflowPath: flags.workflowPath,
    service,
    done,
    get stopped(): boolean {
      return stopped;
    },
    stop: async (reason = 'manual'): Promise<void> => {
      if (stopped) {
        return;
      }
      stopped = true;
      service.stop();
      clearInterval(keepAlive);
      await cleanupAllDemoWorkspaces(preparedDemoWorkspaces);
      log(formatStructuredLogLine({ level: 'info', event: 'service_cli', outcome: 'stopped', reason }));
      resolveDone();
    },
  };
}

export async function runSymphonyServiceCli(
  argv: readonly string[],
  options: SymphonyServiceCliOptions = {},
): Promise<number> {
  const stderr = options.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  const stdout = options.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const log = options.log ?? ((line: string) => {
    stderr(`${line}\n`);
  });

  let flags: ServiceCliFlags;
  try {
    flags = parseFlags(argv);
    if (flags.help) {
      stdout(usage());
      return 0;
    }
    if (flags.printConfirmation) {
      const packet = await buildServiceConfirmationPacket(flags);
      stdout(`${JSON.stringify(packet, null, 2)}\n`);
      return 0;
    }
    if (flags.check) {
      const check = await runServiceReadinessCheck(flags);
      stdout(`${JSON.stringify(check, null, 2)}\n`);
      return check.ok ? 0 : 1;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(formatStructuredLogLine({ level: 'error', event: 'service_cli', outcome: 'failed', reason }));
    return 1;
  }

  let runtime: SymphonyServiceCliRuntime;
  try {
    const readiness = await runServiceReadinessCheck(flags);
    if (!flags.demo && !flags.demoIdle && readiness.checks.live_codex_or_openai && !readiness.ok) {
      stdout(`${JSON.stringify(readiness, null, 2)}\n`);
      return 1;
    }
    runtime = await startSymphonyServiceCli(argv, { log });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(formatStructuredLogLine({ level: 'error', event: 'service_cli', outcome: 'failed', reason }));
    return 1;
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    void runtime.stop(signal);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await runtime.done;
  process.off('SIGINT', shutdown);
  process.off('SIGTERM', shutdown);
  return 0;
}

function buildCliMode(flags: ServiceCliFlags): 'demo' | 'demo-idle' | 'workflow' {
  return flags.demoIdle ? 'demo-idle' : flags.demo ? 'demo' : 'workflow';
}

async function buildServiceConfirmationPacket(flags: ServiceCliFlags) {
  const workflow = await loadWorkflow(flags.workflowPath);
  const config = getEffectiveConfig(workflow);
  const basePacket = {
    effect: 'print_only' as const,
    requires_operator_confirmation: true as const,
    workflow: {
      path: resolve(workflow.workflow_path),
    },
    tracker: {
      kind: config.tracker.kind,
      endpoint: config.tracker.endpoint,
      project_slug: config.tracker.projectSlug,
      team_key: config.tracker.teamKey,
      all_approved_projects: config.tracker.allApprovedProjects,
      api_key_present: config.tracker.apiKey !== null,
      require_canary: config.tracker.requireCanary,
      canary_issue_identifier: config.tracker.canaryIssueIdentifier,
      canary_labels: config.tracker.canaryLabels,
      allow_broad_dispatch: config.tracker.allowBroadDispatch,
      max_issues_per_poll: config.tracker.maxIssuesPerPoll,
      active_states: config.tracker.activeStates,
      terminal_states: config.tracker.terminalStates,
      mutations: {
        enabled: config.tracker.mutations.enabled,
        comment_on_start: config.tracker.mutations.commentOnStart,
        comment_on_completion: config.tracker.mutations.commentOnCompletion,
        comment_on_failure: config.tracker.mutations.commentOnFailure,
        start_state_id: config.tracker.mutations.startStateId,
        completed_state_id: config.tracker.mutations.completedStateId,
        failed_state_id: config.tracker.mutations.failedStateId,
        comment_marker: config.tracker.mutations.commentMarker,
      },
    },
    workspace: {
      root: config.workspace.root,
      source: summarizeWorkspaceSource(config.workspace.source),
      hooks: {
        after_create: config.hooks.afterCreate !== null,
        before_run: config.hooks.beforeRun !== null,
        after_run: config.hooks.afterRun !== null,
        before_remove: config.hooks.beforeRemove !== null,
        timeout_ms: config.hooks.timeoutMs,
      },
    },
    codex: {
      command_preview: redactForReceiptText(config.codex.command),
      live_command_detected: isLiveCodexOrOpenaiCommand(config.codex.command),
      approval_policy: typeof config.codex.approvalPolicy === 'string' ? config.codex.approvalPolicy : null,
      thread_sandbox: typeof config.codex.threadSandbox === 'string' ? config.codex.threadSandbox : null,
      sandbox_mode: typeof config.codex.turnSandboxPolicy === 'string' ? config.codex.turnSandboxPolicy : null,
      read_timeout_ms: config.codex.readTimeoutMs,
      turn_timeout_ms: config.codex.turnTimeoutMs,
      stall_timeout_ms: config.codex.stallTimeoutMs,
    },
    service: {
      mode: buildCliMode(flags),
      polling_interval_ms: config.polling.intervalMs,
      max_concurrent_agents: config.agent.maxConcurrentAgents,
      max_turns: config.agent.maxTurns,
      success_continuation_delay_ms: config.agent.successContinuationDelayMs,
      state_path: config.service.statePath,
      control_plane: {
        enabled: config.service.controlPlane.enabled,
        host: config.service.controlPlane.host,
        port: config.service.controlPlane.port,
        auth_token_present: config.service.controlPlane.authToken !== null,
        allow_external_bind: config.service.controlPlane.allowExternalBind,
      },
    },
    operator_confirmation: {
      confirmation_digest_algorithm: 'sha256-json-v1' as const,
      confirmation_digest_scope: 'reviewed-redacted-config-v1' as const,
      live_command_default_blocked: true as const,
      live_command_override_flag: '--allow-live-codex-openai-command' as const,
      confirmation_digest_flag: '--confirmation-digest' as const,
      required_for_live_execution: [
        '--allow-live-codex-openai-command',
        '--confirmation-digest',
        '<sha256 digest printed by --print-confirmation for the same reviewed non-secret inputs>',
      ] as const,
    },
    non_actions: {
      service_started: false as const,
      linear_queries_sent: false as const,
      codex_started: false as const,
      fake_dependencies_used: flags.demo || flags.demoIdle,
      receipt_files_written: false as const,
      linear_mutation_authorized: false as const,
      git_push_authorized: false as const,
      deploy_authorized: false as const,
      broad_dispatch_authorized: false as const,
      pull_request_created: false as const,
    },
  };
  const digestInput = buildServiceConfirmationDigestInput(flags, workflow, config);
  return {
    ...basePacket,
    operator_confirmation: {
      ...basePacket.operator_confirmation,
      confirmation_digest: digestJson(digestInput),
    },
  };
}

function buildServiceConfirmationDigestInput(
  flags: ServiceCliFlags,
  workflow: Awaited<ReturnType<typeof loadWorkflow>>,
  config: ReturnType<typeof getEffectiveConfig>,
) {
  return {
    algorithm: 'sha256-json-v1' as const,
    scope: 'reviewed-redacted-config-v1' as const,
    workflow: {
      path: resolve(workflow.workflow_path),
    },
    tracker: {
      kind: config.tracker.kind,
      endpoint: config.tracker.endpoint,
      project_slug: config.tracker.projectSlug,
      team_key: config.tracker.teamKey,
      all_approved_projects: config.tracker.allApprovedProjects,
      api_key_present: config.tracker.apiKey !== null,
      require_canary: config.tracker.requireCanary,
      canary_issue_identifier: config.tracker.canaryIssueIdentifier,
      canary_labels: config.tracker.canaryLabels,
      allow_broad_dispatch: config.tracker.allowBroadDispatch,
      max_issues_per_poll: config.tracker.maxIssuesPerPoll,
      active_states: config.tracker.activeStates,
      terminal_states: config.tracker.terminalStates,
      mutations: {
        enabled: config.tracker.mutations.enabled,
        comment_on_start: config.tracker.mutations.commentOnStart,
        comment_on_completion: config.tracker.mutations.commentOnCompletion,
        comment_on_failure: config.tracker.mutations.commentOnFailure,
        start_state_id: config.tracker.mutations.startStateId,
        completed_state_id: config.tracker.mutations.completedStateId,
        failed_state_id: config.tracker.mutations.failedStateId,
        comment_marker: config.tracker.mutations.commentMarker,
      },
    },
    workspace: {
      root: config.workspace.root,
      source: summarizeWorkspaceSource(config.workspace.source),
      hooks: {
        after_create: config.hooks.afterCreate !== null,
        before_run: config.hooks.beforeRun !== null,
        after_run: config.hooks.afterRun !== null,
        before_remove: config.hooks.beforeRemove !== null,
        timeout_ms: config.hooks.timeoutMs,
      },
    },
    codex: {
      command_redacted: redactSecretText(config.codex.command),
      live_command_detected: isLiveCodexOrOpenaiCommand(config.codex.command),
      approval_policy: typeof config.codex.approvalPolicy === 'string' ? config.codex.approvalPolicy : null,
      thread_sandbox: typeof config.codex.threadSandbox === 'string' ? config.codex.threadSandbox : null,
      sandbox_mode: typeof config.codex.turnSandboxPolicy === 'string' ? config.codex.turnSandboxPolicy : null,
      read_timeout_ms: config.codex.readTimeoutMs,
      turn_timeout_ms: config.codex.turnTimeoutMs,
      stall_timeout_ms: config.codex.stallTimeoutMs,
    },
    service: {
      mode: buildCliMode(flags),
      polling_interval_ms: config.polling.intervalMs,
      max_concurrent_agents: config.agent.maxConcurrentAgents,
      max_turns: config.agent.maxTurns,
      success_continuation_delay_ms: config.agent.successContinuationDelayMs,
      state_path: config.service.statePath,
      control_plane: {
        enabled: config.service.controlPlane.enabled,
        host: config.service.controlPlane.host,
        port: config.service.controlPlane.port,
        auth_token_present: config.service.controlPlane.authToken !== null,
        allow_external_bind: config.service.controlPlane.allowExternalBind,
      },
    },
  };
}

async function runServiceReadinessCheck(flags: ServiceCliFlags) {
  const workflow = await loadWorkflow(flags.workflowPath);
  const config = getEffectiveConfig(workflow);
  const dispatchPreflightOk = validateDispatchPreflight(workflow).length === 0;
  const requireCanary = config.tracker.requireCanary;
  const exactCanarySelector = config.tracker.canaryIssueIdentifier !== null && config.tracker.canaryIssueIdentifier.trim() !== '';
  const labelCanarySelector = config.tracker.canaryLabels.length > 0;
  const trackerScopeConfigured = config.tracker.projectSlug !== null || config.tracker.teamKey !== null || config.tracker.allApprovedProjects;
  const broadSelectorAuthorized = !requireCanary && trackerScopeConfigured && config.tracker.allowBroadDispatch && config.tracker.maxIssuesPerPoll > 0 && config.tracker.activeStates.length > 0;
  const selectorScopeOk = requireCanary ? (exactCanarySelector || labelCanarySelector) : broadSelectorAuthorized;
  const durableStateOk = requireCanary || config.service.statePath !== null;
  const concurrencyBounded = config.agent.maxConcurrentAgents >= 1 && config.agent.maxConcurrentAgents <= config.tracker.maxIssuesPerPoll;
  const approvalPolicyFailClosed = config.codex.approvalPolicy === 'fail';
  const sandboxExplicit = typeof config.codex.threadSandbox === 'string' && typeof config.codex.turnSandboxPolicy === 'string';
  const liveTimeoutValues = config.codex.readTimeoutMs >= 30_000 && config.codex.turnTimeoutMs >= 300_000;
  const maxConcurrentAgentsOne = config.agent.maxConcurrentAgents === 1;
  const liveCodexOrOpenai = isLiveCodexOrOpenaiCommand(config.codex.command);
  const successContinuationSafe = !liveCodexOrOpenai || config.agent.successContinuationDelayMs === 0;
  const workspaceGitWorktreeSource = config.workspace.source.kind === 'git_worktree';
  const sourceRepoGit = workspaceGitWorktreeSource ? await isGitWorkTree(config.workspace.source.gitCommand, config.workspace.source.repoPath) : false;
  const sourceRepoClean = workspaceGitWorktreeSource && sourceRepoGit ? await isCleanGitWorkTree(config.workspace.source.gitCommand, config.workspace.source.repoPath) : false;
  const sourceBaseRefResolves = workspaceGitWorktreeSource && sourceRepoGit ? await gitRefResolves(config.workspace.source.gitCommand, config.workspace.source.repoPath, config.workspace.source.baseRef) : false;
  const confirmationPacket = await buildServiceConfirmationPacket(flags);
  const confirmationDigestMatches = flags.confirmationDigest === confirmationPacket.operator_confirmation.confirmation_digest;
  const liveCommandGateOk = !liveCodexOrOpenai || (flags.allowLiveCodexOpenaiCommand && confirmationDigestMatches);
  const fakeDependenciesUsed = flags.demo || flags.demoIdle;
  const ok = dispatchPreflightOk
    && selectorScopeOk
    && durableStateOk
    && approvalPolicyFailClosed
    && sandboxExplicit
    && liveTimeoutValues
    && concurrencyBounded
    && successContinuationSafe
    && workspaceGitWorktreeSource
    && sourceRepoGit
    && sourceRepoClean
    && sourceBaseRefResolves
    && liveCommandGateOk
    && !fakeDependenciesUsed;

  return {
    effect: 'check_only' as const,
    ok,
    checks: {
      workflow_load_ok: true,
      dispatch_preflight_ok: dispatchPreflightOk,
      require_canary: requireCanary,
      exact_canary_selector: exactCanarySelector,
      label_canary_selector: labelCanarySelector,
      tracker_scope_configured: trackerScopeConfigured,
      broad_selector_authorized: broadSelectorAuthorized,
      selector_scope_ok: selectorScopeOk,
      durable_state_ok: durableStateOk,
      concurrency_bounded: concurrencyBounded,
      approval_policy_fail_closed: approvalPolicyFailClosed,
      sandbox_explicit: sandboxExplicit,
      live_timeout_values: liveTimeoutValues,
      max_concurrent_agents_one: maxConcurrentAgentsOne,
      success_continuation_safe: successContinuationSafe,
      success_continuation_delay_ms: config.agent.successContinuationDelayMs,
      state_path: config.service.statePath,
      control_plane: {
        enabled: config.service.controlPlane.enabled,
        host: config.service.controlPlane.host,
        port: config.service.controlPlane.port,
        auth_token_present: config.service.controlPlane.authToken !== null,
        allow_external_bind: config.service.controlPlane.allowExternalBind,
      },
      workspace_git_worktree_source: workspaceGitWorktreeSource,
      source_repo_git: sourceRepoGit,
      source_repo_clean: sourceRepoClean,
      source_base_ref_resolves: sourceBaseRefResolves,
      live_codex_or_openai: liveCodexOrOpenai,
      live_command_override: flags.allowLiveCodexOpenaiCommand,
      confirmation_digest_matches: confirmationDigestMatches,
      service_would_start: false as const,
      linear_queries_would_send: false as const,
      codex_would_spawn: false as const,
      fake_dependencies_used: fakeDependenciesUsed,
    },
  };
}

function summarizeWorkspaceSource(source: WorkspaceSourceConfig) {
  if (source.kind === 'empty_directory') {
    return { kind: 'empty_directory' as const };
  }
  return {
    kind: 'git_worktree' as const,
    repo_path: source.repoPath,
    base_ref: source.baseRef,
    git_command: source.gitCommand,
  };
}

async function isGitWorkTree(gitCommand: string, repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(gitCommand, ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function isCleanGitWorkTree(gitCommand: string, repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(gitCommand, ['-C', repoPath, 'status', '--porcelain=v1']);
    return stdout.length === 0;
  } catch {
    return false;
  }
}

async function gitRefResolves(gitCommand: string, repoPath: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync(gitCommand, ['-C', repoPath, 'rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isLiveCodexOrOpenaiCommand(command: string): boolean {
  return /(?:^|[^a-z0-9])(?:codex|openai)(?:[^a-z0-9]|$)/i.test(command);
}

function redactForReceiptText(value: string): string {
  return truncateForReceipt(redactSecretText(value));
}

function redactSecretText(value: string): string {
  return value
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replaceAll(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replaceAll(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1[REDACTED]')
    .replaceAll(/(--(?:api[-_]?key|token|secret|password)\s+)([^\s]+)/gi, '$1[REDACTED]')
    .replaceAll(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\bsess_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\blin_(?:api|oauth)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
}

function truncateForReceipt(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function parseFlags(argv: readonly string[]): ServiceCliFlags {
  let demo = false;
  let demoIdle = false;
  let printConfirmation = false;
  let check = false;
  let allowLiveCodexOpenaiCommand = false;
  let confirmationDigest: string | undefined;
  let workflowPath: string | undefined;
  let workflowPathSource: '--workflow' | 'positional' | undefined;
  let help = false;

  const setWorkflowPath = (value: string, source: '--workflow' | 'positional'): void => {
    if (workflowPath !== undefined) {
      if (workflowPath === value) {
        throw new Error(`Multiple workflow paths specified: ${workflowPathSource ?? 'previous'} and ${source} both specified ${JSON.stringify(value)}`);
      }
      throw new Error(`Conflicting workflow paths: ${workflowPathSource ?? 'previous'} specified ${JSON.stringify(workflowPath)} but ${source} specified ${JSON.stringify(value)}`);
    }
    workflowPath = value;
    workflowPathSource = source;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--demo') {
      demo = true;
      continue;
    }
    if (arg === '--demo-idle') {
      demoIdle = true;
      continue;
    }
    if (arg === '--print-confirmation') {
      printConfirmation = true;
      continue;
    }
    if (arg === '--check') {
      check = true;
      continue;
    }
    if (arg === '--allow-live-codex-openai-command') {
      allowLiveCodexOpenaiCommand = true;
      continue;
    }
    if (arg === '--confirmation-digest') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--confirmation-digest requires a value');
      }
      confirmationDigest = value;
      index += 1;
      continue;
    }
    if (arg === '--workflow') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--workflow requires a path');
      }
      setWorkflowPath(value, '--workflow');
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    setWorkflowPath(arg, 'positional');
  }

  return {
    demo,
    demoIdle,
    printConfirmation,
    check,
    allowLiveCodexOpenaiCommand,
    ...(confirmationDigest === undefined ? {} : { confirmationDigest }),
    ...(workflowPath === undefined ? {} : { workflowPath }),
    help,
  };
}

function usage(): string {
  return [
    'Usage: symphony-service [WORKFLOW.md] [--workflow WORKFLOW.md] [--demo|--demo-idle] [--print-confirmation|--check]',
    '',
    'When omitted, the workflow path defaults to ./WORKFLOW.md in the current working directory. A positional WORKFLOW.md path is equivalent to --workflow WORKFLOW.md.',
    'Runs the local Symphony service loop. By default it uses the configured workflow, Linear tracker, workspace manager, and Codex runner.',
    '--demo replaces live tracker/runner dependencies with deterministic fake local dependencies and dispatches one fake issue for smoke testing.',
    '--demo-idle replaces live tracker/runner dependencies with deterministic fake local dependencies and returns no candidates, which is the safest systemd setup mode.',
    '--print-confirmation prints the resolved workflow, canary, Codex policy, non-actions, and digest without starting the service.',
    '--check validates live-readiness without querying Linear, starting Codex, creating workspaces, or writing receipts; live-readiness also requires a clean git-worktree source repo and disabled clean-success continuation for live-looking commands.',
    'Live-looking Codex/OpenAI commands fail closed before service startup unless the reviewed digest is supplied with --allow-live-codex-openai-command and --confirmation-digest.',
    '',
  ].join('\n');
}

if (isDirectCliExecution(import.meta.url)) {
  void runSymphonyServiceCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  });
}
