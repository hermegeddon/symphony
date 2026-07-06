import { describe, expect, it, vi } from "vitest";

import { startSymphonyControlPlane } from "../src/control-plane.js";
import type { SymphonyOrchestrator } from "../src/orchestrator.js";

const VALUE = "unit-test-value-42";

function headerFor(value: string): string {
  return `Bearer ${value}`;
}

function fakeOrchestrator() {
  const tick = vi.fn(() => Promise.resolve());
  const snapshot = vi.fn(() => ({
    poll_interval_ms: 1000,
    running: [],
    completed: [],
    ledger: null,
  }));
  return { tick, snapshot } as unknown as SymphonyOrchestrator & { tick: typeof tick; snapshot: typeof snapshot };
}

describe("Symphony control plane", () => {
  it("serves unauthenticated read-only health endpoint and loopback /status /snapshot without exposing secrets", async () => {
    const orchestrator = fakeOrchestrator();
    const controlPlane = await startSymphonyControlPlane({
      config: { enabled: true, host: "127.0.0.1", port: 0, authToken: VALUE, allowExternalBind: false },
      orchestrator,
    });
    try {
      const health = await fetch(`${controlPlane.url}/health`);
      const status = await fetch(`${controlPlane.url}/status`);

      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, service: "symphony-ts" });
      expect(status.status).toBe(200);
      const payload = await status.text();
      expect(payload).toContain('"ok": true');
      expect(payload).not.toContain(VALUE);
    } finally {
      await controlPlane.close();
    }
  });

  it("refuses external bind unless explicitly allowed", async () => {
    const orchestrator = fakeOrchestrator();
    await expect(
      startSymphonyControlPlane({
        config: { enabled: true, host: "0.0.0.0", port: 0, authToken: VALUE, allowExternalBind: false },
        orchestrator,
      }),
    ).rejects.toThrow("control_plane_external_bind_not_allowed");
  });

  it("requires bearer auth for /status and /snapshot when bound externally", async () => {
    const orchestrator = fakeOrchestrator();
    const controlPlane = await startSymphonyControlPlane({
      config: { enabled: true, host: "0.0.0.0", port: 0, authToken: VALUE, allowExternalBind: true },
      orchestrator,
    });
    try {
      const localUrl = controlPlane.url.replace("://0.0.0.0", "://127.0.0.1");
      const statusDenied = await fetch(`${localUrl}/status`);
      const snapshotDenied = await fetch(`${localUrl}/snapshot`);
      const healthOk = await fetch(`${localUrl}/health`);
      const headers = new Headers();
      headers.set("authorization", headerFor(VALUE));
      const statusOk = await fetch(`${localUrl}/status`, {
        method: "GET",
        headers,
      });

      expect(statusDenied.status).toBe(401);
      expect(snapshotDenied.status).toBe(401);
      expect(await healthOk.json()).toEqual({ ok: true, service: "symphony-ts" });
      expect(statusOk.status).toBe(200);
    } finally {
      await controlPlane.close().catch(() => undefined);
    }
  });

  it("requires bearer auth for mutating endpoints and supports explicit shutdown callback", async () => {
    const orchestrator = fakeOrchestrator();
    const stopService = vi.fn();
    const controlPlane = await startSymphonyControlPlane({
      config: { enabled: true, host: "127.0.0.1", port: 0, authToken: VALUE, allowExternalBind: false },
      orchestrator,
      stopService,
    });
    try {
      const denied = await fetch(`${controlPlane.url}/tick`, { method: "POST" });
      const tickHeaders = new Headers();
      tickHeaders.set("authorization", headerFor(VALUE));
      const accepted = await fetch(`${controlPlane.url}/tick`, {
        method: "POST",
        headers: tickHeaders,
      });
      const refreshHeaders = new Headers();
      refreshHeaders.set("authorization", headerFor(VALUE));
      const refresh = await fetch(`${controlPlane.url}/api/v1/refresh`, {
        method: "POST",
        headers: refreshHeaders,
      });
      const stateHeaders = new Headers();
      stateHeaders.set("authorization", headerFor(VALUE));
      const state = await fetch(`${controlPlane.url}/api/v1/state`, {
        method: "GET",
        headers: stateHeaders,
      });
      const shutdownHeaders = new Headers();
      shutdownHeaders.set("authorization", headerFor(VALUE));
      const shutdown = await fetch(`${controlPlane.url}/shutdown`, {
        method: "POST",
        headers: shutdownHeaders,
      });

      expect(denied.status).toBe(401);
      expect(accepted.status).toBe(202);
      expect(refresh.status).toBe(202);
      expect(state.status).toBe(200);
      expect(orchestrator.tick).toHaveBeenCalledTimes(2);
      expect(shutdown.status).toBe(202);
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopService).toHaveBeenCalledWith("control-plane-shutdown");
    } finally {
      await controlPlane.close().catch(() => undefined);
    }
  });
});
