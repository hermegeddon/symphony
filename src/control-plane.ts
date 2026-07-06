import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { KanbanSymphonyService } from './kanban-service.js';
import type { SymphonyOrchestrator } from './orchestrator.js';
import { formatStructuredLogLine } from './observability.js';
import type { KanbanBackendConfig } from './workflow.js';
import { isLoopbackHost } from './workflow.js';

export interface SymphonyControlPlaneConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly authToken: string | null;
  readonly allowExternalBind: boolean;
}

function isExternalBindAllowed(config: SymphonyControlPlaneConfig): boolean {
  return isLoopbackHost(config.host) || config.allowExternalBind;
}

function readEndpointsRequireAuth(config: SymphonyControlPlaneConfig): boolean {
  return !isLoopbackHost(config.host);
}

export interface StartSymphonyControlPlaneInput {
  readonly config: SymphonyControlPlaneConfig;
  readonly orchestrator?: SymphonyOrchestrator;
  readonly kanban?: {
    readonly config: KanbanBackendConfig;
    readonly service: KanbanSymphonyService;
  };
  readonly log?: (line: string) => void;
  readonly stopService?: (reason: string) => void;
}

export interface SymphonyControlPlane {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

export async function startSymphonyControlPlane(input: StartSymphonyControlPlaneInput): Promise<SymphonyControlPlane> {
  if (input.orchestrator === undefined && input.kanban === undefined) {
    throw new Error('control plane requires either a legacy orchestrator or a Kanban service facade');
  }
  if (!isExternalBindAllowed(input.config)) {
    throw new Error('control_plane_external_bind_not_allowed');
  }
  const log = input.log ?? (() => undefined);
  const server = createServer((request, response) => {
    void routeRequest(input, request, response).catch((error: unknown) => {
      writeJson(response, 500, { ok: false, error: safeError(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.config.port, input.config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const url = addressToUrl(server.address(), input.config.host);
  log(formatStructuredLogLine({ level: 'info', event: 'control_plane', outcome: 'started', url }));
  return {
    server,
    url,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      log(formatStructuredLogLine({ level: 'info', event: 'control_plane', outcome: 'stopped', url }));
    },
  };
}

async function routeRequest(
  input: StartSymphonyControlPlaneInput,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (method === 'GET' && url.pathname === '/health') {
    writeJson(response, 200, { ok: true, service: 'symphony-ts' });
    return;
  }
  if (method === 'GET' && isReadEndpoint(url.pathname)) {
    if (readEndpointsRequireAuth(input.config) && !isAuthorized(request, input.config.authToken)) {
      writeJson(response, 401, { ok: false, error: 'missing_or_invalid_bearer_token' });
      return;
    }
    if (input.kanban !== undefined) {
      writeJson(response, 200, {
        ok: true,
        snapshot: await input.kanban.service.snapshot(),
      });
      return;
    }
    writeJson(response, 200, {
      ok: true,
      snapshot: input.orchestrator?.snapshot(),
    });
    return;
  }
  if (method === 'POST' && isMutatingRefreshEndpoint(url.pathname)) {
    if (!isAuthorized(request, input.config.authToken)) {
      writeJson(response, 401, { ok: false, error: 'missing_or_invalid_bearer_token' });
      return;
    }
    if (input.kanban !== undefined) {
      if (input.kanban.config.dispatch !== 'allow_gateway_dispatch') {
        writeJson(response, 409, {
          ok: false,
          error: 'kanban_dispatch_not_authorized',
          dispatch: input.kanban.config.dispatch,
        });
        return;
      }
      writeJson(response, 409, { ok: false, error: 'kanban_gateway_dispatch_is_external_to_symphony' });
      return;
    }
    await input.orchestrator?.tick();
    writeJson(response, 202, { ok: true, snapshot: input.orchestrator?.snapshot() });
    return;
  }
  if (method === 'POST' && url.pathname === '/shutdown') {
    if (!isAuthorized(request, input.config.authToken)) {
      writeJson(response, 401, { ok: false, error: 'missing_or_invalid_bearer_token' });
      return;
    }
    writeJson(response, 202, { ok: true, action: 'shutdown_requested' });
    setImmediate(() => input.stopService?.('control-plane-shutdown'));
    return;
  }
  writeJson(response, 404, { ok: false, error: 'not_found' });
}

function isReadEndpoint(pathname: string): boolean {
  return pathname === '/snapshot' || pathname === '/status' || pathname === '/api/v1/state';
}

function isMutatingRefreshEndpoint(pathname: string): boolean {
  return pathname === '/tick' || pathname === '/api/v1/refresh';
}

function isAuthorized(request: IncomingMessage, authToken: string | null): boolean {
  if (authToken === null || authToken.trim() === '') {
    return false;
  }
  return request.headers.authorization === `Bearer ${authToken}`;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function addressToUrl(address: string | AddressInfo | null, fallbackHost: string): string {
  if (address === null || typeof address === 'string') {
    return `http://${fallbackHost}`;
  }
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}`;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
