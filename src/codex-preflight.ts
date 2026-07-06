import {
  CodexAppServerRunner,
  CodexRunnerError,
  type CodexRunnerConfig,
  type CodexRunnerReceipt,
  type CodexRunnerReceiptSink,
  type CodexRuntimeEvent,
  type JsonObject,
  type JsonValue,
  type SymphonyIssue,
  type WorkflowVariables,
} from './codex-runner.js';

export type CodexPreflightReceipt = CodexRunnerReceipt | CodexPreflightRuntimeEventReceipt | CodexPreflightResultReceipt;

export type CodexPreflightReceiptSink = (receipt: CodexPreflightReceipt) => void | Promise<void>;

export interface RunCodexProtocolPreflightInput {
  readonly workspacePath: string;
  readonly runnerConfig: CodexRunnerConfig;
  readonly issue?: SymphonyIssue;
  readonly workflow?: WorkflowVariables;
  readonly promptTemplate?: string;
  readonly signal?: AbortSignal;
  readonly receiptSink?: CodexPreflightReceiptSink;
}

export interface CodexPreflightRuntimeEventReceipt {
  readonly kind: 'codex_runtime_event';
  readonly event: string;
  readonly timestamp: string;
  readonly codex_app_server_pid?: number;
  readonly thread_id?: string;
  readonly turn_id?: string;
  readonly session_id?: string;
  readonly usage?: JsonObject;
  readonly payload?: JsonValue;
}

export interface CodexPreflightResultReceipt {
  readonly kind: 'codex_preflight_result';
  readonly outcome: 'pass' | 'fail';
  readonly issue_identifier: string;
  readonly thread_id: string | null;
  readonly turn_count: number;
  readonly codex_app_server_pid: number | null;
  readonly protocol?: {
    readonly schema_source: string;
    readonly transport: 'stdio-jsonl-json-rpc-without-jsonrpc-header';
  };
  readonly error?: JsonObject;
}

export interface CodexPreflightReceiptFinding {
  readonly pattern: string;
}

export interface CodexPreflightReceiptValidation {
  readonly ok: boolean;
  readonly findings: readonly CodexPreflightReceiptFinding[];
}

const DEFAULT_PREFLIGHT_ISSUE: SymphonyIssue = {
  identifier: 'PREFLIGHT-0',
  title: 'Codex auth/protocol preflight',
  description: 'Synthetic preflight issue. Do not modify files, push, deploy, or mutate external systems.',
};

const DEFAULT_PREFLIGHT_PROMPT = [
  'Symphony Codex preflight only.',
  'Do not modify files, push commits, deploy, call external tools, or mutate trackers.',
  'Return a concise readiness acknowledgement if the app-server protocol is available.',
].join(' ');

const SECRET_LIKE_PATTERNS: Readonly<Record<string, RegExp>> = {
  authorization_bearer: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  openai_secret_key: /\bsk-[A-Za-z0-9_-]{16,}\b/,
  codex_session_token: /\bsess_[A-Za-z0-9_-]{12,}\b/,
  linear_token: /\blin_(?:api|oauth)_[A-Za-z0-9_-]{8,}\b/,
  jwt_like: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  private_key: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
};

export async function runCodexProtocolPreflight(input: RunCodexProtocolPreflightInput): Promise<CodexPreflightResultReceipt> {
  const issue = input.issue ?? DEFAULT_PREFLIGHT_ISSUE;
  const workflow = input.workflow ?? { preflight: true };
  const promptTemplate = input.promptTemplate ?? DEFAULT_PREFLIGHT_PROMPT;
  const emit = (receipt: CodexPreflightReceipt): void => {
    invokeReceiptSink(input.receiptSink, receipt);
  };
  const existingRunnerReceiptSink = input.runnerConfig.receiptSink;
  const runnerReceiptSink: CodexRunnerReceiptSink = (receipt) => {
    emit(receipt);
    invokeReceiptSink(existingRunnerReceiptSink, receipt);
  };
  const runner = new CodexAppServerRunner({ ...input.runnerConfig, receiptSink: runnerReceiptSink });

  try {
    const run = await runner.runIssue({
      workspacePath: input.workspacePath,
      issue,
      workflow,
      promptTemplate,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onEvent: (event) => {
        emit(runtimeEventReceipt(event));
      },
    });
    const result: CodexPreflightResultReceipt = {
      kind: 'codex_preflight_result',
      outcome: 'pass',
      issue_identifier: issue.identifier,
      thread_id: redactForReceiptText(run.threadId),
      turn_count: run.turns.length,
      codex_app_server_pid: run.codexAppServerPid,
      protocol: {
        schema_source: run.protocol.schemaSource,
        transport: run.protocol.transport,
      },
    };
    emit(result);
    return result;
  } catch (error) {
    const result: CodexPreflightResultReceipt = {
      kind: 'codex_preflight_result',
      outcome: 'fail',
      issue_identifier: issue.identifier,
      thread_id: null,
      turn_count: 0,
      codex_app_server_pid: null,
      error: serializePreflightError(error),
    };
    emit(result);
    throw error;
  }
}

export function validateCodexPreflightReceipts(receipts: readonly unknown[]): CodexPreflightReceiptValidation {
  const serialized = JSON.stringify(receipts);
  const findings: CodexPreflightReceiptFinding[] = [];
  for (const [pattern, regex] of Object.entries(SECRET_LIKE_PATTERNS)) {
    if (regex.test(serialized)) {
      findings.push({ pattern });
    }
  }
  return { ok: findings.length === 0, findings };
}

function runtimeEventReceipt(event: CodexRuntimeEvent): CodexPreflightRuntimeEventReceipt {
  return {
    kind: 'codex_runtime_event',
    event: event.event,
    timestamp: event.timestamp,
    ...(event.codex_app_server_pid === undefined ? {} : { codex_app_server_pid: event.codex_app_server_pid }),
    ...(event.thread_id === undefined ? {} : { thread_id: redactForReceiptText(event.thread_id) }),
    ...(event.turn_id === undefined ? {} : { turn_id: redactForReceiptText(event.turn_id) }),
    ...(event.session_id === undefined ? {} : { session_id: redactForReceiptText(event.session_id) }),
    ...(event.usage === undefined ? {} : { usage: redactJsonValue(event.usage) as JsonObject }),
    ...(event.payload === undefined ? {} : { payload: redactJsonValue(event.payload) }),
  };
}

function invokeReceiptSink<TReceipt>(sink: ((receipt: TReceipt) => void | Promise<void>) | undefined, receipt: TReceipt): void {
  try {
    const result = sink?.(receipt);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Receipt sinks are observability hooks and must not change preflight behavior.
  }
}

function serializePreflightError(error: unknown): JsonObject {
  if (error instanceof CodexRunnerError) {
    return error.details === undefined
      ? { code: error.code, message: redactSecretText(error.message), name: error.name }
      : { code: error.code, message: redactSecretText(error.message), name: error.name, details: redactJsonValue(error.details) };
  }
  if (error instanceof Error) {
    return { message: redactSecretText(error.message), name: error.name };
  }
  return { message: redactSecretText(String(error)) };
}

function redactJsonValue(value: unknown, key = ''): JsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return isSecretField(key) ? '[REDACTED]' : redactForReceiptText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry));
  }
  if (typeof value === 'object') {
    const redacted: Record<string, JsonValue> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[entryKey] = redactJsonValue(entryValue, entryKey);
    }
    return redacted;
  }
  return redactForReceiptText(stringifyUnknown(value));
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'undefined') {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return `[Function ${value.name.length === 0 ? 'anonymous' : value.name}]`;
  }
  try {
    const serialized: unknown = JSON.stringify(value);
    if (typeof serialized === 'string') {
      return serialized;
    }
    return Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isSecretField(key: string): boolean {
  return /(?:api[_-]?key|authorization|password|refresh|secret|session|token)/i.test(key);
}

function redactSecretText(value: string): string {
  return value
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replaceAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replaceAll(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replaceAll(/([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)[A-Z0-9_]*\s*[:=]\s*["']?)([^"'\s,}]+)/gi, '$1[REDACTED]')
    .replaceAll(/(--(?:api[-_]?key|token|secret|password)\s+)([^\s]+)/gi, '$1[REDACTED]')
    .replaceAll(/\bsk[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\bsess_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\blin_(?:api|oauth)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replaceAll(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
}

function truncateForReceipt(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function redactForReceiptText(value: string): string {
  return truncateForReceipt(redactSecretText(value));
}
