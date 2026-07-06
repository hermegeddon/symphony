import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface GraphSyncRecurringClock {
  now(): Date;
}

export const systemGraphSyncRecurringClock: GraphSyncRecurringClock = {
  now: () => new Date(),
};

export interface GraphSyncLockPolicy {
  readonly leaseTtlMs: number;
  readonly staleLockBreakPolicy: 'manual' | 'allow_configured_break';
}

export interface GraphSyncRecurringStateConfig {
  readonly lockPath: string;
  readonly statePath: string;
  readonly clock: GraphSyncRecurringClock;
  readonly policy: GraphSyncLockPolicy;
}

export type GraphSyncRecurringLockStatus =
  | 'held'
  | 'available'
  | 'stale'
  | 'corrupt';

export interface GraphSyncRecurringLockInfo {
  readonly status: GraphSyncRecurringLockStatus;
  readonly holder: string | null;
  readonly holder_pid: number | null;
  readonly acquired_at: string | null;
  readonly expires_at: string | null;
  readonly lease_ttl_ms: number;
  readonly stale_reason: string | null;
}

export interface GraphSyncRecurringLockReceipt {
  readonly ok: boolean;
  readonly effect: 'graph_sync_recurring_lock_acquire';
  readonly acquired: boolean;
  readonly lock: GraphSyncRecurringLockInfo;
  readonly run_id: string;
  readonly requested_by: string;
  readonly requested_pid: number;
  readonly non_actions: readonly string[];
}

export interface GraphSyncRecurringStateDocument {
  readonly version: 1;
  readonly generated_by: 'symphony-ts';
  readonly last_run_id: string | null;
  readonly last_completed_at: string | null;
  readonly last_status: 'PASS' | 'REVIEW' | 'BLOCK' | null;
  readonly last_receipt_sha256: string | null;
  readonly last_generation: number;
  readonly freshness_ttl_ms: number;
}

export interface GraphSyncRecurringStateReadReceipt {
  readonly ok: boolean;
  readonly effect: 'graph_sync_recurring_state_read';
  readonly state: GraphSyncRecurringStateDocument | null;
  readonly state_path: string;
  readonly corrupt_backup_path: string | null;
  readonly generation: number;
  readonly receipt_fresh: boolean;
  readonly freshness_ttl_ms: number;
  readonly stale_reason: string | null;
  readonly run_id: string;
}

export interface GraphSyncRecurringStateWriteReceipt {
  readonly ok: boolean;
  readonly effect: 'graph_sync_recurring_state_write';
  readonly state_path: string;
  readonly previous_generation: number;
  readonly next_generation: number;
  readonly receipt_sha256: string;
  readonly run_id: string;
}

const DEFAULT_FRESHNESS_TTL_MS = 300000;
const DEFAULT_LEASE_TTL_MS = 300000;
const NON_ACTIONS = [
  'did_not_dispatch_workers_or_gateway',
  'did_not_edit_restart_or_disable_services_or_timers',
  'did_not_push_publish_deploy_or_open_pr',
] as const;

interface LockFileDocument {
  readonly holder: string;
  readonly holder_pid: number;
  readonly run_id: string;
  readonly acquired_at: string;
  readonly expires_at: string;
  readonly lease_ttl_ms: number;
}

function isLockFileDocument(value: unknown): value is LockFileDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as { readonly holder?: unknown; readonly holder_pid?: unknown; readonly run_id?: unknown; readonly acquired_at?: unknown; readonly expires_at?: unknown; readonly lease_ttl_ms?: unknown };
  return typeof record.holder === 'string'
    && typeof record.holder_pid === 'number'
    && typeof record.run_id === 'string'
    && typeof record.acquired_at === 'string'
    && typeof record.expires_at === 'string'
    && typeof record.lease_ttl_ms === 'number';
}

function emptyState(freshnessTtlMs: number): GraphSyncRecurringStateDocument {
  return {
    version: 1,
    generated_by: 'symphony-ts',
    last_run_id: null,
    last_completed_at: null,
    last_status: null,
    last_receipt_sha256: null,
    last_generation: 0,
    freshness_ttl_ms: freshnessTtlMs,
  };
}

function normalizeState(
  value: unknown,
  freshnessTtlMs: number,
): { readonly state: GraphSyncRecurringStateDocument; readonly corrupt: boolean } {
  if (!isStateDocument(value)) {
    return { state: emptyState(freshnessTtlMs), corrupt: true };
  }
  const state = value as GraphSyncRecurringStateDocument;
  return {
    state: {
      ...state,
      freshness_ttl_ms: Number.isFinite(state.freshness_ttl_ms) && state.freshness_ttl_ms > 0
        ? state.freshness_ttl_ms
        : freshnessTtlMs,
    },
    corrupt: false,
  };
}

function isStateDocument(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as { readonly version?: unknown; readonly generated_by?: unknown; readonly last_generation?: unknown };
  return record.version === 1
    && record.generated_by === 'symphony-ts'
    && typeof record.last_generation === 'number';
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface GraphSyncRecurringStateManager {
  readonly config: GraphSyncRecurringStateConfig;
  /**
   * Acquire the recurring lock. Fails closed if the lock is already held by a
   * non-stale holder. Stale locks are reported via `stale` status but are not
   * broken automatically unless the configured policy allows it and the caller
   * subsequently calls `breakStaleLock`.
   */
  acquireLock(runId: string): Promise<GraphSyncRecurringLockReceipt>;
  /**
   * Release the lock held by the given run. Safe to call when not holding the
   * lock (no-op).
   */
  releaseLock(runId: string): Promise<void>;
  /**
   * Break a stale lock if and only if the current lock info reports `stale` and
   * the configured policy is `allow_configured_break`. Returns a receipt.
   */
  breakStaleLock(runId: string): Promise<GraphSyncRecurringLockReceipt>;
  /**
   * Read the durable recurring state document with corruption backup semantics.
   */
  readState(runId: string): Promise<GraphSyncRecurringStateReadReceipt>;
  /**
   * Write the durable recurring state document atomically, bumping generation.
   */
  writeState(input: WriteStateInput): Promise<GraphSyncRecurringStateWriteReceipt>;
  /**
   * Inspect the lock without mutating it.
   */
  inspectLock(): Promise<GraphSyncRecurringLockInfo>;
}

export interface WriteStateInput {
  readonly runId: string;
  readonly status: 'PASS' | 'REVIEW' | 'BLOCK';
  readonly receiptSha256: string;
  readonly completedAt: Date;
}

export interface CreateGraphSyncRecurringStateManagerInput {
  readonly artifactRoot: string;
  readonly workflowId: string;
  readonly clock?: GraphSyncRecurringClock | undefined;
  readonly leaseTtlMs?: number | undefined;
  readonly staleLockBreakPolicy?: 'manual' | 'allow_configured_break' | undefined;
  readonly freshnessTtlMs?: number | undefined;
}

export function createGraphSyncRecurringStateManager(
  input: CreateGraphSyncRecurringStateManagerInput,
): GraphSyncRecurringStateManager {
  const clock = input.clock ?? systemGraphSyncRecurringClock;
  const leaseTtlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const freshnessTtlMs = input.freshnessTtlMs ?? DEFAULT_FRESHNESS_TTL_MS;
  const staleLockBreakPolicy = input.staleLockBreakPolicy ?? 'manual';
  const stateRoot = resolve(input.artifactRoot);
  const lockPath = join(stateRoot, 'graph-sync-recurring.lock.json');
  const statePath = join(stateRoot, 'graph-sync-recurring.state.json');
  const config: GraphSyncRecurringStateConfig = {
    lockPath,
    statePath,
    clock,
    policy: { leaseTtlMs, staleLockBreakPolicy },
  };
  return new JsonFileGraphSyncRecurringStateManager(config, freshnessTtlMs);
}

class JsonFileGraphSyncRecurringStateManager implements GraphSyncRecurringStateManager {
  public readonly config: GraphSyncRecurringStateConfig;
  private readonly freshnessTtlMs: number;

  public constructor(config: GraphSyncRecurringStateConfig, freshnessTtlMs: number) {
    this.config = config;
    this.freshnessTtlMs = freshnessTtlMs;
  }

  public acquireLock(runId: string): Promise<GraphSyncRecurringLockReceipt> {
    const requestedBy = safeIdentifier(`${String(process.pid)}:${runId}`);
    const requestedPid = process.pid;
    const now = this.config.clock.now();
    const acquiredAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.config.policy.leaseTtlMs).toISOString();
    const lockDocument: LockFileDocument = {
      holder: requestedBy,
      holder_pid: requestedPid,
      run_id: runId,
      acquired_at: acquiredAt,
      expires_at: expiresAt,
      lease_ttl_ms: this.config.policy.leaseTtlMs,
    };

    // Attempt atomic exclusive creation of the lock file. Only one process on the
    // local filesystem can succeed; the rest see EEXIST and must fail closed.
    const createResult = this.tryCreateLockFile(lockDocument);
    if (createResult === 'created') {
      return Promise.resolve({
        ok: true,
        effect: 'graph_sync_recurring_lock_acquire',
        acquired: true,
        lock: {
          status: 'held',
          holder: requestedBy,
          holder_pid: requestedPid,
          acquired_at: acquiredAt,
          expires_at: expiresAt,
          lease_ttl_ms: this.config.policy.leaseTtlMs,
          stale_reason: null,
        },
        run_id: runId,
        requested_by: requestedBy,
        requested_pid: requestedPid,
        non_actions: NON_ACTIONS,
      });
    }

    const existing = this.readLockFile();
    if (existing !== null) {
      const expiresAtExisting = new Date(existing.expires_at);
      if (expiresAtExisting > now) {
        const heldBySameProcess = existing.holder_pid === requestedPid && existing.holder === requestedBy;
        if (heldBySameProcess) {
          return Promise.resolve({
            ok: true,
            effect: 'graph_sync_recurring_lock_acquire',
            acquired: true,
            lock: {
              status: 'held',
              holder: existing.holder,
              holder_pid: existing.holder_pid,
              acquired_at: existing.acquired_at,
              expires_at: existing.expires_at,
              lease_ttl_ms: existing.lease_ttl_ms,
              stale_reason: null,
            },
            run_id: runId,
            requested_by: requestedBy,
            requested_pid: requestedPid,
            non_actions: NON_ACTIONS,
          });
        }
        return Promise.resolve({
          ok: false,
          effect: 'graph_sync_recurring_lock_acquire',
          acquired: false,
          lock: {
            status: 'held',
            holder: existing.holder,
            holder_pid: existing.holder_pid,
            acquired_at: existing.acquired_at,
            expires_at: existing.expires_at,
            lease_ttl_ms: existing.lease_ttl_ms,
            stale_reason: null,
          },
          run_id: runId,
          requested_by: requestedBy,
          requested_pid: requestedPid,
          non_actions: NON_ACTIONS,
        });
      }
      return Promise.resolve({
        ok: true,
        effect: 'graph_sync_recurring_lock_acquire',
        acquired: false,
        lock: {
          status: 'stale',
          holder: existing.holder,
          holder_pid: existing.holder_pid,
          acquired_at: existing.acquired_at,
          expires_at: existing.expires_at,
          lease_ttl_ms: existing.lease_ttl_ms,
          stale_reason: `lock expired at ${existing.expires_at}`,
        },
        run_id: runId,
        requested_by: requestedBy,
        requested_pid: requestedPid,
        non_actions: NON_ACTIONS,
      });
    }

    // The lock disappeared between the failed exclusive create and the read.
    // Fail closed rather than racing a second create attempt.
    return Promise.resolve({
      ok: false,
      effect: 'graph_sync_recurring_lock_acquire',
      acquired: false,
      lock: {
        status: 'available',
        holder: null,
        holder_pid: null,
        acquired_at: null,
        expires_at: null,
        lease_ttl_ms: this.config.policy.leaseTtlMs,
        stale_reason: null,
      },
      run_id: runId,
      requested_by: requestedBy,
      requested_pid: requestedPid,
      non_actions: NON_ACTIONS,
    });
  }

  public releaseLock(runId: string): Promise<void> {
    const existing = this.readLockFile();
    if (existing !== null && existing.run_id === runId) {
      this.removeLockFile();
    }
    return Promise.resolve();
  }

  public async breakStaleLock(runId: string): Promise<GraphSyncRecurringLockReceipt> {
    const requestedBy = safeIdentifier(`${String(process.pid)}:${runId}`);
    const requestedPid = process.pid;
    const firstRead = this.readLockFile();
    if (firstRead === null) {
      // The lock was here when we decided to break it but is gone by the time we
      // read it. Another contender won the race. Fail closed with a structured
      // stale reason so callers cannot misread this as a clean available-lock
      // outcome.
      return Promise.resolve({
        ok: false,
        effect: 'graph_sync_recurring_lock_acquire',
        acquired: false,
        lock: {
          status: 'available',
          holder: null,
          holder_pid: null,
          acquired_at: null,
          expires_at: null,
          lease_ttl_ms: this.config.policy.leaseTtlMs,
          stale_reason: 'stale lock already removed by another contender before break started',
        },
        run_id: runId,
        requested_by: requestedBy,
        requested_pid: requestedPid,
        non_actions: NON_ACTIONS,
      });
    }

    const now = this.config.clock.now();
    const expiresAt = new Date(firstRead.expires_at);
    const isStale = expiresAt <= now;
    if (this.config.policy.staleLockBreakPolicy !== 'allow_configured_break') {
      return Promise.resolve({
        ok: true,
        effect: 'graph_sync_recurring_lock_acquire',
        acquired: false,
        lock: {
          status: isStale ? 'stale' : 'held',
          holder: firstRead.holder,
          holder_pid: firstRead.holder_pid,
          acquired_at: firstRead.acquired_at,
          expires_at: firstRead.expires_at,
          lease_ttl_ms: firstRead.lease_ttl_ms,
          stale_reason: isStale ? `lock expired at ${firstRead.expires_at}` : null,
        },
        run_id: runId,
        requested_by: requestedBy,
        requested_pid: requestedPid,
        non_actions: NON_ACTIONS,
      });
    }

    if (!isStale) {
      // The lock is held by a non-stale identity. Under break policy this means
      // another contender refreshed or replaced the stale lock before we could
      // break it. Fail closed.
      return Promise.resolve({
        ok: false,
        effect: 'graph_sync_recurring_lock_acquire',
        acquired: false,
        lock: {
          status: 'held',
          holder: firstRead.holder,
          holder_pid: firstRead.holder_pid,
          acquired_at: firstRead.acquired_at,
          expires_at: firstRead.expires_at,
          lease_ttl_ms: firstRead.lease_ttl_ms,
          stale_reason: 'lock is no longer stale; another contender refreshed or replaced it',
        },
        run_id: runId,
        requested_by: requestedBy,
        requested_pid: requestedPid,
        non_actions: NON_ACTIONS,
      });
    }

    // Conditional stale-lock break: remove only if the on-disk identity still
    // matches the stale lock we observed, tolerating another contender's win.
    const breakResult = this.tryBreakStaleLock(firstRead);
    if (breakResult.kind === 'identity_changed') {
      const current = breakResult.current;
      return Promise.resolve({
        ok: false,
        effect: 'graph_sync_recurring_lock_acquire',
        acquired: false,
        lock: {
          status: current === null ? 'available' : 'held',
          holder: current?.holder ?? null,
          holder_pid: current?.holder_pid ?? null,
          acquired_at: current?.acquired_at ?? null,
          expires_at: current?.expires_at ?? null,
          lease_ttl_ms: this.config.policy.leaseTtlMs,
          stale_reason: 'observed lock identity changed before break; aborting',
        },
        run_id: runId,
        requested_by: requestedBy,
        requested_pid: requestedPid,
        non_actions: NON_ACTIONS,
      });
    }
    if (breakResult.kind === 'error') {
      return Promise.resolve({
        ok: false,
        effect: 'graph_sync_recurring_lock_acquire',
        acquired: false,
        lock: {
          status: 'held',
          holder: firstRead.holder,
          holder_pid: firstRead.holder_pid,
          acquired_at: firstRead.acquired_at,
          expires_at: firstRead.expires_at,
          lease_ttl_ms: firstRead.lease_ttl_ms,
          stale_reason: `stale-lock break failed: ${breakResult.message}`,
        },
        run_id: runId,
        requested_by: requestedBy,
        requested_pid: requestedPid,
        non_actions: NON_ACTIONS,
      });
    }

    // The stale lock is gone (by us or by another contender). Atomically create
    // a new one. If another contender already created a lock in this window,
    // fail closed with a structured receipt.
    const acquiredAt = now.toISOString();
    const nextExpiresAt = new Date(now.getTime() + this.config.policy.leaseTtlMs).toISOString();
    const lockDocument: LockFileDocument = {
      holder: requestedBy,
      holder_pid: requestedPid,
      run_id: runId,
      acquired_at: acquiredAt,
      expires_at: nextExpiresAt,
      lease_ttl_ms: this.config.policy.leaseTtlMs,
    };
    const createResult = this.tryCreateLockFile(lockDocument);
    if (createResult !== 'created') {
      const current = this.readLockFile();
      return Promise.resolve({
        ok: false,
        effect: 'graph_sync_recurring_lock_acquire',
        acquired: false,
        lock: {
          status: current === null ? 'available' : 'held',
          holder: current?.holder ?? null,
          holder_pid: current?.holder_pid ?? null,
          acquired_at: current?.acquired_at ?? null,
          expires_at: current?.expires_at ?? null,
          lease_ttl_ms: this.config.policy.leaseTtlMs,
          stale_reason: 'another contender created a lock before the break replacement',
        },
        run_id: runId,
        requested_by: requestedBy,
        requested_pid: requestedPid,
        non_actions: NON_ACTIONS,
      });
    }

    return Promise.resolve({
      ok: true,
      effect: 'graph_sync_recurring_lock_acquire',
      acquired: true,
      lock: {
        status: 'held',
        holder: requestedBy,
        holder_pid: requestedPid,
        acquired_at: acquiredAt,
        expires_at: nextExpiresAt,
        lease_ttl_ms: this.config.policy.leaseTtlMs,
        stale_reason: null,
      },
      run_id: runId,
      requested_by: requestedBy,
      requested_pid: requestedPid,
      non_actions: NON_ACTIONS,
    });
  }

  public inspectLock(): Promise<GraphSyncRecurringLockInfo> {
    const existing = this.readLockFile();
    if (existing === null) {
      return Promise.resolve({
        status: 'available',
        holder: null,
        holder_pid: null,
        acquired_at: null,
        expires_at: null,
        lease_ttl_ms: this.config.policy.leaseTtlMs,
        stale_reason: null,
      });
    }
    const now = this.config.clock.now();
    const expiresAt = new Date(existing.expires_at);
    const isStale = expiresAt <= now;
    return Promise.resolve({
      status: isStale ? 'stale' : 'held',
      holder: existing.holder,
      holder_pid: existing.holder_pid,
      acquired_at: existing.acquired_at,
      expires_at: existing.expires_at,
      lease_ttl_ms: existing.lease_ttl_ms,
      stale_reason: isStale ? `lock expired at ${existing.expires_at}` : null,
    });
  }

  public async readState(runId: string): Promise<GraphSyncRecurringStateReadReceipt> {
    mkdirSync(dirname(this.config.statePath), { recursive: true });
    let raw: string | null = null;
    if (existsSync(this.config.statePath)) {
      raw = await readFile(this.config.statePath, 'utf8');
    }
    if (raw === null) {
      const empty = emptyState(this.freshnessTtlMs);
      return {
        ok: true,
        effect: 'graph_sync_recurring_state_read',
        state: empty,
        state_path: this.config.statePath,
        corrupt_backup_path: null,
        generation: empty.last_generation,
        receipt_fresh: false,
        freshness_ttl_ms: this.freshnessTtlMs,
        stale_reason: 'no prior state',
        run_id: runId,
      };
    }

    let parsed: unknown;
    let corrupt = false;
    let backupPath: string | null = null;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = emptyState(this.freshnessTtlMs);
      corrupt = true;
    }

    const normalized = normalizeState(parsed, this.freshnessTtlMs);
    if (corrupt || normalized.corrupt) {
      backupPath = await this.backupCorruptState(raw);
    }

    const now = this.config.clock.now();
    const staleReason = stateStaleReason(normalized.state, now);
    const receiptFresh = staleReason === null;

    return {
      ok: true,
      effect: 'graph_sync_recurring_state_read',
      state: normalized.state,
      state_path: this.config.statePath,
      corrupt_backup_path: backupPath,
      generation: normalized.state.last_generation,
      receipt_fresh: receiptFresh,
      freshness_ttl_ms: this.freshnessTtlMs,
      stale_reason: staleReason,
      run_id: runId,
    };
  }

  public async writeState(input: WriteStateInput): Promise<GraphSyncRecurringStateWriteReceipt> {
    const read = await this.readState(input.runId);
    const previous = read.state ?? emptyState(this.freshnessTtlMs);
    const nextGeneration = previous.last_generation + 1;
    const nextState: GraphSyncRecurringStateDocument = {
      ...previous,
      last_run_id: input.runId,
      last_completed_at: input.completedAt.toISOString(),
      last_status: input.status,
      last_receipt_sha256: input.receiptSha256,
      last_generation: nextGeneration,
      freshness_ttl_ms: this.freshnessTtlMs,
    };
    const payload = jsonPayload(nextState);
    await writeFileAtomic(this.config.statePath, payload);
    return {
      ok: true,
      effect: 'graph_sync_recurring_state_write',
      state_path: this.config.statePath,
      previous_generation: previous.last_generation,
      next_generation: nextGeneration,
      receipt_sha256: sha256Hex(payload),
      run_id: input.runId,
    };
  }

  private readLockFile(): LockFileDocument | null {
    if (!existsSync(this.config.lockPath)) {
      return null;
    }
    try {
      const raw = readFileSync(this.config.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isLockFileDocument(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private tryCreateLockFile(document: LockFileDocument): 'created' | 'already_exists' | 'error' {
    mkdirSync(dirname(this.config.lockPath), { recursive: true });
    let fd: number | undefined;
    try {
      fd = openSync(this.config.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      const payload = jsonPayload(document);
      const buffer = Buffer.from(payload, 'utf8');
      writeSync(fd, buffer);
      return 'created';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        return 'already_exists';
      }
      return 'error';
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  private removeLockFile(): void {
    try {
      unlinkSync(this.config.lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT is a safe no-op: the file is already gone, which is the intended
      // end state. Any other error is swallowed to keep releaseLock defensive.
      if (code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Conditional stale-lock break primitive.
   *
   * Removes the lock file only if its current on-disk identity matches the
   * expected stale lock. Tolerates ENOENT (another contender already removed it)
   * and identity changes (fail closed). Never throws ENOENT.
   */
  private tryBreakStaleLock(expected: LockFileDocument):
    | { readonly kind: 'removed' }
    | { readonly kind: 'already_absent' }
    | { readonly kind: 'identity_changed'; readonly current: LockFileDocument | null }
    | { readonly kind: 'error'; readonly message: string } {
    // Open with O_RDWR to pin the inode while we verify content. If the file
    // is already gone, another contender won the race; that is a safe outcome.
    let fd: number | undefined;
    try {
      fd = openSync(this.config.lockPath, constants.O_RDWR);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { kind: 'already_absent' };
      }
      return { kind: 'error', message: `open failed: ${code ?? 'unknown'}` };
    }

    let parsed: unknown;
    try {
      const raw = readFileSync(fd, 'utf8');
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    } finally {
      closeSync(fd);
    }

    if (!isLockFileDocument(parsed) || !sameLockIdentity(expected, parsed)) {
      // The lock identity changed underneath us (or is unreadable/corrupt).
      // Fail closed without deleting anything.
      return {
        kind: 'identity_changed',
        current: isLockFileDocument(parsed) ? parsed : null,
      };
    }

    // Identity verified. Attempt removal. ENOENT here means another contender
    // removed it first; that is still a safe outcome for us to proceed to the
    // O_EXCL create step, which will then fail closed if we lost.
    try {
      unlinkSync(this.config.lockPath);
      return { kind: 'removed' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return { kind: 'already_absent' };
      }
      return { kind: 'error', message: `unlink failed: ${code ?? 'unknown'}` };
    }
  }

  private async backupCorruptState(raw: string): Promise<string> {
    const backupDir = join(dirname(this.config.statePath), 'corrupt-backups');
    mkdirSync(backupDir, { recursive: true });
    const timestamp = this.config.clock.now().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(backupDir, `state-${timestamp}.json`);
    await writeFileAtomic(backupPath, raw);
    return backupPath;
  }
}

function stateStaleReason(state: GraphSyncRecurringStateDocument, now: Date): string | null {
  if (state.last_completed_at === null) {
    return 'no prior completion';
  }
  const completedAt = new Date(state.last_completed_at);
  if (Number.isNaN(completedAt.getTime())) {
    return 'last_completed_at is not a valid timestamp';
  }
  const elapsedMs = now.getTime() - completedAt.getTime();
  if (elapsedMs >= state.freshness_ttl_ms) {
    return `last completion ${state.last_completed_at} exceeds freshness_ttl_ms ${String(state.freshness_ttl_ms)}`;
  }
  return null;
}

function jsonPayload(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${String(process.pid)}.${String(Math.random()).slice(2)}.tmp`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, '_');
}

function sameLockIdentity(a: LockFileDocument, b: LockFileDocument): boolean {
  return a.holder === b.holder
    && a.holder_pid === b.holder_pid
    && a.run_id === b.run_id
    && a.acquired_at === b.acquired_at
    && a.expires_at === b.expires_at
    && a.lease_ttl_ms === b.lease_ttl_ms;
}

export function latestCorruptBackupPath(statePath: string): string | null {
  const backupDir = join(dirname(resolve(statePath)), 'corrupt-backups');
  if (!existsSync(backupDir)) {
    return null;
  }
  const entries = readdirSync(backupDir);
  if (entries.length === 0) {
    return null;
  }
  const latest = entries
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .pop();
  if (latest === undefined) {
    return null;
  }
  return join(backupDir, latest);
}
