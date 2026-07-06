import { describe, expect, it } from 'vitest';

import { runFakeCheck } from '../src/cli/fake-check.js';

describe('symphony-fake-check CLI', () => {
  it('runs the fake-only check without credentials or network and completes the demo issue', async () => {
    const logs: string[] = [];
    const result = await runFakeCheck((line) => logs.push(line));

    expect(result.ok).toBe(true);
    expect(result.logs).toEqual(expect.arrayContaining([
      expect.stringContaining('event=fake_check outcome=started'),
      expect.stringContaining('event=fake_agent_run outcome=started'),
      expect.stringContaining('event=fake_check outcome=completed completed_count=1'),
    ]));
    expect(result.snapshot.completed).toContain('fake-issue-1');
    expect(result.snapshot.running).toHaveLength(0);
    expect(result.snapshot.retrying).toHaveLength(1); // success schedules a continuation retry
    expect(result.snapshot.codex_totals.total_tokens).toBe(10);
  });

  it('uses a fake tracker, workspace manager, and runner with no live services', async () => {
    const result = await runFakeCheck(() => undefined);

    expect(result.snapshot.last_preflight_errors).toHaveLength(0);
    expect(result.snapshot.codex_rate_limits).toBeNull();
    expect(result.snapshot.completed).toHaveLength(1);
  });
});
