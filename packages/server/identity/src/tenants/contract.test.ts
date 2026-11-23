import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assignableTenantRoleSchema, tenantIdSchema, tenantRoles } from "./contract.js";

describe("tenants/contract", () => {
  it("parses tenant IDs and assignable roles without server dependencies", () => {
    const id = tenantIdSchema.parse("550e8400-e29b-41d4-a716-446655440000");
    expect(id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(tenantIdSchema.safeParse("not-a-uuid").success).toBe(false);

    expect(tenantRoles).toEqual(["owner", "admin", "member"]);
    expect(assignableTenantRoleSchema.parse("admin")).toBe("admin");
    expect(assignableTenantRoleSchema.parse("member")).toBe("member");
    expect(assignableTenantRoleSchema.safeParse("owner").success).toBe(false);
  });

  it("imports only zod so browser bundles never pull Node builtins or database drivers", async () => {
    const source = await readFile(new URL("./contract.ts", import.meta.url), "utf8");
    const specifiers = [
      ...Array.from(source.matchAll(/\bfrom\s+["']([^"']+)["']/gu), (match) => match[1]),
      ...Array.from(source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu), (match) => match[1]),
    ];

    expect(specifiers).toEqual(["zod"]);
  });
});
