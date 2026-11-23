import { describe, expect, it, vi } from "vitest";

import { createAuditLogExporter } from "./create-audit-log-exporter.js";

describe("audit log export authorization", () => {
  it("denies a tenant without an export grant before reading audit rows", async () => {
    const listRows = vi.fn();
    const authorize = vi.fn((tenantId: string) => Promise.resolve(tenantId === "mine"));
    const exportPage = createAuditLogExporter({
      reader: { listRows },
      tenantDimension: "workspace",
      authorize,
    });

    await expect(
      exportPage({
        tenantId: "elsewhere",
        olderThan: { position: 1, recordedAt: "2026-10-22T10:00:00.000001Z" },
      }),
    ).resolves.toEqual({ kind: "denied" });
    expect(authorize).toHaveBeenCalledWith("elsewhere");
    expect(listRows).not.toHaveBeenCalled();
  });

  it.each([
    { tenantId: "" },
    { tenantId: "mine", pageSize: 501 },
    { tenantId: "mine", scope: { kind: "platform" } },
    { tenantId: "mine", olderThan: { position: 1, recordedAt: "yesterday" } },
  ])("rejects invalid requests before authorizing or reading rows ($tenantId)", async (request) => {
    const listRows = vi.fn();
    const authorize = vi.fn(() => true);
    const exportPage = createAuditLogExporter({
      reader: { listRows },
      tenantDimension: "workspace",
      authorize,
    });

    await expect(exportPage(request)).rejects.toMatchObject({
      name: "ZodError",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(listRows).not.toHaveBeenCalled();
  });
});
