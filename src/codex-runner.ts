import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

export interface SymphonyIssue {
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
}

export type WorkflowVariables = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface RenderIssuePromptInput {
  readonly template: string;
  readonly issue: SymphonyIssue;
  readonly workflow: WorkflowVariables;
}

export interface CodexRunnerConfig {
  readonly codex: {
    readonly command: string;
    readonly readTimeoutMs: number;
    readonly turnTimeoutMs: number;
  };
  readonly protocol: {
    readonly schemaSource: string;
  };
  readonly approval: {
    readonly mode: 'auto_approve' | 'fail';
  };
  readonly sandbox: {
    readonly mode: string;
  };
  readonly tools: {
    readonly linearGraphql: {
      readonly enabled: boolean;
      readonly tracker?: LinearTrackerConfig;
      readonly fetchGraphql?: GraphqlFetch;
    };
  };
  readonly env?: Readonly<Record<string, string>>;
  readonly receiptSink?: CodexRunnerReceiptSink;
}

export interface RunIssueInput {
  readonly workspacePath: string;
  readonly issue: SymphonyIssue;
  readonly workflow: WorkflowVariables;
  readonly promptTemplate: string;
  readonly continuationGuidance?: readonly string[];
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: CodexRuntimeEvent) => void;
}

export interface CodexTurnResult {
  readonly threadId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly protocolSessionId?: string;
}

export interface CodexRunResult {
  readonly threadId: string;
  readonly turns: readonly CodexTurnResult[];
  readonly codexAppServerPid: number;
  readonly protocol: {
    readonly schemaSource: string;
    readonly transport: 'stdio-jsonl-json-rpc-without-jsonrpc-header';
  };
}

export interface CodexRuntimeEvent {
  readonly event: string;
  readonly timestamp: string;
  readonly codex_app_server_pid?: number;
  readonly thread_id?: string;
  readonly turn_id?: string;
  readonly session_id?: string;
  readonly usage?: JsonObject;
  readonly payload?: JsonValue;
}

export type CodexRunnerReceipt = CodexAppServerSpawnReceipt | CodexProtocolRequestResponseReceipt;

export interface CodexAppServerSpawnReceipt {
  readonly kind: 'codex_app_server_spawn';
  readonly command: {
    readonly launcher: 'bash';
    readonly launcher_args: readonly string[];
    readonly configured_command_sha256: string;
    readonly configured_command_preview: string;
  };
  readonly cwd: string;
  readonly env_keys: readonly string[];
  readonly approval: {
    readonly mode: CodexRunnerConfig['approval']['mode'];
    readonly wire_policy: string;
  };
  readonly sandbox: {
    readonly mode: string;
    readonly wire_policy: string;
  };
  readonly protocol: {
    readonly schema_source: string;
    readonly transport: 'stdio-jsonl-json-rpc-without-jsonrpc-header';
  };
}

export interface CodexProtocolRequestResponseReceipt {
  readonly kind: 'codex_protocol_request_response';
  readonly method: string;
  readonly request: JsonObject;
  readonly response: JsonObject;
}

export type CodexRunnerReceiptSink = (receipt: CodexRunnerReceipt) => void | Promise<void>;

export interface LinearTrackerConfig {
  readonly kind: string;
  readonly endpoint?: string;
  readonly token?: string;
}

export type GraphqlFetch = (
  endpoint: string,
  token: string,
  body: { readonly query: string; readonly variables?: JsonObject },
) => Promise<JsonObject>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

interface JsonRpcMessage extends JsonObject {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: JsonObject;
  readonly result?: JsonObject;
  readonly error?: JsonObject;
}

interface PendingRequest {
  readonly resolve: (message: JsonRpcMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface TurnWaiter {
  readonly resolve: (message: JsonRpcMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input?: JsonValue;
}

const MAX_CODEX_STDERR_DIAGNOSTIC_CHARS = 4096;
const TRUNCATED_STDERR_LINE_MARKER = '[stderr tail omitted: capture began inside a truncated line]';

export class CodexRunnerError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: JsonValue,
  ) {
    super(message);
    this.name = 'CodexRunnerError';
  }
}

export function renderIssuePrompt(input: RenderIssuePromptInput): string {
  return input.template.replaceAll(/{{\s*([^}]+?)\s*}}/g, (_match, rawPath: string) => {
    const path = rawPath.trim();
    const value = resolveTemplatePath(path, input.issue, input.workflow);
    if (value === undefined) {
      throw new CodexRunnerError('template_render_error', `Unknown prompt template variable: ${path}`);
    }
    return value === null ? '' : String(value);
  });
}

function resolveTemplatePath(path: string, issue: SymphonyIssue, workflow: WorkflowVariables): string | number | boolean | null | undefined {
  switch (path) {
    case 'issue.identifier':
      return issue.identifier;
    case 'issue.title':
      return issue.title;
    case 'issue.description':
      return issue.description;
    default:
      if (path.startsWith('workflow.')) {
        return workflow[path.slice('workflow.'.length)];
      }
      return undefined;
  }
}

export class CodexAppServerRunner {
  public constructor(private readonly config: CodexRunnerConfig) {}

  public async runIssue(input: RunIssueInput): Promise<CodexRunResult> {
    const client: JsonlCodexClient = new JsonlCodexClient({
      command: this.config.codex.command,
      cwd: input.workspacePath,
      readTimeoutMs: this.config.codex.readTimeoutMs,
      turnTimeoutMs: this.config.codex.turnTimeoutMs,
      ...(this.config.env === undefined ? {} : { env: this.config.env }),
      onMessage: (message: JsonRpcMessage): void => {
        void this.handleNotification(client, message, input.onEvent).catch((error: unknown) => {
          input.onEvent?.(this.event('malformed', client.pid, undefined, undefined, undefined, serializeError(error)));
        });
      },
    });
    const cancellationError = (): CodexRunnerError => new CodexRunnerError('run_cancelled', `Codex run cancelled: ${String(input.signal?.reason ?? 'cancelled')}`);
    const abort = (): void => {
      void client.stop(cancellationError());
    };

    try {
      if (input.signal?.aborted === true) {
        throw cancellationError();
      }
      input.signal?.addEventListener('abort', abort, { once: true });
      this.emitSpawnReceipt(input.workspacePath);
      client.start();
      await this.requestWithReceipt(client, 'initialize', {
        clientInfo: { name: 'symphony-ts', title: 'Symphony TypeScript', version: '0.1.0' },
      });
      client.notify('initialized', {});

      const advertisedTools = this.config.tools.linearGraphql.enabled ? [{ name: 'linear_graphql' }] : [];
      const threadResponse = await this.requestWithReceipt(client, 'thread/start', {
        cwd: input.workspacePath,
        title: `${input.issue.identifier}: ${input.issue.title}`,
        approvalPolicy: codexWireApprovalPolicy(this.config.approval.mode),
        sandbox: codexWireSandboxPolicy(this.config.sandbox.mode),
        tools: advertisedTools,
        metadata: {
          issue: { identifier: input.issue.identifier, title: input.issue.title },
          protocol_schema_source: this.config.protocol.schemaSource,
        },
      });
      const threadId = extractRequiredId(threadResponse.result, ['thread', 'id'], 'thread/start did not return thread.id');

      const prompts = [
        renderIssuePrompt({ template: input.promptTemplate, issue: input.issue, workflow: input.workflow }),
        ...(input.continuationGuidance ?? []),
      ];

      const turns: CodexTurnResult[] = [];
      for (const prompt of prompts) {
        const turn = await this.startTurn(client, input.workspacePath, threadId, prompt, input.onEvent);
        turns.push(turn);
      }

      return {
        threadId,
        turns,
        codexAppServerPid: client.pid,
        protocol: {
          schemaSource: this.config.protocol.schemaSource,
          transport: 'stdio-jsonl-json-rpc-without-jsonrpc-header',
        },
      };
    } finally {
      input.signal?.removeEventListener('abort', abort);
      await client.stop();
    }
  }

  private emitSpawnReceipt(workspacePath: string): void {
    const approvalWirePolicy = codexWireApprovalPolicy(this.config.approval.mode);
    const sandboxWirePolicy = codexWireSandboxPolicy(this.config.sandbox.mode);
    this.emitReceipt({
      kind: 'codex_app_server_spawn',
      command: {
        launcher: 'bash',
        launcher_args: ['-lc', '[REDACTED_CONFIGURED_COMMAND]'],
        configured_command_sha256: sha256Hex(this.config.codex.command),
        configured_command_preview: redactForReceiptText(this.config.codex.command),
      },
      cwd: workspacePath,
      env_keys: Object.keys(this.config.env ?? {}).sort(),
      approval: { mode: this.config.approval.mode, wire_policy: approvalWirePolicy },
      sandbox: { mode: this.config.sandbox.mode, wire_policy: sandboxWirePolicy },
      protocol: {
        schema_source: this.config.protocol.schemaSource,
        transport: 'stdio-jsonl-json-rpc-without-jsonrpc-header',
      },
    });
  }

  private async requestWithReceipt(client: JsonlCodexClient, method: string, params: JsonObject): Promise<JsonRpcMessage> {
    try {
      const response = await client.request(method, params);
      this.emitReceipt({
        kind: 'codex_protocol_request_response',
        method,
        request: summarizeProtocolRequest(method, params),
        response: summarizeProtocolResponse(response),
      });
      return response;
    } catch (error) {
      this.emitReceipt({
        kind: 'codex_protocol_request_response',
        method,
        request: summarizeProtocolRequest(method, params),
        response: { outcome: 'error', error: serializeRunnerError(error) },
      });
      throw error;
    }
  }

  private emitReceipt(receipt: CodexRunnerReceipt): void {
    try {
      const result = this.config.receiptSink?.(receipt);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
      }
    } catch {
      // Receipt sinks are observability hooks and must not change runner behavior.
    }
  }

  private async startTurn(
    client: JsonlCodexClient,
    workspacePath: string,
    threadId: string,
    prompt: string,
    onEvent: ((event: CodexRuntimeEvent) => void) | undefined,
  ): Promise<CodexTurnResult> {
    const response = await this.requestWithReceipt(client, 'turn/start', {
      threadId,
      cwd: workspacePath,
      approvalPolicy: codexWireApprovalPolicy(this.config.approval.mode),
      sandboxPolicy: codexWireTurnSandboxPolicy(this.config.sandbox.mode, workspacePath),
      input: [{ type: 'text', text: prompt }],
      title: threadId,
    });
    const turnId = extractRequiredId(response.result, ['turn', 'id'], 'turn/start did not return turn.id');
    const protocolSessionId = extractOptionalId(response.result, ['session', 'id']);
    const sessionId = `${threadId}-${turnId}`;
    onEvent?.(this.event('session_started', client.pid, threadId, turnId, sessionId, { protocol_session_id: protocolSessionId }));

    const completion = await client.waitForTurnEnd(threadId, turnId);
    const method = completion.method;
    if (method === 'turn/completed') {
      onEvent?.(this.event('turn_completed', client.pid, threadId, turnId, sessionId, completion.params));
      return protocolSessionId === undefined ? { threadId, turnId, sessionId } : { threadId, turnId, sessionId, protocolSessionId };
    }
    if (method === 'turn/input_required') {
      onEvent?.(this.event('turn_input_required', client.pid, threadId, turnId, sessionId, completion.params));
      throw new CodexRunnerError('turn_input_required', 'Codex turn requested user input; configured policy fails instead of stalling.', completion.params);
    }
    if (method === 'turn/cancelled') {
      onEvent?.(this.event('turn_cancelled', client.pid, threadId, turnId, sessionId, completion.params));
      throw new CodexRunnerError('turn_cancelled', 'Codex turn was cancelled.', completion.params);
    }
    onEvent?.(this.event('turn_failed', client.pid, threadId, turnId, sessionId, completion.params));
    throw new CodexRunnerError('turn_failed', 'Codex turn failed.', completion.params);
  }

  private async handleNotification(
    client: JsonlCodexClient,
    message: JsonRpcMessage,
    onEvent: ((event: CodexRuntimeEvent) => void) | undefined,
  ): Promise<void> {
    if (message.id !== undefined || message.method === undefined) {
      return;
    }

    const threadId = extractOptionalId(message.params, ['thread', 'id']);
    const turnId = extractOptionalId(message.params, ['turn', 'id']);
    const sessionId = threadId !== undefined && turnId !== undefined ? `${threadId}-${turnId}` : undefined;

    switch (message.method) {
      case 'token/usage':
        onEvent?.(this.event('token_usage', client.pid, threadId, turnId, sessionId, undefined, getObject(message.params, 'usage')));
        return;
      case 'rate_limit/update':
        onEvent?.(this.event('rate_limit_update', client.pid, threadId, turnId, sessionId, message.params));
        return;
      case 'agent/update':
        onEvent?.(this.event('agent_update', client.pid, threadId, turnId, sessionId, message.params));
        return;
      case 'approval/request':
        this.handleApprovalRequest(client, message, onEvent, threadId, turnId, sessionId);
        return;
      case 'tool/call':
        await this.handleToolCall(client, message, onEvent, threadId, turnId, sessionId);
        return;
      case 'turn/started':
      case 'turn/completed':
      case 'turn/failed':
      case 'turn/cancelled':
      case 'turn/input_required':
        return;
      default:
        onEvent?.(this.event('notification', client.pid, threadId, turnId, sessionId, message.params ?? { method: message.method }));
    }
  }

  private handleApprovalRequest(
    client: JsonlCodexClient,
    message: JsonRpcMessage,
    onEvent: ((event: CodexRuntimeEvent) => void) | undefined,
    threadId: string | undefined,
    turnId: string | undefined,
    sessionId: string | undefined,
  ): void {
    const approvalId = extractOptionalId(message.params, ['approval', 'id']) ?? extractOptionalId(message.params, ['id']);
    if (this.config.approval.mode !== 'auto_approve') {
      const error = new CodexRunnerError('approval_required', 'Approval was requested and auto-approval is disabled.', message.params);
      onEvent?.(this.event('approval_required', client.pid, threadId, turnId, sessionId, { approval_id: approvalId }));
      client.fail(error);
      return;
    }
    client.notify('approval/decision', { approvalId, approved: true });
    onEvent?.(this.event('approval_auto_approved', client.pid, threadId, turnId, sessionId, { approval_id: approvalId }));
  }

  private async handleToolCall(
    client: JsonlCodexClient,
    message: JsonRpcMessage,
    onEvent: ((event: CodexRuntimeEvent) => void) | undefined,
    threadId: string | undefined,
    turnId: string | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    const toolCall = parseToolCall(message.params);
    if (toolCall === undefined) {
      onEvent?.(this.event('malformed', client.pid, threadId, turnId, sessionId, message.params));
      return;
    }

    if (toolCall.name === 'linear_graphql' && this.config.tools.linearGraphql.enabled) {
      const result = await runLinearGraphqlTool({
        input: toolCall.input,
        tracker: this.config.tools.linearGraphql.tracker ?? { kind: 'linear' },
        fetchGraphql: this.config.tools.linearGraphql.fetchGraphql ?? defaultFetchGraphql,
      });
      client.notify('tool/result', { toolCallId: toolCall.id, result });
      return;
    }

    const result = {
      success: false,
      error: { code: 'unsupported_tool_call', message: `Tool ${toolCall.name} is not implemented by this Symphony runtime.` },
    };
    client.notify('tool/result', { toolCallId: toolCall.id, result });
    onEvent?.(this.event('unsupported_tool_call', client.pid, threadId, turnId, sessionId, { tool_call_id: toolCall.id, tool_name: toolCall.name }));
  }

  private event(
    event: string,
    pid: number | undefined,
    threadId: string | undefined,
    turnId: string | undefined,
    sessionId: string | undefined,
    payload?: JsonValue,
    usage?: JsonObject,
  ): CodexRuntimeEvent {
    const runtimeEvent: Record<string, JsonValue | undefined> = {
      event,
      timestamp: new Date().toISOString(),
    };
    if (pid !== undefined) runtimeEvent['codex_app_server_pid'] = pid;
    if (threadId !== undefined) runtimeEvent['thread_id'] = threadId;
    if (turnId !== undefined) runtimeEvent['turn_id'] = turnId;
    if (sessionId !== undefined) runtimeEvent['session_id'] = sessionId;
    if (payload !== undefined) runtimeEvent['payload'] = payload;
    if (usage !== undefined) runtimeEvent['usage'] = usage;
    return runtimeEvent as unknown as CodexRuntimeEvent;
  }
}

function codexWireApprovalPolicy(mode: CodexRunnerConfig['approval']['mode']): string {
  // Codex app-server 0.141 expects CLI approval-policy names, not Symphony's
  // older internal aliases. In non-interactive service mode, both legacy
  // aliases should avoid approval prompts and surface failures directly.
  switch (mode) {
    case 'auto_approve':
    case 'fail':
      return 'never';
  }
}

function codexWireSandboxPolicy(mode: string): string {
  return mode.split('_').join('-');
}

function codexWireTurnSandboxPolicy(mode: string, workspacePath: string): JsonObject {
  switch (codexWireSandboxPolicy(mode)) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return { type: 'workspaceWrite', networkAccess: false, writableRoots: [workspacePath] };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    default:
      throw new CodexRunnerError('unsupported_sandbox_policy', `Unsupported Codex sandbox mode: ${mode}`);
  }
}

function codexChildEnvironment(overrides: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) {
    if (isLinearSecretEnvKey(key)) {
      Reflect.deleteProperty(env, key);
    }
  }
  return env;
}

function isLinearSecretEnvKey(key: string): boolean {
  return /^LINEAR(?:_|$)/i.test(key) || /LINEAR.*(?:TOKEN|KEY|SECRET|AUTH)/i.test(key);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function truncateForReceipt(value: string): string {
  return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
}

function redactForReceiptText(value: string): string {
  return truncateForReceipt(redactSecretText(value));
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

function summarizeProtocolRequest(method: string, params: JsonObject): JsonObject {
  const summary: Record<string, JsonValue> = { keys: Object.keys(params).sort() };
  switch (method) {
    case 'initialize': {
      const clientInfo = getObject(params, 'clientInfo');
      if (clientInfo !== undefined) {
        summary['client_info'] = redactJsonValue(clientInfo);
      }
      break;
    }
    case 'thread/start': {
      copyString(summary, 'cwd', params, 'cwd');
      copyString(summary, 'title', params, 'title');
      copyString(summary, 'approval_policy', params, 'approvalPolicy');
      copyString(summary, 'sandbox', params, 'sandbox');
      summary['tool_names'] = toolNames(params['tools']);
      const metadata = getObject(params, 'metadata');
      if (metadata !== undefined) {
        summary['metadata'] = redactJsonValue(metadata);
      }
      break;
    }
    case 'turn/start': {
      copyString(summary, 'cwd', params, 'cwd');
      copyString(summary, 'thread_id', params, 'threadId');
      copyString(summary, 'approval_policy', params, 'approvalPolicy');
      const sandboxPolicy = params['sandboxPolicy'];
      if (sandboxPolicy !== undefined) {
        summary['sandbox_policy'] = redactJsonValue(sandboxPolicy);
      }
      const input = params['input'];
      if (Array.isArray(input)) {
        summary['input_count'] = input.length;
        summary['input_sha256'] = sha256Hex(JSON.stringify(input));
      }
      break;
    }
  }
  return summary;
}

function summarizeProtocolResponse(message: JsonRpcMessage): JsonObject {
  if (message.error !== undefined) {
    return { outcome: 'error', error: redactJsonValue(message.error) };
  }
  const response: Record<string, JsonValue> = { outcome: 'ok' };
  if (message.result !== undefined) {
    response['result_keys'] = Object.keys(message.result).sort();
  }
  const threadId = extractOptionalId(message.result, ['thread', 'id']);
  const turnId = extractOptionalId(message.result, ['turn', 'id']);
  const protocolSessionId = extractOptionalId(message.result, ['session', 'id']);
  if (threadId !== undefined) response['thread_id'] = redactForReceiptText(threadId);
  if (turnId !== undefined) response['turn_id'] = redactForReceiptText(turnId);
  if (protocolSessionId !== undefined) response['protocol_session_id'] = redactForReceiptText(protocolSessionId);
  return response;
}

function serializeRunnerError(error: unknown): JsonObject {
  const serialized = redactJsonObject(serializeError(error));
  if (error instanceof CodexRunnerError) {
    return error.details === undefined
      ? { ...serialized, code: error.code }
      : { ...serialized, code: error.code, details: redactJsonValue(error.details) };
  }
  return serialized;
}

function redactJsonObject(value: JsonObject): JsonObject {
  const redacted = redactJsonValue(value);
  return isObject(redacted) ? redacted : {};
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

function copyString(target: Record<string, JsonValue>, targetKey: string, source: JsonObject, sourceKey: string): void {
  const value = source[sourceKey];
  if (typeof value === 'string') {
    target[targetKey] = redactForReceiptText(value);
  }
}

function toolNames(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isObject(entry)) {
      return [];
    }
    const name = entry['name'];
    return typeof name === 'string' ? [name] : [];
  });
}

class BoundedStderrCapture {
  private text = '';
  private truncated = false;

  public constructor(private readonly maxChars: number) {}

  public append(chunk: string): void {
    if (chunk.length === 0) {
      return;
    }
    this.text += chunk;
    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(this.text.length - this.maxChars);
      this.truncated = true;
    }
  }

  public snapshot(): { readonly text: string; readonly truncated: boolean } {
    const redacted = redactSecretText(this.safeTextForRedaction());
    if (redacted.length <= this.maxChars) {
      return { text: redacted, truncated: this.truncated };
    }
    return { text: redacted.slice(redacted.length - this.maxChars), truncated: true };
  }

  private safeTextForRedaction(): string {
    if (!this.truncated) {
      return this.text;
    }
    const firstNewline = this.text.indexOf('\n');
    if (firstNewline === -1) {
      return TRUNCATED_STDERR_LINE_MARKER;
    }
    return `${TRUNCATED_STDERR_LINE_MARKER}\n${this.text.slice(firstNewline + 1)}`;
  }
}

class JsonlCodexClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readline: ReadlineInterface | undefined;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingRequest>();
  private turnWaiter: TurnWaiter | undefined;
  private bufferedTurnEnd: JsonRpcMessage | undefined;
  private stopping: Promise<void> | undefined;
  private fatalError: Error | undefined;
  private readonly stderrCapture = new BoundedStderrCapture(MAX_CODEX_STDERR_DIAGNOSTIC_CHARS);

  public constructor(
    private readonly options: {
      readonly command: string;
      readonly cwd: string;
      readonly readTimeoutMs: number;
      readonly turnTimeoutMs: number;
      readonly env?: Readonly<Record<string, string>>;
      readonly onMessage: (message: JsonRpcMessage) => void;
    },
  ) {}

  public get pid(): number {
    return this.child?.pid ?? 0;
  }

  public start(): void {
    this.child = spawn('bash', ['-lc', this.options.command], {
      cwd: this.options.cwd,
      detached: true,
      env: codexChildEnvironment(this.options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string | Buffer) => {
      this.stderrCapture.append(String(chunk));
    });
    this.child.on('exit', (exitCode, signal) => {
      const error = this.errorWithDiagnostics('port_exit', 'Codex app-server subprocess exited.', {
        exit_code: exitCode,
        signal,
      });
      this.rejectAll(error);
    });
    this.readline = createInterface({ input: this.child.stdout });
    this.readline.on('line', (line) => {
      this.acceptLine(line);
    });
  }

  public async stop(error?: Error): Promise<void> {
    if (this.stopping !== undefined) {
      if (error !== undefined) {
        this.rejectAll(error);
      }
      await this.stopping;
      return;
    }

    if (error !== undefined) {
      this.rejectAll(error);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
    }
    this.pending.clear();
    if (this.turnWaiter !== undefined) {
      clearTimeout(this.turnWaiter.timeout);
      this.turnWaiter = undefined;
    }
    this.bufferedTurnEnd = undefined;
    this.readline?.close();
    if (error === undefined && this.child?.stdin.writable === true) {
      this.child.stdin.end();
    } else {
      this.terminateProcessTree('SIGTERM');
    }
    this.stopping = this.waitForProcessExit();
    await this.stopping;
  }

  public fail(error: Error): void {
    this.fatalError = error;
    this.rejectAll(error);
  }

  private async waitForProcessExit(): Promise<void> {
    const child = this.child;
    if (child?.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(killTimer);
          resolve();
        }
      };
      const killTimer = setTimeout(() => {
        this.terminateProcessTree('SIGKILL');
        settle();
      }, 500);
      killTimer.unref();
      child.once('exit', settle);
    });
  }

  private terminateProcessTree(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (pid === undefined) {
      return;
    }

    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!isMissingProcessError(error)) {
        try {
          this.child?.kill(signal);
        } catch (childError) {
          if (!isMissingProcessError(childError)) {
            throw childError;
          }
        }
      }
    }
  }

  public async request(method: string, params: JsonObject): Promise<JsonRpcMessage> {
    if (this.fatalError !== undefined) {
      throw this.fatalError;
    }
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    this.write(message);
    return await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(this.errorWithDiagnostics('response_timeout', `${method} timed out waiting for response.`));
      }, this.options.readTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  public notify(method: string, params: JsonObject): void {
    this.write({ method, params });
  }

  public async waitForTurnEnd(threadId: string, turnId: string): Promise<JsonRpcMessage> {
    if (this.fatalError !== undefined) {
      throw this.fatalError;
    }
    if (this.bufferedTurnEnd !== undefined) {
      const buffered = this.bufferedTurnEnd;
      this.bufferedTurnEnd = undefined;
      return buffered;
    }
    return await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiter = undefined;
        reject(this.errorWithDiagnostics('turn_timeout', `Turn ${threadId}-${turnId} timed out.`));
      }, this.options.turnTimeoutMs);
      this.turnWaiter = { resolve, reject, timeout };
    });
  }

  private write(message: JsonObject): void {
    if (this.child?.stdin.writable !== true) {
      throw this.errorWithDiagnostics('startup_failed', 'Codex app-server stdin is not writable.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private errorWithDiagnostics(code: string, message: string, details: JsonObject = {}): CodexRunnerError {
    const stderr = this.stderrCapture.snapshot();
    const diagnostics: Record<string, JsonValue | undefined> = { ...details };
    if (stderr.text.length > 0) {
      diagnostics['stderr_tail'] = stderr.text;
      diagnostics['stderr_truncated'] = stderr.truncated;
      diagnostics['stderr_tail_characters'] = stderr.text.length;
    }
    return Object.keys(diagnostics).length === 0
      ? new CodexRunnerError(code, message)
      : new CodexRunnerError(code, message, diagnostics);
  }

  private acceptLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.options.onMessage({ method: 'malformed', params: { line, error: String(error) } });
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      if (pending !== undefined) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          pending.reject(new CodexRunnerError('response_error', 'Codex app-server returned an error response.', message.error));
        } else {
          pending.resolve(message);
        }
      }
      return;
    }

    if (isTurnEndMethod(message.method) && this.turnWaiter !== undefined) {
      const waiter = this.turnWaiter;
      clearTimeout(waiter.timeout);
      this.turnWaiter = undefined;
      waiter.resolve(message);
    } else if (isTurnEndMethod(message.method)) {
      this.bufferedTurnEnd = message;
    }

    this.options.onMessage(message);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (this.turnWaiter !== undefined) {
      clearTimeout(this.turnWaiter.timeout);
      this.turnWaiter.reject(error);
      this.turnWaiter = undefined;
    }
  }
}

function isTurnEndMethod(method: string | undefined): boolean {
  return method === 'turn/completed' || method === 'turn/failed' || method === 'turn/cancelled' || method === 'turn/input_required';
}

function parseToolCall(params: JsonObject | undefined): ToolCall | undefined {
  const toolCall = getObject(params, 'toolCall');
  if (toolCall === undefined) {
    return undefined;
  }
  const id = getString(toolCall, 'id');
  const name = getString(toolCall, 'name');
  if (id === undefined || name === undefined) {
    return undefined;
  }
  return toolCall['input'] === undefined ? { id, name } : { id, name, input: toolCall['input'] };
}

function extractRequiredId(root: JsonObject | undefined, path: readonly string[], errorMessage: string): string {
  const value = extractOptionalId(root, path);
  if (value === undefined) {
    throw new CodexRunnerError('response_error', errorMessage, root);
  }
  return value;
}

function extractOptionalId(root: JsonObject | undefined, path: readonly string[]): string | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return typeof current === 'string' || typeof current === 'number' ? String(current) : undefined;
}

function getString(root: JsonObject | undefined, key: string): string | undefined {
  const value = root?.[key];
  return typeof value === 'string' ? value : undefined;
}

function getObject(root: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = root?.[key];
  return isObject(value) ? value : undefined;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeError(error: unknown): JsonObject {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return { message: String(error) };
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === 'ESRCH';
}

export async function runLinearGraphqlTool(input: {
  readonly input: JsonValue | undefined;
  readonly tracker: LinearTrackerConfig;
  readonly fetchGraphql?: GraphqlFetch;
}): Promise<JsonObject> {
  const normalized = normalizeLinearGraphqlInput(input.input);
  if (!normalized.success) {
    return normalized;
  }
  if (input.tracker.kind !== 'linear' || input.tracker.endpoint === undefined || input.tracker.token === undefined) {
    return { success: false, error: { code: 'missing_auth', message: 'linear_graphql requires configured Linear endpoint and token.' } };
  }

  try {
    const fetchGraphql = input.fetchGraphql ?? defaultFetchGraphql;
    const response = await fetchGraphql(input.tracker.endpoint, input.tracker.token, normalized.body);
    if (Array.isArray(response['errors'])) {
      return { success: false, response };
    }
    return { success: true, response };
  } catch (error) {
    return { success: false, error: { code: 'transport_failure', ...serializeError(error) } };
  }
}

function normalizeLinearGraphqlInput(input: JsonValue | undefined):
  | { readonly success: true; readonly body: { readonly query: string; readonly variables?: JsonObject } }
  | { readonly success: false; readonly error: JsonObject } {
  const query = typeof input === 'string' ? input : isObject(input) ? getString(input, 'query') : undefined;
  if (query === undefined || query.trim().length === 0) {
    return { success: false, error: { code: 'invalid_input', message: 'linear_graphql query must be a non-empty string.' } };
  }
  if (countGraphqlOperations(query) !== 1) {
    return { success: false, error: { code: 'invalid_input', message: 'linear_graphql accepts exactly one GraphQL operation.' } };
  }
  const variables = isObject(input) ? input['variables'] : undefined;
  if (variables !== undefined && !isObject(variables)) {
    return { success: false, error: { code: 'invalid_input', message: 'linear_graphql variables must be a JSON object when provided.' } };
  }
  return variables === undefined ? { success: true, body: { query } } : { success: true, body: { query, variables } };
}

function countGraphqlOperations(query: string): number {
  const withoutComments = query.replaceAll(/#[^\n\r]*/g, ' ').trim();
  const matches = withoutComments.match(/\b(?:query|mutation|subscription)\b/g);
  if (matches !== null) {
    return matches.length;
  }
  return withoutComments.startsWith('{') && withoutComments.endsWith('}') ? 1 : 0;
}

async function defaultFetchGraphql(
  endpoint: string,
  token: string,
  body: { readonly query: string; readonly variables?: JsonObject },
): Promise<JsonObject> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: token,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as JsonObject;
  if (!response.ok) {
    return { errors: [{ message: `Linear GraphQL HTTP ${String(response.status)}` }], response: parsed };
  }
  return parsed;
}
