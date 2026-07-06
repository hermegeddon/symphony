import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SymphonyOrchestrator } from '../orchestrator.js';
import { formatStructuredLogLine } from '../observability.js';
import { fakeDemoWorkflow } from './workflow.js';
import { fakeTracker } from './fixtures.js';
import { createDemoWorkspaceManager, cleanupAllDemoWorkspaces } from './workspace.js';
import { createDemoAgentRunner } from './runner.js';

export interface FakeSmokeResult {
  readonly ok: boolean;
  readonly logs: readonly string[];
  readonly snapshot: ReturnType<SymphonyOrchestrator['snapshot']>;
}

export async function runFakeSmoke(
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<FakeSmokeResult> {
  const logs: string[] = [];
  const safeLog = (line: string): void => {
    log(line);
    logs.push(line);
  };

  const preparedWorkspaces = new Map<string, string>();
  const workspaceManager = createDemoWorkspaceManager(safeLog, preparedWorkspaces);
  const runner = createDemoAgentRunner(safeLog);

  const workflow = {
    ...fakeDemoWorkflow,
    config: {
      ...fakeDemoWorkflow.config,
      workspace: { root: tmpdir() },
    },
    workflow_path: join(tmpdir(), 'fake-smoke-workflow.md'),
  };

  let fakeTimerId = 0;
  const orchestrator = new SymphonyOrchestrator({
    workflow,
    tracker: fakeTracker,
    workspaceManager,
    runner,
    log: safeLog,
    clock: {
      now: () => new Date(),
      setTimeout: () => {
        fakeTimerId += 1;
        return fakeTimerId as unknown as NodeJS.Timeout;
      },
      clearTimeout: () => undefined,
    },
  });

  safeLog(formatStructuredLogLine({ level: 'info', event: 'fake_smoke', outcome: 'started' }));

  await orchestrator.startupCleanup();
  await orchestrator.tick();
  await orchestrator.drain();

  const snapshot = orchestrator.snapshot();
  safeLog(formatStructuredLogLine({
    level: 'info',
    event: 'fake_smoke',
    outcome: 'completed',
    completed_count: snapshot.completed.length,
    running_count: snapshot.running.length,
    retrying_count: snapshot.retrying.length,
  }));

  await cleanupAllDemoWorkspaces(preparedWorkspaces);

  return { ok: true, logs, snapshot };
}
