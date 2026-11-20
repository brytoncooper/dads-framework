import { expect } from "vitest";
import { z } from "zod";

import type { startApp } from "../assembly/start-app.js";

type Http = Awaited<ReturnType<typeof startApp>>;

const auditLine = z.object({
  position: z.int().positive(),
  tableName: z.string(),
  operation: z.enum(["insert", "update", "delete"]),
});

type AuditProof = {
  readonly customer: Http;
  readonly staff: Http;
  readonly owner: Record<string, string>;
  readonly member: Record<string, string>;
  readonly tenantId: string;
  readonly otherTenantId: string;
};

export async function proveAuditExport(proof: AuditProof) {
  const { customer, staff, owner, member, tenantId, otherTenantId } = proof;
  const url = `/api/tenants/${tenantId}/audit-log/export`;
  const betaNote = await customer.inject({
    method: "POST",
    url: `/api/tenants/${otherTenantId}/notes`,
    headers: member,
    payload: { text: "Beta's private note" },
  });
  expect(betaNote.statusCode).toBe(201);

  await proveAuditExportAccess(proof, url);
  await proveAuditExportPages(staff, url, owner, member);
  await proveAuditExportMetadata(staff, url, owner);
}

async function proveAuditExportAccess(
  { customer, staff, owner, member, otherTenantId }: AuditProof,
  url: string,
) {
  expect((await staff.inject({ url })).statusCode).toBe(401);
  expect((await customer.inject({ url, headers: owner })).statusCode).toBe(404);
  const denied = await staff.inject({ url, headers: member });
  expect(denied.statusCode).toBe(404);
  expect(denied.headers["content-type"]).toMatch(/^application\/json/u);
  expect(
    (
      await staff.inject({
        url: `/api/tenants/${otherTenantId}/audit-log/export`,
        headers: owner,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await staff.inject({ url: `${url}?beforePosition=1`, headers: owner }))
      .statusCode,
  ).toBe(400);
}

async function proveAuditExportPages(
  staff: Http,
  url: string,
  owner: AuditProof["owner"],
  member: AuditProof["member"],
) {
  const first = await staff.inject({
    url: `${url}?pageSize=1`,
    headers: owner,
  });
  expect(first.statusCode).toBe(200);
  expect(first.headers["content-type"]).toMatch(/^application\/x-ndjson\b/u);
  expect(first.headers["cache-control"]).toBe("no-store");
  expect(first.headers["content-disposition"]).toBe(
    'attachment; filename="audit-log.ndjson"',
  );
  const link = first.headers["link"];
  const next = /^<([^>]+)>; rel="next"$/u.exec(
    typeof link === "string" ? link : "",
  )?.[1];
  if (next === undefined) throw new Error("Expected a continuation link");
  expect(next.startsWith(`${url}?`)).toBe(true);
  expect((await staff.inject({ url: next, headers: member })).statusCode).toBe(
    404,
  );
  const nextPage = await staff.inject({ url: next, headers: owner });
  expect(nextPage.statusCode).toBe(200);
  expect(first.body).not.toBe(nextPage.body);
}

async function proveAuditExportMetadata(
  staff: Http,
  url: string,
  owner: AuditProof["owner"],
) {
  const complete = await staff.inject({ url, headers: owner });
  expect(complete.statusCode).toBe(200);
  const audit = complete.body
    .trimEnd()
    .split("\n")
    .map((line) => auditLine.parse(JSON.parse(line)));
  expect(
    audit.filter(({ tableName }) => tableName === "starter_note"),
  ).toHaveLength(1);
  expect(complete.body).not.toContain("rowAfter");
  expect(complete.body).not.toContain("Alpha's note");
  expect(complete.body).not.toContain("Beta's private note");
}
