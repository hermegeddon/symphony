import { describe, expect, it } from 'vitest';

import {
  createEmptyGraphSyncLedger,
  createBridgeLedgerGraphSyncMappingReader,
  createLinearTrackerGraphSyncLinearReader,
  GRAPH_SYNC_LEDGER_VERSION,
  applyGraphSyncMissingKanbanBlockingEdges,
  implementationPolicyDecisions,
  materializeGraphSyncMissingKanbanBlockingEdges,
  runRecurringLinearKanbanGraphSyncCanary,
  runRecurringLinearKanbanGraphSyncTick,
  symphonyImplementationName,
} from '../src/index.js';

describe('symphony-ts public API', () => {
  it('exports the implementation package identity', () => {
    expect(symphonyImplementationName).toBe('symphony-ts');
  });

  it('exports GraphSyncLedger primitives for local dependency-sync planning without enabling apply mode', () => {
    expect(GRAPH_SYNC_LEDGER_VERSION).toBe(1);
    expect(createEmptyGraphSyncLedger({
      workflowId: 'wf-export-smoke',
      scope: { tracker: 'linear', kanbanBoard: 'linear' },
      generatedAt: '2026-06-27T19:15:00.000Z',
    })).toMatchObject({
      version: 1,
      workflow_id: 'wf-export-smoke',
      edges: {},
      conflicts: {},
      semantic_events: {},
    });
  });

  it('exports GraphSync fake-only materialization helper without granting live apply authority', () => {
    expect(typeof materializeGraphSyncMissingKanbanBlockingEdges).toBe('function');
  });

  it('exports the gated GraphSync live Kanban apply helper', () => {
    expect(typeof applyGraphSyncMissingKanbanBlockingEdges).toBe('function');
  });

  it('exports read-only GraphSync live reader helpers without granting apply authority', () => {
    expect(typeof createBridgeLedgerGraphSyncMappingReader).toBe('function');
    expect(typeof createLinearTrackerGraphSyncLinearReader).toBe('function');
  });

  it('exports the recurring lifecycle plus GraphSync tick coordinator and canary harness without dispatch authority', () => {
    expect(typeof runRecurringLinearKanbanGraphSyncTick).toBe('function');
    expect(typeof runRecurringLinearKanbanGraphSyncCanary).toBe('function');
  });

  it('records implementation-defined policies as selected or explicitly gated, not deferred', () => {
    expect(implementationPolicyDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: 'trust-and-safety-posture', status: 'selected' }),
        expect.objectContaining({ topic: 'workspace-population-policy', status: 'selected' }),
        expect.objectContaining({ topic: 'dynamic-workflow-reload', status: 'selected' }),
        expect.objectContaining({ topic: 'live-validation-boundary', status: 'gated' }),
        expect.objectContaining({ topic: 'durable-live-service-state', status: 'selected' }),
        expect.objectContaining({ topic: 'control-plane-read-privacy', status: 'selected' }),
        expect.objectContaining({ topic: 'backend-direction', status: 'selected' }),
        expect.objectContaining({ topic: 'hermes-kanban-backend', status: 'selected' }),
        expect.objectContaining({ topic: 'linear-kanban-bridge', status: 'selected' }),
        expect.objectContaining({ topic: 'graph-sync-read-only-diff', status: 'selected' }),
        expect.objectContaining({ topic: 'graph-sync-read-only-snapshot-capture', status: 'selected' }),
        expect.objectContaining({ topic: 'recurring-lifecycle-graph-sync-tick', status: 'selected' }),
        expect.objectContaining({ topic: 'graph-sync-status-watchdog', status: 'selected' }),
        expect.objectContaining({ topic: 'graph-sync-fake-kanban-materialization', status: 'selected' }),
        expect.objectContaining({ topic: 'graph-sync-live-kanban-apply', status: 'gated' }),
        expect.objectContaining({ topic: 'graph-sync-live-linear-apply', status: 'gated' }),
        expect.objectContaining({ topic: 'live-bidirectional-sync-definition', status: 'gated' }),
        expect.objectContaining({ topic: 'linear-comment-privacy-interlock', status: 'selected' }),
      ]),
    );
    const statuses = implementationPolicyDecisions.map((decision) => decision.status as string);
    expect(statuses).not.toContain('deferred');
    expect(implementationPolicyDecisions.every((decision) => decision.decision.length > 0 && decision.evidence.length > 0)).toBe(true);
  });

  it('records the graph_sync config schema as inert by default and fail-closed for apply/live modes', () => {
    const graphSyncConfig = implementationPolicyDecisions.find((decision) => decision.topic === 'graph-sync-config-schema');

    expect(graphSyncConfig).toBeDefined();
    if (graphSyncConfig === undefined) {
      throw new Error('graph-sync-config-schema policy decision not found');
    }
    expect(graphSyncConfig.status).toBe('selected');
    expect(graphSyncConfig.decision).toContain('top-level graph_sync workflow config');
    expect(graphSyncConfig.decision).toContain('inertly by default');
    expect(graphSyncConfig.decision).toContain('fail-closed for live/apply modes');
    expect(graphSyncConfig.decision).toContain('read_only_diff');
    expect(graphSyncConfig.decision).toContain('not dispatch authority');
    expect(graphSyncConfig.decision).toContain('not service/timer authorization');
    expect(graphSyncConfig.decision).toContain('not live mutation approval');
    expect(graphSyncConfig.evidence).toEqual(expect.arrayContaining([
      'src/workflow.ts',
      'tests/workflow.test.ts',
      'tests/index.test.ts',
    ]));
  });

  it('identifies Hermes Kanban as the canonical work engine and direct Codex as legacy compatibility', () => {
    const backendDirection = implementationPolicyDecisions.find((decision) => decision.topic === 'backend-direction');

    expect(backendDirection).toBeDefined();
    if (backendDirection === undefined) {
      throw new Error('backend-direction policy decision not found');
    }
    expect(backendDirection.status).toBe('selected');
    expect(backendDirection.decision).toContain('Hermes Kanban is the canonical Symphony work engine');
    expect(backendDirection.decision).toContain('in_process_linear_codex');
    expect(backendDirection.decision).toContain('legacy compatibility');
    expect(backendDirection.decision).toContain('does not prove that the Kanban-first work engine');
    expect(backendDirection.decision).toContain('materialize a task graph');
    expect(backendDirection.decision).toContain('pass a no-worker canary');
    expect(backendDirection.decision).toContain('safely dispatch through the Hermes gateway');
    expect(backendDirection.evidence).toEqual(expect.arrayContaining([
      'src/linear-kanban-canary.ts',
      'docs/kanban-first-migration.md',
    ]));
  });

  it('identifies the Linear Kanban bridge as the normal Kanban-first Linear integration path', () => {
    const bridge = implementationPolicyDecisions.find((decision) => decision.topic === 'linear-kanban-bridge');

    expect(bridge).toBeDefined();
    if (bridge === undefined) {
      throw new Error('linear-kanban-bridge policy decision not found');
    }
    expect(bridge.status).toBe('selected');
    expect(bridge.decision).toContain('polls eligible Linear issues');
    expect(bridge.decision).toContain('tracker.all_approved_projects');
    expect(bridge.decision).toContain('reviewed and bounded');
    expect(bridge.decision).toContain('materializes Hermes Kanban tasks');
    expect(bridge.decision).toContain('never invokes the legacy Codex runner');
    expect(bridge.evidence).toEqual(expect.arrayContaining([
      'src/linear-kanban-bridge.ts',
      'tests/cli-linear-kanban-bridge.test.ts',
    ]));
  });

  it('defines full live bidirectional sync as requiring recurring DAG GraphSync, not lifecycle polling alone', () => {
    const syncDefinition = implementationPolicyDecisions.find((decision) => decision.topic === 'live-bidirectional-sync-definition');

    expect(syncDefinition).toBeDefined();
    if (syncDefinition === undefined) {
      throw new Error('live-bidirectional-sync-definition policy decision not found');
    }
    expect(syncDefinition.status).toBe('gated');
    expect(syncDefinition.decision).toContain('not satisfied by a recurring lifecycle bridge alone');
    expect(syncDefinition.decision).toContain('recurring DAG/GraphSync companion loop');
    expect(syncDefinition.decision).toContain('dependency-readiness output before gateway/worker dispatch reliance');
    expect(syncDefinition.evidence).toEqual(expect.arrayContaining([
      'docs/linear-kanban-dag-sync-roadmap.md',
      'tests/index.test.ts',
    ]));
  });

  it('records the recurring lifecycle plus GraphSync tick as local coordination, not live dispatch authority', () => {
    const recurringTick = implementationPolicyDecisions.find((decision) => decision.topic === 'recurring-lifecycle-graph-sync-tick');

    expect(recurringTick).toBeDefined();
    if (recurringTick === undefined) {
      throw new Error('recurring-lifecycle-graph-sync-tick policy decision not found');
    }
    expect(recurringTick.status).toBe('selected');
    expect(recurringTick.decision).toContain('runs the lifecycle tick before the GraphSync snapshot');
    expect(recurringTick.decision).toContain('dispatch_reliance_decision');
    expect(recurringTick.decision).toContain('Neither surface dispatches workers or edits services/timers');
    expect(recurringTick.decision).toContain('local canary harness');
    expect(recurringTick.decision).toContain('writes local receipt/status/summary artifacts');
    expect(recurringTick.decision).toContain('suppresses dispatch-reliance probes when readiness is deferred or blocked');
    expect(recurringTick.evidence).toEqual(expect.arrayContaining([
      'src/linear-kanban-graph-sync-tick.ts',
      'tests/linear-kanban-graph-sync-tick.test.ts',
    ]));
  });

  it('records the GraphSync status watchdog as read-only operator observation, not apply or dispatch authority', () => {
    const watchdog = implementationPolicyDecisions.find((decision) => decision.topic === 'graph-sync-status-watchdog');

    expect(watchdog).toBeDefined();
    if (watchdog === undefined) {
      throw new Error('graph-sync-status-watchdog policy decision not found');
    }
    expect(watchdog.status).toBe('selected');
    expect(watchdog.decision).toContain('reads the recurring GraphSync last-run.json');
    expect(watchdog.decision).toContain('classifies PASS, REVIEW, and BLOCK');
    expect(watchdog.decision).toContain('15-minute default stale threshold');
    expect(watchdog.decision).toContain('does not mutate Linear or Hermes Kanban');
    expect(watchdog.decision).toContain('does not edit services/timers or dispatch workers/gateway');
    expect(watchdog.evidence).toEqual(expect.arrayContaining([
      'src/graph-sync-status.ts',
      'src/cli/graph-sync-status.ts',
      'tests/graph-sync-status.test.ts',
      'tests/cli-graph-sync-status.test.ts',
    ]));
  });
});
