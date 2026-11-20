import { describe, expect, it } from "vitest";

import { createHttpApp } from "../create-http-app.js";
import { requestOriginOr } from "./request-origin.js";

async function appAnswering(trustedProxyHops?: number) {
  const app = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
    ...(trustedProxyHops === undefined ? {} : { trustedProxyHops }),
  });
  app.get("/origin", () => ({
    origin: requestOriginOr("https://fallback.example"),
  }));
  return app;
}

describe("requestOriginOr", () => {
  it("names the origin the request reached the server on, after an await", async () => {
    const app = await appAnswering();
    app.get("/later", async () => {
      await Promise.resolve();
      return { origin: requestOriginOr("https://fallback.example") };
    });
    const response = await app.inject({
      method: "GET",
      url: "/later",
      headers: { host: "site.lab.example:8443" },
    });
    expect(response.json()).toEqual({ origin: "http://site.lab.example:8443" });
    await app.close();
  });

  it("reads the forwarded scheme and host only from a trusted proxy", async () => {
    const forwarded = {
      host: "10.0.0.5:3000",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "site.example",
    };
    const trusting = await appAnswering(1);
    const trusted = await trusting.inject({
      method: "GET",
      url: "/origin",
      headers: forwarded,
    });
    expect(trusted.json()).toEqual({ origin: "https://site.example" });
    await trusting.close();

    const direct = await appAnswering();
    const untrusted = await direct.inject({
      method: "GET",
      url: "/origin",
      headers: forwarded,
    });
    expect(untrusted.json()).toEqual({ origin: "http://10.0.0.5:3000" });
    await direct.close();
  });

  it("answers the fallback outside any request", () => {
    expect(requestOriginOr("https://fallback.example")).toBe(
      "https://fallback.example",
    );
  });
});
