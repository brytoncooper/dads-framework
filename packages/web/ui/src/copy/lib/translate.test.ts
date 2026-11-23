import { describe, expect, it } from "vitest";
import { copy } from "./copy-descriptor.js";
import { defineCopy } from "./localized-text.js";
import { translate, type CopyKey } from "./translate.js";

/**
 * What: a key becoming a sentence — interpolation, plural selection by count,
 * nested fragments pluralized independently, and the three ways it refuses.
 * Why: the refusals are the half worth pinning. Rendering the key instead of
 * throwing is how `permissions.page.title` reaches a screen and stays there: it
 * looks deliberate enough to survive review, and no test anywhere would fail.
 */

const permissionsCopy = defineCopy({
  "permissions.page.title": { en: "Permission Roles" },
  "permissions.at": { en: "Roles at {facility}" },
  "permissions.summary": { en: "{holders} across {groups}" },
  "permissions.holders.none": { en: "Nobody holds this role" },
  "permissions.holders_one": { en: "1 person" },
  "permissions.holders_other": { en: "{count} people" },
  "permissions.groups_one": { en: "1 group" },
  "permissions.groups_other": { en: "{count} groups" },
});

type PermissionsCopyKey = CopyKey<typeof permissionsCopy>;

describe("translate", () => {
  it("resolves a bare key", () => {
    expect(translate(permissionsCopy, "en", "permissions.page.title")).toBe("Permission Roles");
  });

  it("fills {name} slots from vars", () => {
    expect(
      translate(permissionsCopy, "en", "permissions.at", {
        facility: "Cedar Rapids",
      }),
    ).toBe("Roles at Cedar Rapids");
  });

  it("resolves a descriptor exactly as it resolves a key", () => {
    expect(translate(permissionsCopy, "en", copy("permissions.at", { facility: "Cedar Rapids" }))).toBe(
      "Roles at Cedar Rapids",
    );
  });

  it("selects the singular and plural forms by count", () => {
    expect(translate(permissionsCopy, "en", "permissions.holders", {}, 1)).toBe("1 person");
    expect(translate(permissionsCopy, "en", "permissions.holders", {}, 4)).toBe("4 people");
    expect(translate(permissionsCopy, "en", "permissions.holders", {}, 0)).toBe("0 people");
  });

  it("fills {count} from the count itself — no second argument", () => {
    expect(translate(permissionsCopy, "en", copy("permissions.holders", {}, 1200))).toBe("1,200 people");
  });

  it("pluralizes nested fragments independently", () => {
    const sentence = copy("permissions.summary", {
      holders: copy("permissions.holders", {}, 1),
      groups: copy("permissions.groups", {}, 3),
    });

    expect(translate(permissionsCopy, "en", sentence)).toBe("1 person across 3 groups");
  });

  it("interpolates a plain number without ceremony", () => {
    expect(translate(permissionsCopy, "en", "permissions.at", { facility: 1200 })).toBe("Roles at 1,200");
  });

  it("throws on a key the catalog does not declare — never renders the key", () => {
    expect(() => translate(permissionsCopy, "en", "permissions.page.titel")).toThrow(
      /"permissions\.page\.titel" is not declared/,
    );
  });

  it("throws when a pluralized key has no form to select", () => {
    expect(() => translate(permissionsCopy, "en", "permissions.missing", {}, 2)).toThrow(
      /pluralizes but the catalog declares neither/,
    );
  });

  it("throws when a slot has nothing to fill it", () => {
    expect(() => translate(permissionsCopy, "en", "permissions.at")).toThrow(
      /interpolates \{facility\} and nothing was given/,
    );
  });

  it("throws on a malformed placeholder instead of rendering it literally", () => {
    const malformedCopy = defineCopy({
      "permissions.company": { en: "Roles at {company-name}" },
    });

    expect(() =>
      translate(malformedCopy, "en", "permissions.company", {
        companyName: "Acme",
      }),
    ).toThrow(/permissions\.company.*\{company-name\}/s);
  });

  it("leaves a sentence with no slots untouched", () => {
    expect(translate(permissionsCopy, "en", "permissions.holders.none")).toBe("Nobody holds this role");
  });
});

describe("CopyKey", () => {
  it("admits a declared key", () => {
    const key: PermissionsCopyKey = "permissions.page.title";
    expect(key).toBe("permissions.page.title");
  });

  it("admits the base of a plural pair, which the catalog never spells", () => {
    const key: PermissionsCopyKey = "permissions.holders";
    expect(translate(permissionsCopy, "en", key, {}, 1)).toBe("1 person");
  });
});
