import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatStructuredLogLine, StructuredLogger } from '../src/observability.js';
import { startSymphonyService, type SymphonyServiceFactory } from '../src/service.js';
import type {
  OrchestratorAgentRunner,
  OrchestratorWorkspaceManager,
  SymphonyOrchestrator,
} from '../src/orchestrator.js';
import type { LinearTrackerReceipt } from '../src/tracker.js';

class FakeServiceOrchestrator {
  public cleanupCalls = 0;
  public tickCalls = 0;
  public workflowTemplates: string[] = [];

  public startupCleanup(): Promise<void> {
    this.cleanupCalls += 1;
    return Promise.resolve();
  }

  public tick(): Promise<void> {
    this.tickCalls += 1;
    return Promise.resolve();
  }

  public updateWorkflow(workflow: { readonly prompt_template: string }): void {
    this.workflowTemplates.push(workflow.prompt_template);
  }
}

describe('structured observability logs', () => {
  it('emits stable key=value lines with issue and session context without raw payload dumps', () => {
    const line = formatStructuredLogLine({
      level: 'warn',
      event: 'dispatch',
      outcome: 'retrying',
      issue_id: 'abc123',
      issue_identifier: 'CORE-99',
      session_id: 'thread-1-turn-2',
      reason: 'workspace hook failed because dependency install exited 1',
      raw_payload: { huge: 'payload should be omitted' },
    });

    expect(line).toContain('level=warn event=dispatch outcome=retrying');
    expect(line).toContain('issue_id=abc123 issue_identifier=CORE-99 session_id=thread-1-turn-2');
    expect(line).toContain('reason="workspace hook failed because dependency install exited 1"');
    expect(line).not.toContain('raw_payload');
    expect(line).not.toContain('huge');
  });

  it('treats logging sink failures as nonfatal', () => {
    const logger = new StructuredLogger(() => { throw new Error('sink unavailable'); });

    expect(() => {
      logger.write({ level: 'warn', event: 'dispatch', outcome: 'retrying' });
    }).not.toThrow();
  });
});

describe('Symphony service startup', () => {
  it('loads WORKFLOW.md, validates startup config, runs cleanup, logs visibility, and schedules an immediate tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-service-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-token\n  project_slug: CORE\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 30000\n---\nWork on {{ issue.identifier }}\n`, 'utf8');
    const logs: string[] = [];
    const fake = new FakeServiceOrchestrator();
    const factory: SymphonyServiceFactory = () => fake as unknown as SymphonyOrchestrator;

    const service = await startSymphonyService({ workflowPath, factory, log: (line) => logs.push(line) });

    expect(service.workflow.workflow_path).toBe(workflowPath);
    expect(fake.cleanupCalls).toBe(1);
    expect(fake.tickCalls).toBe(1);
    expect(logs).toEqual(expect.arrayContaining([
      expect.stringContaining('event=startup outcome=completed'),
      expect.stringContaining('event=startup_cleanup outcome=completed'),
      expect.stringContaining('event=tick outcome=scheduled reason="immediate startup tick"'),
    ]));
    service.stop();
  });

  it('keeps service startup alive when the configured log sink throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-service-throwing-log-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-token\n  project_slug: CORE\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\n---\nPrompt\n`, 'utf8');
    const fake = new FakeServiceOrchestrator();

    const service = await startSymphonyService({
      workflowPath,
      factory: () => fake as unknown as SymphonyOrchestrator,
      log: () => { throw new Error('sink unavailable'); },
    });

    expect(fake.cleanupCalls).toBe(1);
    expect(fake.tickCalls).toBe(1);
    service.stop();
  });

  it('polls as a long-running local service and keeps last-known-good workflow on invalid reloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-service-reload-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-token\n  project_slug: CORE\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 10\n---\nFirst prompt\n`, 'utf8');
    const logs: string[] = [];
    const fake = new FakeServiceOrchestrator();
    const service = await startSymphonyService({ workflowPath, factory: () => fake as unknown as SymphonyOrchestrator, log: (line) => logs.push(line) });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 10\n---\nInvalid prompt\n`, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 35));
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-token\n  project_slug: CORE\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 10\n---\nSecond prompt\n`, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 35));

    service.stop();
    expect(fake.tickCalls).toBeGreaterThan(1);
    expect(fake.workflowTemplates).toContain('Second prompt');
    expect(fake.workflowTemplates).not.toContain('Invalid prompt');
    expect(logs).toEqual(expect.arrayContaining([
      expect.stringContaining('event=workflow_reload outcome=failed'),
      expect.stringContaining('event=workflow_reload outcome=completed'),
    ]));
  });

  it('does not run a scheduled tick after stop is requested during reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-service-stop-during-reload-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    const writeWorkflow = (prompt: string): Promise<void> => writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: test-token\n  project_slug: CORE\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 20\n---\n${prompt}\n`, 'utf8');
    await writeWorkflow('First prompt');
    const fake = new FakeServiceOrchestrator();
    let service: Awaited<ReturnType<typeof startSymphonyService>> | null = null;
    fake.updateWorkflow = (workflow: { readonly prompt_template: string }): void => {
      fake.workflowTemplates.push(workflow.prompt_template);
      service?.stop();
    };

    service = await startSymphonyService({ workflowPath, factory: () => fake as unknown as SymphonyOrchestrator });
    await writeWorkflow('Second prompt');
    await new Promise((resolve) => setTimeout(resolve, 70));
    service.stop();

    expect(fake.workflowTemplates).toContain('Second prompt');
    expect(fake.tickCalls).toBe(1);
  });

  it('rebuilds default runtime dependencies on valid reload while invalid reloads keep last-known-good scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-service-runtime-reload-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    const writeWorkflow = (projectSlug: string, prompt: string): Promise<void> => writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  endpoint: http://linear.test/graphql\n  api_key: fake-token\n  project_slug: ${projectSlug}\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 10\n---\n${prompt}\n`, 'utf8');
    await writeWorkflow('CORE', 'Initial prompt');

    const originalFetch = globalThis.fetch;
    const fetchCalls: { readonly variables: Readonly<Record<string, unknown>> }[] = [];
    const logs: string[] = [];
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = parseRequestBody(init?.body);
      fetchCalls.push({ variables: isGraphQLVariablesBody(body) ? body.variables : {} });
      return Promise.resolve(new Response(JSON.stringify({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      }), { status: 200 }));
    };

    let service: Awaited<ReturnType<typeof startSymphonyService>> | null = null;
    try {
      service = await startSymphonyService({ workflowPath, log: (line) => logs.push(line) });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  endpoint: http://linear.test/graphql\n  api_key: fake-token\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 10\n---\nInvalid prompt\n`, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(fetchCalls.map((call) => call.variables['projectSlug'])).not.toContain('OPS');

      await writeWorkflow('OPS', 'Reloaded prompt');
      await new Promise((resolve) => setTimeout(resolve, 35));
    } finally {
      service?.stop();
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls.map((call) => call.variables['projectSlug'])).toContain('CORE');
    expect(fetchCalls.map((call) => call.variables['projectSlug'])).toContain('OPS');
    expect(service.workflow.prompt_template).toBe('Reloaded prompt');
    expect(logs).toEqual(expect.arrayContaining([
      expect.stringContaining('event=workflow_reload outcome=failed'),
      expect.stringContaining('event=workflow_reload outcome=completed'),
    ]));
  });

  it('starts a Hermes Kanban backend facade without requiring legacy Linear or Codex config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-service-kanban-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    const logs: string[] = [];
    await writeFile(workflowPath, `---\nbackend:\n  kind: hermes_kanban\nkanban:\n  hermes_command: /safe/bin/hermes\n  hermes_home: ./hermes-home\n  board: symphony-test\n  board_create: false\n  dispatch: observe_only\n  artifact_root: ./artifacts/symphony-test\n  workspace:\n    kind: scratch\n  safety:\n    require_profile_preflight: true\n    require_review_gate_for_repo_mutation: true\n    require_human_gate_for_external_actions: true\nservice:\n  control_plane:\n    enabled: true\n    host: 127.0.0.1\n    port: 0\n    auth_token: test-control-token\npolling:\n  interval_ms: 60000\n---\nKanban facade prompt\n`, 'utf8');

    const service = await startSymphonyService({
      workflowPath,
      kanbanClient: {
        listTasks: () => Promise.resolve([
          { id: 't_kanban', title: 'Kanban-backed task', status: 'blocked', assignee: null },
        ]),
      },
      log: (line) => logs.push(line),
    });

    try {
      const controlPlane = service.controlPlane;
      expect(controlPlane).not.toBeNull();
      if (controlPlane === null) {
        throw new Error('expected Kanban control plane to start');
      }
      expect(controlPlane.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const response = await fetch(`${controlPlane.url}/snapshot`);
      const payload = await response.json() as {
        readonly snapshot: {
          readonly backend: string;
          readonly mode: string;
          readonly board: string;
          readonly tasks: readonly { readonly id: string; readonly state: string }[];
        };
      };

      expect(response.status).toBe(200);
      expect(payload.snapshot).toMatchObject({
        backend: 'hermes_kanban',
        mode: 'available',
        board: 'symphony-test',
      });
      expect(payload.snapshot.tasks).toEqual([
        { id: 't_kanban', title: 'Kanban-backed task', status: 'blocked', state: 'blocked', assignee: null, source_identifier: null, provenance: { workflow_id: null, kanban_board: 'symphony-test', ledger_path: null } },
      ]);
      expect(logs.join('\n')).toContain('event=startup outcome=completed');
    } finally {
      service.stop();
    }
  });

  it('logs startup validation failures before rejecting so operators can see config errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-service-invalid-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\nworkspace:\n  root: ./workspaces\n---\nPrompt\n`, 'utf8');
    const logs: string[] = [];

    await expect(startSymphonyService({ workflowPath, factory: () => { throw new Error('factory should not run'); }, log: (line) => logs.push(line) })).rejects.toThrow(/startup validation failed/);

    expect(logs).toEqual(expect.arrayContaining([
      expect.stringContaining('event=startup_validation outcome=failed'),
      expect.stringContaining('reason="missing_tracker_api_key tracker.api_key; missing_tracker_project_slug tracker.project_slug, tracker.team_key, or tracker.all_approved_projects"'),
    ]));
  });

  it('passes the tracker receipt sink into the default Linear tracker for live validation evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'symphony-service-receipts-'));
    const workflowPath = join(root, 'WORKFLOW.md');
    const apiKey = ['test', 'token', 'secret'].join('-');
    await writeFile(workflowPath, `---\ntracker:\n  kind: linear\n  api_key: ${apiKey}\n  project_slug: OPS\n  require_canary: true\n  canary_issue_identifier: OPS-42\nworkspace:\n  root: ./workspaces\ncodex:\n  command: fake-codex\npolling:\n  interval_ms: 999999\n---\nPrompt\n`, 'utf8');
    const originalFetch = globalThis.fetch;
    const fetchCalls: { readonly body: unknown; readonly headers: RequestInit['headers'] | undefined }[] = [];
    const receipts: LinearTrackerReceipt[] = [];
    const runner: OrchestratorAgentRunner = {
      runIssue: () => { throw new Error('runner should not start for non-active canary issue'); },
    };
    const workspaceManager: OrchestratorWorkspaceManager = {
      prepareWorkspace: () => Promise.reject(new Error('workspace should not be prepared')),
      runAfterRunHook: () => Promise.resolve(),
      cleanupTerminalWorkspace: () => Promise.resolve(),
    };
    globalThis.fetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      fetchCalls.push({ body: parseRequestBody(init?.body), headers: init?.headers });
      const body = fetchCalls[fetchCalls.length - 1]?.body;
      const query = isGraphQLBody(body) ? body.query : '';
      if (query.includes('SymphonyExactIssue')) {
        return Promise.resolve(new Response(JSON.stringify({
          issue: {
            id: 'issue-c',
            identifier: 'OPS-42',
            title: 'Canary live validation',
            description: null,
            priority: null,
            state: { name: 'Done' },
            team: { key: 'OPS', name: 'Operations' },
            branchName: null,
            url: 'https://linear.app/example/issue/OPS-42',
            labels: { nodes: [] },
            inverseRelations: { nodes: [] },
            createdAt: null,
            updatedAt: null,
          },
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }), { status: 200 }));
    };

    try {
      const service = await startSymphonyService({
        workflowPath,
        runner,
        workspaceManager,
        trackerReceiptSink: (receipt) => { receipts.push(receipt); },
      });
      service.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]?.headers).toMatchObject({ Authorization: apiKey });
    const exactRequestReceipt = receipts.find((receipt) => receipt.kind === 'linear_graphql_request_response' && receipt.operation === 'SymphonyExactIssue');
    expect(exactRequestReceipt?.kind).toBe('linear_graphql_request_response');
    if (exactRequestReceipt?.kind !== 'linear_graphql_request_response') {
      throw new Error('expected exact request receipt');
    }
    expect(exactRequestReceipt.request.headers).toEqual({ authorization: '[REDACTED]', content_type: 'application/json' });
    expect(exactRequestReceipt.request.query_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(exactRequestReceipt.response).toEqual({ outcome: 'ok', graphql_error_count: 0 });
    const selectedIssueReceipt = receipts.find((receipt) => receipt.kind === 'linear_selected_issue');
    expect(selectedIssueReceipt).toEqual({
      kind: 'linear_selected_issue',
      operation: 'SymphonyExactIssue',
      project_slug: 'OPS',
      selector_scope: {
        kind: 'project_slug',
        value: 'OPS',
        required_labels: [],
        canary_labels: [],
        canary_issue_identifier: 'OPS-42',
        active_states: ['Todo', 'In Progress'],
        max_issues_per_poll: 50,
      },
      issue: {
        id: 'issue-c',
        identifier: 'OPS-42',
        title: 'Canary live validation',
        team: { key: 'OPS', name: 'Operations' },
        state: 'Done',
        url: 'https://linear.app/example/issue/OPS-42',
      },
    });
    expect(JSON.stringify(receipts)).not.toContain(apiKey);
  });
});

function parseRequestBody(body: RequestInit['body'] | undefined): unknown {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body === 'string') {
    return JSON.parse(body) as unknown;
  }
  return {};
}

function isGraphQLBody(value: unknown): value is { readonly query: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { readonly query?: unknown };
  return typeof record.query === 'string';
}

function isGraphQLVariablesBody(value: unknown): value is { readonly variables: Readonly<Record<string, unknown>> } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { readonly variables?: unknown };
  return typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables);
}
