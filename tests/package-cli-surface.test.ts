import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

describe('package CLI surface', () => {
  it('exposes the local service CLI as symphony-service', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      readonly name?: string;
      readonly license?: string;
      readonly private?: boolean;
      readonly bin?: Record<string, string>;
      readonly description?: string;
      readonly files?: readonly string[];
    };

    expect(packageJson.name).toBe('@hermegeddon/symphony-ts');
    expect(packageJson.license).toBe('Apache-2.0');
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.bin?.['symphony-service']).toBe('dist/src/cli/service.js');
    expect(packageJson.bin?.['symphony-kanban-canary']).toBe('dist/src/cli/kanban-canary.js');
    expect(packageJson.bin?.['symphony-linear-kanban-bridge']).toBe('dist/src/cli/linear-kanban-bridge.js');
    expect(packageJson.bin?.['symphony-graph-sync-diff']).toBe('dist/src/cli/graph-sync-readonly-diff.js');
    expect(packageJson.bin?.['symphony-graph-sync-snapshot']).toBe('dist/src/cli/graph-sync-snapshot.js');
    expect(packageJson.bin?.['symphony-graph-sync-status']).toBe('dist/src/cli/graph-sync-status.js');
    expect(packageJson.bin?.['symphony-linear-kanban-graph-sync-tick']).toBe('dist/src/cli/linear-kanban-graph-sync-tick.js');
    expect(packageJson.bin?.['symphony-graph-sync-materialize-kanban']).toBe('dist/src/cli/graph-sync-materialize-kanban.js');
    expect(packageJson.bin?.['symphony-graph-sync-materialize-linear']).toBe('dist/src/cli/graph-sync-materialize-linear.js');
    expect(packageJson.description).toBe('Local-first TypeScript implementation of the OpenAI Symphony service specification.');
    expect(packageJson.files).toContain('CHANGELOG.md');
    expect(packageJson.files).toContain('LICENSE');
    expect(packageJson.files).not.toContain('docs/**/*.md');
  });

  it('keeps the actual npm packlist public-safe', async () => {
    const { stdout } = await execFileAsync(npmCommand(), ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    });
    const [pack] = JSON.parse(stdout) as [{ readonly files: readonly { readonly path: string }[] }];
    const paths = pack.files.map((file) => file.path);

    expect(paths).toContain('README.md');
    expect(paths).toContain('CHANGELOG.md');
    expect(paths).toContain('LICENSE');
    expect(paths).toContain('dist/src/cli/kanban-canary.js');
    expect(paths).toContain('dist/src/cli/linear-kanban-bridge.js');
    expect(paths).toContain('dist/src/cli/graph-sync-readonly-diff.js');
    expect(paths).toContain('dist/src/cli/graph-sync-materialize-kanban.js');
    expect(paths).toContain('dist/src/cli/graph-sync-materialize-linear.js');
    expect(paths).toContain('dist/src/kanban-canary-operator.js');
    expect(paths).toContain('examples/graph-sync-readonly-diff/matched-edge.snapshot.json');
    expect(paths).toContain('examples/graph-sync-readonly-diff/missing-kanban-edge.snapshot.json');
    expect(paths).toContain('examples/graph-sync-readonly-diff/unmapped-kanban-endpoint.snapshot.json');
    expect(paths.some((path) => path.startsWith('docs/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('dist/tests/'))).toBe(false);

    const privateOperatorSurface = new RegExp([
      ['HER', '-123'].join(''),
      ['HER', '-1'].join(''),
      ['HER', '-3'].join(''),
      ['Janusz', ' authorized'].join(''),
      String.raw`(?:^|[~/])\.hermes(?:[/]|$)`,
      ['\\/', 'home', '\\/', 'openclaw'].join(''),
      ['Open', 'Pass'].join(''),
      ['LINEAR', '_API', '_TOKEN'].join(''),
      ['linear\\.app', '\\/', 'hermegeddon'].join(''),
      ['docs', '\\/', 'live-autonomy'].join(''),
      ['docs', '\\/', 'her-'].join(''),
    ].join('|'));
    for (const path of paths) {
      if (!/\.(?:js|d\.ts|json|md|txt|yml|yaml|map)$/.test(path) && path !== 'LICENSE') {
        continue;
      }
      const text = await readFile(path, 'utf8');
      expect(text, path).not.toMatch(privateOperatorSurface);
    }
  });
});
