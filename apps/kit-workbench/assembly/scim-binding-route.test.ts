import { relationshipWrite } from "@dads-framework/access/runtime";
import { FakeAuthorization } from "@dads-framework/access/testing";
import { buildTestApp } from "@dads-framework/http/testing";
import { TenantUnavailableError } from "@dads-framework/tenants";
import { expect, it, vi } from "vitest";

import { sessionSubjects } from "./session-subjects.js";
import { scimBindingRoutes } from "../domains/tenants/index.js";
import { accountEntity, tenantAccess } from "../libraries/app-runtime/index.js";

const origin = "http://127.0.0.1:3000";
const alpha = "00000000-0000-4000-8000-000000000001";
const beta = "00000000-0000-4000-8000-000000000002";
const scimId = "00000000-0000-4000-8000-000000000003";
const owner = { type: accountEntity.wireName, id: "owner" };
const member = { type: accountEntity.wireName, id: "member" };
const permission = tenantAccess.tenant.permissions.manage_tenant;

it("binds an existing member only for an owner of an enabled tenant", async () => {
  const bindScimUser = vi
    .fn<Parameters<typeof scimBindingRoutes>[0]["bindScimUser"]>()
    .mockImplementation((_actor, _tenant, _scimUser, account) =>
      account === member.id
        ? Promise.resolve()
        : Promise.reject(new TenantUnavailableError()),
    );
  const auth = new FakeAuthorization({
    [permission.entityWireName]: { [permission.permissionName]: ["owner"] },
  });
  for (const tenantId of [alpha, beta]) {
    auth.seed(
      relationshipWrite(
        { type: permission.entityWireName, id: tenantId },
        "owner",
        owner,
      ),
    );
    auth.seed(
      relationshipWrite(
        { type: permission.entityWireName, id: tenantId },
        "member",
        member,
      ),
    );
  }

  const readSession = vi.fn((headers: Headers) => {
    const cookie = headers.get("cookie");
    if (cookie === null) return Promise.resolve(null);
    const id = cookie === "password-owner" ? owner.id : cookie;
    return Promise.resolve({
      account: { id, email: `${id}@example.test`, emailVerified: true },
      expiresAt: new Date("2099-01-01"),
    });
  });
  const readTenantSession = vi.fn((headers: Headers, tenantId: string) =>
    tenantId === alpha && headers.get("cookie") === "password-owner"
      ? Promise.resolve(null)
      : readSession(headers),
  );
  const app = await buildTestApp({
    routes: scimBindingRoutes({ bindScimUser }, origin, [alpha]),
    subjects: sessionSubjects(
      { handle: () => Promise.resolve(new Response(null)), readSession },
      { readTenantSession },
    ),
    authorization: auth,
  });

  const bind = (
    tenant: string,
    cookie?: string,
    requestOrigin = origin,
    accountId = member.id,
  ) =>
    app.inject({
      method: "POST",
      url: `/tenants/${tenant}/scim/users/${scimId}/bind`,
      headers: {
        origin: requestOrigin,
        ...(cookie === undefined ? {} : { cookie }),
      },
      payload: { accountId },
    });

  try {
    expect((await bind(alpha)).statusCode).toBe(401);
    expect((await bind(alpha, "member")).statusCode).toBe(404);
    expect((await bind(alpha, "password-owner")).statusCode).toBe(401);
    expect(readTenantSession).toHaveBeenCalledWith(expect.any(Headers), alpha);
    expect((await bind(beta, "owner")).statusCode).toBe(404);
    expect(
      (await bind(alpha, "owner", "https://elsewhere.example.test")).statusCode,
    ).toBe(403);
    expect(bindScimUser).not.toHaveBeenCalled();
    expect((await bind(alpha, "owner", origin, "unavailable")).statusCode).toBe(
      404,
    );
    expect((await bind(alpha, "owner")).statusCode).toBe(204);
    expect(bindScimUser).toHaveBeenLastCalledWith(
      owner.id,
      alpha,
      scimId,
      member.id,
    );
  } finally {
    await app.close();
  }
});
