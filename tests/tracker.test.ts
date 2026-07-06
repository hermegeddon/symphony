import { describe, expect, it, vi } from 'vitest';

import {
  LinearIssueMutationClient,
  LinearTrackerClient,
  TrackerError,
  type GraphQLTransport,
  type IssueTrackerReader,
  type LinearTrackerReceipt,
} from '../src/tracker.js';

function makeTransport(responses: readonly unknown[]): GraphQLTransport & { readonly calls: { query: string; variables: unknown }[] } {
  const calls: { query: string; variables: unknown }[] = [];
  const request = vi.fn((query: string, variables: unknown) => {
    calls.push({ query, variables });
    const response = responses[calls.length - 1];
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(response);
  });
  return { request, calls };
}

const firstPage = {
  issues: {
    nodes: [
      {
        id: 'issue-1',
        identifier: 'OPS-1',
        title: 'First',
        description: 'Do first thing',
        priority: 1,
        state: { name: 'Todo' },
        branchName: 'ops-1',
        url: 'https://linear.app/acme/issue/OPS-1',
        labels: { nodes: [{ name: 'Backend' }, { name: 'URGENT' }] },
        relations: {
          nodes: [
            {
              id: 'rel_outgoing_blocks',
              type: 'blocks',
              createdAt: '2026-01-01T01:00:00.000Z',
              updatedAt: '2026-01-01T02:00:00.000Z',
              archivedAt: null,
              issue: { id: 'issue-1', identifier: 'OPS-1', state: { name: 'Todo' } },
              relatedIssue: { id: 'issue-2', identifier: 'OPS-2', state: { name: 'Todo' } },
            },
          ],
        },
        inverseRelations: {
          nodes: [
            {
              id: 'rel_inverse_blocks',
              type: 'blocks',
              createdAt: '2025-12-31T23:00:00.000Z',
              updatedAt: '2026-01-01T00:30:00.000Z',
              archivedAt: '2026-01-03T00:00:00.000Z',
              issue: { id: 'issue-0', identifier: 'OPS-0', state: { name: 'Done' } },
              relatedIssue: { id: 'issue-1', identifier: 'OPS-1', state: { name: 'Todo' } },
            },
            { type: 'relates', issue: { id: 'issue-x', identifier: 'OPS-X', state: { name: 'Todo' } } },
          ],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
  },
};

const secondPage = {
  issues: {
    nodes: [
      {
        id: 'issue-2',
        identifier: 'OPS-2',
        title: 'Second',
        description: null,
        priority: 2.5,
        state: { name: 'In Progress' },
        branchName: null,
        url: null,
        labels: { nodes: [] },
        inverseRelations: { nodes: [] },
        createdAt: null,
        updatedAt: 'not-a-date',
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};

describe('Linear-compatible tracker reader', () => {
  it('implements candidate fetching through the IssueTrackerReader interface with isolated Linear query semantics', async () => {
    const transport = makeTransport([firstPage, secondPage]);
    const reader: IssueTrackerReader = new LinearTrackerClient({
      apiKey: 'test-key',
      projectSlug: 'OPS',
      activeStates: ['Todo', 'In Progress'],
      terminalStates: ['Done'],
      transport,
    });

    const issues = await reader.fetch_candidate_issues();

    expect(issues.map((issue) => issue.identifier)).toEqual(['OPS-1', 'OPS-2']);
    expect(issues[0]?.labels).toEqual(['backend', 'urgent']);
    expect(issues[0]?.blocked_by).toEqual([{ id: 'issue-0', identifier: 'OPS-0', state: 'Done' }]);
    expect(issues[0]?.linear_relations).toEqual([
      {
        id: 'rel_outgoing_blocks',
        type: 'blocks',
        observed_from: 'relations',
        issue: { id: 'issue-1', identifier: 'OPS-1', state: 'Todo' },
        related_issue: { id: 'issue-2', identifier: 'OPS-2', state: 'Todo' },
        created_at: new Date('2026-01-01T01:00:00.000Z'),
        updated_at: new Date('2026-01-01T02:00:00.000Z'),
        archived_at: null,
      },
      {
        id: 'rel_inverse_blocks',
        type: 'blocks',
        observed_from: 'inverseRelations',
        issue: { id: 'issue-0', identifier: 'OPS-0', state: 'Done' },
        related_issue: { id: 'issue-1', identifier: 'OPS-1', state: 'Todo' },
        created_at: new Date('2025-12-31T23:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:30:00.000Z'),
        archived_at: new Date('2026-01-03T00:00:00.000Z'),
      },
    ]);
    expect(issues[0]?.created_at).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(issues[1]?.priority).toBeNull();
    expect(issues[1]?.updated_at).toBeNull();
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.query).toContain('project: { slugId: { eq: $projectSlug } }');
    expect(transport.calls[0]?.query).toContain('state: { name: { in: $stateNames } }');
    expect(transport.calls[0]?.query).toContain('relations { nodes { id type createdAt updatedAt archivedAt');
    expect(transport.calls[0]?.query).toContain('inverseRelations { nodes { id type createdAt updatedAt archivedAt');
    expect(transport.calls[0]?.query).not.toContain('$hasLabels: Boolean!');
    expect(transport.calls[0]?.query).not.toContain('@include');
    expect(transport.calls[0]?.query).not.toContain('$hasIssueIdentifier: Boolean!');
    expect(transport.calls[0]?.query).not.toContain('canaryIssueIdentifier');
    expect(transport.calls[0]?.variables).toMatchObject({
      projectSlug: 'OPS',
      stateNames: ['Todo', 'In Progress'],
      first: 50,
      after: null,
    });
    expect(transport.calls[1]?.variables).toMatchObject({ after: 'cursor-1' });
  });

  it('supports team-key selector scope for Linear workspaces without projects', async () => {
    const transport = makeTransport([{
      issues: {
        ...firstPage.issues,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }]);
    const reader = new LinearTrackerClient({
      apiKey: ['test', 'key'].join('-'),
      teamKey: 'HER',
      activeStates: ['Todo'],
      transport,
    });

    const issues = await reader.fetch_candidate_issues();

    expect(issues.map((issue) => issue.identifier)).toEqual(['OPS-1']);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.query).toContain('query SymphonyCandidateIssuesByTeam');
    expect(transport.calls[0]?.query).toContain('team: { key: { eq: $teamKey } }');
    expect(transport.calls[0]?.query).not.toContain('project: { slugId');
    expect(transport.calls[0]?.variables).toMatchObject({
      teamKey: 'HER',
      stateNames: ['Todo'],
      first: 50,
      after: null,
    });
  });

  it('supports explicit all-approved-projects selector scope without project or team filtering', async () => {
    const transport = makeTransport([{
      issues: {
        ...firstPage.issues,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }]);
    const reader = new LinearTrackerClient({
      apiKey: ['test', 'key'].join('-'),
      allApprovedProjects: true,
      activeStates: ['Todo'],
      transport,
    });

    const issues = await reader.fetch_candidate_issues();

    expect(issues.map((issue) => issue.identifier)).toEqual(['OPS-1']);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.query).toContain('query SymphonyCandidateIssuesForAllApprovedProjects');
    expect(transport.calls[0]?.query).toContain('state: { name: { in: $stateNames } }');
    expect(transport.calls[0]?.query).not.toContain('project: { slugId');
    expect(transport.calls[0]?.query).not.toContain('team: { key: { eq: $teamKey } }');
    expect(transport.calls[0]?.query).toContain('project { id name slugId url }');
    expect(transport.calls[0]?.variables).toMatchObject({
      stateNames: ['Todo'],
      first: 50,
      after: null,
    });
  });

  it('rejects direct all-approved-projects tracker config when combined with narrower selectors', () => {
    expect(() => new LinearTrackerClient({
      apiKey: ['test', 'key'].join('-'),
      projectSlug: 'OPS',
      allApprovedProjects: true,
      transport: makeTransport([]),
    })).toThrow(TrackerError);
  });

  it('fetches terminal-state issues and returns empty state queries without an API call', async () => {
    const transport = makeTransport([{ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }]);
    const reader = new LinearTrackerClient({
      apiKey: 'test-key',
      projectSlug: 'OPS',
      activeStates: ['Todo'],
      terminalStates: ['Done', 'Canceled'],
      transport,
    });

    await expect(reader.fetch_issues_by_states([])).resolves.toEqual([]);
    await expect(reader.fetch_terminal_issues()).resolves.toEqual([]);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.variables).toMatchObject({ stateNames: ['Done', 'Canceled'] });
  });

  it('refreshes issue states by GraphQL ID list using [ID!] variable typing', async () => {
    const transport = makeTransport([
      {
        issues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'OPS-1',
              title: 'First',
              description: null,
              priority: null,
              state: { name: 'Done' },
              branchName: null,
              url: null,
              labels: { nodes: [] },
              inverseRelations: { nodes: [] },
              createdAt: null,
              updatedAt: null,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ]);
    const reader = new LinearTrackerClient({ apiKey: 'test-key', projectSlug: 'OPS', transport });

    const refreshed = await reader.fetch_issue_states_by_ids(['issue-1']);

    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]?.state).toBe('Done');
    expect(transport.calls[0]?.query).toContain('$issueIds: [ID!]');
    expect(transport.calls[0]?.variables).toMatchObject({ issueIds: ['issue-1'] });
  });

  it('exposes fetch_all_candidate_issues so the bridge can emit missing-label provenance before filtering', async () => {
    const page = {
      data: {
        issues: {
          nodes: [
            {
              ...firstPage.issues.nodes[0],
              labels: { nodes: [{ name: 'symphony' }] },
            },
            {
              ...firstPage.issues.nodes[0],
              id: 'issue-2',
              identifier: 'OPS-2',
              labels: { nodes: [] },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const transport = makeTransport([page, page]);
    const reader = new LinearTrackerClient({
      apiKey: ['test', 'key'].join('-'),
      projectSlug: 'OPS',
      activeStates: ['Todo'],
      requiredLabels: ['symphony'],
      transport,
    });

    const all = await reader.fetch_all_candidate_issues();
    const filtered = await reader.fetch_candidate_issues();

    expect(all.map((issue) => issue.identifier)).toEqual(['OPS-1', 'OPS-2']);
    expect(filtered.map((issue) => issue.identifier)).toEqual(['OPS-1']);
    expect(all[0]?.labels).toContain('symphony');
    expect(all[1]?.labels).toEqual([]);
  });

  it('normalizes Linear issue label display names for required-label filtering, ignoring surrounding whitespace and case', async () => {
    const page = {
      data: {
        issues: {
          nodes: [
            {
              id: 'issue-whitespace',
              identifier: 'OPS-1',
              title: 'First',
              description: null,
              priority: null,
              state: { name: 'Todo' },
              branchName: null,
              url: null,
              labels: { nodes: [{ name: ' Symphony ' }] },
              inverseRelations: { nodes: [] },
              createdAt: null,
              updatedAt: null,
            },
            {
              id: 'issue-nomatch',
              identifier: 'OPS-2',
              title: 'Second',
              description: null,
              priority: null,
              state: { name: 'Todo' },
              branchName: null,
              url: null,
              labels: { nodes: [{ name: 'Other' }] },
              inverseRelations: { nodes: [] },
              createdAt: null,
              updatedAt: null,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const transport = makeTransport([page, page]);
    const reader = new LinearTrackerClient({
      apiKey: ['test', 'key'].join('-'),
      projectSlug: 'OPS',
      activeStates: ['Todo'],
      requiredLabels: ['symphony'],
      transport,
    });

    const all = await reader.fetch_all_candidate_issues();
    const filtered = await reader.fetch_candidate_issues();

    expect(all.map((issue) => issue.identifier)).toEqual(['OPS-1', 'OPS-2']);
    expect(all[0]?.labels).toEqual(['symphony']);
    expect(filtered.map((issue) => issue.identifier)).toEqual(['OPS-1']);
    expect(transport.calls).toHaveLength(2);
  });

  it('applies exact issue identifier canary selector and emits redacted Linear receipts with selected issue metadata', async () => {
    const transport = makeTransport([
      {
        issue: {
          id: 'issue-c',
          identifier: 'OPS-42',
          title: 'Canary',
          description: null,
          priority: null,
          state: { name: 'Todo' },
          team: { key: 'OPS', name: 'Operations' },
          branchName: null,
          url: null,
          labels: { nodes: [{ name: 'symphony-canary' }] },
          inverseRelations: { nodes: [] },
          createdAt: null,
          updatedAt: null,
        },
      },
    ]);
    const apiKey = ['test', 'key', 'secret'].join('-');
    const receipts: LinearTrackerReceipt[] = [];
    const reader = new LinearTrackerClient({
      apiKey,
      projectSlug: 'OPS',
      canaryIssueIdentifier: 'OPS-42',
      transport,
      receiptSink: (receipt) => { receipts.push(receipt); },
    });

    const issues = await reader.fetch_candidate_issues();

    expect(issues).toHaveLength(1);
    expect(issues[0]?.identifier).toBe('OPS-42');
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.query).toContain('query SymphonyExactIssue($identifier: String!)');
    expect(transport.calls[0]?.query).toContain('issue(id: $identifier)');
    expect(transport.calls[0]?.query).toContain('team { key name }');
    expect(transport.calls[0]?.query).not.toContain('@include');
    expect(transport.calls[0]?.variables).toMatchObject({ identifier: 'OPS-42' });
    expect(receipts).toHaveLength(2);
    const [requestReceipt, selectedIssueReceipt] = receipts;
    expect(requestReceipt?.kind).toBe('linear_graphql_request_response');
    if (requestReceipt?.kind !== 'linear_graphql_request_response') {
      throw new Error('expected request receipt');
    }
    expect(requestReceipt.operation).toBe('SymphonyExactIssue');
    expect(requestReceipt.endpoint).toBe('https://api.linear.app/graphql');
    expect(requestReceipt.request).toEqual({
      method: 'POST',
      headers: { authorization: '[REDACTED]', content_type: 'application/json' },
      query_sha256: requestReceipt.request.query_sha256,
      variables: { identifier: 'OPS-42' },
    });
    expect(requestReceipt.request.query_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(requestReceipt.response).toEqual({ outcome: 'ok', graphql_error_count: 0 });
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
        title: 'Canary',
        team: { key: 'OPS', name: 'Operations' },
        state: 'Todo',
        url: null,
      },
    });
    const serializedReceipts = JSON.stringify(receipts);
    expect(serializedReceipts).not.toContain(apiKey);
    expect(serializedReceipts).not.toContain('Authorization');
  });

  it('treats asynchronous receipt sink failures as nonfatal observability errors', async () => {
    const transport = makeTransport([{ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }]);
    const apiKey = ['test', 'key'].join('-');
    const reader = new LinearTrackerClient({
      apiKey,
      projectSlug: 'OPS',
      transport,
      receiptSink: async () => Promise.reject(new Error('receipt sink unavailable')),
    });

    await expect(reader.fetch_issues_by_states(['Todo'])).resolves.toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('falls back to label filter when only canary_labels is configured', async () => {
    const transport = makeTransport([
      {
        issues: {
          nodes: [
            {
              id: 'issue-c',
              identifier: 'OPS-42',
              title: 'Canary',
              description: null,
              priority: null,
              state: { name: 'Todo' },
              branchName: null,
              url: null,
              labels: { nodes: [{ name: 'symphony-canary' }] },
              inverseRelations: { nodes: [] },
              createdAt: null,
              updatedAt: null,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ]);
    const reader = new LinearTrackerClient({
      apiKey: 'test-key',
      projectSlug: 'OPS',
      canaryLabels: ['symphony-canary'],
      transport,
    });

    const issues = await reader.fetch_candidate_issues();

    expect(issues).toHaveLength(1);
    expect(issues[0]?.identifier).toBe('OPS-42');
    expect(transport.calls[0]?.query).toContain('query SymphonyCandidateIssuesWithLabels');
    expect(transport.calls[0]?.query).toContain('labels: { some: { name: { in: $canaryLabels } } }');
    expect(transport.calls[0]?.query).not.toContain('@include');
    expect(transport.calls[0]?.variables).toMatchObject({
      canaryLabels: ['symphony-canary'],
    });
  });

  it('maps pagination and GraphQL/transport failures to documented tracker error categories', async () => {
    const missingCursor = makeTransport([
      { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } },
    ]);
    const reader = new LinearTrackerClient({ apiKey: ['token'].join('-'), projectSlug: 'OPS', transport: missingCursor });
    await expect(reader.fetch_candidate_issues()).rejects.toMatchObject({ code: 'linear_missing_end_cursor' });

    const graphQLErrors = makeTransport([{ errors: [{ message: 'bad query' }] }]);
    const errorReader = new LinearTrackerClient({ apiKey: ['token'].join('-'), projectSlug: 'OPS', transport: graphQLErrors });
    await expect(errorReader.fetch_candidate_issues()).rejects.toMatchObject({ code: 'linear_graphql_errors' });

    expect(() => new LinearTrackerClient({ apiKey: '', projectSlug: 'OPS' })).toThrow(TrackerError);
    expect(() => new LinearTrackerClient({ apiKey: ['token'].join('-'), projectSlug: '' })).toThrow(TrackerError);
  });

  it('caps broad selector fetches at maxIssuesPerPoll without walking extra pages', async () => {
    const transport = makeTransport([firstPage, secondPage]);
    const reader = new LinearTrackerClient({
      apiKey: ['token'].join('-'),
      projectSlug: 'OPS',
      activeStates: ['Todo', 'In Progress'],
      transport,
      maxIssuesPerPoll: 1,
    });

    const issues = await reader.fetch_candidate_issues();

    expect(issues.map((issue) => issue.identifier)).toEqual(['OPS-1']);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.variables).toMatchObject({ first: 1 });
  });

  it('emits redacted receipts for Linear comment and state mutations', async () => {
    const transport = makeTransport([
      { commentCreate: { success: true, comment: { id: 'comment-1', url: 'https://linear.app/acme/comment/comment-1' } } },
      { issueUpdate: { success: true, issue: { id: 'issue-1', identifier: 'OPS-1', state: { name: 'In Progress' } } } },
    ]);
    const apiKey = ['live', 'linear', 'secret'].join('-');
    const receipts: LinearTrackerReceipt[] = [];
    const client = new LinearIssueMutationClient({
      apiKey,
      transport,
      receiptSink: (receipt) => { receipts.push(receipt); },
    });

    await expect(client.createComment({ issueId: 'issue-1', body: '<!-- symphony-ts:test -->\nStarted' })).resolves.toEqual({
      comment_id: 'comment-1',
      comment_url: 'https://linear.app/acme/comment/comment-1',
    });
    await expect(client.updateIssueState({ issueId: 'issue-1', stateId: 'state-in-progress' })).resolves.toBeUndefined();

    expect(transport.calls[0]?.query).toContain('mutation SymphonyIssueCommentCreate');
    expect(transport.calls[0]?.variables).toEqual({ issueId: 'issue-1', body: '<!-- symphony-ts:test -->\nStarted' });
    expect(transport.calls[1]?.query).toContain('mutation SymphonyIssueStateUpdate');
    expect(transport.calls[1]?.variables).toEqual({ issueId: 'issue-1', stateId: 'state-in-progress' });
    expect(receipts.map((receipt) => receipt.kind)).toEqual([
      'linear_graphql_request_response',
      'linear_mutation_result',
      'linear_graphql_request_response',
      'linear_mutation_result',
    ]);
    const serialized = JSON.stringify(receipts);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).toContain('comment-1');
  });
});
