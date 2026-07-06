import type {
  Issue,
  LinearIssueRelationEndpointRef,
  LinearIssueRelationRef,
} from './domain.js';
import type {
  BuildGraphSyncReadOnlyDiffReceiptInput,
  GraphSyncNodeMappingSnapshot,
  GraphSyncScope,
  KanbanEdgeSnapshotToCanonicalEdgeInput,
  LinearIssueRelationSnapshot,
  LinearRelationIssueSnapshot,
  LinearRelationSnapshotToCanonicalEdgeInput,
} from './graph-sync-ledger.js';
import type { KanbanTaskDetail, KanbanTaskLink } from './kanban-types.js';

export interface GraphSyncObservedNodeMapping {
  readonly linearIssueId: string;
  readonly kanbanTaskId: string;
}

export interface BuildGraphSyncReadOnlySnapshotFromObservedGraphInput {
  readonly workflowId: string;
  readonly runId: string;
  readonly generatedAt: string;
  readonly completedAt: string;
  readonly scope: GraphSyncScope;
  readonly issues: readonly Issue[];
  readonly kanbanTasks: readonly KanbanTaskDetail[];
  readonly nodeMappings: readonly GraphSyncObservedNodeMapping[];
}

export class GraphSyncSnapshotImportError extends Error {
  public readonly field: string;

  public constructor(field: string, message: string) {
    super(message);
    this.name = 'GraphSyncSnapshotImportError';
    this.field = field;
  }
}

export function buildGraphSyncReadOnlySnapshotFromObservedGraph(
  input: BuildGraphSyncReadOnlySnapshotFromObservedGraphInput,
): BuildGraphSyncReadOnlyDiffReceiptInput {
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const tasksById = new Map(input.kanbanTasks.map((task) => [task.id, task]));
  return {
    workflowId: input.workflowId,
    runId: input.runId,
    generatedAt: input.generatedAt,
    completedAt: input.completedAt,
    scope: input.scope,
    nodeMappings: buildNodeMappings(input.nodeMappings, issuesById, tasksById),
    linearRelations: buildLinearRelations(input.issues),
    kanbanEdges: buildKanbanEdges(input.kanbanTasks),
  };
}

function buildNodeMappings(
  mappings: readonly GraphSyncObservedNodeMapping[],
  issuesById: ReadonlyMap<string, Issue>,
  tasksById: ReadonlyMap<string, KanbanTaskDetail>,
): readonly GraphSyncNodeMappingSnapshot[] {
  return mappings.map((mapping, index) => {
    const issue = requireMappedIssue(mapping.linearIssueId, issuesById, index);
    const task = requireMappedTask(mapping.kanbanTaskId, tasksById, index);
    return {
      linearIssue: linearIssueSnapshotFromIssue(issue),
      kanbanTask: { id: task.id, status: task.status },
    };
  });
}

function buildLinearRelations(issues: readonly Issue[]): readonly LinearRelationSnapshotToCanonicalEdgeInput[] {
  return issues.flatMap((issue) =>
    (issue.linear_relations ?? []).map((relation) => ({
      relation: linearRelationSnapshot(relation),
      observedFrom: relation.observed_from,
      anchorIssueId: issue.id,
    })),
  );
}

function buildKanbanEdges(tasks: readonly KanbanTaskDetail[]): readonly KanbanEdgeSnapshotToCanonicalEdgeInput[] {
  const edgesByFingerprint = new Map<string, KanbanEdgeSnapshotToCanonicalEdgeInput>();
  for (const task of tasks) {
    for (const link of [...task.parentLinks, ...task.childLinks]) {
      const edge = kanbanEdgeSnapshot(link);
      edgesByFingerprint.set(canonicalKanbanLinkFingerprint(edge), edge);
    }
  }
  return Array.from(edgesByFingerprint.values());
}

function requireMappedIssue(
  linearIssueId: string,
  issuesById: ReadonlyMap<string, Issue>,
  index: number,
): Issue {
  const issue = issuesById.get(linearIssueId);
  if (issue === undefined) {
    throw new GraphSyncSnapshotImportError(
      `nodeMappings.${String(index)}.linearIssueId`,
      `Mapped Linear issue ${linearIssueId} is missing from observed issues`,
    );
  }
  return issue;
}

function requireMappedTask(
  kanbanTaskId: string,
  tasksById: ReadonlyMap<string, KanbanTaskDetail>,
  index: number,
): KanbanTaskDetail {
  const task = tasksById.get(kanbanTaskId);
  if (task === undefined) {
    throw new GraphSyncSnapshotImportError(
      `nodeMappings.${String(index)}.kanbanTaskId`,
      `Mapped Kanban task ${kanbanTaskId} is missing from observed task readbacks`,
    );
  }
  return task;
}

function linearIssueSnapshotFromIssue(issue: Issue): LinearRelationIssueSnapshot {
  return { id: issue.id, identifier: issue.identifier, stateName: issue.state };
}

function linearRelationSnapshot(relation: LinearIssueRelationRef): LinearIssueRelationSnapshot {
  return {
    id: relation.id,
    type: relation.type,
    issue: linearRelationEndpointSnapshot(relation.id, 'issue', relation.issue),
    relatedIssue: linearRelationEndpointSnapshot(relation.id, 'related_issue', relation.related_issue),
    createdAt: relation.created_at?.toISOString() ?? null,
    updatedAt: relation.updated_at?.toISOString() ?? null,
    archivedAt: relation.archived_at?.toISOString() ?? null,
  };
}

function linearRelationEndpointSnapshot(
  relationId: string,
  field: 'issue' | 'related_issue',
  endpoint: LinearIssueRelationEndpointRef,
): LinearRelationIssueSnapshot {
  const id = endpoint.id;
  if (id === null || id.trim() === '') {
    throw new GraphSyncSnapshotImportError(
      `issues.linear_relations.${relationId}.${field}.id`,
      `Linear relation ${relationId} has no ${field} endpoint id`,
    );
  }
  return {
    id,
    identifier: endpoint.identifier,
    stateName: endpoint.state,
  };
}

function kanbanEdgeSnapshot(link: KanbanTaskLink): KanbanEdgeSnapshotToCanonicalEdgeInput {
  return {
    parentTaskId: link.parentTaskId,
    childTaskId: link.childTaskId,
    kind: link.kind,
    blocking: link.blocking,
    requiredParentStatuses: link.requiredParentStatuses,
    source: link.source,
    createdBy: link.createdBy,
    metadata: link.metadata,
  };
}

function canonicalKanbanLinkFingerprint(edge: KanbanEdgeSnapshotToCanonicalEdgeInput): string {
  return [
    edge.parentTaskId,
    edge.childTaskId,
    edge.kind,
    edge.blocking ? 'blocking' : 'nonblocking',
    edge.requiredParentStatuses.join(','),
    edge.source ?? 'null',
    edge.createdBy ?? 'null',
    stableMetadataFingerprint(edge.metadata),
  ].join('|');
}

function stableMetadataFingerprint(metadata: Readonly<Record<string, string>>): string {
  return Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}
