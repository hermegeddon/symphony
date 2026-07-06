import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatStructuredLogLine, type StructuredLogEntry } from '../observability.js';
import type { Issue } from '../domain.js';

export interface DemoWorkspaceManager {
  readonly prepareWorkspace: (issue: Issue) => Promise<{ readonly workspacePath: string }>;
  readonly runAfterRunHook: (issue: Issue) => Promise<void>;
  readonly cleanupTerminalWorkspace: (issue: Issue) => Promise<void>;
}

export function createDemoWorkspaceManager(
  log: (line: string) => void,
  preparedWorkspaces: Map<string, string> = new Map<string, string>(),
): DemoWorkspaceManager {
  const safeLog = (entry: StructuredLogEntry): void => {
    log(formatStructuredLogLine(entry));
  };

  return {
    prepareWorkspace: async (issue: Issue): Promise<{ readonly workspacePath: string }> => {
      const workspacePath = await mkdtemp(join(tmpdir(), `symphony-fake-${issue.identifier}-`));
      preparedWorkspaces.set(issue.id, workspacePath);
      safeLog({
        level: 'info',
        event: 'fake_workspace_prepare',
        outcome: 'completed',
        issue_id: issue.id,
        issue_identifier: issue.identifier,
        workspace_path: workspacePath,
      });
      return { workspacePath };
    },
    runAfterRunHook: (issue: Issue): Promise<void> => {
      safeLog({
        level: 'info',
        event: 'fake_after_run_hook',
        outcome: 'completed',
        issue_id: issue.id,
        issue_identifier: issue.identifier,
      });
      return Promise.resolve();
    },
    cleanupTerminalWorkspace: async (issue: Issue): Promise<void> => {
      const workspacePath = preparedWorkspaces.get(issue.id);
      if (workspacePath !== undefined) {
        try {
          await rm(workspacePath, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup for the fake demo run.
        }
        preparedWorkspaces.delete(issue.id);
      }
    },
  };
}

export async function cleanupAllDemoWorkspaces(preparedWorkspaces: Map<string, string>): Promise<void> {
  for (const workspacePath of preparedWorkspaces.values()) {
    try {
      await rm(workspacePath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for the fake demo run.
    }
  }
  preparedWorkspaces.clear();
}
