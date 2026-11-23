// Shutdown uses a private capability, never the demo identity or browser cookies.
import { describe, expect, it } from "vitest";
import { startDevelopmentControl } from "./control-server.js";
import { requestDevelopmentStop } from "./request-stop.js";

describe("local development control", () => {
  it("refuses unauthenticated, cross-origin and incorrectly shaped stop requests", async () => {
    let stops = 0;
    const control = await startDevelopmentControl(() => {
      stops += 1;
    });
    const url = `http://127.0.0.1:${String(control.port)}`;
    try {
      for (const options of [
        { method: "POST" },
        { method: "POST", headers: { authorization: "Bearer incorrect" } },
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${control.key}`,
            origin: "https://foreign.example",
          },
        },
        { method: "GET", headers: { authorization: `Bearer ${control.key}` } },
        {
          method: "POST",
          headers: { authorization: `Bearer ${control.key}` },
          body: "unexpected-body",
        },
      ]) {
        const result = await fetch(`${url}/stop`, options);
        expect(result.status).toBe(404);
      }
      expect(stops).toBe(0);
      await Promise.all([requestDevelopmentStop(control), requestDevelopmentStop(control)]);
      expect(stops).toBe(1);
    } finally {
      await control.close();
    }
  });
});
