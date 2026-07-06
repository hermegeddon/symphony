import { createHash } from 'node:crypto';

import type {
  Issue,
  IssueBlockerRef,
  LinearIssueRelationEndpointRef,
  LinearIssueRelationObservationSource,
  LinearIssueRelationRef,
  LinearIssueRelationType,
} from './domain.js';

export type TrackerErrorCode =
  | 'unsupported_tracker_kind'
  | 'missing_tracker_api_key'
  | 'missing_tracker_project_slug'
  | 'linear_api_request'
  | 'linear_api_status'
  | 'linear_graphql_errors'
  | 'linear_unknown_payload'
  | 'linear_missing_end_cursor';

export class TrackerError extends Error {
  public readonly code: TrackerErrorCode;
  public readonly status?: number;
  public readonly graphqlErrors?: readonly unknown[];

  public constructor(
    code: TrackerErrorCode,
    message: string,
    options: { readonly status?: number; readonly graphqlErrors?: readonly unknown[] } = {},
  ) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.graphqlErrors !== undefined) {
      this.graphqlErrors = options.graphqlErrors;
    }
  }
}

export interface IssueTrackerReader {
  fetch_candidate_issues(): Promise<readonly Issue[]>;
  fetch_all_candidate_issues?(): Promise<readonly Issue[]>;
  fetch_issues_by_states(stateNames: readonly string[]): Promise<readonly Issue[]>;
  fetch_terminal_issues(): Promise<readonly Issue[]>;
  fetch_issue_states_by_ids(issueIds: readonly string[]): Promise<readonly Issue[]>;
}

export interface GraphQLTransport {
  request(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export type LinearReceiptJson = string | number | boolean | null | readonly LinearReceiptJson[] | {
  readonly [key: string]: LinearReceiptJson;
};

export type LinearTrackerReceipt = LinearGraphQLRequestResponseReceipt | LinearSelectedIssueReceipt | LinearMutationResultReceipt;

export interface LinearGraphQLRequestResponseReceipt {
  readonly kind: 'linear_graphql_request_response';
  readonly operation: string;
  readonly endpoint: string;
  readonly request: {
    readonly method: 'POST';
    readonly headers: {
      readonly authorization: '[REDACTED]';
      readonly content_type: 'application/json';
    };
    readonly query_sha256: string;
    readonly variables: Readonly<Record<string, LinearReceiptJson>>;
  };
  readonly response: {
    readonly outcome: 'ok' | 'graphql_errors';
    readonly graphql_error_count: number;
  };
}

export interface LinearSelectedIssueReceipt {
  readonly kind: 'linear_selected_issue';
  readonly operation: string;
  readonly project_slug: string;
  readonly selector_scope?: {
    readonly kind: 'project_slug' | 'team_key' | 'all_approved_projects';
    readonly value: string;
    readonly required_labels: readonly string[];
    readonly canary_labels: readonly string[];
    readonly canary_issue_identifier: string | null;
    readonly active_states: readonly string[];
    readonly max_issues_per_poll: number;
  };
  readonly issue: {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly team: {
      readonly key: string | null;
      readonly name: string | null;
    };
    readonly state: string;
    readonly url: string | null;
  };
  readonly workflow_id?: string | null;
  readonly kanban_board?: string | null;
  readonly kanban_task_id?: string | null;
  readonly ledger_path?: string | null;
}

export interface LinearMutationResultReceipt {
  readonly kind: 'linear_mutation_result';
  readonly operation: string;
  readonly issue_id: string;
  readonly outcome: 'ok';
  readonly result: Readonly<Record<string, LinearReceiptJson>>;
}

export type LinearTrackerReceiptSink = (receipt: LinearTrackerReceipt) => void | Promise<void>;

export interface LinearTrackerClientConfig {
  readonly apiKey: string;
  readonly projectSlug?: string | null;
  readonly teamKey?: string | null;
  readonly allApprovedProjects?: boolean;
  readonly endpoint?: string;
  readonly activeStates?: readonly string[];
  readonly terminalStates?: readonly string[];
  readonly canaryIssueIdentifier?: string | null;
  readonly canaryLabels?: readonly string[];
  readonly requiredLabels?: readonly string[];
  readonly pageSize?: number;
  readonly maxIssuesPerPoll?: number;
  readonly networkTimeoutMs?: number;
  readonly transport?: GraphQLTransport;
  readonly receiptSink?: LinearTrackerReceiptSink;
}

export interface LinearIssueMutationClientConfig {
  readonly ['apiKey']: string;
  readonly endpoint?: string;
  readonly networkTimeoutMs?: number;
  readonly transport?: GraphQLTransport;
  readonly receiptSink?: LinearTrackerReceiptSink;
}

export interface CreateLinearIssueCommentInput {
  readonly issueId: string;
  readonly body: string;
}

export interface CreateLinearIssueCommentReceipt {
  readonly comment_id: string | null;
  readonly comment_url: string | null;
}

export interface UpdateLinearIssueStateInput {
  readonly issueId: string;
  readonly stateId: string;
}

export interface CreateLinearIssueRelationInput {
  readonly issueId: string;
  readonly relatedIssueId: string;
  readonly type: 'blocks';
}

export interface CreateLinearIssueRelationReceipt {
  readonly relation_id: string | null;
  readonly type: 'blocks';
  readonly issue_id: string;
  readonly related_issue_id: string;
}

const DEFAULT_LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_ACTIVE_STATES = ['Todo', 'In Progress'] as const;
const DEFAULT_TERMINAL_STATES = ['Closed', 'Cancelled', 'Canceled', 'Duplicate', 'Done'] as const;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;

const candidateIssuesQuery = `
query SymphonyCandidateIssues(
  $projectSlug: String!
  $stateNames: [String!]!
  $first: Int!
  $after: String
) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $stateNames } }
    }
    first: $first
    after: $after
    orderBy: createdAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      labels { nodes { name } }
      relations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      inverseRelations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const candidateIssuesWithLabelsQuery = `
query SymphonyCandidateIssuesWithLabels(
  $projectSlug: String!
  $stateNames: [String!]!
  $first: Int!
  $after: String
  $canaryLabels: [String!]!
) {
  issues(
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $stateNames } }
      labels: { some: { name: { in: $canaryLabels } } }
    }
    first: $first
    after: $after
    orderBy: createdAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      labels { nodes { name } }
      relations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      inverseRelations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const candidateIssuesByTeamQuery = `
query SymphonyCandidateIssuesByTeam(
  $teamKey: String!
  $stateNames: [String!]!
  $first: Int!
  $after: String
) {
  issues(
    filter: {
      team: { key: { eq: $teamKey } }
      state: { name: { in: $stateNames } }
    }
    first: $first
    after: $after
    orderBy: createdAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      team { key name }
      branchName
      url
      labels { nodes { name } }
      relations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      inverseRelations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const candidateIssuesByTeamWithLabelsQuery = `
query SymphonyCandidateIssuesByTeamWithLabels(
  $teamKey: String!
  $stateNames: [String!]!
  $first: Int!
  $after: String
  $canaryLabels: [String!]!
) {
  issues(
    filter: {
      team: { key: { eq: $teamKey } }
      state: { name: { in: $stateNames } }
      labels: { some: { name: { in: $canaryLabels } } }
    }
    first: $first
    after: $after
    orderBy: createdAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      team { key name }
      branchName
      url
      labels { nodes { name } }
      relations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      inverseRelations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const candidateIssuesForAllApprovedProjectsQuery = `
query SymphonyCandidateIssuesForAllApprovedProjects(
  $stateNames: [String!]!
  $first: Int!
  $after: String
) {
  issues(
    filter: {
      state: { name: { in: $stateNames } }
    }
    first: $first
    after: $after
    orderBy: createdAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      team { key name }
      project { id name slugId url }
      branchName
      url
      labels { nodes { name } }
      relations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      inverseRelations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const candidateIssuesForAllApprovedProjectsWithLabelsQuery = `
query SymphonyCandidateIssuesForAllApprovedProjectsWithLabels(
  $stateNames: [String!]!
  $first: Int!
  $after: String
  $canaryLabels: [String!]!
) {
  issues(
    filter: {
      state: { name: { in: $stateNames } }
      labels: { some: { name: { in: $canaryLabels } } }
    }
    first: $first
    after: $after
    orderBy: createdAt
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      team { key name }
      project { id name slugId url }
      branchName
      url
      labels { nodes { name } }
      relations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      inverseRelations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const exactIssueByIdentifierQuery = `
query SymphonyExactIssue($identifier: String!) {
  issue(id: $identifier) {
    id
    identifier
    title
    description
    priority
    state { name }
    team { key name }
    branchName
    url
    labels { nodes { name } }
    relations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
    inverseRelations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
    createdAt
    updatedAt
  }
}`;

const issueStatesByIdQuery = `
query SymphonyIssueStatesByIds($issueIds: [ID!]!, $first: Int!, $after: String) {
  issues(
    filter: { id: { in: $issueIds } }
    first: $first
    after: $after
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      state { name }
      branchName
      url
      labels { nodes { name } }
      relations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      inverseRelations { nodes { id type createdAt updatedAt archivedAt issue { id identifier state { name } } relatedIssue { id identifier state { name } } } }
      createdAt
      updatedAt
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const issueCommentCreateMutation = `
mutation SymphonyIssueCommentCreate($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id url }
  }
}`;

const issueStateUpdateMutation = `
mutation SymphonyIssueStateUpdate($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue { id identifier state { name } }
  }
}`;

const issueRelationCreateMutation = `
mutation SymphonyIssueRelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation {
      id
      type
      archivedAt
      issue { id identifier }
      relatedIssue { id identifier }
    }
  }
}`;

const issueRelationsByIssueIdQuery = `
query SymphonyIssueRelationsByIssueId($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    relations { nodes { id type archivedAt issue { id identifier } relatedIssue { id identifier } } }
    inverseRelations { nodes { id type archivedAt issue { id identifier } relatedIssue { id identifier } } }
  }
}`;

export class LinearTrackerClient implements IssueTrackerReader {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly projectSlug: string | null;
  private readonly teamKey: string | null;
  private readonly allApprovedProjects: boolean;
  private readonly activeStates: readonly string[];
  private readonly terminalStates: readonly string[];
  private readonly canaryIssueIdentifier: string | null;
  private readonly canaryLabels: readonly string[];
  private readonly requiredLabels: readonly string[];
  private readonly pageSize: number;
  private readonly maxIssuesPerPoll: number;
  private readonly transport: GraphQLTransport;
  private readonly receiptSink: LinearTrackerReceiptSink;

  public constructor(config: LinearTrackerClientConfig) {
    if (config.apiKey.trim() === '') {
      throw new TrackerError('missing_tracker_api_key', 'Linear tracker apiKey is required');
    }
    const projectSlug = config.projectSlug?.trim() === '' ? null : config.projectSlug ?? null;
    const teamKey = config.teamKey?.trim() === '' ? null : config.teamKey ?? null;
    const allApprovedProjects = config.allApprovedProjects === true;
    if (allApprovedProjects && (projectSlug !== null || teamKey !== null)) {
      throw new TrackerError(
        'missing_tracker_project_slug',
        'Linear tracker allApprovedProjects cannot be combined with projectSlug or teamKey',
      );
    }
    if (projectSlug === null && teamKey === null && !allApprovedProjects) {
      throw new TrackerError('missing_tracker_project_slug', 'Linear tracker projectSlug, teamKey, or allApprovedProjects is required');
    }

    this.endpoint = config.endpoint ?? DEFAULT_LINEAR_ENDPOINT;
    this.apiKey = config.apiKey;
    this.projectSlug = projectSlug;
    this.teamKey = teamKey;
    this.allApprovedProjects = allApprovedProjects;
    this.activeStates = config.activeStates ?? DEFAULT_ACTIVE_STATES;
    this.terminalStates = config.terminalStates ?? DEFAULT_TERMINAL_STATES;
    this.canaryIssueIdentifier = config.canaryIssueIdentifier ?? null;
    this.canaryLabels = config.canaryLabels ?? [];
    this.requiredLabels = (config.requiredLabels ?? []).map((label) => label.toLowerCase().trim()).filter((label) => label !== '');
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxIssuesPerPoll = config.maxIssuesPerPoll ?? this.pageSize;
    this.transport = config.transport ?? new FetchGraphQLTransport(this.endpoint, this.apiKey, config.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS);
    this.receiptSink = config.receiptSink ?? (() => undefined);
  }

  public getRequiredLabels(): readonly string[] {
    return this.requiredLabels;
  }

  public async fetch_candidate_issues(context?: { readonly workflowId?: string | null; readonly kanbanBoard?: string | null; readonly ledgerPath?: string | null }): Promise<readonly Issue[]> {
    return (await this.fetch_all_candidate_issues(context)).filter((issue) =>
      this.requiredLabels.length === 0 || this.requiredLabels.every((required) => issue.labels.includes(required)));
  }

  public async fetch_all_candidate_issues(context?: { readonly workflowId?: string | null; readonly kanbanBoard?: string | null; readonly ledgerPath?: string | null }): Promise<readonly Issue[]> {
    if (this.canaryIssueIdentifier !== null) {
      const exact = await this.fetchExactIssueByIdentifier(this.canaryIssueIdentifier, context);
      return exact === null ? [] : [exact];
    }
    return this.fetchRawIssuesBySelectorAndStates(this.activeStates);
  }

  public async fetch_terminal_issues(): Promise<readonly Issue[]> {
    return this.fetch_issues_by_states(this.terminalStates);
  }

  public async fetch_issues_by_states(stateNames: readonly string[], context?: { readonly workflowId?: string | null; readonly kanbanBoard?: string | null; readonly ledgerPath?: string | null }): Promise<readonly Issue[]> {
    if (stateNames.length === 0) {
      return [];
    }
    const issues = await this.fetchRawIssuesBySelectorAndStates(stateNames, context);
    return this.filterByRequiredLabels(issues);
  }

  public async fetch_issue_states_by_ids(issueIds: readonly string[]): Promise<readonly Issue[]> {
    if (issueIds.length === 0) {
      return [];
    }
    return this.fetchPaginatedIssues(issueStatesByIdQuery, { issueIds });
  }

  private async fetchExactIssueByIdentifier(identifier: string, context?: { readonly workflowId?: string | null; readonly kanbanBoard?: string | null; readonly kanbanTaskId?: string | null; readonly ledgerPath?: string | null }): Promise<Issue | null> {
    const payload = await this.request(exactIssueByIdentifierQuery, { identifier });
    const root = unwrapGraphQLData(payload);
    const issueNode = recordValue(root, 'issue');
    if (issueNode === null) {
      return null;
    }
    this.emitSelectedIssueReceipt('SymphonyExactIssue', issueNode, context);
    return normalizeLinearIssue(issueNode);
  }

  private async fetchRawIssuesBySelectorAndStates(
    stateNames: readonly string[],
    context?: { readonly workflowId?: string | null; readonly kanbanBoard?: string | null; readonly ledgerPath?: string | null },
  ): Promise<readonly Issue[]> {
    const hasLabels = this.canaryLabels.length > 0;
    if (this.teamKey !== null) {
      const query = hasLabels ? candidateIssuesByTeamWithLabelsQuery : candidateIssuesByTeamQuery;
      return this.fetchPaginatedIssues(query, {
        teamKey: this.teamKey,
        stateNames: [...stateNames],
        ...(hasLabels ? { canaryLabels: [...this.canaryLabels] } : {}),
      }, context);
    }
    if (this.projectSlug !== null) {
      const query = hasLabels ? candidateIssuesWithLabelsQuery : candidateIssuesQuery;
      return this.fetchPaginatedIssues(query, {
        projectSlug: this.projectSlug,
        stateNames: [...stateNames],
        ...(hasLabels ? { canaryLabels: [...this.canaryLabels] } : {}),
      }, context);
    }
    if (this.allApprovedProjects) {
      const query = hasLabels
        ? candidateIssuesForAllApprovedProjectsWithLabelsQuery
        : candidateIssuesForAllApprovedProjectsQuery;
      return this.fetchPaginatedIssues(query, {
        stateNames: [...stateNames],
        ...(hasLabels ? { canaryLabels: [...this.canaryLabels] } : {}),
      }, context);
    }
    throw new TrackerError('missing_tracker_project_slug', 'Linear tracker projectSlug, teamKey, or allApprovedProjects is required');
  }

  private filterByRequiredLabels(issues: readonly Issue[]): readonly Issue[] {
    if (this.requiredLabels.length === 0) {
      return issues;
    }
    return issues.filter((issue) => this.requiredLabels.every((required) => issue.labels.includes(required)));
  }

  private async fetchPaginatedIssues(
    query: string,
    baseVariables: Readonly<Record<string, unknown>>,
    context?: { readonly workflowId?: string | null; readonly kanbanBoard?: string | null; readonly ledgerPath?: string | null },
  ): Promise<readonly Issue[]> {
    const issues: Issue[] = [];
    let after: string | null = null;

    let hasNextPage = true;
    while (hasNextPage) {
      const remaining = this.maxIssuesPerPoll - issues.length;
      const payload = await this.request(query, {
        ...baseVariables,
        first: Math.min(this.pageSize, remaining),
        after,
      });
      const page = extractIssuesConnection(payload);
      const pageNodes = page.nodes.map((node) => {
        this.emitSelectedIssueReceipt(operationName(query), node, context);
        return normalizeLinearIssue(node);
      });
      issues.push(...pageNodes);
      if (issues.length >= this.maxIssuesPerPoll) {
        return issues.slice(0, this.maxIssuesPerPoll);
      }

      hasNextPage = page.pageInfo.hasNextPage;
      if (hasNextPage) {
        if (page.pageInfo.endCursor === null || page.pageInfo.endCursor === '') {
          throw new TrackerError('linear_missing_end_cursor', 'Linear pagination indicated another page without an endCursor');
        }
        after = page.pageInfo.endCursor;
      }
    }

    return issues;
  }

  private async request(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown> {
    let payload: unknown;
    try {
      payload = await this.transport.request(query, variables);
    } catch (error) {
      if (error instanceof TrackerError) {
        throw error;
      }
      const message = error instanceof Error ? `Linear GraphQL request failed: ${error.message}` : 'Linear GraphQL request failed';
      throw new TrackerError('linear_api_request', message);
    }

    const graphqlErrorCount = hasGraphQLErrors(payload) ? payload.errors.length : 0;
    this.emitReceipt({
      kind: 'linear_graphql_request_response',
      operation: operationName(query),
      endpoint: this.endpoint,
      request: {
        method: 'POST',
        headers: { authorization: '[REDACTED]', content_type: 'application/json' },
        query_sha256: sha256(query),
        variables: redactVariables(variables),
      },
      response: { outcome: graphqlErrorCount === 0 ? 'ok' : 'graphql_errors', graphql_error_count: graphqlErrorCount },
    });

    if (hasGraphQLErrors(payload)) {
      throw new TrackerError('linear_graphql_errors', 'Linear GraphQL response contained errors', {
        graphqlErrors: payload.errors,
      });
    }

    return payload;
  }

  private emitSelectedIssueReceipt(operation: string, issueNode: Readonly<Record<string, unknown>>, context?: { readonly workflowId?: string | null; readonly kanbanBoard?: string | null; readonly kanbanTaskId?: string | null; readonly ledgerPath?: string | null }): void {
    const stateRecord = recordValue(issueNode, 'state');
    const state = stateRecord === null ? null : nullableStringValue(stateRecord, 'name');
    if (state === null || state === undefined) {
      return;
    }
    const teamRecord = recordValue(issueNode, 'team');
    const boundedSelectorScope = this.selectorScopeForReceipt();
    this.emitReceipt({
      kind: 'linear_selected_issue',
      operation,
      project_slug: boundedSelectorScope.value,
      selector_scope: boundedSelectorScope,
      issue: {
        id: requiredString(issueNode, 'id'),
        identifier: requiredString(issueNode, 'identifier'),
        title: requiredString(issueNode, 'title'),
        team: {
          key: teamRecord === null ? null : nullableStringValue(teamRecord, 'key') ?? null,
          name: teamRecord === null ? null : nullableStringValue(teamRecord, 'name') ?? null,
        },
        state,
        url: nullableStringValue(issueNode, 'url') ?? null,
      },
      ...(context?.workflowId === undefined ? {} : { workflow_id: context.workflowId }),
      ...(context?.kanbanBoard === undefined ? {} : { kanban_board: context.kanbanBoard }),
      ...(context?.kanbanTaskId === undefined ? {} : { kanban_task_id: context.kanbanTaskId }),
      ...(context?.ledgerPath === undefined ? {} : { ledger_path: context.ledgerPath }),
    });
  }

  private selectedIssueSelectorScope(): Pick<NonNullable<LinearSelectedIssueReceipt['selector_scope']>, 'kind' | 'value'> {
    if (this.teamKey !== null) {
      return { kind: 'team_key', value: this.teamKey };
    }
    if (this.projectSlug !== null) {
      return { kind: 'project_slug', value: this.projectSlug };
    }
    return { kind: 'all_approved_projects', value: 'all_approved_projects' };
  }

  public selectorScopeForReceipt(): NonNullable<LinearSelectedIssueReceipt['selector_scope']> {
    const base = this.selectedIssueSelectorScope();
    return {
      ...base,
      required_labels: this.requiredLabels,
      canary_labels: this.canaryLabels,
      canary_issue_identifier: this.canaryIssueIdentifier,
      active_states: this.activeStates,
      max_issues_per_poll: this.maxIssuesPerPoll,
    };
  }

  private emitReceipt(receipt: LinearTrackerReceipt): void {
    try {
      const result = this.receiptSink(receipt);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Receipt sinks are observability hooks and must not change tracker behavior.
    }
  }
}

export class LinearIssueMutationClient {
  private readonly endpoint: string;
  private readonly transport: GraphQLTransport;
  private readonly receiptSink: LinearTrackerReceiptSink;

  public constructor(config: LinearIssueMutationClientConfig) {
    if (config.apiKey.trim() === '') {
      throw new TrackerError('missing_tracker_api_key', 'Linear mutation apiKey is required');
    }
    this.endpoint = config.endpoint ?? DEFAULT_LINEAR_ENDPOINT;
    this.transport = config.transport ?? new FetchGraphQLTransport(this.endpoint, config.apiKey, config.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS);
    this.receiptSink = config.receiptSink ?? (() => undefined);
  }

  public async createComment(input: CreateLinearIssueCommentInput): Promise<CreateLinearIssueCommentReceipt> {
    const payload = await this.request(issueCommentCreateMutation, { issueId: input.issueId, body: input.body });
    const root = unwrapGraphQLData(payload);
    const result = recordValue(root, 'commentCreate');
    if (result === null || booleanValue(result, 'success') !== true) {
      throw new TrackerError('linear_unknown_payload', 'Linear commentCreate response did not report success');
    }
    const comment = recordValue(result, 'comment');
    const receipt: CreateLinearIssueCommentReceipt = {
      comment_id: comment === null ? null : nullableStringValue(comment, 'id') ?? null,
      comment_url: comment === null ? null : nullableStringValue(comment, 'url') ?? null,
    };
    this.emitReceipt({
      kind: 'linear_mutation_result',
      operation: 'SymphonyIssueCommentCreate',
      issue_id: input.issueId,
      outcome: 'ok',
      result: { comment_id: receipt.comment_id, comment_url: receipt.comment_url },
    });
    return receipt;
  }

  public async updateIssueState(input: UpdateLinearIssueStateInput): Promise<void> {
    const payload = await this.request(issueStateUpdateMutation, { issueId: input.issueId, stateId: input.stateId });
    const root = unwrapGraphQLData(payload);
    const result = recordValue(root, 'issueUpdate');
    if (result === null || booleanValue(result, 'success') !== true) {
      throw new TrackerError('linear_unknown_payload', 'Linear issueUpdate response did not report success');
    }
    this.emitReceipt({
      kind: 'linear_mutation_result',
      operation: 'SymphonyIssueStateUpdate',
      issue_id: input.issueId,
      outcome: 'ok',
      result: { state_id: input.stateId },
    });
  }

  public async createIssueRelation(input: CreateLinearIssueRelationInput): Promise<CreateLinearIssueRelationReceipt> {
    const payload = await this.request(issueRelationCreateMutation, {
      input: {
        issueId: input.issueId,
        relatedIssueId: input.relatedIssueId,
        type: input.type,
      },
    });
    const root = unwrapGraphQLData(payload);
    const result = recordValue(root, 'issueRelationCreate');
    if (result === null || booleanValue(result, 'success') !== true) {
      throw new TrackerError('linear_unknown_payload', 'Linear issueRelationCreate response did not report success');
    }
    const relation = recordValue(result, 'issueRelation');
    if (relation === null) {
      throw new TrackerError('linear_unknown_payload', 'Linear issueRelationCreate response did not include issueRelation');
    }
    const relationType = nullableStringValue(relation, 'type');
    if (relationType !== 'blocks') {
      throw new TrackerError('linear_unknown_payload', 'Linear issueRelationCreate response relation type was not blocks');
    }
    const issue = recordValue(relation, 'issue');
    const relatedIssue = recordValue(relation, 'relatedIssue');
    const receipt: CreateLinearIssueRelationReceipt = {
      relation_id: nullableStringValue(relation, 'id') ?? null,
      type: 'blocks',
      issue_id: issue === null ? input.issueId : requiredString(issue, 'id'),
      related_issue_id: relatedIssue === null ? input.relatedIssueId : requiredString(relatedIssue, 'id'),
    };
    this.emitReceipt({
      kind: 'linear_mutation_result',
      operation: 'SymphonyIssueRelationCreate',
      issue_id: input.issueId,
      outcome: 'ok',
      result: {
        relation_id: receipt.relation_id,
        type: receipt.type,
        related_issue_id: receipt.related_issue_id,
      },
    });
    return receipt;
  }

  public async hasIssueRelation(input: CreateLinearIssueRelationInput): Promise<boolean> {
    const payload = await this.request(issueRelationsByIssueIdQuery, { issueId: input.issueId });
    const root = unwrapGraphQLData(payload);
    const issue = recordValue(root, 'issue');
    if (issue === null) {
      return false;
    }
    const relations = recordValue(issue, 'relations');
    const inverseRelations = recordValue(issue, 'inverseRelations');
    const nodes = [
      ...(relations === null ? [] : arrayValue(relations, 'nodes') ?? []),
      ...(inverseRelations === null ? [] : arrayValue(inverseRelations, 'nodes') ?? []),
    ];
    return nodes.some((node) => {
      if (!isRecord(node)) {
        return false;
      }
      if (nullableStringValue(node, 'type') !== input.type) {
        return false;
      }
      if (nullableStringValue(node, 'archivedAt') !== null) {
        return false;
      }
      const relationIssue = recordValue(node, 'issue');
      const relatedIssue = recordValue(node, 'relatedIssue');
      return relationIssue !== null
        && relatedIssue !== null
        && nullableStringValue(relationIssue, 'id') === input.issueId
        && nullableStringValue(relatedIssue, 'id') === input.relatedIssueId;
    });
  }

  private async request(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown> {
    let payload: unknown;
    try {
      payload = await this.transport.request(query, variables);
    } catch (error) {
      if (error instanceof TrackerError) {
        throw error;
      }
      const message = error instanceof Error ? `Linear GraphQL mutation failed: ${error.message}` : 'Linear GraphQL mutation failed';
      throw new TrackerError('linear_api_request', message);
    }

    const graphqlErrorCount = hasGraphQLErrors(payload) ? payload.errors.length : 0;
    this.emitReceipt({
      kind: 'linear_graphql_request_response',
      operation: operationName(query),
      endpoint: this.endpoint,
      request: {
        method: 'POST',
        headers: { authorization: '[REDACTED]', content_type: 'application/json' },
        query_sha256: sha256(query),
        variables: redactVariables(variables),
      },
      response: { outcome: graphqlErrorCount === 0 ? 'ok' : 'graphql_errors', graphql_error_count: graphqlErrorCount },
    });
    if (hasGraphQLErrors(payload)) {
      throw new TrackerError('linear_graphql_errors', 'Linear GraphQL mutation response contained errors', {
        graphqlErrors: payload.errors,
      });
    }
    return payload;
  }

  private emitReceipt(receipt: LinearTrackerReceipt): void {
    try {
      const result = this.receiptSink(receipt);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Receipt sinks are observability hooks and must not change mutation behavior.
    }
  }
}

class FetchGraphQLTransport implements GraphQLTransport {
  public constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  public async request(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? `Linear HTTP request failed: ${error.message}` : 'Linear HTTP request failed';
      throw new TrackerError('linear_api_request', message);
    }

    if (!response.ok) {
      throw new TrackerError('linear_api_status', `Linear HTTP request returned ${String(response.status)}`, {
        status: response.status,
      });
    }

    try {
      return await response.json();
    } catch (error) {
      const message = error instanceof Error ? `Linear HTTP response was not valid JSON: ${error.message}` : 'Linear HTTP response was not valid JSON';
      throw new TrackerError('linear_unknown_payload', message);
    }
  }
}

interface IssuesConnection {
  readonly nodes: readonly Readonly<Record<string, unknown>>[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly endCursor: string | null;
  };
}

function extractIssuesConnection(payload: unknown): IssuesConnection {
  const root = unwrapGraphQLData(payload);
  const issues = recordValue(root, 'issues');
  if (issues === null) {
    throw new TrackerError('linear_unknown_payload', 'Linear payload did not contain issues connection');
  }
  const nodes = arrayValue(issues, 'nodes');
  const pageInfo = recordValue(issues, 'pageInfo');
  if (nodes === null || pageInfo === null) {
    throw new TrackerError('linear_unknown_payload', 'Linear issues connection is missing nodes/pageInfo');
  }
  const hasNextPage = booleanValue(pageInfo, 'hasNextPage');
  const endCursor = nullableStringValue(pageInfo, 'endCursor');
  if (hasNextPage === null || endCursor === undefined) {
    throw new TrackerError('linear_unknown_payload', 'Linear pageInfo is malformed');
  }

  return {
    nodes: nodes.filter(isRecord),
    pageInfo: { hasNextPage, endCursor },
  };
}

function unwrapGraphQLData(payload: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(payload)) {
    throw new TrackerError('linear_unknown_payload', 'Linear payload is not an object');
  }
  const data = payload['data'];
  if (data === undefined) {
    return payload;
  }
  if (!isRecord(data)) {
    throw new TrackerError('linear_unknown_payload', 'Linear payload data is not an object');
  }
  return data;
}

function normalizeLinearIssue(node: Readonly<Record<string, unknown>>): Issue {
  const id = requiredString(node, 'id');
  const identifier = requiredString(node, 'identifier');
  const title = requiredString(node, 'title');
  const stateRecord = recordValue(node, 'state');
  const state = stateRecord === null ? null : nullableStringValue(stateRecord, 'name');
  if (state === null || state === undefined) {
    throw new TrackerError('linear_unknown_payload', `Linear issue ${id} is missing state.name`);
  }

  const teamRecord = recordValue(node, 'team');
  const hasProjectField = Object.prototype.hasOwnProperty.call(node, 'project');
  const projectRecord = recordValue(node, 'project');

  return {
    id,
    identifier,
    title,
    description: nullableStringValue(node, 'description') ?? null,
    priority: integerOrNull(node['priority']),
    state,
    branch_name: nullableStringValue(node, 'branchName') ?? null,
    url: nullableStringValue(node, 'url') ?? null,
    labels: normalizeLabels(node['labels']),
    blocked_by: normalizeBlockers(node['inverseRelations']),
    linear_relations: normalizeLinearRelations(node),
    created_at: parseIsoDateOrNull(node['createdAt']),
    updated_at: parseIsoDateOrNull(node['updatedAt']),
    ...(teamRecord === null ? {} : { team: normalizeLinearTeam(teamRecord) }),
    ...(hasProjectField ? { project: projectRecord === null ? null : normalizeLinearProject(projectRecord) } : {}),
  };
}

function normalizeLinearTeam(node: Readonly<Record<string, unknown>>): NonNullable<Issue['team']> {
  return {
    key: nullableStringValue(node, 'key') ?? null,
    name: nullableStringValue(node, 'name') ?? null,
  };
}

function normalizeLinearProject(node: Readonly<Record<string, unknown>>): NonNullable<NonNullable<Issue['project']>> {
  return {
    id: nullableStringValue(node, 'id') ?? null,
    name: nullableStringValue(node, 'name') ?? null,
    slug_id: nullableStringValue(node, 'slugId') ?? null,
    url: nullableStringValue(node, 'url') ?? null,
  };
}

function normalizeLabels(value: unknown): readonly string[] {
  const labelConnection = isRecord(value) ? value : null;
  const nodes = labelConnection === null ? null : arrayValue(labelConnection, 'nodes');
  if (nodes === null) {
    return [];
  }
  const labels: string[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const label = nullableStringValue(node, 'name');
    if (label !== null && label !== undefined) {
      labels.push(label.toLowerCase().trim());
    }
  }
  return labels;
}

function normalizeLinearRelations(issueNode: Readonly<Record<string, unknown>>): readonly LinearIssueRelationRef[] {
  return [
    ...normalizeLinearRelationConnection(issueNode['relations'], 'relations'),
    ...normalizeLinearRelationConnection(issueNode['inverseRelations'], 'inverseRelations'),
  ];
}

function normalizeLinearRelationConnection(
  value: unknown,
  observedFrom: LinearIssueRelationObservationSource,
): readonly LinearIssueRelationRef[] {
  const relationConnection = isRecord(value) ? value : null;
  const nodes = relationConnection === null ? null : arrayValue(relationConnection, 'nodes');
  if (nodes === null) {
    return [];
  }
  const relations: LinearIssueRelationRef[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    const relation = normalizeLinearRelationNode(node, observedFrom);
    if (relation !== null) {
      relations.push(relation);
    }
  }
  return relations;
}

function normalizeLinearRelationNode(
  node: Readonly<Record<string, unknown>>,
  observedFrom: LinearIssueRelationObservationSource,
): LinearIssueRelationRef | null {
  const id = nullableStringValue(node, 'id');
  const type = nullableStringValue(node, 'type');
  if (id === null || id === undefined || !isLinearIssueRelationType(type)) {
    return null;
  }
  return {
    id,
    type,
    observed_from: observedFrom,
    issue: normalizeLinearRelationEndpoint(recordValue(node, 'issue')),
    related_issue: normalizeLinearRelationEndpoint(recordValue(node, 'relatedIssue')),
    created_at: parseIsoDateOrNull(node['createdAt']),
    updated_at: parseIsoDateOrNull(node['updatedAt']),
    archived_at: parseIsoDateOrNull(node['archivedAt']),
  };
}

function normalizeLinearRelationEndpoint(
  node: Readonly<Record<string, unknown>> | null,
): LinearIssueRelationEndpointRef {
  if (node === null) {
    return { id: null, identifier: null, state: null };
  }
  const stateRecord = recordValue(node, 'state');
  return {
    id: nullableStringValue(node, 'id') ?? null,
    identifier: nullableStringValue(node, 'identifier') ?? null,
    state: stateRecord === null ? null : nullableStringValue(stateRecord, 'name') ?? null,
  };
}

function isLinearIssueRelationType(value: string | null | undefined): value is LinearIssueRelationType {
  return value === 'blocks' || value === 'duplicate' || value === 'related' || value === 'similar';
}

function normalizeBlockers(value: unknown): readonly IssueBlockerRef[] {
  const relationConnection = isRecord(value) ? value : null;
  const nodes = relationConnection === null ? null : arrayValue(relationConnection, 'nodes');
  if (nodes === null) {
    return [];
  }
  const blockers: IssueBlockerRef[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    if (nullableStringValue(node, 'type') !== 'blocks') {
      continue;
    }
    const blockedByIssue = recordValue(node, 'issue');
    if (blockedByIssue === null) {
      blockers.push({ id: null, identifier: null, state: null });
      continue;
    }
    const blockerState = recordValue(blockedByIssue, 'state');
    blockers.push({
      id: nullableStringValue(blockedByIssue, 'id') ?? null,
      identifier: nullableStringValue(blockedByIssue, 'identifier') ?? null,
      state: blockerState === null ? null : nullableStringValue(blockerState, 'name') ?? null,
    });
  }
  return blockers;
}

function hasGraphQLErrors(payload: unknown): payload is { readonly errors: readonly unknown[] } {
  return isRecord(payload) && Array.isArray(payload['errors']) && payload['errors'].length > 0;
}

const SECRET_VARIABLE_FIELD = /(?:api[_-]?key|authorization|password|secret|token)/i;

function operationName(query: string): string {
  const match = /\b(?:query|mutation)\s+([A-Za-z][A-Za-z0-9_]*)/.exec(query);
  return match?.[1] ?? 'anonymous';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function redactVariables(variables: Readonly<Record<string, unknown>>): Readonly<Record<string, LinearReceiptJson>> {
  const redacted: Record<string, LinearReceiptJson> = {};
  for (const [key, value] of Object.entries(variables)) {
    redacted[key] = SECRET_VARIABLE_FIELD.test(key) ? '[REDACTED]' : toReceiptJson(value);
  }
  return redacted;
}

function toReceiptJson(value: unknown): LinearReceiptJson {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toReceiptJson(entry));
  }
  if (isRecord(value)) {
    const redacted: Record<string, LinearReceiptJson> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = SECRET_VARIABLE_FIELD.test(key) ? '[REDACTED]' : toReceiptJson(nestedValue);
    }
    return redacted;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'symbol') {
    return value.description ?? '[symbol]';
  }
  if (typeof value === 'function') {
    return '[function]';
  }
  return null;
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = nullableStringValue(record, key);
  if (value === null || value === undefined) {
    throw new TrackerError('linear_unknown_payload', `Linear payload missing required string: ${key}`);
  }
  return value;
}

function recordValue(record: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function arrayValue(record: Readonly<Record<string, unknown>>, key: string): readonly unknown[] | null {
  const value = record[key];
  return Array.isArray(value) ? value : null;
}

function booleanValue(record: Readonly<Record<string, unknown>>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

function nullableStringValue(record: Readonly<Record<string, unknown>>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function parseIsoDateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return new Date(timestamp);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
