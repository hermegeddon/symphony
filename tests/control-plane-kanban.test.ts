import { describe, expect, it, vi } from "vitest";

import { createKanbanServiceFacade } from "../src/kanban-service.js";
import { startSymphonyControlPlane } from "../src/control-plane.js";
import type { KanbanClient, KanbanTaskSummary } from "../src/kanban-types.js";
import type { KanbanBackendConfig } from "../src/workflow.js";

const CP_AUTH = "unit-test-auth-99";

function kanbanConfig(overrides: Partial<KanbanBackendConfig> = {}): KanbanBackendConfig {
  return {
    hermesCommand: "/safe/bin/hermes",
    hermesHome: "/tmp/hermes-home",
    board: "symphony-test",
    boardCreate: false,
    dispatch: "observe_only",
    dispatchPolicy: "dispatchable",
    defaultAssignee: "default",
    artifactRoot: "/tmp/symphony-artifacts",
    workspace: { kind: "scratch" },
    safety: {
      requireProfilePreflight: true,
      requireReviewGateForRepoMutation: true,
      requireHumanGateForExternalActions: true,
    },
    ...overrides,
  };
}

function fakeKanbanClient(tasks: readonly KanbanTaskSummary[]): Pick<KanbanClient, "listTasks"> {
  return {
    listTasks: vi.fn(() => Promise.resolve(tasks)),
  };
}

const baseControlPlaneConfig = { enabled: true, host: "127.0.0.1", port: 0, authToken: CP_AUTH, allowExternalBind: false } as const;

function authHeader(token: string): string {
  return `Bearer ${token}`;
}

function fakeLinearToken(suffix = "fake_secret"): string {
  return ["lin", "_api_", suffix].join("");
}

function fakeInlineSecret(): string {
  return ["token", "=super-hidden"].join("");
}

describe("Kanban-backed Symphony control plane", () => {
  it("returns a normalized Kanban board snapshot without raw task bodies or secrets", async () => {
    const secretLikeTitle = `Task containing ${fakeLinearToken("fakeSecretValue")}`;
    const service = createKanbanServiceFacade({
      config: kanbanConfig(),
      client: fakeKanbanClient([
        { id: "t_ready", title: "Ready task", status: "ready", assignee: "default" },
        { id: "t_running", title: secretLikeTitle, status: "running", assignee: "backend-eng" },
        { id: "t_blocked", title: "Blocked task", status: "blocked", assignee: null },
        { id: "t_done", title: "Done task", status: "done", assignee: "reviewer" },
      ]),
    });
    const controlPlane = await startSymphonyControlPlane({
      config: baseControlPlaneConfig,
      kanban: { config: kanbanConfig(), service },
    });

    try {
      const response = await fetch(`${controlPlane.url}/snapshot`);
      const payload = await response.json() as { readonly snapshot: { readonly tasks: unknown } };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        ok: true,
        snapshot: {
          backend: "hermes_kanban",
          mode: "available",
          board: "symphony-test",
          dispatch: "observe_only",
          counts: {
            total: 4,
            pending: 1,
            running: 1,
            blocked: 1,
            completed: 1,
          },
        },
      });
      expect(payload.snapshot.tasks).toEqual([
        { id: "t_ready", title: "Ready task", status: "ready", state: "pending", assignee: "default", source_identifier: null, provenance: { workflow_id: null, kanban_board: "symphony-test", ledger_path: null } },
        { id: "t_running", title: "t_running [title redacted]", status: "running", state: "running", assignee: "backend-eng", source_identifier: null, provenance: { workflow_id: null, kanban_board: "symphony-test", ledger_path: null } },
        { id: "t_blocked", title: "Blocked task", status: "blocked", state: "blocked", assignee: null, source_identifier: null, provenance: { workflow_id: null, kanban_board: "symphony-test", ledger_path: null } },
        { id: "t_done", title: "Done task", status: "done", state: "completed", assignee: "reviewer", source_identifier: null, provenance: { workflow_id: null, kanban_board: "symphony-test", ledger_path: null } },
      ]);
      expect(JSON.stringify(payload)).not.toContain(fakeLinearToken("fakeSecretValue"));
      expect(JSON.stringify(payload)).not.toContain(secretLikeTitle);
      expect(JSON.stringify(payload)).not.toContain("/tmp/symphony-artifacts");
      expect(JSON.stringify(payload)).not.toContain("artifactRoot");
    } finally {
      await controlPlane.close();
    }
  });

  it("returns an unavailable snapshot without raw artifactRoot or absolute local artifact paths", async () => {
    const privateArtifactRoot = "/very/private/symphony-artifacts";
    const privateErrorMessage = `CLI failed token=${fakeLinearToken("fakeSecretValue")} at /reviewer/private/artifacts-root/subdir and ${privateArtifactRoot}`;
    const client: Pick<KanbanClient, "listTasks"> = {
      listTasks: vi.fn(() => Promise.reject(new Error(privateErrorMessage))),
    };
    const service = createKanbanServiceFacade({
      config: kanbanConfig({ artifactRoot: privateArtifactRoot }),
      client,
    });
    const controlPlane = await startSymphonyControlPlane({
      config: baseControlPlaneConfig,
      kanban: { config: kanbanConfig({ artifactRoot: privateArtifactRoot }), service },
    });

    try {
      const response = await fetch(`${controlPlane.url}/status`);
      const body = await response.text();
      const payload = JSON.parse(body) as { readonly snapshot: { readonly error: string; readonly provenance_warnings: readonly { readonly message: string }[] } };

      expect(response.status).toBe(200);
      expect(payload.snapshot).toMatchObject({
        backend: "hermes_kanban",
        mode: "unavailable",
        board: "symphony-test",
      });
      expect(payload.snapshot.error).toContain("[REDACTED");
      expect(body).not.toContain(fakeLinearToken("fakeSecretValue"));
      expect(body).not.toContain("super-hidden");
      expect(body).not.toContain(privateArtifactRoot);
      expect(body).not.toContain("/reviewer/private/artifacts-root");
      expect(body).not.toContain("/tmp/symphony-artifacts");
      expect(body).not.toContain("artifactRoot");
      expect(payload.snapshot.provenance_warnings[0]?.message).not.toContain(privateArtifactRoot);
      expect(payload.snapshot.provenance_warnings[0]?.message).not.toContain("/reviewer/private/artifacts-root");
    } finally {
      await controlPlane.close();
    }
  });

  it("requires auth and refuses refresh/tick mutations in observe-only Kanban mode", async () => {
    const service = createKanbanServiceFacade({ config: kanbanConfig(), client: fakeKanbanClient([]) });
    const controlPlane = await startSymphonyControlPlane({
      config: baseControlPlaneConfig,
      kanban: { config: kanbanConfig(), service },
    });

    try {
      const deniedTick = await fetch(`${controlPlane.url}/tick`, { method: "POST" });
      const deniedRefresh = await fetch(`${controlPlane.url}/api/v1/refresh`, { method: "POST" });
      const refusedHeaders = new Headers();
      refusedHeaders.set("authorization", authHeader(CP_AUTH));
      const refusedTick = await fetch(`${controlPlane.url}/tick`, {
        method: "POST",
        headers: refusedHeaders,
      });
      const refusedRefresh = await fetch(`${controlPlane.url}/api/v1/refresh`, {
        method: "POST",
        headers: refusedHeaders,
      });
      const refusedTickPayload = await refusedTick.json();
      const refusedRefreshPayload = await refusedRefresh.json();

      expect(deniedTick.status).toBe(401);
      expect(deniedRefresh.status).toBe(401);
      expect(refusedTick.status).toBe(409);
      expect(refusedRefresh.status).toBe(409);
      expect(refusedTickPayload).toEqual({
        ok: false,
        error: "kanban_dispatch_not_authorized",
        dispatch: "observe_only",
      });
      expect(refusedRefreshPayload).toEqual({
        ok: false,
        error: "kanban_dispatch_not_authorized",
        dispatch: "observe_only",
      });
    } finally {
      await controlPlane.close();
    }
  });

  it("supports the upstream-compatible /api/v1/state read alias on loopback without extra exposure", async () => {
    const service = createKanbanServiceFacade({ config: kanbanConfig(), client: fakeKanbanClient([
      { id: "t_alias", title: "Alias task", status: "ready", assignee: "default" },
    ]) });
    const controlPlane = await startSymphonyControlPlane({
      config: baseControlPlaneConfig,
      kanban: { config: kanbanConfig(), service },
    });

    try {
      const state = await fetch(`${controlPlane.url}/api/v1/state`);
      const snapshot = await fetch(`${controlPlane.url}/snapshot`);
      const statePayload = await state.json() as { readonly snapshot: { readonly tasks: readonly unknown[] } };
      const snapshotPayload = await snapshot.json() as { readonly snapshot: { readonly tasks: readonly unknown[] } };

      expect(state.status).toBe(200);
      expect(statePayload).toEqual({ ok: true, snapshot: snapshotPayload.snapshot });
    } finally {
      await controlPlane.close();
    }
  });

  it("requires bearer auth for /api/v1/state and /api/v1/refresh when bound externally", async () => {
    const service = createKanbanServiceFacade({ config: kanbanConfig(), client: fakeKanbanClient([]) });
    const controlPlane = await startSymphonyControlPlane({
      config: { ...baseControlPlaneConfig, host: "0.0.0.0", allowExternalBind: true },
      kanban: { config: kanbanConfig(), service },
    });

    try {
      const localUrl = controlPlane.url.replace("://0.0.0.0", "://127.0.0.1");
      const stateDenied = await fetch(`${localUrl}/api/v1/state`);
      const refreshDenied = await fetch(`${localUrl}/api/v1/refresh`, { method: "POST" });
      const stateHeaders = new Headers();
      stateHeaders.set("authorization", authHeader(CP_AUTH));
      const stateOk = await fetch(`${localUrl}/api/v1/state`, {
        method: "GET",
        headers: stateHeaders,
      });
      const refreshHeaders = new Headers();
      refreshHeaders.set("authorization", authHeader(CP_AUTH));
      const refreshRefused = await fetch(`${localUrl}/api/v1/refresh`, {
        method: "POST",
        headers: refreshHeaders,
      });

      expect(stateDenied.status).toBe(401);
      expect(refreshDenied.status).toBe(401);
      expect(stateOk.status).toBe(200);
      expect(refreshRefused.status).toBe(409);
      expect(await refreshRefused.json()).toEqual({
        ok: false,
        error: "kanban_dispatch_not_authorized",
        dispatch: "observe_only",
      });
    } finally {
      await controlPlane.close();
    }
  });

  it("maps malformed or failed Kanban CLI reads into an unavailable snapshot without leaking diagnostics", async () => {
    const privateArtifactRoot = "/very/private/alt-root";
    const privateErrorMessage = `CLI parse failed for ${fakeLinearToken("fakeSecretValue")} and ${fakeInlineSecret()} at ${privateArtifactRoot}`;
    const client: Pick<KanbanClient, "listTasks"> = {
      listTasks: vi.fn(() => Promise.reject(new Error(privateErrorMessage))),
    };
    const service = createKanbanServiceFacade({ config: kanbanConfig({ artifactRoot: privateArtifactRoot }), client });
    const controlPlane = await startSymphonyControlPlane({
      config: baseControlPlaneConfig,
      kanban: { config: kanbanConfig({ artifactRoot: privateArtifactRoot }), service },
    });

    try {
      const response = await fetch(`${controlPlane.url}/status`);
      const body = await response.text();
      const payload = JSON.parse(body) as { readonly snapshot: { readonly error: string; readonly provenance_warnings: readonly { readonly message: string }[] } };

      expect(response.status).toBe(200);
      expect(payload.snapshot).toMatchObject({
        backend: "hermes_kanban",
        mode: "unavailable",
        board: "symphony-test",
      });
      expect(payload.snapshot.error).toContain("[REDACTED");
      expect(body).not.toContain(fakeLinearToken("fakeSecretValue"));
      expect(body).not.toContain("super-hidden");
      expect(body).not.toContain(privateArtifactRoot);
      expect(payload.snapshot.provenance_warnings[0]?.message).not.toContain(privateArtifactRoot);
    } finally {
      await controlPlane.close();
    }
  });

  it("requires bearer auth for /status and /snapshot when bound externally", async () => {
    const service = createKanbanServiceFacade({ config: kanbanConfig(), client: fakeKanbanClient([]) });
    const controlPlane = await startSymphonyControlPlane({
      config: { ...baseControlPlaneConfig, host: "0.0.0.0", allowExternalBind: true },
      kanban: { config: kanbanConfig(), service },
    });

    try {
      const localUrl = controlPlane.url.replace("://0.0.0.0", "://127.0.0.1");
      const statusDenied = await fetch(`${localUrl}/status`);
      const snapshotDenied = await fetch(`${localUrl}/snapshot`);
      const healthOk = await fetch(`${localUrl}/health`);
      const statusHeaders = new Headers();
      statusHeaders.set("authorization", authHeader(CP_AUTH));
      const statusOk = await fetch(`${localUrl}/status`, {
        method: "GET",
        headers: statusHeaders,
      });

      expect(statusDenied.status).toBe(401);
      expect(snapshotDenied.status).toBe(401);
      expect(await healthOk.json()).toEqual({ ok: true, service: "symphony-ts" });
      expect(statusOk.status).toBe(200);
    } finally {
      await controlPlane.close();
    }
  });
});
