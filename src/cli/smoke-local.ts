#!/usr/bin/env node

import { runFakeSmoke } from '../demo/smoke.js';
import { formatStructuredLogLine } from '../observability.js';
import { isDirectCliExecution } from './direct-execution.js';

async function main(): Promise<void> {
  const result = await runFakeSmoke();
  process.stdout.write(`${JSON.stringify(result.snapshot, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (isDirectCliExecution(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(formatStructuredLogLine({ level: 'error', event: 'fake_smoke', outcome: 'failed', reason: message }));
    process.stderr.write('\n');
    process.exit(1);
  });
}
