import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  WorkflowError,
  getEffectiveConfig,
  loadWorkflow,
  renderPromptTemplate,
  validateDispatchPreflight,
} from '../src/workflow.js';

async function tempWorkflow(content: string, filename = 'WORKFLOW.md'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'symphony-workflow-test-'));
  const filePath = path.join(dir, filename);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('workflow loader', () => {
  it('fails with missing_workflow_file when WORKFLOW.md cannot be read', async () => {
    await expect(loadWorkflow('/definitely/missing/WORKFLOW.md')).rejects.toMatchObject({
      code: 'missing_workflow_file',
    });
  });

  it('parses optional YAML front matter and trims Markdown prompt body', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  project_slug: OPS
---

  Work on {{ issue.identifier }}.  \n\n`);

    await expect(loadWorkflow(workflowPath)).resolves.toEqual({
      config: { tracker: { kind: 'linear', project_slug: 'OPS' } },
      prompt_template: 'Work on {{ issue.identifier }}.',
      workflow_path: workflowPath,
    });
  });

  it('uses an empty config map when front matter is absent', async () => {
    const workflowPath = await tempWorkflow('\n# Plain prompt\n');

    await expect(loadWorkflow(workflowPath)).resolves.toMatchObject({
      config: {},
      prompt_template: '# Plain prompt',
    });
  });

  it('fails YAML syntax errors as workflow_parse_error', async () => {
    const workflowPath = await tempWorkflow(`---
tracker: [unterminated
---
Prompt
`);

    await expect(loadWorkflow(workflowPath)).rejects.toMatchObject({ code: 'workflow_parse_error' });
  });

  it('enforces map/object YAML front matter', async () => {
    const workflowPath = await tempWorkflow(`---
- tracker
- polling
---
Prompt
`);

    await expect(loadWorkflow(workflowPath)).rejects.toMatchObject({
      code: 'workflow_front_matter_not_a_map',
    });
  });
});

describe('typed effective config', () => {
  it('applies documented defaults and tolerates unknown keys', async () => {
    const workflowPath = await tempWorkflow(`---
unknown_extension:
  future: true
tracker:
  kind: linear
  api_key: literal-token
  project_slug: CORE
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(getEffectiveConfig(workflow, { env: {} })).toMatchObject({
      tracker: {
        kind: 'linear',
        endpoint: 'https://api.linear.app/graphql',
        apiKey: 'literal-token',
        projectSlug: 'CORE',
        teamKey: null,
        activeStates: ['Todo', 'In Progress'],
        terminalStates: ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'],
        requireCanary: false,
        canaryIssueIdentifier: null,
        canaryLabels: [],
      },
      polling: { intervalMs: 30000 },
      workspace: {
        root: path.join(tmpdir(), 'symphony_workspaces'),
        source: { kind: 'empty_directory' },
      },
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 60000,
      },
      agent: {
        maxConcurrentAgents: 10,
        maxTurns: 20,
        maxRetryBackoffMs: 300000,
        maxFailureRetries: 5,
        maxConcurrentAgentsByState: {},
      },
      codex: {
        command: 'codex app-server',
        approvalPolicy: null,
        threadSandbox: null,
        turnSandboxPolicy: null,
        turnTimeoutMs: 3600000,
        readTimeoutMs: 5000,
        stallTimeoutMs: 300000,
      },
      graphSync: {
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
      },
    });
  });

  it('resolves env indirection only for allowed $VAR_NAME fields', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: $LINEAR_TOKEN
  project_slug: SHOULD_NOT_BE_ENV_OVERRIDDEN
workspace:
  root: $WORKSPACE_ROOT
codex:
  command: $CODEX_COMMAND
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    const config = getEffectiveConfig(workflow, {
      env: {
        LINEAR_TOKEN: 'resolved-token',
        LINEAR_API_KEY: 'canonical-but-not-global',
        WORKSPACE_ROOT: '~/relative-from-home',
        CODEX_COMMAND: 'should-not-resolve-command',
        SHOULD_NOT_BE_ENV_OVERRIDDEN: 'env-project',
        HOME: '/home/tester',
      },
    });

    expect(config.tracker.apiKey).toBe('resolved-token');
    expect(config.tracker.projectSlug).toBe('SHOULD_NOT_BE_ENV_OVERRIDDEN');
    expect(config.workspace.root).toBe(path.resolve('/home/tester/relative-from-home'));
    expect(config.codex.command).toBe('$CODEX_COMMAND');
  });

  it('resolves relative workspace.root values relative to WORKFLOW.md and normalizes absolute paths', async () => {
    const workflowPath = await tempWorkflow(`---
workspace:
  root: .cache/symphony/../workspaces
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(getEffectiveConfig(workflow, { env: {} }).workspace.root).toBe(
      path.join(path.dirname(workflowPath), '.cache', 'workspaces'),
    );
  });

  it('resolves a typed git worktree workspace source relative to WORKFLOW.md', async () => {
    const workflowPath = await tempWorkflow(`---
workspace:
  root: ./workspaces
  source:
    kind: git_worktree
    repo: ../source-repo
    base_ref: main
    git_command: custom-git
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(getEffectiveConfig(workflow, { env: {} }).workspace).toEqual({
      root: path.join(path.dirname(workflowPath), 'workspaces'),
      source: {
        kind: 'git_worktree',
        repoPath: path.join(path.dirname(workflowPath), '..', 'source-repo'),
        baseRef: 'main',
        gitCommand: 'custom-git',
      },
    });
  });

  it('parses a typed Hermes Kanban backend without requiring legacy Linear/Codex config', async () => {
    const workflowPath = await tempWorkflow(`---
backend:
  kind: hermes_kanban
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: symphony-test
  board_create: false
  dispatch: dry_run
  default_assignee: default
  artifact_root: ./artifacts/symphony-test
  workspace:
    kind: worktree
    root: /tmp/symphony-test-worktrees
  safety:
    require_profile_preflight: true
    require_review_gate_for_repo_mutation: true
    require_human_gate_for_external_actions: true
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);
    const config = getEffectiveConfig(workflow, { env: {} });

    expect(config.backend).toEqual({ kind: 'hermes_kanban' });
    expect(config.kanban).toEqual({
      hermesCommand: '/safe/bin/hermes',
      hermesHome: path.join(path.dirname(workflowPath), 'hermes-home'),
      board: 'symphony-test',
      boardCreate: false,
      dispatch: 'dry_run',
      dispatchPolicy: 'dispatchable',
      defaultAssignee: 'default',
      artifactRoot: path.join(path.dirname(workflowPath), 'artifacts', 'symphony-test'),
      workspace: { kind: 'worktree', root: '/tmp/symphony-test-worktrees' },
      safety: {
        requireProfilePreflight: true,
        requireReviewGateForRepoMutation: true,
        requireHumanGateForExternalActions: true,
      },
    });
    expect(config.graphSync).toEqual({
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
    });
    expect(validateDispatchPreflight(workflow, { env: {} })).toEqual([]);
  });

  it('rejects unsafe Kanban backend config with field-specific validation errors', async () => {
    const invalidBoardPath = await tempWorkflow(`---
backend:
  kind: hermes_kanban
kanban:
  hermes_command: hermes
  hermes_home: /tmp/hermes-home
  board: Symphony Default
  artifact_root: /tmp/artifacts
  workspace:
    kind: dir
    root: /tmp/symphony-workspace
---
Prompt
`);
    await expect(loadWorkflow(invalidBoardPath).then((workflow) => getEffectiveConfig(workflow, { env: {} }))).rejects.toThrow(/kanban\.board/);

    const relativeWorkspacePath = await tempWorkflow(`---
backend:
  kind: hermes_kanban
kanban:
  hermes_command: hermes
  hermes_home: /tmp/hermes-home
  board: symphony-test
  artifact_root: /tmp/artifacts
  workspace:
    kind: dir
    root: relative/path
---
Prompt
`);
    await expect(loadWorkflow(relativeWorkspacePath).then((workflow) => getEffectiveConfig(workflow, { env: {} }))).rejects.toThrow(/kanban\.workspace\.root/);
  });

  it('rejects incomplete git worktree workspace source config with a field-specific error', async () => {
    const workflowPath = await tempWorkflow(`---
workspace:
  source:
    kind: git_worktree
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(ConfigValidationError);
    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(/workspace\.source\.repo/);
  });

  it('rejects invalid numeric config values with field-specific validation errors', async () => {
    const workflowPath = await tempWorkflow(`---
polling:
  interval_ms: 0
hooks:
  timeout_ms: nope
agent:
  max_turns: -1
codex:
  read_timeout_ms: -5
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(ConfigValidationError);
    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(/polling.interval_ms/);
  });

  it('ignores invalid max_concurrent_agents_by_state entries and normalizes valid state keys', async () => {
    const workflowPath = await tempWorkflow(`---
agent:
  max_concurrent_agents_by_state:
    In Progress: 2
    Closed: 0
    Review: three
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(getEffectiveConfig(workflow, { env: {} }).agent.maxConcurrentAgentsByState).toEqual({
      'in progress': 2,
    });
  });

  it('parses a read-only graph_sync config for local fake use', async () => {
    const workflowPath = await tempWorkflow(`---
backend:
  kind: hermes_kanban
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: symphony-test
  dispatch: dry_run
  artifact_root: ./artifacts/symphony-test
  workspace:
    kind: worktree
    root: /tmp/symphony-test-worktrees
graph_sync:
  enabled: true
  mode: read_only_diff
  artifact_root: ./artifacts/symphony-test/graph-sync
  state_path: ./private/graph-sync-state.json
  require_lifecycle_receipt: true
  require_same_board_scope: true
  freshness_ttl_ms: 600000
  caps:
    max_nodes: 40
    max_relations: 80
    max_kanban_tasks: 40
    max_pages: 4
  proposal_policy:
    linear_to_kanban: propose_only
    kanban_to_linear: propose_only
  dispatch_reliance:
    enabled: false
    require_fresh_pass: true
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);
    const config = getEffectiveConfig(workflow, { env: {} });

    expect(config.graphSync).toEqual({
      enabled: true,
      mode: 'read_only_diff',
      artifactRoot: path.join(path.dirname(workflowPath), 'artifacts', 'symphony-test', 'graph-sync'),
      statePath: path.join(path.dirname(workflowPath), 'private', 'graph-sync-state.json'),
      requireLifecycleReceipt: true,
      requireSameBoardScope: true,
      freshnessTtlMs: 600000,
      caps: { maxNodes: 40, maxRelations: 80, maxKanbanTasks: 40, maxPages: 4 },
      proposalPolicy: { linearToKanban: 'propose_only', kanbanToLinear: 'propose_only' },
      dispatchReliance: { enabled: false, requireFreshPass: true },
    });
  });

  it('rejects apply-like graph_sync modes in this version', async () => {
    const workflowPath = await tempWorkflow(`---
backend:
  kind: hermes_kanban
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: symphony-test
  dispatch: dry_run
  artifact_root: /tmp/artifacts
  workspace:
    kind: worktree
    root: /tmp/symphony-test-worktrees
graph_sync:
  enabled: true
  mode: linear_authoritative_apply
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(ConfigValidationError);
    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(/graph_sync\.mode/);
  });

  it('rejects non-propose-only graph_sync proposal policies', async () => {
    const workflowPath = await tempWorkflow(`---
backend:
  kind: hermes_kanban
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: symphony-test
  dispatch: dry_run
  artifact_root: /tmp/artifacts
  workspace:
    kind: worktree
    root: /tmp/symphony-test-worktrees
graph_sync:
  enabled: true
  mode: read_only_diff
  proposal_policy:
    linear_to_kanban: propose_only
    kanban_to_linear: auto_apply
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(ConfigValidationError);
    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(/graph_sync\.proposal_policy/);
  });

  it('rejects zero mutation caps in graph_sync config', async () => {
    const workflowPath = await tempWorkflow(`---
backend:
  kind: hermes_kanban
kanban:
  hermes_command: /safe/bin/hermes
  hermes_home: ./hermes-home
  board: symphony-test
  dispatch: dry_run
  artifact_root: /tmp/artifacts
  workspace:
    kind: worktree
    root: /tmp/symphony-test-worktrees
graph_sync:
  enabled: true
  caps:
    max_nodes: 0
    max_relations: 100
    max_kanban_tasks: 50
    max_pages: 5
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(ConfigValidationError);
    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(/graph_sync\.caps/);
  });
});

describe('dispatch preflight and strict templates', () => {
  it('reports documented dispatch validation errors without globally reading env defaults', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
codex:
  command: ''
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(validateDispatchPreflight(workflow, { env: { LINEAR_API_KEY: '' } })).toEqual([
      { code: 'missing_tracker_api_key', field: 'tracker.api_key' },
      {
        code: 'missing_tracker_project_slug',
        field: 'tracker.project_slug, tracker.team_key, or tracker.all_approved_projects',
        message: 'Linear tracker requires a project_slug, team_key, or all_approved_projects selector scope',
      },
      { code: 'missing_codex_command', field: 'codex.command' },
    ]);
  });

  it('reports missing_canary_selector when require_canary is true without a selector', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  project_slug: CORE
  require_canary: true
codex:
  command: fake-codex
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(validateDispatchPreflight(workflow)).toEqual([
      {
        code: 'missing_canary_selector',
        field: 'tracker.canary_issue_identifier or tracker.canary_labels',
        message: 'require_canary is enabled but no canary_issue_identifier or canary_labels selector is configured',
      },
    ]);
  });

  it('passes dispatch preflight when a canary selector is configured', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  project_slug: CORE
  require_canary: true
  canary_issue_identifier: CORE-1
codex:
  command: fake-codex
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(validateDispatchPreflight(workflow)).toEqual([]);
  });

  it('passes dispatch preflight with a team-key selector scope instead of a project slug', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  team_key: HER
  allow_broad_dispatch: true
codex:
  command: codex app-server
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);
    const config = getEffectiveConfig(workflow, { env: {} });

    expect(config.tracker.projectSlug).toBeNull();
    expect(config.tracker.teamKey).toBe('HER');
    expect(validateDispatchPreflight(workflow)).toEqual([]);
  });

  it('passes dispatch preflight with an explicit all-approved-projects selector scope', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  all_approved_projects: true
  allow_broad_dispatch: true
  max_issues_per_poll: 2
codex:
  command: codex app-server
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);
    const config = getEffectiveConfig(workflow, { env: {} });

    expect(config.tracker.projectSlug).toBeNull();
    expect(config.tracker.teamKey).toBeNull();
    expect(config.tracker.allApprovedProjects).toBe(true);
    expect(config.tracker.maxIssuesPerPoll).toBe(2);
    expect(validateDispatchPreflight(workflow)).toEqual([]);
  });

  it('rejects all-approved-projects selector scope when combined with a narrower selector', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  project_slug: CORE
  all_approved_projects: true
codex:
  command: fake-codex
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(() => getEffectiveConfig(workflow, { env: {} })).toThrow(ConfigValidationError);
    expect(validateDispatchPreflight(workflow, { env: {} })).toEqual([
      expect.objectContaining({
        code: 'invalid_workflow_config',
        field: 'tracker.all_approved_projects',
      }),
    ]);
  });

  it('requires explicit broad dispatch authorization for live Codex selectors without exact issue scope', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  project_slug: CORE
codex:
  command: codex app-server
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(validateDispatchPreflight(workflow)).toEqual([
      {
        code: 'missing_broad_dispatch_authorization',
        field: 'tracker.allow_broad_dispatch',
        message: 'broad Linear dispatch requires tracker.allow_broad_dispatch: true when require_canary is disabled and no exact issue selector is configured',
      },
    ]);
  });

  it('parses broad live operation safety config for selectors, mutation, ledger state, and loopback control plane', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  project_slug: CORE
  allow_broad_dispatch: true
  max_issues_per_poll: 3
  mutations:
    enabled: true
    comment_on_start: false
    completed_state_id: state-done
    comment_marker: symphony-test
service:
  state_path: ./private/live-ledger.json
  control_plane:
    enabled: true
    host: 127.0.0.1
    port: 8765
    auth_token: $CONTROL_TOKEN
codex:
  command: codex app-server
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);
    const config = getEffectiveConfig(workflow, { env: { CONTROL_TOKEN: 'control-secret' } });

    expect(validateDispatchPreflight(workflow, { env: { CONTROL_TOKEN: 'control-secret' } })).toEqual([]);
    expect(config.tracker.allowBroadDispatch).toBe(true);
    expect(config.tracker.maxIssuesPerPoll).toBe(3);
    expect(config.tracker.mutations).toMatchObject({
      enabled: true,
      commentOnStart: false,
      completedStateId: 'state-done',
      commentMarker: 'symphony-test',
    });
    expect(config.service.statePath).toMatch(/private\/live-ledger\.json$/);
    expect(config.service.controlPlane).toMatchObject({
      enabled: true,
      host: '127.0.0.1',
      port: 8765,
      authToken: 'control-secret',
      allowExternalBind: false,
    });
  });

  it('rejects external control-plane bind unless explicit external bind and auth token are configured', async () => {
    const workflowPath = await tempWorkflow(`---
service:
  control_plane:
    enabled: true
    host: 0.0.0.0
codex:
  command: fake-codex
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(validateDispatchPreflight(workflow)).toEqual([
      expect.objectContaining({
        code: 'invalid_workflow_config',
        field: 'service.control_plane.allow_external_bind',
      }),
    ]);
  });

  it('rejects blank or whitespace-only required_labels entries', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  project_slug: CORE
  required_labels:
    - Symphony-Required
    - '   '
    - ''
codex:
  command: fake-codex
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);

    expect(validateDispatchPreflight(workflow)).toEqual([
      expect.objectContaining({
        code: 'invalid_workflow_config',
        field: 'tracker.required_labels',
      }),
    ]);
  });

  it('normalizes required_labels to lowercase and trims', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  project_slug: CORE
  required_labels:
    - Symphony-Required
    - '  APPROVED  '
codex:
  command: fake-codex
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);
    const config = getEffectiveConfig(workflow, { env: {} });

    expect(config.tracker.requiredLabels).toEqual(['symphony-required', 'approved']);
    expect(validateDispatchPreflight(workflow)).toEqual([]);
  });

  it('normalizes canary_labels to lowercase', async () => {
    const workflowPath = await tempWorkflow(`---
tracker:
  kind: linear
  api_key: test-token
  project_slug: CORE
  require_canary: true
  canary_labels:
    - Symphony-Canary
    - LIVE-01
codex:
  command: fake-codex
---
Prompt
`);
    const workflow = await loadWorkflow(workflowPath);
    const config = getEffectiveConfig(workflow, { env: {} });

    expect(config.tracker.canaryLabels).toEqual(['symphony-canary', 'live-01']);
    expect(validateDispatchPreflight(workflow)).toEqual([]);
  });

  it('fails prompt rendering on unknown variables and unknown filters', async () => {
    await expect(
      renderPromptTemplate('Issue {{ issue.identifier }} {{ issue.missing }}', {
        issue: { identifier: 'OPS-1' },
        attempt: null,
      }),
    ).rejects.toMatchObject({ code: 'template_render_error' });

    await expect(
      renderPromptTemplate('Issue {{ issue.identifier | made_up_filter }}', {
        issue: { identifier: 'OPS-1' },
        attempt: null,
      }),
    ).rejects.toMatchObject({ code: 'template_render_error' });
  });

  it('exposes workflow error classes with documented error codes', () => {
    const error = new WorkflowError('template_parse_error', 'bad template');

    expect(error.code).toBe('template_parse_error');
    expect(error.message).toBe('bad template');
  });
});
