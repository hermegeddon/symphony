import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createGraphSyncRecurringStateManager,
  latestCorruptBackupPath,
  systemGraphSyncRecurringClock,
  type GraphSyncRecurringClock,
} from '../src/graph-sync-recurring-state.js';

type TestClock = GraphSyncRecurringClock & { advance(ms: number): void };

function fixedClock(at: Date): TestClock {
  let current = new Date(at.getTime());
  return {
    now: () => new Date(current.getTime()),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

async function tempArtifactRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'symphony-gs-state-'));
}

describe('GraphSync recurring state manager', () => {
  it('acquires, holds, and releases a lock with lease TTL', async () => {
    const root = await tempArtifactRoot();
    const clock = fixedClock(new Date('2026-07-02T10:00:00.000Z'));
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock,
      leaseTtlMs: 300000,
    });

    const first = await manager.acquireLock('run-1');
    expect(first.acquired).toBe(true);
    expect(first.ok).toBe(true);
    expect(first.lock.status).toBe('held');
    expect(first.lock.expires_at).toBe('2026-07-02T10:05:00.000Z');
    expect(first.non_actions).toContain('did_not_dispatch_workers_or_gateway');

    // Re-acquiring with the same process/run id within the lease returns ok:true, acquired:true.
    const reacquire = await manager.acquireLock('run-1');
    expect(reacquire.acquired).toBe(true);
    expect(reacquire.ok).toBe(true);
    expect(reacquire.lock.status).toBe('held');

    // A different run id with the same manager must fail closed while the lock is valid.
    const second = await manager.acquireLock('run-2');
    expect(second.acquired).toBe(false);
    expect(second.ok).toBe(false);
    expect(second.lock.status).toBe('held');
    expect(second.lock.holder).toBe(first.lock.holder);

    await manager.releaseLock('run-1');
    const after = await manager.inspectLock();
    expect(after.status).toBe('available');
  });

  it('reports a stale lock after lease TTL expires but does not break it under manual policy', async () => {
    const start = new Date('2026-07-02T10:00:00.000Z');
    const clock = fixedClock(start);
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock,
      leaseTtlMs: 300000,
      staleLockBreakPolicy: 'manual',
    });

    await manager.acquireLock('run-1');
    clock.advance(301000);

    const inspect = await manager.inspectLock();
    expect(inspect.status).toBe('stale');
    expect(inspect.stale_reason).toContain('2026-07-02T10:05:00.000Z');

    const attempt = await manager.acquireLock('run-2');
    expect(attempt.acquired).toBe(false);
    expect(attempt.ok).toBe(true);
    expect(attempt.lock.status).toBe('stale');

    const broke = await manager.breakStaleLock('run-2');
    expect(broke.acquired).toBe(false);
    expect(broke.lock.status).toBe('stale');
    expect(broke.lock.holder).toBe(inspect.holder);
  });

  it('breaks a stale lock when configured to allow configured break', async () => {
    const start = new Date('2026-07-02T10:00:00.000Z');
    const clock = fixedClock(start);
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock,
      leaseTtlMs: 300000,
      staleLockBreakPolicy: 'allow_configured_break',
    });

    await manager.acquireLock('run-1');
    clock.advance(301000);

    const broke = await manager.breakStaleLock('run-2');
    expect(broke.acquired).toBe(true);
    expect(broke.lock.status).toBe('held');
    expect(broke.lock.holder).toContain('run-2');
  });

  it('fail-closes breakStaleLock when the stale lock is already gone', async () => {
    const start = new Date('2026-07-02T10:00:00.000Z');
    const clock = fixedClock(start);
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock,
      leaseTtlMs: 300000,
      staleLockBreakPolicy: 'allow_configured_break',
    });

    await manager.acquireLock('run-1');
    clock.advance(301000);
    expect((await manager.inspectLock()).status).toBe('stale');

    // A helper process wins the race by breaking/removing the stale lock first.
    const sourceUrl = import.meta.resolve('../src/graph-sync-recurring-state.ts');
    const winnerScript = `
      const { createGraphSyncRecurringStateManager } = await import('${sourceUrl}');
      const manager = createGraphSyncRecurringStateManager({
        artifactRoot: process.env.ARTIFACT_ROOT,
        workflowId: 'wf-1',
        leaseTtlMs: 300000,
        staleLockBreakPolicy: 'allow_configured_break',
      });
      const receipt = await manager.breakStaleLock(process.env.RUN_ID);
      console.log(JSON.stringify({ acquired: receipt.acquired, ok: receipt.ok, holder: receipt.lock.holder }));
      if (receipt.acquired) {
        await manager.releaseLock(process.env.RUN_ID);
      }
    `;

    const winner = await runNodeScript(winnerScript, { ARTIFACT_ROOT: root, RUN_ID: 'run-winner' });
    const winnerResult = JSON.parse(winner.trim().split('\n').pop() ?? '{}') as { acquired: boolean; ok: boolean; holder: string | null };
    expect(winnerResult.acquired).toBe(true);
    expect(winnerResult.ok).toBe(true);

    // The original manager's breakStaleLock call now races against a gone lock.
    const loser = await manager.breakStaleLock('run-1');
    expect(loser.acquired).toBe(false);
    expect(loser.ok).toBe(false);
    expect(loser.lock.status).toBe('available');
    expect(loser.lock.stale_reason).toMatch(/stale lock already removed/);
    expect(loser.lock.stale_reason).not.toBeNull();
  });

  it('reads state with freshness TTL and stale reasons included in the receipt', async () => {
    const start = new Date('2026-07-02T10:00:00.000Z');
    const clock = fixedClock(start);
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock,
      freshnessTtlMs: 300000,
    });

    const readBefore = await manager.readState('run-1');
    expect(readBefore.ok).toBe(true);
    expect(readBefore.state?.last_generation).toBe(0);
    expect(readBefore.receipt_fresh).toBe(false);
    expect(readBefore.stale_reason).toBe('no prior state');
    expect(readBefore.freshness_ttl_ms).toBe(300000);

    await manager.writeState({
      runId: 'run-1',
      status: 'PASS',
      receiptSha256: 'deadbeef',
      completedAt: start,
    });

    const readFresh = await manager.readState('run-2');
    expect(readFresh.receipt_fresh).toBe(true);
    expect(readFresh.stale_reason).toBeNull();
    expect(readFresh.freshness_ttl_ms).toBe(300000);
    expect(readFresh.generation).toBe(1);

    clock.advance(301000);
    const readStale = await manager.readState('run-3');
    expect(readStale.receipt_fresh).toBe(false);
    expect(readStale.stale_reason).toContain('exceeds freshness_ttl_ms');
    expect(readStale.generation).toBe(1);
  });

  it('backs up and reports corrupt state instead of silently overwriting', async () => {
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock: systemGraphSyncRecurringClock,
      freshnessTtlMs: 300000,
    });

    const statePath = join(root, 'graph-sync-recurring.state.json');
    await writeFile(statePath, 'this is not json', 'utf8');

    const read = await manager.readState('run-1');
    expect(read.ok).toBe(true);
    expect(read.state?.last_generation).toBe(0);
    expect(read.corrupt_backup_path).not.toBeNull();
    expect(await readFile(read.corrupt_backup_path ?? '', 'utf8')).toBe('this is not json');
    expect(latestCorruptBackupPath(statePath)).toBe(read.corrupt_backup_path);
    expect(read.receipt_fresh).toBe(false);
    expect(read.stale_reason).toBe('no prior completion');
  });

  it('backs up and reports corrupt state with schema-valid but wrong generated_by', async () => {
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock: systemGraphSyncRecurringClock,
      freshnessTtlMs: 300000,
    });

    const statePath = join(root, 'graph-sync-recurring.state.json');
    await writeFile(statePath, JSON.stringify({ version: 1, generated_by: 'other', last_generation: 0 }), 'utf8');

    const read = await manager.readState('run-1');
    expect(read.ok).toBe(true);
    expect(read.state?.generated_by).toBe('symphony-ts');
    expect(read.corrupt_backup_path).not.toBeNull();
    expect(read.receipt_fresh).toBe(false);
    expect(read.stale_reason).toBe('no prior completion');
  });

  it('writes state preserving receipt hash and generation', async () => {
    const start = new Date('2026-07-02T10:00:00.000Z');
    const clock = fixedClock(start);
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock,
      freshnessTtlMs: 300000,
    });

    const write = await manager.writeState({
      runId: 'run-1',
      status: 'PASS',
      receiptSha256: 'deadbeef',
      completedAt: start,
    });
    expect(write.ok).toBe(true);
    expect(write.previous_generation).toBe(0);
    expect(write.next_generation).toBe(1);
    expect(write.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);

    const read = await manager.readState('run-2');
    expect(read.ok).toBe(true);
    expect(read.state?.last_run_id).toBe('run-1');
    expect(read.state?.last_status).toBe('PASS');
    expect(read.state?.last_receipt_sha256).toBe('deadbeef');
    expect(read.state?.last_generation).toBe(1);
    expect(read.generation).toBe(1);
    expect(read.receipt_fresh).toBe(true);
    expect(read.stale_reason).toBeNull();
  });

  it('reports stale receipt when state exceeds freshness TTL', async () => {
    const start = new Date('2026-07-02T10:00:00.000Z');
    const clock = fixedClock(start);
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock,
      freshnessTtlMs: 300000,
    });

    await manager.writeState({
      runId: 'run-1',
      status: 'PASS',
      receiptSha256: 'deadbeef',
      completedAt: start,
    });

    clock.advance(301000);
    const read = await manager.readState('run-2');
    expect(read.receipt_fresh).toBe(false);
    expect(read.stale_reason).toContain('exceeds freshness_ttl_ms');
  });

  it('returns available lock info when no lock exists', async () => {
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
    });

    const info = await manager.inspectLock();
    expect(info.status).toBe('available');
    expect(info.holder).toBeNull();
    expect(info.expires_at).toBeNull();
  });

  it('creates lock and state paths under the artifact root distinct from each other', async () => {
    const root = await tempArtifactRoot();
    createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
    });

    expect((await import('node:fs')).existsSync(join(root, 'graph-sync-recurring.lock.json'))).toBe(false);
    expect((await import('node:fs')).existsSync(join(root, 'graph-sync-recurring.state.json'))).toBe(false);
  });

  it('only one of two independent processes can acquire a fresh lock', async () => {
    const root = await tempArtifactRoot();
    const sourceUrl = import.meta.resolve('../src/graph-sync-recurring-state.ts');

    // Spawn two independent Node processes that both race to acquire the lock.
    const script = `
      const { createGraphSyncRecurringStateManager } = await import('${sourceUrl}');
      const manager = createGraphSyncRecurringStateManager({
        artifactRoot: process.env.ARTIFACT_ROOT,
        workflowId: 'wf-race',
      });
      const receipt = await manager.acquireLock(process.env.RUN_ID);
      console.log(JSON.stringify({ acquired: receipt.acquired, holder: receipt.lock.holder, pid: receipt.requested_pid }));
      if (receipt.acquired) {
        // Hold the lock long enough for the other contender to observe it.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await manager.releaseLock(process.env.RUN_ID);
      }
    `;

    const childA = runNodeScript(script, { ARTIFACT_ROOT: root, RUN_ID: 'run-a' });
    const childB = runNodeScript(script, { ARTIFACT_ROOT: root, RUN_ID: 'run-b' });

    const [outA, outB] = await Promise.all([childA, childB]);
    const resultA = JSON.parse(outA.trim().split('\n').pop() ?? '{}') as { acquired: boolean; holder: string | null; pid: number };
    const resultB = JSON.parse(outB.trim().split('\n').pop() ?? '{}') as { acquired: boolean; holder: string | null; pid: number };

    const winners = [resultA, resultB].filter((r) => r.acquired);
    expect(winners.length).toBeLessThanOrEqual(1);
    expect(winners.length).toBe(1);
    expect(resultA.pid).not.toBe(resultB.pid);
  });

  it('only one of two independent processes can break a stale lock', async () => {
    const start = new Date('2026-07-02T10:00:00.000Z');
    const clock = fixedClock(start);
    const root = await tempArtifactRoot();
    const manager = createGraphSyncRecurringStateManager({
      artifactRoot: root,
      workflowId: 'wf-1',
      clock,
      leaseTtlMs: 300000,
      staleLockBreakPolicy: 'allow_configured_break',
    });

    await manager.acquireLock('run-1');
    clock.advance(301000);
    expect((await manager.inspectLock()).status).toBe('stale');

    const sourceUrl = import.meta.resolve('../src/graph-sync-recurring-state.ts');
    const script = `
      const { createGraphSyncRecurringStateManager } = await import('${sourceUrl}');
      const manager = createGraphSyncRecurringStateManager({
        artifactRoot: process.env.ARTIFACT_ROOT,
        workflowId: 'wf-1',
        leaseTtlMs: 300000,
        staleLockBreakPolicy: 'allow_configured_break',
      });
      const receipt = await manager.breakStaleLock(process.env.RUN_ID);
      console.log(JSON.stringify({
        acquired: receipt.acquired,
        holder: receipt.lock.holder,
        pid: receipt.requested_pid,
        ok: receipt.ok,
        stale_reason: receipt.lock.stale_reason,
        status: receipt.lock.status,
      }));
      if (receipt.acquired) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await manager.releaseLock(process.env.RUN_ID);
      }
    `;

    const childA = runNodeScript(script, { ARTIFACT_ROOT: root, RUN_ID: 'run-a' });
    const childB = runNodeScript(script, { ARTIFACT_ROOT: root, RUN_ID: 'run-b' });

    const [outA, outB] = await Promise.all([childA, childB]);
    const resultA = JSON.parse(outA.trim().split('\n').pop() ?? '{}') as { acquired: boolean; holder: string | null; pid: number; ok: boolean; stale_reason: string | null; status: string };
    const resultB = JSON.parse(outB.trim().split('\n').pop() ?? '{}') as { acquired: boolean; holder: string | null; pid: number; ok: boolean; stale_reason: string | null; status: string };

    const winners = [resultA, resultB].filter((r) => r.acquired);
    expect(winners.length).toBeLessThanOrEqual(1);
    expect(winners.length).toBe(1);

    const loser = [resultA, resultB].find((r) => !r.acquired);
    expect(loser).toBeDefined();
    expect(loser?.ok).toBe(false);
    expect(loser?.acquired).toBe(false);
    expect(loser?.stale_reason).not.toBeNull();
    expect(loser?.stale_reason).toMatch(/another contender/);
    // The current lock status at receipt time may be 'held' (winner still holds)
    // or 'available' (winner already released); both are valid fail-closed
    // outcomes. The important invariant is that the loser did not acquire.
    expect(loser?.status).toMatch(/held|available/);
  });
});

function runNodeScript(script: string, env: { readonly ARTIFACT_ROOT: string; readonly RUN_ID: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => {
      const child = execFile(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        { cwd: process.cwd(), env: { ...process.env, ...env } },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
          } else {
            resolve(stdout);
          }
        },
      );
      child.on('error', reject);
    }).catch(reject);
  });
}
