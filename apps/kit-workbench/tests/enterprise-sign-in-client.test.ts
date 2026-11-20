import { afterEach, expect, it, vi } from "vitest";

import {
  beginEnterpriseSignIn,
  returnedWithEnterpriseError,
} from "../apps/web/enterprise-sign-in-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("starts company sign-in and keeps the same-origin invitation return link", async () => {
  const respond = vi.fn(() =>
    Promise.resolve(Response.json({ url: "https://idp.example.test/login" })),
  );
  vi.stubGlobal("fetch", respond);

  const current = new URL(
    "https://workbench.example.test/accept-tenant-invitation?enterpriseSignIn=1&error=denied#error-fragment",
  );
  expect(returnedWithEnterpriseError(current)).toBe(true);
  await expect(beginEnterpriseSignIn("sso-company", current)).resolves.toBe(
    "https://idp.example.test/login",
  );
  expect(respond).toHaveBeenCalledWith("/api/auth/sign-in/sso", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "sso-company",
      callbackURL:
        "https://workbench.example.test/accept-tenant-invitation?enterpriseSignIn=1#error-fragment",
    }),
  });
});

it("refuses an unsuccessful start, unsafe navigation, or malformed result", async () => {
  const current = new URL("https://workbench.example.test/");
  const respond = vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ url: "javascript:alert(1)" }))
    .mockResolvedValueOnce(Response.json({}));
  vi.stubGlobal("fetch", respond);

  await expect(beginEnterpriseSignIn("sso-example", current)).rejects.toThrow();
  await expect(beginEnterpriseSignIn("sso-example", current)).rejects.toThrow();
  await expect(beginEnterpriseSignIn("sso-example", current)).rejects.toThrow();
  expect(
    returnedWithEnterpriseError(new URL("/?error=unrelated", current)),
  ).toBe(false);
});
