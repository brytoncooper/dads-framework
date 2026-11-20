import { describe, expect, it } from "vitest";
import { z } from "zod";

import { startWorkbenchServer } from "./server.js";
import { MemoryWorkbenchStore } from "./storage/memory-workbench-store.js";
import { WorkbenchMemoryAuthorization } from "./testing/workbench-memory-authorization.js";

describe("Workbench activity stream", () => {
  it("streams authorized events and denies a reconnect after membership is revoked", async () => {
    const server = await startWorkbenchServer({
      store: new MemoryWorkbenchStore(),
      authorization: new WorkbenchMemoryAuthorization(),
      port: 0,
    });
    try {
      const created = await fetch(`${server.url}/api/workspaces`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workbench-user": "alice",
        },
        body: JSON.stringify({
          requestKey: "activity-stream-test",
          name: "Stream workspace",
        }),
      });
      const workspace = z
        .object({ data: z.object({ id: z.string() }) })
        .parse(await created.json());
      const url = `${server.url}/api/workspaces/${workspace.data.id}/activity`;
      await fetch(`${server.url}/api/workspaces/${workspace.data.id}/members`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-workbench-user": "alice",
        },
        body: JSON.stringify({ userId: "bob" }),
      });
      const response = await fetch(`${url}/stream`, {
        headers: { "x-workbench-user": "bob" },
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const feed = response.body?.getReader();
      if (feed === undefined)
        throw new Error("Expected an activity response stream");
      try {
        let output = "";
        const decoder = new TextDecoder();
        while (!output.includes("workspace.created")) {
          const part = await feed.read();
          if (part.done) break;
          output += decoder.decode(part.value, { stream: true });
        }
        expect(output).toContain("workspace.created");
        expect(output).toContain("member.granted");
      } finally {
        await feed.cancel();
      }
      await fetch(
        `${server.url}/api/workspaces/${workspace.data.id}/members/bob`,
        {
          method: "DELETE",
          headers: { "x-workbench-user": "alice" },
        },
      );
      expect(
        (
          await fetch(`${url}/stream`, {
            headers: { "x-workbench-user": "bob" },
          })
        ).status,
      ).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
