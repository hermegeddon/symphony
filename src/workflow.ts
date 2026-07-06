import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import { Liquid } from 'liquidjs';
import * as YAML from 'yaml';

export type WorkflowErrorCode =
  | 'missing_workflow_file'
  | 'workflow_parse_error'
  | 'workflow_front_matter_not_a_map'
  | 'template_parse_error'
  | 'template_render_error';

export class WorkflowError extends Error {
  public readonly code: WorkflowErrorCode;

  public constructor(code: WorkflowErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, configurable: true });
    }
  }
}

export class ConfigValidationError extends Error {
  public readonly field: string;

  public constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ConfigValidationError';
    this.field = field;
  }
}

export interface WorkflowDefinition {
  readonly config: Record<string, unknown>;
  readonly prompt_template: string;
  readonly workflow_path: string;
}

export interface ConfigResolutionOptions {
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export type WorkspaceSourceConfig = EmptyDirectoryWorkspaceSourceConfig | GitWorktreeWorkspaceSourceConfig;

export interface EmptyDirectoryWorkspaceSourceConfig {
  readonly kind: 'empty_directory';
}

export interface GitWorktreeWorkspaceSourceConfig {
  readonly kind: 'git_worktree';
  readonly repoPath: string;
  readonly baseRef: string;
  readonly gitCommand: string;
}

export type BackendKind = 'in_process_linear_codex' | 'hermes_kanban';

export interface EffectiveBackendConfig {
  readonly kind: BackendKind;
}

export type KanbanDispatchMode = 'observe_only' | 'dry_run' | 'allow_gateway_dispatch';
export type KanbanBridgeDispatchPolicy = 'dispatchable' | 'no_worker';
export type GraphSyncMode = 'read_only_diff';
export type GraphSyncProposalPolicy = 'propose_only';
export interface GraphSyncDispatchReliance {
  readonly enabled: boolean;
  readonly requireFreshPass: boolean;
}
export interface GraphSyncCaps {
  readonly maxNodes: number;
  readonly maxRelations: number;
  readonly maxKanbanTasks: number;
  readonly maxPages: number;
}
export interface GraphSyncProposalPolicies {
  readonly linearToKanban: GraphSyncProposalPolicy;
  readonly kanbanToLinear: GraphSyncProposalPolicy;
}
export interface GraphSyncBackendConfig {
  readonly enabled: boolean;
  readonly mode: GraphSyncMode;
  readonly artifactRoot: string | null;
  readonly statePath: string | null;
  readonly requireLifecycleReceipt: boolean;
  readonly requireSameBoardScope: boolean;
  readonly freshnessTtlMs: number;
  readonly caps: GraphSyncCaps;
  readonly proposalPolicy: GraphSyncProposalPolicies;
  readonly dispatchReliance: GraphSyncDispatchReliance;
}

export type KanbanWorkspacePolicy =
  | { readonly kind: 'scratch' }
  | { readonly kind: 'dir'; readonly root: string }
  | { readonly kind: 'worktree'; readonly root: string };

export interface KanbanBackendConfig {
  readonly hermesCommand: string;
  readonly hermesHome: string;
  readonly board: string;
  readonly boardCreate: boolean;
  readonly dispatch: KanbanDispatchMode;
  readonly dispatchPolicy: KanbanBridgeDispatchPolicy;
  readonly defaultAssignee: string | null;
  readonly artifactRoot: string;
  readonly workspace: KanbanWorkspacePolicy;
  readonly safety: {
    readonly requireProfilePreflight: boolean;
    readonly requireReviewGateForRepoMutation: boolean;
    readonly requireHumanGateForExternalActions: boolean;
  };
}

export interface EffectiveConfig {
  readonly backend: EffectiveBackendConfig;
  readonly kanban: KanbanBackendConfig | null;
  readonly tracker: {
    readonly kind: string | null;
    readonly endpoint: string;
    readonly apiKey: string | null;
    readonly projectSlug: string | null;
    readonly teamKey: string | null;
    readonly allApprovedProjects: boolean;
    readonly activeStates: readonly string[];
    readonly terminalStates: readonly string[];
    readonly requireCanary: boolean;
    readonly canaryIssueIdentifier: string | null;
    readonly canaryLabels: readonly string[];
    readonly requiredLabels: readonly string[];
    readonly allowBroadDispatch: boolean;
    readonly maxIssuesPerPoll: number;
    readonly mutations: {
      readonly enabled: boolean;
      readonly commentOnStart: boolean;
      readonly commentOnCompletion: boolean;
      readonly commentOnFailure: boolean;
      readonly startStateId: string | null;
      readonly completedStateId: string | null;
      readonly failedStateId: string | null;
      readonly commentMarker: string;
    };
  };
  readonly polling: {
    readonly intervalMs: number;
  };
  readonly workspace: {
    readonly root: string;
    readonly source: WorkspaceSourceConfig;
  };
  readonly hooks: {
    readonly afterCreate: string | null;
    readonly beforeRun: string | null;
    readonly afterRun: string | null;
    readonly beforeRemove: string | null;
    readonly timeoutMs: number;
  };
  readonly agent: {
    readonly maxConcurrentAgents: number;
    readonly maxTurns: number;
    readonly maxRetryBackoffMs: number;
    readonly maxFailureRetries: number;
    readonly successContinuationDelayMs: number;
    readonly maxConcurrentAgentsByState: Readonly<Record<string, number>>;
  };
  readonly codex: {
    readonly command: string;
    readonly approvalPolicy: unknown;
    readonly threadSandbox: unknown;
    readonly turnSandboxPolicy: unknown;
    readonly turnTimeoutMs: number;
    readonly readTimeoutMs: number;
    readonly stallTimeoutMs: number;
  };
  readonly service: {
    readonly statePath: string | null;
    readonly controlPlane: {
      readonly enabled: boolean;
      readonly host: string;
      readonly port: number;
      readonly authToken: string | null;
      readonly allowExternalBind: boolean;
    };
  };
  readonly graphSync: GraphSyncBackendConfig;
}

export type DispatchPreflightErrorCode =
  | 'invalid_workflow_config'
  | 'missing_tracker_kind'
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'missing_codex_command'
  | 'missing_canary_selector'
  | 'missing_broad_dispatch_authorization';

export interface DispatchPreflightError {
  readonly code: DispatchPreflightErrorCode;
  readonly field: string;
  readonly message?: string;
}

const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress'] as const;
const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'] as const;
const DEFAULT_LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_CODEX_COMMAND = 'codex app-server';
const DEFAULT_BACKEND_KIND: BackendKind = 'in_process_linear_codex';
const DEFAULT_KANBAN_HERMES_COMMAND = 'hermes';
const DEFAULT_KANBAN_DISPATCH: KanbanDispatchMode = 'observe_only';
const DEFAULT_KANBAN_DISPATCH_POLICY: KanbanBridgeDispatchPolicy = 'dispatchable';

export async function loadWorkflow(workflowPath = path.join(process.cwd(), 'WORKFLOW.md')): Promise<WorkflowDefinition> {
  let content: string;
  try {
    content = await readFile(workflowPath, 'utf8');
  } catch (error) {
    throw new WorkflowError('missing_workflow_file', `Unable to read workflow file: ${workflowPath}`, error);
  }

  const parsed = parseWorkflowContent(content, workflowPath);
  return {
    config: parsed.config,
    prompt_template: parsed.promptTemplate,
    workflow_path: workflowPath,
  };
}

export function getEffectiveConfig(
  workflow: WorkflowDefinition,
  options: ConfigResolutionOptions = {},
): EffectiveConfig {
  const env = options.env ?? process.env;
  const backend = objectAt(workflow.config, 'backend');
  const kanban = objectAt(workflow.config, 'kanban');
  const tracker = objectAt(workflow.config, 'tracker');
  const polling = objectAt(workflow.config, 'polling');
  const workspace = objectAt(workflow.config, 'workspace');
  const hooks = objectAt(workflow.config, 'hooks');
  const agent = objectAt(workflow.config, 'agent');
  const codex = objectAt(workflow.config, 'codex');
  const service = objectAt(workflow.config, 'service');
  const controlPlane = objectAtValue(service, 'control_plane', 'service.control_plane');
  const trackerMutations = objectAtValue(tracker, 'mutations', 'tracker.mutations');
  const graphSync = objectAt(workflow.config, 'graph_sync');

  const backendKind = backendKindConfig(backend);
  const kanbanConfig = backendKind === 'hermes_kanban'
    ? kanbanBackendConfig(kanban, workflow.workflow_path, env)
    : null;

  const trackerKind = optionalString(tracker, 'kind', 'tracker.kind');
  const trackerEndpoint = optionalString(tracker, 'endpoint', 'tracker.endpoint') ?? DEFAULT_LINEAR_ENDPOINT;
  const rawApiKey = optionalString(tracker, 'api_key', 'tracker.api_key');
  const trackerApiKey = rawApiKey === null ? null : resolveExactEnvToken(rawApiKey, env);
  const trackerProjectSlug = optionalString(tracker, 'project_slug', 'tracker.project_slug');
  const trackerTeamKey = optionalString(tracker, 'team_key', 'tracker.team_key');
  const trackerAllApprovedProjects = optionalBoolean(tracker, 'all_approved_projects', 'tracker.all_approved_projects', false);
  const normalizedTrackerProjectSlug = emptyToNull(trackerProjectSlug);
  const normalizedTrackerTeamKey = emptyToNull(trackerTeamKey);
  if (trackerAllApprovedProjects && (normalizedTrackerProjectSlug !== null || normalizedTrackerTeamKey !== null)) {
    throw new ConfigValidationError(
      'tracker.all_approved_projects',
      'cannot be combined with tracker.project_slug or tracker.team_key',
    );
  }
  const trackerRequireCanary = optionalBoolean(tracker, 'require_canary', 'tracker.require_canary', false);
  const trackerCanaryIssueIdentifier = optionalString(tracker, 'canary_issue_identifier', 'tracker.canary_issue_identifier');
  const trackerCanaryLabels =
    optionalStringArray(tracker, 'canary_labels', 'tracker.canary_labels')?.map((label) => label.toLowerCase()) ?? [];
  const rawTrackerRequiredLabels = optionalStringArray(tracker, 'required_labels', 'tracker.required_labels');
  if (rawTrackerRequiredLabels !== null) {
    for (const label of rawTrackerRequiredLabels) {
      if (label.trim() === '') {
        throw new ConfigValidationError('tracker.required_labels', 'entries must be non-empty, non-whitespace strings');
      }
    }
  }
  const trackerRequiredLabels = rawTrackerRequiredLabels?.map((label) => label.toLowerCase().trim()) ?? [];
  const controlPlaneEnabled = optionalBoolean(controlPlane, 'enabled', 'service.control_plane.enabled', false);
  const controlPlaneHost = optionalString(controlPlane, 'host', 'service.control_plane.host') ?? '127.0.0.1';
  const controlPlanePort = nonNegativeInteger(controlPlane, 'port', 'service.control_plane.port', 0);
  const controlPlaneAuthToken = emptyToNull(resolveExactEnvToken(optionalString(controlPlane, 'auth_token', 'service.control_plane.auth_token') ?? '', env));
  const controlPlaneAllowExternalBind = optionalBoolean(controlPlane, 'allow_external_bind', 'service.control_plane.allow_external_bind', false);
  if (controlPlaneEnabled && !isLoopbackHost(controlPlaneHost) && !controlPlaneAllowExternalBind) {
    throw new ConfigValidationError('service.control_plane.allow_external_bind', 'must be true when binding outside loopback');
  }
  if (controlPlaneEnabled && !isLoopbackHost(controlPlaneHost) && controlPlaneAuthToken === null) {
    throw new ConfigValidationError('service.control_plane.auth_token', 'is required for external bind');
  }

  return {
    backend: { kind: backendKind },
    kanban: kanbanConfig,
    tracker: {
      kind: trackerKind,
      endpoint: trackerEndpoint,
      apiKey: emptyToNull(trackerApiKey),
      projectSlug: normalizedTrackerProjectSlug,
      teamKey: normalizedTrackerTeamKey,
      allApprovedProjects: trackerAllApprovedProjects,
      activeStates: optionalStringArray(tracker, 'active_states', 'tracker.active_states') ?? [...DEFAULT_ACTIVE_STATES],
      terminalStates:
        optionalStringArray(tracker, 'terminal_states', 'tracker.terminal_states') ?? [...DEFAULT_TERMINAL_STATES],
      requireCanary: trackerRequireCanary,
      canaryIssueIdentifier: trackerCanaryIssueIdentifier,
      canaryLabels: trackerCanaryLabels,
      requiredLabels: trackerRequiredLabels,
      allowBroadDispatch: optionalBoolean(tracker, 'allow_broad_dispatch', 'tracker.allow_broad_dispatch', false),
      maxIssuesPerPoll: positiveInteger(tracker, 'max_issues_per_poll', 'tracker.max_issues_per_poll', 50),
      mutations: {
        enabled: optionalBoolean(trackerMutations, 'enabled', 'tracker.mutations.enabled', false),
        commentOnStart: optionalBoolean(trackerMutations, 'comment_on_start', 'tracker.mutations.comment_on_start', true),
        commentOnCompletion: optionalBoolean(trackerMutations, 'comment_on_completion', 'tracker.mutations.comment_on_completion', true),
        commentOnFailure: optionalBoolean(trackerMutations, 'comment_on_failure', 'tracker.mutations.comment_on_failure', true),
        startStateId: emptyToNull(optionalString(trackerMutations, 'start_state_id', 'tracker.mutations.start_state_id')),
        completedStateId: emptyToNull(optionalString(trackerMutations, 'completed_state_id', 'tracker.mutations.completed_state_id')),
        failedStateId: emptyToNull(optionalString(trackerMutations, 'failed_state_id', 'tracker.mutations.failed_state_id')),
        commentMarker: optionalString(trackerMutations, 'comment_marker', 'tracker.mutations.comment_marker') ?? 'symphony-ts',
      },
    },
    polling: {
      intervalMs: positiveInteger(polling, 'interval_ms', 'polling.interval_ms', 30000),
    },
    workspace: {
      root: resolveConfigPath(
        optionalString(workspace, 'root', 'workspace.root') ?? path.join(tmpdir(), 'symphony_workspaces'),
        workflow.workflow_path,
        env,
      ),
      source: workspaceSourceConfig(workspace, workflow.workflow_path, env),
    },
    hooks: {
      afterCreate: optionalString(hooks, 'after_create', 'hooks.after_create'),
      beforeRun: optionalString(hooks, 'before_run', 'hooks.before_run'),
      afterRun: optionalString(hooks, 'after_run', 'hooks.after_run'),
      beforeRemove: optionalString(hooks, 'before_remove', 'hooks.before_remove'),
      timeoutMs: positiveInteger(hooks, 'timeout_ms', 'hooks.timeout_ms', 60000),
    },
    agent: {
      maxConcurrentAgents: positiveInteger(agent, 'max_concurrent_agents', 'agent.max_concurrent_agents', 10),
      maxTurns: positiveInteger(agent, 'max_turns', 'agent.max_turns', 20),
      maxRetryBackoffMs: positiveInteger(agent, 'max_retry_backoff_ms', 'agent.max_retry_backoff_ms', 300000),
      maxFailureRetries: nonNegativeInteger(agent, 'max_failure_retries', 'agent.max_failure_retries', 5),
      successContinuationDelayMs: nonNegativeInteger(
        agent,
        'success_continuation_delay_ms',
        'agent.success_continuation_delay_ms',
        1000,
      ),
      maxConcurrentAgentsByState: stateConcurrencyMap(agent['max_concurrent_agents_by_state']),
    },
    codex: {
      command: optionalString(codex, 'command', 'codex.command') ?? DEFAULT_CODEX_COMMAND,
      approvalPolicy: codex['approval_policy'] ?? null,
      threadSandbox: codex['thread_sandbox'] ?? null,
      turnSandboxPolicy: codex['turn_sandbox_policy'] ?? null,
      turnTimeoutMs: positiveInteger(codex, 'turn_timeout_ms', 'codex.turn_timeout_ms', 3600000),
      readTimeoutMs: positiveInteger(codex, 'read_timeout_ms', 'codex.read_timeout_ms', 5000),
      stallTimeoutMs: nonNegativeInteger(codex, 'stall_timeout_ms', 'codex.stall_timeout_ms', 300000),
    },
    service: {
      statePath: serviceStatePath(service, workflow.workflow_path, env),
      controlPlane: {
        enabled: controlPlaneEnabled,
        host: controlPlaneHost,
        port: controlPlanePort,
        authToken: controlPlaneAuthToken,
        allowExternalBind: controlPlaneAllowExternalBind,
      },
    },
    graphSync: graphSyncBackendConfig(graphSync, workflow.workflow_path, env),
  };
}

export function validateDispatchPreflight(
  workflow: WorkflowDefinition,
  options: ConfigResolutionOptions = {},
): readonly DispatchPreflightError[] {
  let config: EffectiveConfig;
  try {
    config = getEffectiveConfig(workflow, options);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return [{ code: 'invalid_workflow_config', field: error.field, message: error.message }];
    }
    throw error;
  }

  const errors: DispatchPreflightError[] = [];

  if (config.backend.kind === 'hermes_kanban') {
    return errors;
  }

  if (config.tracker.kind === null || config.tracker.kind.trim() === '') {
    errors.push({ code: 'missing_tracker_kind', field: 'tracker.kind' });
  } else if (config.tracker.kind !== 'linear') {
    errors.push({ code: 'unsupported_tracker_kind', field: 'tracker.kind' });
  }

  if (config.tracker.apiKey === null) {
    errors.push({ code: 'missing_tracker_api_key', field: 'tracker.api_key' });
  }

  if (
    config.tracker.kind === 'linear'
    && config.tracker.projectSlug === null
    && config.tracker.teamKey === null
    && !config.tracker.allApprovedProjects
  ) {
    errors.push({
      code: 'missing_tracker_project_slug',
      field: 'tracker.project_slug, tracker.team_key, or tracker.all_approved_projects',
      message: 'Linear tracker requires a project_slug, team_key, or all_approved_projects selector scope',
    });
  }

  if (config.tracker.requireCanary && config.tracker.kind === 'linear') {
    const hasCanary =
      config.tracker.canaryIssueIdentifier !== null && config.tracker.canaryIssueIdentifier.trim() !== '';
    const hasCanaryLabels = config.tracker.canaryLabels.length > 0;
    if (!hasCanary && !hasCanaryLabels) {
      errors.push({
        code: 'missing_canary_selector',
        field: 'tracker.canary_issue_identifier or tracker.canary_labels',
        message: 'require_canary is enabled but no canary_issue_identifier or canary_labels selector is configured',
      });
    }
  }

  if (
    !config.tracker.requireCanary
    && config.tracker.kind === 'linear'
    && config.tracker.apiKey !== null
    && (
      config.tracker.projectSlug !== null
      || config.tracker.teamKey !== null
      || config.tracker.allApprovedProjects
    )
    && isLiveDispatchCommand(config.codex.command)
  ) {
    const hasExactIssueSelector =
      config.tracker.canaryIssueIdentifier !== null && config.tracker.canaryIssueIdentifier.trim() !== '';
    if (!hasExactIssueSelector && !config.tracker.allowBroadDispatch) {
      errors.push({
        code: 'missing_broad_dispatch_authorization',
        field: 'tracker.allow_broad_dispatch',
        message: 'broad Linear dispatch requires tracker.allow_broad_dispatch: true when require_canary is disabled and no exact issue selector is configured',
      });
    }
  }

  if (config.codex.command.trim() === '') {
    errors.push({ code: 'missing_codex_command', field: 'codex.command' });
  }

  return errors;
}

export async function renderPromptTemplate(
  promptTemplate: string,
  variables: Readonly<Record<string, unknown>>,
): Promise<string> {
  const engine = new Liquid({ strictFilters: true, strictVariables: true });

  try {
    const rendered: unknown = await engine.parseAndRender(promptTemplate, variables);
    if (typeof rendered !== 'string') {
      throw new TypeError('Liquid renderer returned a non-string value');
    }
    return rendered;
  } catch (error) {
    throw new WorkflowError('template_render_error', 'Failed to render workflow prompt template', error);
  }
}

function parseWorkflowContent(content: string, workflowPath: string): { config: Record<string, unknown>; promptTemplate: string } {
  if (!content.startsWith('---')) {
    return { config: {}, promptTemplate: content.trim() };
  }

  const firstLineMatch = /^---(?:\r?\n|$)/.exec(content);
  if (firstLineMatch === null) {
    return { config: {}, promptTemplate: content.trim() };
  }

  const frontMatterStart = firstLineMatch[0].length;
  const closingMarker = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(content.slice(frontMatterStart));
  if (closingMarker === null) {
    throw new WorkflowError('workflow_parse_error', `Unterminated YAML front matter in ${workflowPath}`);
  }

  const relativeClosingStart = closingMarker.index;
  const closingText = closingMarker[0];
  const frontMatterText = content.slice(frontMatterStart, frontMatterStart + relativeClosingStart).replace(/\r?\n$/, '');
  const promptStart = frontMatterStart + relativeClosingStart + closingText.length;
  const promptTemplate = content.slice(promptStart).trim();

  let parsed: unknown;
  try {
    parsed = frontMatterText.trim() === '' ? {} : YAML.parse(frontMatterText);
  } catch (error) {
    throw new WorkflowError('workflow_parse_error', `Unable to parse YAML front matter in ${workflowPath}`, error);
  }

  if (!isPlainRecord(parsed)) {
    throw new WorkflowError(
      'workflow_front_matter_not_a_map',
      `YAML front matter in ${workflowPath} must decode to a map/object`,
    );
  }

  return { config: parsed, promptTemplate };
}

function objectAt(source: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const value = source[key];
  if (value === undefined) {
    return {};
  }
  if (!isPlainRecord(value)) {
    throw new ConfigValidationError(key, 'must be an object when present');
  }
  return value;
}

function objectAtValue(source: Readonly<Record<string, unknown>>, key: string, field: string): Readonly<Record<string, unknown>> {
  const value = source[key];
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainRecord(value)) {
    throw new ConfigValidationError(field, 'must be an object when present');
  }
  return value;
}

function optionalString(source: Readonly<Record<string, unknown>>, key: string, field: string): string | null {
  const value = source[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new ConfigValidationError(field, 'must be a string');
  }
  return value;
}

function optionalStringArray(
  source: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
): readonly string[] | null {
  const value = source[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(field, 'must be a list of strings');
  }
  const values: readonly unknown[] = value;
  if (values.some((entry) => typeof entry !== 'string')) {
    throw new ConfigValidationError(field, 'must be a list of strings');
  }
  return values as readonly string[];
}

function optionalBoolean(source: Readonly<Record<string, unknown>>, key: string, field: string, defaultValue: boolean): boolean {
  const value = source[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw new ConfigValidationError(field, 'must be a boolean');
  }
  return value;
}

function positiveInteger(source: Readonly<Record<string, unknown>>, key: string, field: string, defaultValue: number): number {
  const value = source[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigValidationError(field, 'must be a positive integer');
  }
  return value;
}

function nonNegativeInteger(
  source: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  defaultValue: number,
): number {
  const value = source[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigValidationError(field, 'must be a non-negative integer');
  }
  return value;
}

function stateConcurrencyMap(value: unknown): Readonly<Record<string, number>> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isPlainRecord(value)) {
    throw new ConfigValidationError('agent.max_concurrent_agents_by_state', 'must be a map when present');
  }

  const result: Record<string, number> = {};
  for (const [state, limit] of Object.entries(value)) {
    if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0) {
      result[state.toLowerCase()] = limit;
    }
  }
  return result;
}

function backendKindConfig(backend: Readonly<Record<string, unknown>>): BackendKind {
  const kind = optionalString(backend, 'kind', 'backend.kind') ?? DEFAULT_BACKEND_KIND;
  if (kind !== 'in_process_linear_codex' && kind !== 'hermes_kanban') {
    throw new ConfigValidationError('backend.kind', 'must be in_process_linear_codex or hermes_kanban');
  }
  return kind;
}

function kanbanBackendConfig(
  kanban: Readonly<Record<string, unknown>>,
  workflowPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): KanbanBackendConfig {
  const workspace = objectAtValue(kanban, 'workspace', 'kanban.workspace');
  const safety = objectAtValue(kanban, 'safety', 'kanban.safety');
  const board = requiredNonEmptyString(kanban, 'board', 'kanban.board');
  if (!isValidKanbanBoardSlug(board)) {
    throw new ConfigValidationError('kanban.board', 'must be a kebab-case board slug');
  }
  const boardCreate = optionalBoolean(kanban, 'board_create', 'kanban.board_create', false);
  if (boardCreate && !isTempOrTestBoardSlug(board)) {
    throw new ConfigValidationError('kanban.board_create', 'can only be true for temp/test-scoped board slugs');
  }
  const dispatch = kanbanDispatchMode(optionalString(kanban, 'dispatch', 'kanban.dispatch'));
  const dispatchPolicy = kanbanBridgeDispatchPolicy(optionalString(kanban, 'dispatch_policy', 'kanban.dispatch_policy'));
  return {
    hermesCommand: requiredNonEmptyString(
      kanban,
      'hermes_command',
      'kanban.hermes_command',
      DEFAULT_KANBAN_HERMES_COMMAND,
    ),
    hermesHome: resolveConfigPath(
      requiredNonEmptyString(kanban, 'hermes_home', 'kanban.hermes_home', '~/.hermes'),
      workflowPath,
      env,
    ),
    board,
    boardCreate,
    dispatch,
    dispatchPolicy,
    defaultAssignee: emptyToNull(optionalString(kanban, 'default_assignee', 'kanban.default_assignee')),
    artifactRoot: resolveConfigPath(
      requiredNonEmptyString(kanban, 'artifact_root', 'kanban.artifact_root'),
      workflowPath,
      env,
    ),
    workspace: kanbanWorkspacePolicy(workspace, env),
    safety: {
      requireProfilePreflight: optionalBoolean(
        safety,
        'require_profile_preflight',
        'kanban.safety.require_profile_preflight',
        true,
      ),
      requireReviewGateForRepoMutation: optionalBoolean(
        safety,
        'require_review_gate_for_repo_mutation',
        'kanban.safety.require_review_gate_for_repo_mutation',
        true,
      ),
      requireHumanGateForExternalActions: optionalBoolean(
        safety,
        'require_human_gate_for_external_actions',
        'kanban.safety.require_human_gate_for_external_actions',
        true,
      ),
    },
  };
}

function kanbanDispatchMode(value: string | null): KanbanDispatchMode {
  const dispatch = value ?? DEFAULT_KANBAN_DISPATCH;
  if (dispatch !== 'observe_only' && dispatch !== 'dry_run' && dispatch !== 'allow_gateway_dispatch') {
    throw new ConfigValidationError('kanban.dispatch', 'must be observe_only, dry_run, or allow_gateway_dispatch');
  }
  return dispatch;
}

function kanbanBridgeDispatchPolicy(value: string | null): KanbanBridgeDispatchPolicy {
  const policy = value ?? DEFAULT_KANBAN_DISPATCH_POLICY;
  if (policy !== 'dispatchable' && policy !== 'no_worker') {
    throw new ConfigValidationError('kanban.dispatch_policy', 'must be dispatchable or no_worker');
  }
  return policy;
}

function kanbanWorkspacePolicy(
  workspace: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): KanbanWorkspacePolicy {
  const kind = optionalString(workspace, 'kind', 'kanban.workspace.kind') ?? 'scratch';
  if (kind === 'scratch') {
    return { kind: 'scratch' };
  }
  if (kind !== 'dir' && kind !== 'worktree') {
    throw new ConfigValidationError('kanban.workspace.kind', 'must be scratch, dir, or worktree');
  }
  const root = requiredNonEmptyString(workspace, 'root', 'kanban.workspace.root');
  return { kind, root: resolveRequiredAbsoluteConfigPath(root, 'kanban.workspace.root', env) };
}

function resolveRequiredAbsoluteConfigPath(
  rawPath: string,
  field: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  let expanded = resolveExactEnvToken(rawPath, env);
  if (expanded.startsWith('~')) {
    const home = env['HOME'] ?? homedir();
    expanded = expanded === '~' ? home : path.join(home, expanded.slice(1));
  }
  if (!path.isAbsolute(expanded)) {
    throw new ConfigValidationError(field, 'must be an absolute path');
  }
  return path.resolve(expanded);
}

function isValidKanbanBoardSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}

function isTempOrTestBoardSlug(value: string): boolean {
  return /^(?:tmp|temp|test|sandbox|smoke|fixture|symphony-test)(?:-|$)/.test(value);
}

function serviceStatePath(
  service: Readonly<Record<string, unknown>>,
  workflowPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | null {
  const rawStatePath = optionalString(service, 'state_path', 'service.state_path');
  if (rawStatePath === null || rawStatePath.trim() === '') {
    return null;
  }
  return resolveConfigPath(rawStatePath, workflowPath, env);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function isLiveDispatchCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return normalized === 'codex app-server'
    || normalized.startsWith('codex app-server ')
    || normalized.includes('openai');
}

function workspaceSourceConfig(
  workspace: Readonly<Record<string, unknown>>,
  workflowPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): WorkspaceSourceConfig {
  const value = workspace['source'];
  if (value === undefined || value === null) {
    return { kind: 'empty_directory' };
  }
  if (!isPlainRecord(value)) {
    throw new ConfigValidationError('workspace.source', 'must be an object when present');
  }

  const kind = optionalString(value, 'kind', 'workspace.source.kind') ?? 'empty_directory';
  if (kind === 'empty_directory') {
    return { kind: 'empty_directory' };
  }
  if (kind !== 'git_worktree') {
    throw new ConfigValidationError('workspace.source.kind', 'must be empty_directory or git_worktree');
  }

  const repo = requiredNonEmptyString(value, 'repo', 'workspace.source.repo');
  return {
    kind: 'git_worktree',
    repoPath: resolveConfigPath(repo, workflowPath, env),
    baseRef: requiredNonEmptyString(value, 'base_ref', 'workspace.source.base_ref', 'HEAD'),
    gitCommand: requiredNonEmptyString(value, 'git_command', 'workspace.source.git_command', 'git'),
  };
}

function requiredNonEmptyString(
  source: Readonly<Record<string, unknown>>,
  key: string,
  field: string,
  defaultValue?: string,
): string {
  const value = optionalString(source, key, field) ?? defaultValue;
  if (value === undefined || value.trim() === '') {
    throw new ConfigValidationError(field, 'must be a non-empty string');
  }
  return value;
}

function resolveConfigPath(rawRoot: string, workflowPath: string, env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  let expanded = resolveExactEnvToken(rawRoot, env);
  if (expanded.startsWith('~')) {
    const home = env['HOME'] ?? homedir();
    expanded = expanded === '~' ? home : path.join(home, expanded.slice(1));
  }
  if (!path.isAbsolute(expanded)) {
    expanded = path.join(path.dirname(workflowPath), expanded);
  }
  return path.resolve(expanded);
}

function resolveExactEnvToken(value: string, env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (match === null) {
    return value;
  }
  const variableName = match[1];
  if (variableName === undefined) {
    return value;
  }
  return env[variableName] ?? '';
}

function emptyToNull(value: string | null): string | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function graphSyncBackendConfig(
  graphSync: Readonly<Record<string, unknown>>,
  workflowPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): GraphSyncBackendConfig {
  const enabled = optionalBoolean(graphSync, 'enabled', 'graph_sync.enabled', false);
  if (!enabled) {
    return {
      enabled: false,
      mode: 'read_only_diff',
      artifactRoot: null,
      statePath: null,
      requireLifecycleReceipt: false,
      requireSameBoardScope: false,
      freshnessTtlMs: 300000,
      caps: { maxNodes: 0, maxRelations: 0, maxKanbanTasks: 0, maxPages: 0 },
      proposalPolicy: { linearToKanban: 'propose_only', kanbanToLinear: 'propose_only' },
      dispatchReliance: { enabled: false, requireFreshPass: true },
    };
  }

  const mode = graphSyncMode(graphSync);
  const proposal = objectAtValue(graphSync, 'proposal_policy', 'graph_sync.proposal_policy');
  const linearToKanban = graphSyncProposalPolicy(proposal, 'linear_to_kanban');
  const kanbanToLinear = graphSyncProposalPolicy(proposal, 'kanban_to_linear');

  const caps = objectAtValue(graphSync, 'caps', 'graph_sync.caps');
  const maxNodes = nonNegativeInteger(caps, 'max_nodes', 'graph_sync.caps.max_nodes', 50);
  const maxRelations = nonNegativeInteger(caps, 'max_relations', 'graph_sync.caps.max_relations', 100);
  const maxKanbanTasks = nonNegativeInteger(caps, 'max_kanban_tasks', 'graph_sync.caps.max_kanban_tasks', 50);
  const maxPages = nonNegativeInteger(caps, 'max_pages', 'graph_sync.caps.max_pages', 5);
  if (maxNodes === 0 || maxRelations === 0 || maxKanbanTasks === 0 || maxPages === 0) {
    throw new ConfigValidationError('graph_sync.caps', 'mutation caps must be positive integers in this version');
  }

  const rawArtifactRoot = optionalString(graphSync, 'artifact_root', 'graph_sync.artifact_root');
  const rawStatePath = optionalString(graphSync, 'state_path', 'graph_sync.state_path');
  const dispatchReliance = objectAtValue(graphSync, 'dispatch_reliance', 'graph_sync.dispatch_reliance');

  return {
    enabled: true,
    mode,
    artifactRoot: rawArtifactRoot === null ? null : resolveConfigPath(rawArtifactRoot, workflowPath, env),
    statePath: rawStatePath === null ? null : resolveConfigPath(rawStatePath, workflowPath, env),
    requireLifecycleReceipt: optionalBoolean(graphSync, 'require_lifecycle_receipt', 'graph_sync.require_lifecycle_receipt', true),
    requireSameBoardScope: optionalBoolean(graphSync, 'require_same_board_scope', 'graph_sync.require_same_board_scope', true),
    freshnessTtlMs: positiveInteger(graphSync, 'freshness_ttl_ms', 'graph_sync.freshness_ttl_ms', 300000),
    caps: {
      maxNodes,
      maxRelations,
      maxKanbanTasks,
      maxPages,
    },
    proposalPolicy: {
      linearToKanban,
      kanbanToLinear,
    },
    dispatchReliance: {
      enabled: optionalBoolean(dispatchReliance, 'enabled', 'graph_sync.dispatch_reliance.enabled', false),
      requireFreshPass: optionalBoolean(dispatchReliance, 'require_fresh_pass', 'graph_sync.dispatch_reliance.require_fresh_pass', true),
    },
  };
}

function graphSyncMode(source: Readonly<Record<string, unknown>>): GraphSyncMode {
  const value = optionalString(source, 'mode', 'graph_sync.mode') ?? 'read_only_diff';
  if (value !== 'read_only_diff') {
    throw new ConfigValidationError('graph_sync.mode', 'must be read_only_diff');
  }
  return value;
}

function graphSyncProposalPolicy(
  source: Readonly<Record<string, unknown>>,
  key: 'linear_to_kanban' | 'kanban_to_linear',
): GraphSyncProposalPolicy {
  const value = optionalString(source, key, `graph_sync.proposal_policy.${key}`) ?? 'propose_only';
  if (value !== 'propose_only') {
    throw new ConfigValidationError(`graph_sync.proposal_policy.${key}`, 'must be propose_only');
  }
  return value;
}

export function fakeGraphSyncBackendConfigForTests(): GraphSyncBackendConfig {
  return {
    enabled: true,
    mode: 'read_only_diff',
    artifactRoot: null,
    statePath: null,
    requireLifecycleReceipt: true,
    requireSameBoardScope: true,
    freshnessTtlMs: 300000,
    caps: { maxNodes: 50, maxRelations: 100, maxKanbanTasks: 50, maxPages: 5 },
    proposalPolicy: { linearToKanban: 'propose_only', kanbanToLinear: 'propose_only' },
    dispatchReliance: { enabled: false, requireFreshPass: true },
  };
}
