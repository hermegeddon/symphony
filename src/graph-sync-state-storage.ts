import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  createGraphSyncStateStorage,
  type GraphSyncState,
  type GraphSyncStateStorage,
} from './graph-sync-state.js';

export interface FileSystemGraphSyncStateStorageOptions {
  readonly statePath: string;
  /**
   * When true, all writes are suppressed. This is the default for fake/demo
   * runs and read-only snapshot capture when no explicit `--state-path` is
   * supplied. The storage still reads durable state if a file exists, but
   * never creates or renames one.
   */
  readonly dryRun: boolean;
}

export function createFileSystemGraphSyncStateStorage(
  options: FileSystemGraphSyncStateStorageOptions,
): GraphSyncStateStorage {
  const absolutePath = resolve(options.statePath);

  return createGraphSyncStateStorage({
    read: async () => {
      try {
        const raw = await readFile(absolutePath, 'utf8');
        return JSON.parse(raw) as object;
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },
    write: options.dryRun
      ? () => Promise.resolve()
      : async (state: GraphSyncState) => {
        const directory = dirname(absolutePath);
        await ensureDirectory(directory);
        const temporaryPath = `${absolutePath}.tmp`;
        await writeFile(temporaryPath, serializeGraphSyncState(state), 'utf8');
        await rename(temporaryPath, absolutePath);
      },
  });
}

export interface InMemoryGraphSyncStateStorageOptions {
  readonly initialState?: GraphSyncState | null | undefined;
}

export function createInMemoryGraphSyncStateStorage(
  options: InMemoryGraphSyncStateStorageOptions = {},
): GraphSyncStateStorage {
  let state: GraphSyncState | null = options.initialState ?? null;
  return createGraphSyncStateStorage({
    read: () => Promise.resolve(state),
    write: (next: GraphSyncState) => {
      state = next;
      return Promise.resolve();
    },
  });
}

function isFileNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return 'code' in error && (error as { code: unknown }).code === 'ENOENT';
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
  } catch {
    // The recursive option should normally not throw for an existing directory,
    // but we swallow any race-condition errors here; a subsequent writeFile will
    // surface real filesystem problems.
  }
}

function serializeGraphSyncState(state: GraphSyncState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}
