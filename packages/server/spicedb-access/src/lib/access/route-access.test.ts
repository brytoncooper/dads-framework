import { describe, expect, it } from "vitest";
import { evaluateRouteAccess } from "@dads-framework/access/runtime";

const param = (name: string) => ({ kind: "param", name }) as const;

const subject = { type: "user", id: "u1" };
const permission = {
  resourceType: "organizations/organization",
  permission: "view",
  source: param("id"),
};

describe("evaluateRouteAccess", () => {
  it("allows @Public routes without a subject", () => {
    const verdict = evaluateRouteAccess({
      isPublic: true,
      sessionOnly: false,
      permission: undefined,
      subject: null,
      resourceId: undefined,
    });
    expect(verdict).toEqual({ outcome: "allow" });
  });

  it("allows unannotated routes (outside the domain walls)", () => {
    const verdict = evaluateRouteAccess({
      isPublic: false,
      sessionOnly: false,
      permission: undefined,
      subject: null,
      resourceId: undefined,
    });
    expect(verdict).toEqual({ outcome: "allow" });
  });

  it("401s @RequireSession without a subject", () => {
    const verdict = evaluateRouteAccess({
      isPublic: false,
      sessionOnly: true,
      permission: undefined,
      subject: null,
      resourceId: undefined,
    });
    expect(verdict).toEqual({ outcome: "unauthenticated" });
  });

  it("allows @RequireSession with a subject — the use-case owns authorization", () => {
    const verdict = evaluateRouteAccess({
      isPublic: false,
      sessionOnly: true,
      permission: undefined,
      subject,
      resourceId: undefined,
    });
    expect(verdict).toEqual({ outcome: "allow" });
  });

  it("requests a check for @RequirePermission with subject and resource id", () => {
    const verdict = evaluateRouteAccess({
      isPublic: false,
      sessionOnly: false,
      permission,
      subject,
      resourceId: "org-1",
    });
    expect(verdict).toEqual({
      outcome: "check",
      resource: { type: "organizations/organization", id: "org-1" },
      permission: "view",
    });
  });

  it("resolves the check result to allow / not-found (never a 403)", () => {
    const base = {
      isPublic: false,
      sessionOnly: false,
      permission,
      subject,
      resourceId: "org-1",
    };
    expect(evaluateRouteAccess({ ...base, checkResult: true })).toEqual({
      outcome: "allow",
    });
    expect(evaluateRouteAccess({ ...base, checkResult: false })).toEqual({
      outcome: "not-found",
    });
  });

  it("fails closed as not-found when the route param is missing", () => {
    const verdict = evaluateRouteAccess({
      isPublic: false,
      sessionOnly: false,
      permission,
      subject,
      resourceId: undefined,
    });
    expect(verdict).toEqual({ outcome: "not-found" });
  });

  it("401s @RequirePermission without a subject", () => {
    const verdict = evaluateRouteAccess({
      isPublic: false,
      sessionOnly: false,
      permission,
      subject: null,
      resourceId: "org-1",
    });
    expect(verdict).toEqual({ outcome: "unauthenticated" });
  });
});
