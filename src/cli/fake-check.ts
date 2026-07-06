#!/usr/bin/env node

import { SymphonyOrchestrator } from '../orchestrator.js';
import { formatStructuredLogLine } from '../observability.js';
import { fakeDemoWorkflow } from '../demo/workflow.js';
import { fakeTracker } from '../demo/fixtures.js';
import { createDemoWorkspaceManager, cleanupAllDemoWorkspaces } from '../demo/workspace.js';
import { createDemoAgentRunner } from '../demo/runner.js';
import { isDirectCliExecution } from './direct-execution.js';

export interface FakeCheckResult {
  readonly ok: boolean;
  readonly logs: readonly string[];
  readonly snapshot: ReturnType<SymphonyOrchestrator['snapshot']>;
}

export async function runFakeCheck(
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<FakeCheckResult> {
  const logs: string[] = [];
  const safeLog = (line: string): void => {
    log(line);
    logs.push(line);
  };

  const preparedWorkspaces = new Map<string, string>();
  const workspaceManager = createDemoWorkspaceManager(safeLog, preparedWorkspaces);
  const runner = createDemoAgentRunner(safeLog);

  let fakeTimerId = 0;
  const orchestrator = new SymphonyOrchestrator({
    workflow: fakeDemoWorkflow,
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

  safeLog(formatStructuredLogLine({ level: 'info', event: 'fake_check', outcome: 'started' }));

  await orchestrator.startupCleanup();
  await orchestrator.tick();
  await orchestrator.drain();

  const snapshot = orchestrator.snapshot();
  safeLog(formatStructuredLogLine({
    level: 'info',
    event: 'fake_check',
    outcome: 'completed',
    completed_count: snapshot.completed.length,
    running_count: snapshot.running.length,
    retrying_count: snapshot.retrying.length,
  }));

  await cleanupAllDemoWorkspaces(preparedWorkspaces);

  return { ok: true, logs, snapshot };
}

async function main(): Promise<void> {
  const result = await runFakeCheck();
  process.stdout.write(`${JSON.stringify(result.snapshot, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (isDirectCliExecution(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(formatStructuredLogLine({ level: 'error', event: 'fake_check', outcome: 'failed', reason: message }));
    process.stderr.write('\n');
    process.exit(1);
  });
}
