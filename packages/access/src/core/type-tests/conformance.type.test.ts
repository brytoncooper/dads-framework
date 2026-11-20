/**
 * What/why: write-law conformance checks catch missing grantable catalog
 * metadata and granting.requires permissions that do not exist on the entity.
 * Seeded violations prove the checker fails loudly before domain sweeps land.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkAccessConformance,
  missingGrantingAdvisories,
} from "../conformance.js";
import { entityHandle } from "../entity-handle.js";
import { lifecycleTrigger } from "../lifecycle.js";
import { access } from "../model.js";
import { testGrantable } from "../test-support/test-grantable.js";

const idSchema = z.string();
let wireNameSerial = 0;

function nextWireName(label: string): string {
  wireNameSerial += 1;
  return `test/${label}-${wireNameSerial}`;
}

const membershipEnds = lifecycleTrigger("membershipEnds");

describe("checkAccessConformance()", () => {
  it("passes when grantable roles have label and group and granting requires real permissions", () => {
    const Site = entityHandle({
      wireName: nextWireName("site"),
      idSchema,
    });
    const Person = entityHandle({
      wireName: "user",
      idSchema,
    });

    const site = access(Site, {
      roles: {
        admin: Person,
        formulator: testGrantable({ label: { en: "Formulate recipes" } }),
      },
      granting: {
        requires: ["manage_direct_grants"],
        removedWhen: [membershipEnds],
      },
      permissions: (roles) => ({
        view: [roles.admin],
        manage_direct_grants: [roles.admin, roles.formulator],
      }),
    });

    expect(checkAccessConformance([site.resolve()])).toEqual([]);
    expect(missingGrantingAdvisories([site.resolve()])).toEqual([]);
  });

  it("fails when granting.requires names a permission that permissions() does not declare", () => {
    const Site = entityHandle({
      wireName: nextWireName("site"),
      idSchema,
    });
    const Person = entityHandle({
      wireName: "user",
      idSchema,
    });

    const site = access(Site, {
      roles: {
        admin: Person,
        formulator: testGrantable({ label: { en: "Formulate recipes" } }),
      },
      granting: {
        // @ts-expect-error runtime conformance names a missing permission
        requires: ["not_a_real_permission"],
        removedWhen: [membershipEnds],
      },
      permissions: (roles) => ({
        view: [roles.admin],
      }),
    });

    expect(checkAccessConformance([site.resolve()])).toEqual([
      {
        fileHint: `${Site.wireName}.access.ts`,
        role: "",
        message: `Granting law on entity "${Site.wireName}" requires permission "not_a_real_permission", which is not declared in permissions().`,
      },
    ]);
  });

  it("fails when a grantable role is missing label or group", () => {
    const Site = entityHandle({
      wireName: nextWireName("site"),
      idSchema,
    });
    const Person = entityHandle({
      wireName: "user",
      idSchema,
    });

    const site = access(Site, {
      roles: {
        admin: Person,
        unnamed: testGrantable({
          label: { en: "" },
        }),
        ungrouped: testGrantable({
          label: { en: "Manage things" },
          group: { name: "", label: { en: "" } },
        }),
      },
      permissions: (roles) => ({
        view: [roles.admin],
      }),
    });

    expect(checkAccessConformance([site.resolve()])).toEqual([
      {
        fileHint: `${Site.wireName}.access.ts`,
        role: "unnamed",
        message: `Grantable role "unnamed" on entity "${Site.wireName}" is missing a label.`,
      },
      {
        fileHint: `${Site.wireName}.access.ts`,
        role: "ungrouped",
        message: `Grantable role "ungrouped" on entity "${Site.wireName}" is missing a group.`,
      },
    ]);
  });

  it("advises but does not fail when grantable roles exist without granting", () => {
    const Site = entityHandle({
      wireName: nextWireName("site"),
      idSchema,
    });
    const Person = entityHandle({
      wireName: "user",
      idSchema,
    });

    const site = access(Site, {
      roles: {
        admin: Person,
        formulator: testGrantable({ label: { en: "Formulate recipes" } }),
      },
      permissions: (roles) => ({
        view: [roles.admin],
      }),
    });

    const sealed = site.resolve();

    expect(checkAccessConformance([sealed])).toEqual([]);
    expect(missingGrantingAdvisories([sealed])).toEqual([
      {
        fileHint: `${Site.wireName}.access.ts`,
        message: `Entity "${Site.wireName}" has grantable roles but no granting block.`,
      },
    ]);
  });
});
