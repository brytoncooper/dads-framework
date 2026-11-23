import type { IdentitySession } from "@dads-framework/identity";
import { expect, it, vi } from "vitest";

import { sessionSubjects } from "../assembly/session-subjects.js";

it("requires the tenant's session policy on tenant routes", async () => {
  const tenantId = "c56a4180-65aa-4a42-80d3-f8e3159b9966";
  const session: IdentitySession = {
    account: {
      id: "user-1",
      email: "member@example.test",
      emailVerified: true,
    },
    expiresAt: new Date(),
  };
  const readSession = vi.fn(() => Promise.resolve(session));
  const readTenantSession = vi.fn<(headers: Headers, tenantId: string) => Promise<null>>().mockResolvedValue(null);
  const identity = {
    handle: () => Promise.resolve(new Response(null)),
    readSession,
    readTenantSession,
    readEnterpriseSession: () => Promise.resolve(null),
  };
  const subjects = sessionSubjects(identity, identity);
  const headers = { cookie: "fixture" };
  expect(
    await subjects.resolve({
      headers,
      url: `/api/tenants/${tenantId.toUpperCase()}/notes?limit=1`,
      params: { tenantId: tenantId.toUpperCase() },
    }),
  ).toBeNull();
  expect(readTenantSession).toHaveBeenCalledWith(new Headers(headers), tenantId);
  expect(await subjects.resolve({ headers, params: { tenantId: "invalid" } })).toBeNull();
  expect(readTenantSession).toHaveBeenCalledTimes(1);
  expect(readSession).not.toHaveBeenCalled();
  expect(await subjects.resolve({ headers, url: "/api/tenants" })).toMatchObject({
    id: session.account.id,
  });
});
