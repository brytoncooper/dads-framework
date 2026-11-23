// Real HTTP proves the local identity boundary and public OpenAPI match the
// executable application, without substituting a fake transport for the server.
import { afterEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";
import { createWorkbench } from "./create-workbench.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import { startComposedWorkbenchServer, startWorkbenchServer } from "./server.js";

const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(shutdowns.splice(0).map((stop) => stop()));
});

describe("runnable workbench server", () => {
  it("serves an already-composed Workbench without reconstructing its dependencies", async () => {
    const workbench = createWorkbench({
      store: new MemoryWorkbenchStore(),
      authorization: new WorkbenchMemoryAuthorization(),
      clock: () => "2026-09-02T00:00:00.000Z",
      createId: () => "composed-workbench-id",
    });
    const running = await startComposedWorkbenchServer({ workbench, port: 0 });
    shutdowns.push(running.stop);
    const response = await fetch(`${running.url}/api/openapi.json`);
    expect(response.status).toBe(200);
  });

  it("serves real CRUD and hides owned data from another local identity", async () => {
    const running = await startWorkbenchServer({
      store: new MemoryWorkbenchStore(),
      authorization: new WorkbenchMemoryAuthorization(),
      port: 0,
    });
    shutdowns.push(running.stop);
    const created = await fetch(`${running.url}/api/workspaces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-workbench-user": "alice",
      },
      body: JSON.stringify({
        requestKey: "proof-request-key-01",
        name: "API proof",
      }),
    });
    expect(created.status).toBe(201);
    const content: unknown = await created.json();
    expect(content).toMatchObject({ data: { name: "API proof" } });
    const other = await fetch(`${running.url}/api/workspaces`, {
      headers: { "x-workbench-user": "bob" },
    });
    expect(other.status).toBe(200);
    await expect(other.json()).resolves.toMatchObject({ data: [] });
    const spec = await fetch(`${running.url}/api/openapi.json`);
    expect(spec.status).toBe(200);
    await expect(spec.json()).resolves.toMatchObject({
      openapi: "3.0.0",
      paths: {
        "/api/workspaces": { post: { operationId: "postApiWorkspaces" } },
      },
    });
  });

  it("rejects absent identities and cross-origin or rebound-host requests", async () => {
    const running = await startWorkbenchServer({
      store: new MemoryWorkbenchStore(),
      authorization: new WorkbenchMemoryAuthorization(),
      port: 0,
    });
    shutdowns.push(running.stop);
    for (const headers of [
      {},
      { "x-workbench-user": "unknown" },
      { "x-workbench-user": "alice", origin: "https://untrusted.example" },
    ]) {
      const response = await fetch(`${running.url}/api/workspaces`, {
        headers,
      });
      expect(response.status, JSON.stringify(headers)).toBe(401);
    }
    // Native fetch normalizes Host; the HTTP client sends the actual rebinding
    // request so this tests the server's guard instead of fetch's normalization.
    const reboundStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${running.url}/api/workspaces`,
        {
          headers: { "x-workbench-user": "alice", host: "untrusted.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });
    expect(reboundStatus).toBe(401);
  });
});
