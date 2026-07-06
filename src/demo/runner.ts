import { formatStructuredLogLine, type StructuredLogEntry } from '../observability.js';
import type { Issue } from '../domain.js';
import type { RunCompletion } from '../orchestrator.js';

export interface DemoAgentRunner {
  readonly runIssue: (input: {
    readonly issue: Issue;
    readonly workspacePath: string;
    readonly promptTemplate: string;
    readonly retryAttempt: number | null;
  }) => { readonly completion: Promise<RunCompletion>; readonly cancel: (reason: string) => Promise<void> };
}

export function createDemoAgentRunner(log: (line: string) => void): DemoAgentRunner {
  const safeLog = (entry: StructuredLogEntry): void => {
    log(formatStructuredLogLine(entry));
  };

  return {
    runIssue: (input): { readonly completion: Promise<RunCompletion>; readonly cancel: (reason: string) => Promise<void> } => {
      safeLog({
        level: 'info',
        event: 'fake_agent_run',
        outcome: 'started',
        issue_id: input.issue.id,
        issue_identifier: input.issue.identifier,
      });
      const completion: Promise<RunCompletion> = Promise.resolve({
        ok: true,
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      });
      return {
        completion,
        cancel: async (): Promise<void> => {
          await completion.then(() => undefined, () => undefined);
        },
      };
    },
  };
}
