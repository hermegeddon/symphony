import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkflowDefinition } from '../workflow.js';

export const fakeDemoWorkflow: WorkflowDefinition = {
  config: {
    tracker: {
      kind: 'linear',
      api_key: 'fake-api-key',
      project_slug: 'FAKE',
    },
    workspace: {
      root: tmpdir(),
    },
    codex: {
      command: 'fake-codex',
    },
    polling: {
      interval_ms: 10000,
    },
    agent: {
      max_concurrent_agents: 1,
      max_turns: 1,
    },
  },
  prompt_template: 'Fake check run for {{ issue.identifier }}: {{ issue.title }}',
  workflow_path: join(tmpdir(), 'fake-workflow.md'),
};
