import { createHttpApp, registerRoutes } from "@dads-framework/http";
import { expect, it } from "vitest";

import { createSignInOptionsRoutes } from "../assembly/sign-in-options-route.js";

it.each([true, false])("exposes only the SSO availability flag to signed-out users (%s)", async (enabled) => {
  const http = await createHttpApp({
    nodeEnv: "test",
    trustedOrigins: [],
    logger: false,
  });
  try {
    registerRoutes(http, {
      routes: createSignInOptionsRoutes(enabled),
      subjects: { resolve: () => Promise.resolve(null) },
      authorization: { check: () => Promise.resolve(false) },
    });
    const result = await http.inject({
      method: "GET",
      url: "/sign-in-options",
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ data: { enterpriseSso: enabled } });
  } finally {
    await http.close();
  }
});
