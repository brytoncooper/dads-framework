/**
 * What/why: write-law conformance checks catch missing grantable catalog
 * metadata and granting.requires permissions that do not exist on the entity.
 * Seeded violations prove the checker fails loudly before domain sweeps land.
 */
import { describe, expect, it } from "vitest";

import { checkAccessConformance, lifecycleTrigger, missingGrantingAdvisories } from "../../catalog.js";
import { actor, compileAccess, resource } from "../../index.js";
import { testGrantable } from "../test-support/test-grantable.js";

let wireNameSerial = 0;

function nextWireName(label: string): string {
  wireNameSerial += 1;
  return `test/${label}-${wireNameSerial}`;
}

const membershipEnds = lifecycleTrigger("membershipEnds");

describe("checkAccessConformance()", () => {
  it("passes when grantable roles have label and group and granting requires real permissions", () => {
    const user = actor("user");
    const site = resource(nextWireName("site"), {
      roles: {
        admin: user,
        formulator: testGrantable({ label: { en: "Formulate recipes" } }),
      },
      granting: {
        requires: ["manage_direct_grants"],
        removedWhen: [membershipEnds],
      },
      can: ({ admin, formulator }) => ({
        view: admin,
        manage_direct_grants: [admin, formulator],
      }),
    });

    const definitions = compileAccess([site]).definitions;
    expect(checkAccessConformance(definitions)).toEqual([]);
    expect(missingGrantingAdvisories(definitions)).toEqual([]);
  });

  it("fails when granting.requires names a permission that can() does not declare", () => {
    const user = actor("user");
    const siteWireName = nextWireName("site");
    const site = resource(siteWireName, {
      roles: {
        admin: user,
        formulator: testGrantable({ label: { en: "Formulate recipes" } }),
      },
      granting: {
        // @ts-expect-error runtime conformance names a missing permission
        requires: ["not_a_real_permission"],
        removedWhen: [membershipEnds],
      },
      can: ({ admin }) => ({
        view: admin,
      }),
    });

    const definitions = compileAccess([site]).definitions;
    expect(checkAccessConformance(definitions)).toEqual([
      {
        fileHint: `${siteWireName}.access.ts`,
        role: "",
        message: `Granting law on entity "${siteWireName}" requires permission "not_a_real_permission", which is not declared in permissions().`,
      },
    ]);
  });

  it("fails when a grantable role is missing label or group", () => {
    const user = actor("user");
    const siteWireName = nextWireName("site");
    const site = resource(siteWireName, {
      roles: {
        admin: user,
        unnamed: testGrantable({
          label: { en: "" },
        }),
        ungrouped: testGrantable({
          label: { en: "Manage things" },
          group: { name: "", label: { en: "" } },
        }),
      },
      can: ({ admin }) => ({
        view: admin,
      }),
    });

    const definitions = compileAccess([site]).definitions;
    expect(checkAccessConformance(definitions)).toEqual([
      {
        fileHint: `${siteWireName}.access.ts`,
        role: "unnamed",
        message: `Grantable role "unnamed" on entity "${siteWireName}" is missing a label.`,
      },
      {
        fileHint: `${siteWireName}.access.ts`,
        role: "ungrouped",
        message: `Grantable role "ungrouped" on entity "${siteWireName}" is missing a group.`,
      },
    ]);
  });

  it("advises but does not fail when grantable roles exist without granting", () => {
    const user = actor("user");
    const siteWireName = nextWireName("site");
    const site = resource(siteWireName, {
      roles: {
        admin: user,
        formulator: testGrantable({ label: { en: "Formulate recipes" } }),
      },
      can: ({ admin }) => ({
        view: admin,
      }),
    });

    const definitions = compileAccess([site]).definitions;
    expect(checkAccessConformance(definitions)).toEqual([]);
    expect(missingGrantingAdvisories(definitions)).toEqual([
      {
        fileHint: `${siteWireName}.access.ts`,
        message: `Entity "${siteWireName}" has grantable roles but no granting block.`,
      },
    ]);
  });
});
