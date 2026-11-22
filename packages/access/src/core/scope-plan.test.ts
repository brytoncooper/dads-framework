/**
 * What/why: record lists are filtered by the plan this compiler writes, so
 * each operator's lowering, each refusal, the fail-closed lookup policy, and
 * the startup check are pinned here against a small fake schema.
 */
import { describe, expect, it } from "vitest";

import { compileAccess } from "../index.js";
import {
  checkScopeBindings,
  compileScopePlan,
  compileScopePlanInSchema,
  describeScopePlan,
  distinctScopeLookups,
  isLookupResourcesAllowed,
  isSparseDirectGrant,
  planScope,
  scopeBindings,
  scopeSchema,
} from "../scopes.js";
import { alpha } from "./test-support/cycle-alpha.access.js";
import { beta } from "./test-support/cycle-beta.access.js";
import { folder, sheet, site } from "./test-support/scope-plan.access.js";

function bindFolder() {
  return scopeBindings(folder, {
    home_site: { kind: "scope-column" },
    shared_site: { kind: "scope-join" },
    draft_site: { kind: "derived" },
    archived: { kind: "tag" },
    assignee: { kind: "sparse-direct" },
    reader: { kind: "scope-column" },
  });
}

function bindSheet() {
  return scopeBindings(sheet, {
    folder: { kind: "scope-column" },
    site: { kind: "scope-column" },
  });
}

describe("compileScopePlan", () => {
  const model = compileAccess([site, folder, sheet], {
    bindings: [bindFolder(), bindSheet()],
    allowLookupResourcesOn: [site],
  });

  it("lowers every operator and inlines the sibling permission", () => {
    expect(
      describeScopePlan(compileScopePlan(model, "test/folder", "view")),
    ).toBe(
      [
        "any(",
        "lookup(home_site: test/site#view_records), ",
        "lookup(shared_site: test/site#view_records), ",
        "all(lookup(draft_site: test/site#view_records), tag(archived)), ",
        "all(lookup(shared_site: test/site#manage_records), not(lookup(shared_site: test/site#blocked_here))), ",
        "all(lookup(home_site: test/site#manage_records), lookup(draft_site: test/site#manage_records)), ",
        "direct(assignee))",
      ].join(""),
    );
  });

  it("keeps the plan as plain data", () => {
    const plan = compileScopePlan(model, "test/folder", "view_on_site");
    expect(JSON.parse(JSON.stringify(plan))).toEqual({
      kind: "any",
      plans: [
        {
          kind: "lookup",
          role: "home_site",
          targetType: "test/site",
          targetPermission: "view_records",
        },
        {
          kind: "lookup",
          role: "shared_site",
          targetType: "test/site",
          targetPermission: "view_records",
        },
      ],
    });
  });

  it("asks each distinct lookup once", () => {
    const plan = compileScopePlan(model, "test/folder", "view");
    expect(distinctScopeLookups(plan)).toEqual([
      { targetType: "test/site", targetPermission: "view_records" },
      { targetType: "test/site", targetPermission: "manage_records" },
      { targetType: "test/site", targetPermission: "blocked_here" },
    ]);
  });

  it("walks into another bound record with via", () => {
    expect(
      describeScopePlan(compileScopePlan(model, "test/sheet", "view")),
    ).toBe(
      "all(via(folder: test/folder, any(lookup(home_site: test/site#view_records), lookup(shared_site: test/site#view_records))), lookup(site: test/site#view_records))",
    );
  });

  it("merges walks through the same role inside any", () => {
    expect(
      describeScopePlan(
        compileScopePlan(model, "test/sheet", "view_or_manage_folder"),
      ),
    ).toBe(
      "via(folder: test/folder, any(lookup(home_site: test/site#view_records), lookup(shared_site: test/site#view_records), lookup(home_site: test/site#manage_records)))",
    );
  });

  it("refuses a direct role that is not a tag or sparse grant", () => {
    expect(() =>
      compileScopePlan(model, "test/folder", "read_directly"),
    ).toThrow(
      "test/folder.read_directly: role reader is bound as scope-column but used directly; a direct role must be bound as tag or sparse-direct",
    );
  });

  it("refuses an unbound role", () => {
    expect(
      planScope(scopeSchema(model), "test/folder", "view_unbound"),
    ).toEqual({
      plan: undefined,
      failures: [
        {
          path: "test/folder.view_unbound",
          message: "role unbound_site is not bound",
        },
      ],
    });
  });

  it("refuses a lookup on an entity not in allowLookupResourcesOn", () => {
    const registered = scopeSchema(model);
    const lookupAllowlist = new Set(registered.lookupAllowlist);
    lookupAllowlist.delete("test/site");
    expect(() =>
      compileScopePlanInSchema(
        { ...registered, lookupAllowlist },
        "test/folder",
        "view_on_site",
      ),
    ).toThrow(
      "role home_site points at test/site, which is neither in allowLookupResourcesOn nor a record with scope bindings",
    );
  });

  it("refuses a role pointing at a resource that has neither bindings nor lookup allowlist", () => {
    const unboundFolderModel = compileAccess([site, folder, sheet], {
      bindings: [bindSheet()],
      allowLookupResourcesOn: [site],
    });
    expect(
      planScope(scopeSchema(unboundFolderModel), "test/sheet", "view").failures,
    ).toEqual([
      {
        path: "test/sheet.view",
        message:
          "role folder points at test/folder, which is neither in allowLookupResourcesOn nor a record with scope bindings",
      },
    ]);
  });

  it("refuses a cycle with the path that closes it", () => {
    const cyclicModel = compileAccess([alpha, beta], {
      bindings: [
        scopeBindings(alpha, { peer: { kind: "scope-column" } }),
        scopeBindings(beta, { peer: { kind: "scope-column" } }),
      ],
    });
    expect(
      planScope(scopeSchema(cyclicModel), "test/alpha", "view").failures,
    ).toEqual([
      {
        path: "test/alpha.view → via peer → test/beta.view → via peer → test/alpha.view",
        message: "cycle: the rules reach this permission again",
      },
    ]);
  });
});

describe("isLookupResourcesAllowed & isSparseDirectGrant", () => {
  it("fails closed unless explicitly listed in allowLookupResourcesOn and never allows bound records", () => {
    const model = compileAccess([site, folder, sheet], {
      bindings: [bindFolder(), bindSheet()],
      allowLookupResourcesOn: [site, folder],
    });

    expect(isLookupResourcesAllowed(model, "test/site")).toBe(true);
    // Bound records are ALWAYS denied even if also listed in allowLookupResourcesOn.
    expect(isLookupResourcesAllowed(model, "test/folder")).toBe(false);
    expect(isLookupResourcesAllowed(model, "test/sheet")).toBe(false);
    // Undeclared or unlisted entities fail closed.
    expect(isLookupResourcesAllowed(model, "test/member")).toBe(false);
    expect(isLookupResourcesAllowed(model, "test/unknown")).toBe(false);

    // Without allowLookupResourcesOn at all, every entity fails closed.
    const defaultModel = compileAccess([site, folder, sheet]);
    expect(isLookupResourcesAllowed(defaultModel, "test/site")).toBe(false);

    // Sparse-direct grants are identified purely from scope bindings.
    expect(isSparseDirectGrant(model, "test/folder", "assignee")).toBe(true);
    expect(isSparseDirectGrant(model, "test/folder", "home_site")).toBe(false);
    expect(isSparseDirectGrant(model, "test/site", "member")).toBe(false);
  });

  it("rejects allowLookupResourcesOn naming a missing definition", () => {
    expect(() =>
      compileAccess([site], { allowLookupResourcesOn: ["test/missing"] }),
    ).toThrow(
      "allowLookupResourcesOn names missing access definition test/missing",
    );
  });
});

describe("checkScopeBindings", () => {
  it("passes with zero failures when nothing declares bindings", () => {
    expect(checkScopeBindings(compileAccess([]))).toEqual([]);
  });

  it("passes for complete bindings", () => {
    const model = compileAccess([site, folder, sheet], {
      bindings: [bindFolder(), bindSheet()],
      allowLookupResourcesOn: [site],
    });
    expect(checkScopeBindings(model)).toEqual([]);
  });

  it("reports when an entity is both in allowLookupResourcesOn and has scope bindings", () => {
    const model = compileAccess([site, folder, sheet], {
      bindings: [bindFolder(), bindSheet()],
      allowLookupResourcesOn: [site, folder],
    });
    expect(checkScopeBindings(model)).toEqual([
      {
        path: "test/folder.view",
        message:
          "test/folder is listed in allowLookupResourcesOn but also has scope bindings",
      },
    ]);
  });

  it("reports a missing binding with its path", () => {
    const binding = scopeBindings(folder, {
      home_site: { kind: "scope-column" },
      shared_site: { kind: "scope-join" },
      archived: { kind: "tag" },
      assignee: { kind: "sparse-direct" },
    });
    const model = compileAccess([site, folder, sheet], {
      bindings: [binding, bindSheet()],
      allowLookupResourcesOn: [site],
    });
    expect(checkScopeBindings(model)).toEqual([
      { path: "test/folder.view", message: "role draft_site is not bound" },
    ]);
  });

  it("reports a cycle", () => {
    const model = compileAccess([alpha, beta], {
      bindings: [
        scopeBindings(alpha, { peer: { kind: "scope-column" } }),
        scopeBindings(beta, { peer: { kind: "scope-column" } }),
      ],
    });
    expect(checkScopeBindings(model).map((failure) => failure.path)).toEqual([
      "test/alpha.view → via peer → test/beta.view → via peer → test/alpha.view",
      "test/beta.view → via peer → test/alpha.view → via peer → test/beta.view",
    ]);
  });
});
