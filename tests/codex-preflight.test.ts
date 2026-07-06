import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  runCodexProtocolPreflight,
  validateCodexPreflightReceipts,
  type CodexPreflightReceipt,
  type CodexPreflightResultReceipt,
} from '../src/codex-preflight.js';
import type { CodexProtocolRequestResponseReceipt, CodexRunnerConfig } from '../src/codex-runner.js';

async function makeFakeServer(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-codex-preflight-'));
  const scriptPath = join(dir, 'fake-codex-preflight-app-server.mjs');
  await writeFile(scriptPath, script, 'utf8');
  return scriptPath;
}

const completingPreflightServer = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.env.FAKE_CODEX_LOG;
const log = (entry) => {
  if (logPath !== undefined) {
    appendFileSync(logPath, JSON.stringify(entry) + '\\n');
  }
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let threadId = 'thread_preflight';

log({ event: 'started', cwd: process.cwd(), envKeys: Object.keys(process.env).filter((key) => key.includes('CODEX') || key.includes('OPENAI')).sort() });

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  log({ event: 'client_message', message });

  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: {} } });
    return;
  }

  if (message.method === 'initialized') {
    send({ method: 'server/ready', params: { version: 'fake-preflight-v1' } });
    return;
  }

  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }

  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_preflight' }, session: { id: 'session_preflight' } } });
    send({ method: 'turn/started', params: { thread: { id: threadId }, turn: { id: 'turn_preflight' } } });
    send({ method: 'token/usage', params: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } });
    send({ method: 'turn/completed', params: { thread: { id: threadId }, turn: { id: 'turn_preflight' } } });
  }
});
`;

const approvalRequestServer = String.raw`
import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);

  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: {} } });
    return;
  }

  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread_needs_approval' } } });
    return;
  }

  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn_needs_approval' } } });
    send({ method: 'approval/request', params: { approval: { id: 'approval_1' }, reason: 'fake approval should fail closed' } });
  }
});
`;

function secretBearingPreflightServer(input: {
  readonly bearerText: string;
  readonly jwtLike: string;
  readonly privateKeyBlock: string;
  readonly protocolSessionId: string;
  readonly tokenLikeThreadId: string;
}): string {
  return `
import { createInterface } from 'node:readline';

const bearerText = ${JSON.stringify(input.bearerText)};
const jwtLike = ${JSON.stringify(input.jwtLike)};
const privateKeyBlock = ${JSON.stringify(input.privateKeyBlock)};
const protocolSessionId = ${JSON.stringify(input.protocolSessionId)};
const threadId = ${JSON.stringify(input.tokenLikeThreadId)};
const turnId = 'turn_secret_redaction';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);

  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: {} } });
    return;
  }

  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }

  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: turnId }, session: { id: protocolSessionId } } });
    send({
      method: 'rate_limit/update',
      params: {
        thread: { id: threadId },
        turn: { id: turnId },
        authorization: bearerText,
        diagnostic: jwtLike,
        pem: privateKeyBlock,
        nested: { api_key: bearerText },
      },
    });
    send({ method: 'turn/completed', params: { thread: { id: threadId }, turn: { id: turnId } } });
  }
});
`;
}

function runnerConfig(input: {
  readonly command: string;
  readonly logPath?: string;
  readonly envSecret?: string;
  readonly approvalMode?: 'auto_approve' | 'fail';
}): CodexRunnerConfig {
  return {
    codex: { command: input.command, readTimeoutMs: 1_000, turnTimeoutMs: 1_000 },
    protocol: { schemaSource: 'fake Codex app-server schema for local preflight tests' },
    approval: { mode: input.approvalMode ?? 'fail' },
    sandbox: { mode: 'workspace_write' },
    tools: { linearGraphql: { enabled: false } },
    env: {
      ...(input.logPath === undefined ? {} : { FAKE_CODEX_LOG: input.logPath }),
      ...(input.envSecret === undefined ? {} : { OPENAI_API_KEY: input.envSecret }),
    },
  };
}

function isProtocolReceipt(receipt: CodexPreflightReceipt, method: string): receipt is CodexProtocolRequestResponseReceipt {
  return receipt.kind === 'codex_protocol_request_response' && receipt.method === method;
}

function isPreflightResultReceipt(receipt: CodexPreflightReceipt): receipt is CodexPreflightResultReceipt {
  return receipt.kind === 'codex_preflight_result';
}

describe('runCodexProtocolPreflight', () => {
  it('runs a fake Codex protocol preflight and emits redacted startup, protocol, runtime, and result receipts', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-preflight-workspace-'));
    const logPath = join(workspacePath, 'fake-codex-preflight.log');
    const fakeServerPath = await makeFakeServer(completingPreflightServer);
    const secret = ['fixture', 'codex', 'secret'].join('-');
    const receipts: CodexPreflightReceipt[] = [];

    const result = await runCodexProtocolPreflight({
      workspacePath,
      runnerConfig: runnerConfig({
        command: `node ${JSON.stringify(fakeServerPath)}`,
        logPath,
        envSecret: secret,
      }),
      issue: { identifier: 'HER-1', title: 'Codex protocol preflight' },
      receiptSink: (receipt) => { receipts.push(receipt); },
    });

    expect(result).toMatchObject({
      outcome: 'pass',
      issue_identifier: 'HER-1',
      thread_id: 'thread_preflight',
      turn_count: 1,
    });
    expect(receipts.map((receipt) => receipt.kind)).toEqual(expect.arrayContaining([
      'codex_app_server_spawn',
      'codex_protocol_request_response',
      'codex_runtime_event',
      'codex_preflight_result',
    ]));

    const spawnReceipt = receipts.find((receipt) => receipt.kind === 'codex_app_server_spawn');
    expect(spawnReceipt).toMatchObject({
      kind: 'codex_app_server_spawn',
      cwd: workspacePath,
      approval: { mode: 'fail', wire_policy: 'never' },
      sandbox: { mode: 'workspace_write', wire_policy: 'workspace-write' },
    });
    expect(spawnReceipt?.env_keys).toEqual(expect.arrayContaining(['FAKE_CODEX_LOG', 'OPENAI_API_KEY']));

    const threadStartReceipt = receipts.find((receipt) => isProtocolReceipt(receipt, 'thread/start'));
    expect(threadStartReceipt?.response['outcome']).toBe('ok');
    expect(threadStartReceipt?.response['thread_id']).toBe('thread_preflight');

    const turnStartReceipt = receipts.find((receipt) => isProtocolReceipt(receipt, 'turn/start'));
    expect(turnStartReceipt?.response['outcome']).toBe('ok');
    expect(turnStartReceipt?.response['turn_id']).toBe('turn_preflight');
    expect(turnStartReceipt?.response['protocol_session_id']).toBe('session_preflight');

    expect(receipts.some((receipt) => receipt.kind === 'codex_runtime_event' && receipt.event === 'token_usage')).toBe(true);
    expect(receipts.some((receipt) => receipt.kind === 'codex_preflight_result' && receipt.outcome === 'pass')).toBe(true);

    const serializedReceipts = JSON.stringify(receipts);
    expect(serializedReceipts).not.toContain(secret);
    expect(serializedReceipts).not.toContain('Authorization: Bearer');
    expect(validateCodexPreflightReceipts(receipts)).toEqual({ ok: true, findings: [] });
  });

  it('treats synchronous and asynchronous receipt sink failures as nonfatal observability failures', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-preflight-sink-'));
    const fakeServerPath = await makeFakeServer(completingPreflightServer);
    let calls = 0;

    await expect(runCodexProtocolPreflight({
      workspacePath,
      runnerConfig: runnerConfig({ command: `node ${JSON.stringify(fakeServerPath)}` }),
      receiptSink: (receipt) => {
        calls += 1;
        if (receipt.kind === 'codex_app_server_spawn') {
          throw new Error('sync sink unavailable');
        }
        return Promise.reject(new Error('async sink unavailable'));
      },
    })).resolves.toMatchObject({ outcome: 'pass' });

    expect(calls).toBeGreaterThan(1);
  });

  it('fails closed and records a failure receipt when the app-server asks for approval while approval mode is fail', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-preflight-approval-'));
    const fakeServerPath = await makeFakeServer(approvalRequestServer);
    const receipts: CodexPreflightReceipt[] = [];

    await expect(runCodexProtocolPreflight({
      workspacePath,
      runnerConfig: runnerConfig({ command: `node ${JSON.stringify(fakeServerPath)}`, approvalMode: 'fail' }),
      receiptSink: (receipt) => { receipts.push(receipt); },
    })).rejects.toMatchObject({ code: 'approval_required' });

    const failureReceipt = receipts.filter(isPreflightResultReceipt).find((receipt) => receipt.outcome === 'fail');
    expect(failureReceipt?.error?.['code']).toBe('approval_required');
  });

  it('redacts secret-like command, protocol, runtime, and result values before receipt emission', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'symphony-preflight-redaction-'));
    const openaiKey = ['sk', 'notarealpreflightredactionfixture123456'].join('-');
    const bearerToken = 'not-a-real-preflight-bearer-token';
    const bearerText = ['Authorization: Bearer', bearerToken].join(' ');
    const jwtLike = [`eyJ${'header'.repeat(3)}`, 'payloadpayload', 'signaturesignature'].join('.');
    const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const privateKeyFooter = ['-----END', 'PRIVATE KEY-----'].join(' ');
    const privateKeyBlock = [privateKeyHeader, 'not-real-private-key-body', privateKeyFooter].join('\n');
    const protocolSessionId = ['sess', 'protocolredactionfixture123456'].join('_');
    const tokenLikeThreadId = ['sess', 'threadredactionfixture123456'].join('_');
    const fakeServerPath = await makeFakeServer(secretBearingPreflightServer({
      bearerText,
      jwtLike,
      privateKeyBlock,
      protocolSessionId,
      tokenLikeThreadId,
    }));
    const receipts: CodexPreflightReceipt[] = [];

    const result = await runCodexProtocolPreflight({
      workspacePath,
      runnerConfig: runnerConfig({ command: `node ${JSON.stringify(fakeServerPath)} --api-key ${openaiKey}` }),
      receiptSink: (receipt) => { receipts.push(receipt); },
    });

    expect(result.outcome).toBe('pass');
    const serializedReceipts = JSON.stringify(receipts);
    for (const rawSecret of [openaiKey, bearerText, bearerToken, jwtLike, privateKeyBlock, protocolSessionId, tokenLikeThreadId]) {
      expect(serializedReceipts).not.toContain(rawSecret);
    }
    expect(validateCodexPreflightReceipts(receipts)).toEqual({ ok: true, findings: [] });
  });

  it('flags secret-like text in receipt payloads before live artifacts are trusted', () => {
    const leakedBearer = ['Authorization: Bearer', 'not-a-real-token-value'].join(' ');
    const validation = validateCodexPreflightReceipts([
      {
        kind: 'codex_preflight_result',
        outcome: 'fail',
        issue_identifier: 'HER-1',
        thread_id: null,
        turn_count: 0,
        codex_app_server_pid: null,
        error: { code: 'leak', message: leakedBearer },
      },
    ]);

    expect(validation.ok).toBe(false);
    expect(validation.findings).toEqual([expect.objectContaining({ pattern: 'authorization_bearer' })]);
  });
});
