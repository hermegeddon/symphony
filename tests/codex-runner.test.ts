import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CodexAppServerRunner,
  renderIssuePrompt,
  runLinearGraphqlTool,
} from '../src/codex-runner.js';

interface FakeClientMessage {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

interface FakeLogLine {
  readonly event?: string;
  readonly cwd?: string;
  readonly marker?: string | null;
  readonly message?: FakeClientMessage;
}

function parseFakeLog(text: string): FakeLogLine[] {
  return text.trim().split('\n').map((line): FakeLogLine => JSON.parse(line) as unknown as FakeLogLine);
}

function hasClientMessage(line: FakeLogLine): line is FakeLogLine & { readonly message: FakeClientMessage } {
  return line.event === 'client_message' && line.message !== undefined;
}

async function makeFakeServer(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-codex-fake-'));
  const scriptPath = join(dir, 'fake-app-server.mjs');
  await writeFile(scriptPath, script, 'utf8');
  return scriptPath;
}

async function waitForFakeLogEvent(logPath: string, event: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      if (parseFakeLog(await readFile(logPath, 'utf8')).some((line) => line.event === event)) {
        return;
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fake Codex log event ${event}`);
}

const fakeJsonlServer = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.env.FAKE_CODEX_LOG;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let threadId = 'thread_fake_1';
let turnCounter = 0;

log({ event: 'started', cwd: process.cwd(), marker: process.env.SHELL_MARKER ?? null });

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  log({ event: 'client_message', message });

  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: {} } });
    return;
  }

  if (message.method === 'initialized') {
    send({ method: 'server/ready', params: { version: 'fake-jsonl-v1' } });
    return;
  }

  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }

  if (message.method === 'turn/start') {
    turnCounter += 1;
    const turnId = 'turn_fake_' + turnCounter;
    send({ id: message.id, result: { turn: { id: turnId }, session: { id: 'session_' + turnCounter } } });
    send({ method: 'turn/started', params: { thread: { id: threadId }, turn: { id: turnId } } });
    send({ method: 'token/usage', params: { usage: { input_tokens: turnCounter, output_tokens: turnCounter + 1 } } });
    send({ method: 'rate_limit/update', params: { reset_at: '2030-01-01T00:00:00Z' } });
    send({ method: 'agent/update', params: { message: 'update ' + turnCounter } });
    send({ method: 'tool/call', params: { toolCall: { id: 'tool_' + turnCounter, name: 'not_implemented', input: {} } } });
    send({ method: 'turn/completed', params: { thread: { id: threadId }, turn: { id: turnId }, usage: { total_tokens: 10 + turnCounter } } });
    return;
  }

  if (message.method === 'tool/result') {
    log({ event: 'tool_result', message });
  }
});
`;

describe('renderIssuePrompt', () => {
  it('renders issue and workflow fields into the first-turn prompt', () => {
    expect(
      renderIssuePrompt({
        template: 'Work on {{issue.identifier}}: {{issue.title}}\n{{issue.description}}\nPolicy: {{workflow.name}}',
        issue: {
          identifier: 'LIN-123',
          title: 'Fix runner',
          description: 'Use fake app-server fixtures.',
        },
        workflow: { name: 'Engineering' },
      }),
    ).toBe('Work on LIN-123: Fix runner\nUse fake app-server fixtures.\nPolicy: Engineering');
  });

  it('fails strict first-turn rendering on unknown variables instead of erasing them', () => {
    expect(() => renderIssuePrompt({
      template: 'Work on {{ issue.identifier }} with {{ workflow.missing_policy }}',
      issue: { identifier: 'LIN-123', title: 'Fix runner' },
      workflow: {},
    })).toThrow(/Unknown prompt template variable: workflow\.missing_policy/);
  });
});

describe('CodexAppServerRunner', () => {
  it('launches codex.command through bash in the issue workspace and drives first plus continuation turns over JSONL', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-workspace-'));
    const logPath = join(workspacePath, 'fake-server.log');
    const fakeServerPath = await makeFakeServer(fakeJsonlServer);
    const events: unknown[] = [];

    const runner = new CodexAppServerRunner({
      codex: {
        command: `SHELL_MARKER=from-bash node ${JSON.stringify(fakeServerPath)}`,
        readTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      },
      protocol: { schemaSource: 'fake-jsonl-v1 fixture for Codex JSONL JSON-RPC shape' },
      approval: { mode: 'auto_approve' },
      sandbox: { mode: 'workspace_write' },
      tools: { linearGraphql: { enabled: false } },
      env: { FAKE_CODEX_LOG: logPath },
    });

    const result = await runner.runIssue({
      workspacePath,
      issue: {
        identifier: 'LIN-456',
        title: 'Implement Codex runner',
        description: 'Acceptance criteria from the Kanban task.',
      },
      workflow: { name: 'Default workflow' },
      promptTemplate: 'Issue {{issue.identifier}}: {{issue.title}}\n{{issue.description}}',
      continuationGuidance: ['Continue on the same thread; do not resend the original issue prompt.'],
      onEvent: (event) => events.push(event),
    });

    expect(result.threadId).toBe('thread_fake_1');
    expect(result.turns.map((turn) => turn.turnId)).toEqual(['turn_fake_1', 'turn_fake_2']);
    expect(result.turns.map((turn) => turn.sessionId)).toEqual(['thread_fake_1-turn_fake_1', 'thread_fake_1-turn_fake_2']);
    expect(result.codexAppServerPid).toEqual(expect.any(Number));
    expect(result.protocol.schemaSource).toContain('fake-jsonl-v1');

    const logLines = parseFakeLog(await readFile(logPath, 'utf8'));
    expect(logLines).toContainEqual(expect.objectContaining({ event: 'started', cwd: workspacePath, marker: 'from-bash' }));

    const clientMessages = logLines.filter(hasClientMessage).map((line) => line.message);
    expect(clientMessages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
      'tool/result',
      'turn/start',
      'tool/result',
    ]);

    const threadStartParams = clientMessages.find((message) => message.method === 'thread/start')?.params;
    expect(threadStartParams).toMatchObject({
      cwd: workspacePath,
      title: 'LIN-456: Implement Codex runner',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    });
    expect(threadStartParams).not.toHaveProperty('sandboxPolicy');

    const turnStarts = clientMessages.filter((message) => message.method === 'turn/start');
    expect(turnStarts[0]?.params).toMatchObject({
      threadId: 'thread_fake_1',
      cwd: workspacePath,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [workspacePath] },
    });
    expect(turnStarts[0]?.params?.['input']).toEqual([
      { type: 'text', text: 'Issue LIN-456: Implement Codex runner\nAcceptance criteria from the Kanban task.' },
    ]);
    expect(turnStarts[1]?.params).toMatchObject({ threadId: 'thread_fake_1', cwd: workspacePath });
    expect(turnStarts[1]?.params?.['input']).toEqual([
      { type: 'text', text: 'Continue on the same thread; do not resend the original issue prompt.' },
    ]);

    const toolResults = clientMessages.filter((message) => message.method === 'tool/result');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]?.params?.['result']).toMatchObject({
      success: false,
      error: { code: 'unsupported_tool_call' },
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'session_started', codex_app_server_pid: result.codexAppServerPid, thread_id: 'thread_fake_1', turn_id: 'turn_fake_1', session_id: 'thread_fake_1-turn_fake_1' }),
        expect.objectContaining({ event: 'token_usage', usage: { input_tokens: 1, output_tokens: 2 } }),
        expect.objectContaining({ event: 'rate_limit_update' }),
        expect.objectContaining({ event: 'agent_update' }),
        expect.objectContaining({ event: 'unsupported_tool_call' }),
        expect.objectContaining({ event: 'turn_completed', thread_id: 'thread_fake_1', turn_id: 'turn_fake_2' }),
      ]),
    );
  });

  it('scrubs Linear service secrets from Codex child process environment while preserving explicit non-secret env', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-workspace-'));
    const logPath = join(workspacePath, 'fake-server.log');
    const fakeServerPath = await makeFakeServer(String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const logPath = process.env.FAKE_CODEX_LOG;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
log({ event: 'started', linearKeys: Object.keys(process.env).filter((key) => key.startsWith('LINEAR')), marker: process.env.SHELL_MARKER ?? null });
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_env' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_env' } } });
    send({ method: 'turn/completed', params: { thread: { id: 'thread_env' }, turn: { id: 'turn_env' } } });
  }
});
`);
    const previousToken = process.env['LINEAR_API_TOKEN'];
    process.env['LINEAR_API_TOKEN'] = 'service-token-that-must-not-leak';
    try {
      const runner = new CodexAppServerRunner({
        codex: { command: `SHELL_MARKER=visible node ${JSON.stringify(fakeServerPath)}`, readTimeoutMs: 1_000, turnTimeoutMs: 1_000 },
        protocol: { schemaSource: 'fake-jsonl-env-fixture' },
        approval: { mode: 'auto_approve' },
        sandbox: { mode: 'workspace_write' },
        tools: { linearGraphql: { enabled: false } },
        env: { FAKE_CODEX_LOG: logPath, LINEAR_API_KEY: 'override-that-must-not-leak' },
      });

      await runner.runIssue({
        workspacePath,
        issue: { identifier: 'LIN-ENV', title: 'Check env scrub' },
        workflow: { name: 'Default workflow' },
        promptTemplate: 'Issue {{issue.identifier}}: {{issue.title}}',
        continuationGuidance: [],
      });

      const logLines = parseFakeLog(await readFile(logPath, 'utf8'));
      expect(logLines[0]).toMatchObject({ event: 'started', linearKeys: [], marker: 'visible' });
    } finally {
      if (previousToken === undefined) {
        Reflect.deleteProperty(process.env, 'LINEAR_API_TOKEN');
      } else {
        process.env['LINEAR_API_TOKEN'] = previousToken;
      }
    }
  });

  it('drains pending tool results before normal shutdown', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-workspace-'));
    const logPath = join(workspacePath, 'fake-server.log');
    const fakeServerPath = await makeFakeServer(String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.env.FAKE_CODEX_LOG;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

log({ event: 'started' });

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_shutdown' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_shutdown' } } });
    send({ method: 'tool/call', params: { toolCall: { id: 'tool_shutdown', name: 'not_implemented', input: {} } } });
    send({ method: 'turn/completed', params: { thread: { id: 'thread_shutdown' }, turn: { id: 'turn_shutdown' } } });
  }
  if (message.method === 'tool/result') {
    setTimeout(() => log({ event: 'tool_result', message }), 50);
  }
});
`);

    const runner = new CodexAppServerRunner({
      codex: {
        command: `node ${JSON.stringify(fakeServerPath)}`,
        readTimeoutMs: 1_000,
        turnTimeoutMs: 1_000,
      },
      protocol: { schemaSource: 'fake-jsonl-v1 fixture for shutdown drain' },
      approval: { mode: 'auto_approve' },
      sandbox: { mode: 'workspace_write' },
      tools: { linearGraphql: { enabled: false } },
      env: { FAKE_CODEX_LOG: logPath },
    });

    await runner.runIssue({
      workspacePath,
      issue: { identifier: 'LIN-789', title: 'Drain shutdown', description: 'Wait for pending tool result.' },
      workflow: {},
      promptTemplate: 'Issue {{issue.identifier}}: {{issue.title}}',
    });

    const drainedToolResult = parseFakeLog(await readFile(logPath, 'utf8')).find((line) => line.event === 'tool_result');
    expect(drainedToolResult?.message?.method).toBe('tool/result');
  });

  it('fails user-input-required signals instead of waiting indefinitely', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-workspace-'));
    const logPath = join(workspacePath, 'fake-server.log');
    const fakeServerPath = await makeFakeServer(String.raw`
import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_input' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_input' } } });
    send({ method: 'turn/input_required', params: { message: 'Need a human decision.' } });
  }
});
`);

    const runner = new CodexAppServerRunner({
      codex: { command: `node ${JSON.stringify(fakeServerPath)}`, readTimeoutMs: 1_000, turnTimeoutMs: 1_000 },
      protocol: { schemaSource: 'fake-jsonl-v1 fixture' },
      approval: { mode: 'auto_approve' },
      sandbox: { mode: 'workspace_write' },
      tools: { linearGraphql: { enabled: false } },
      env: { FAKE_CODEX_LOG: logPath },
    });

    await expect(
      runner.runIssue({
        workspacePath,
        issue: { identifier: 'LIN-789', title: 'Needs input' },
        workflow: {},
        promptTemplate: '{{issue.title}}',
      }),
    ).rejects.toMatchObject({ code: 'turn_input_required' });
  });

  it('captures a bounded redacted stderr tail when the app-server times out before initialize', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-workspace-stderr-'));
    const fakeServerPath = await makeFakeServer(String.raw`
process.stderr.write('startup diagnostic before padding\n');
process.stderr.write('x'.repeat(6000));
process.stderr.write('\nfinal diagnostic API_KEY=x123\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);
    const runner = new CodexAppServerRunner({
      codex: { command: `node ${JSON.stringify(fakeServerPath)}`, readTimeoutMs: 500, turnTimeoutMs: 1_000 },
      protocol: { schemaSource: 'fake-jsonl-stderr-fixture' },
      approval: { mode: 'auto_approve' },
      sandbox: { mode: 'workspace_write' },
      tools: { linearGraphql: { enabled: false } },
    });

    let caught: unknown;
    try {
      await runner.runIssue({
        workspacePath,
        issue: { identifier: 'LIN-ERR', title: 'Capture stderr' },
        workflow: {},
        promptTemplate: '{{issue.title}}',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'response_timeout' });
    const details = (caught as { readonly details?: Record<string, unknown> }).details;
    expect(details?.['stderr_truncated']).toBe(true);
    expect(details?.['stderr_tail']).toEqual(expect.stringContaining('final diagnostic'));
    expect(details?.['stderr_tail']).toEqual(expect.stringContaining('[REDACTED]'));
    expect(details?.['stderr_tail']).not.toEqual(expect.stringContaining('x123'));
    expect(String(details?.['stderr_tail']).length).toBeLessThanOrEqual(4096);
  });

  it('does not leak a prefix-truncated secret-like stderr line', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-workspace-stderr-secret-'));
    const fakeServerPath = await makeFakeServer(String.raw`
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', () => {
  process.stderr.write('API_KEY=' + 'z'.repeat(6000));
});
`);
    const runner = new CodexAppServerRunner({
      codex: { command: `node ${JSON.stringify(fakeServerPath)}`, readTimeoutMs: 1_000, turnTimeoutMs: 1_000 },
      protocol: { schemaSource: 'fake-jsonl-stderr-prefix-truncation-fixture' },
      approval: { mode: 'auto_approve' },
      sandbox: { mode: 'workspace_write' },
      tools: { linearGraphql: { enabled: false } },
    });

    let caught: unknown;
    try {
      await runner.runIssue({
        workspacePath,
        issue: { identifier: 'LIN-SEC', title: 'Capture safe stderr' },
        workflow: {},
        promptTemplate: '{{issue.title}}',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'response_timeout' });
    const details = (caught as { readonly details?: Record<string, unknown> }).details;
    expect(details?.['stderr_truncated']).toBe(true);
    expect(details?.['stderr_tail']).toEqual(expect.stringContaining('truncated line'));
    expect(details?.['stderr_tail']).not.toEqual(expect.stringContaining('zzzzzzzzzzzz'));
    expect(String(details?.['stderr_tail']).length).toBeLessThanOrEqual(4096);
  });

  it('terminates the app-server subprocess when the run signal is aborted', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-workspace-abort-'));
    const logPath = join(workspacePath, 'fake-server.log');
    const childServerPath = await makeFakeServer(String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const logPath = process.env.FAKE_CODEX_LOG;
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
process.on('SIGTERM', () => {
  log({ event: 'child_sigterm' });
  process.exit(0);
});
log({ event: 'child_ready' });
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread_abort' } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_abort' } } });
    send({ method: 'turn/started', params: { thread: { id: 'thread_abort' }, turn: { id: 'turn_abort' } } });
  }
});
`);
    const fakeServerPath = await makeFakeServer(String.raw`
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.env.FAKE_CODEX_CHILD], { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
`);
    const controller = new AbortController();
    const runner = new CodexAppServerRunner({
      codex: { command: `node ${JSON.stringify(fakeServerPath)}`, readTimeoutMs: 1_000, turnTimeoutMs: 10_000 },
      protocol: { schemaSource: 'fake-jsonl-v1 fixture' },
      approval: { mode: 'auto_approve' },
      sandbox: { mode: 'workspace_write' },
      tools: { linearGraphql: { enabled: false } },
      env: { FAKE_CODEX_LOG: logPath, FAKE_CODEX_CHILD: childServerPath },
    });

    const completion = runner.runIssue({
      workspacePath,
      issue: { identifier: 'LIN-999', title: 'Cancel me' },
      workflow: {},
      promptTemplate: '{{issue.title}}',
      signal: controller.signal,
    });

    await waitForFakeLogEvent(logPath, 'child_ready');
    controller.abort('reconciled-away');

    await expect(completion).rejects.toMatchObject({ code: 'run_cancelled' });
    await waitForFakeLogEvent(logPath, 'child_sigterm');
    expect(parseFakeLog(await readFile(logPath, 'utf8'))).toContainEqual({ event: 'child_sigterm' });
  });
});

describe('runLinearGraphqlTool', () => {
  it('keeps tracker auth outside tool input and returns structured GraphQL outcomes', async () => {
    const calls: { endpoint: string; token: string; body: unknown }[] = [];

    const result = await runLinearGraphqlTool({
      input: { query: 'query Viewer { viewer { id } }', variables: { include: true } },
      tracker: { kind: 'linear', endpoint: 'https://linear.example/graphql', token: 'lin_secret_token' },
      fetchGraphql: (endpoint, token, body) => {
        calls.push({ endpoint, token, body });
        return Promise.resolve({ data: { viewer: { id: 'viewer_1' } } });
      },
    });

    expect(result).toEqual({ success: true, response: { data: { viewer: { id: 'viewer_1' } } } });
    expect(calls).toEqual([
      {
        endpoint: 'https://linear.example/graphql',
        token: 'lin_secret_token',
        body: { query: 'query Viewer { viewer { id } }', variables: { include: true } },
      },
    ]);
  });

  it('accepts anonymous GraphQL query shorthand as a single operation', async () => {
    const result = await runLinearGraphqlTool({
      input: '{ viewer { id } }',
      tracker: { kind: 'linear', endpoint: 'https://linear.example/graphql', token: 'lin_secret_token' },
      fetchGraphql: (_endpoint, _token, body) => Promise.resolve({ data: { echoedQuery: body.query } }),
    });

    expect(result).toEqual({ success: true, response: { data: { echoedQuery: '{ viewer { id } }' } } });
  });

  it('uses the configured Linear auth header value without adding a bearer prefix', async () => {
    const originalFetch = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const observedUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      calls.push({ url: observedUrl, init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    };

    try {
      const result = await runLinearGraphqlTool({
        input: 'query Viewer { viewer { id } }',
        tracker: { kind: 'linear', endpoint: 'https://linear.example/graphql', token: 'lin_secret_token' },
      });

      expect(result).toEqual({ success: true, response: { data: { ok: true } } });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init.headers).toMatchObject({
        authorization: 'lin_secret_token',
        'content-type': 'application/json',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects missing auth and multiple GraphQL operations as tool failures', async () => {
    await expect(
      runLinearGraphqlTool({
        input: { query: 'query A { viewer { id } } query B { organization { id } }' },
        tracker: { kind: 'linear', endpoint: 'https://linear.example/graphql', token: 'lin_secret_token' },
        fetchGraphql: () => Promise.resolve({ data: {} }),
      }),
    ).resolves.toMatchObject({ success: false, error: { code: 'invalid_input' } });

    await expect(
      runLinearGraphqlTool({
        input: 'query Viewer { viewer { id } }',
        tracker: { kind: 'linear', endpoint: 'https://linear.example/graphql' },
        fetchGraphql: () => Promise.resolve({ data: {} }),
      }),
    ).resolves.toMatchObject({ success: false, error: { code: 'missing_auth' } });
  });
});
