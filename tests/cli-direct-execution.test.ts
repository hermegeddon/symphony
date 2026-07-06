import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isDirectCliExecution } from '../src/cli/direct-execution.js';

describe('CLI direct execution detection', () => {
  it('matches argv paths that are symlinks to the module file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'symphony-cli-direct-'));
    const realModulePath = join(dir, 'service.js');
    const symlinkPath = join(dir, 'symphony-service');
    await writeFile(realModulePath, '#!/usr/bin/env node\n');
    await symlink(realModulePath, symlinkPath);

    expect(isDirectCliExecution(pathToFileURL(realModulePath).href, symlinkPath)).toBe(true);
  });

  it('does not match missing argv paths', () => {
    expect(isDirectCliExecution(import.meta.url, undefined)).toBe(false);
  });
});
