import { ACCESS_REFUSAL_HEADER, ACCESS_REFUSAL_VALUE } from "@dads-framework/core/contract";
import { expect } from "vitest";
import { z } from "zod";

import type { startApp } from "../assembly/start-app.js";

type Http = Awaited<ReturnType<typeof startApp>>;
type RequestHeaders = (cookie?: string) => Record<string, string>;

const rosterResponse = z.strictObject({
  data: z.array(z.strictObject({ accountId: z.string().min(1), role: z.string() })),
  meta: z.object({ total: z.number() }),
});

export async function provePermissionsBeforeInvite(
  http: Http,
  tenantId: string,
  owner: string,
  outsider: string,
  headers: RequestHeaders,
) {
  const roster = `/api/tenants/${tenantId}/members`;
  const response = await http.inject({
    method: "GET",
    url: roster,
    headers: headers(owner),
  });
  expect(response.statusCode).toBe(200);
  const { data } = rosterResponse.parse(response.json());
  expect(data.map(({ role }) => role)).toEqual(["owner"]);
  const accountId = data[0]?.accountId;
  if (accountId === undefined) throw new Error("Expected a workspace owner.");
  const permissions = `${roster}/${encodeURIComponent(accountId)}/permissions`;
  const inspected = await http.inject({
    method: "GET",
    url: permissions,
    headers: headers(owner),
  });
  expect(inspected.statusCode).toBe(200);
  expect(inspected.json()).toEqual({
    data: {
      role: "owner",
      view: true,
      manageMembers: true,
      manageTenant: true,
    },
  });
  for (const url of [roster, permissions]) {
    const denied = await http.inject({
      method: "GET",
      url,
      headers: headers(outsider),
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.headers[ACCESS_REFUSAL_HEADER]).toBe(ACCESS_REFUSAL_VALUE);
    expect((await http.inject({ method: "GET", url })).statusCode).toBe(401);
  }
  return accountId;
}

export async function provePermissionsAfterInvite(
  http: Http,
  tenantId: string,
  owner: string,
  member: string,
  headers: RequestHeaders,
) {
  const roster = `/api/tenants/${tenantId}/members`;
  const rosterRead = await http.inject({
    method: "GET",
    url: roster,
    headers: headers(owner),
  });
  const { data } = rosterResponse.parse(rosterRead.json());
  const selected = data.find(({ role }) => role === "member");
  if (selected === undefined) throw new Error("Expected an ordinary workspace member.");
  const url = `${roster}/${encodeURIComponent(selected.accountId)}/permissions`;
  const inspected = await http.inject({
    method: "GET",
    url,
    headers: headers(owner),
  });
  expect(inspected.statusCode).toBe(200);
  expect(inspected.json()).toEqual({
    data: {
      role: "member",
      view: true,
      manageMembers: false,
      manageTenant: false,
    },
  });
  for (const path of [roster, url]) {
    const denied = await http.inject({
      method: "GET",
      url: path,
      headers: headers(member),
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.headers[ACCESS_REFUSAL_HEADER]).toBe(ACCESS_REFUSAL_VALUE);
  }
}
