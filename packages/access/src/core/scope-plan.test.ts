/**
 * What/why: record lists are filtered by the plan this compiler writes, so
 * each operator's lowering, each refusal, and the startup check are pinned
 * here against a small fake schema.
 */
import { describe, expect, it } from "vitest";

import { alpha } from "./test-support/cycle-alpha.access.js";
import { beta } from "./test-support/cycle-beta.access.js";
import { folder, sheet, site } from "./test-support/scope-plan.access.js";
import { accessModel } from "./access-model.js";
import { checkScopeBindings } from "./scope-binding-check.js";
import { scopeBindings } from "./scope-bindings.js";
import {
  compileScopePlan,
  compileScopePlanInSchema,
  describeScopePlan,
  distinctScopeLookups,
  planScope,
  scopeSchema,
} from "./scope-plan.js";

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
  const model = accessModel([site, folder, sheet], [bindFolder(), bindSheet()]);

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

  it("refuses a lookup on an entity that is not a declared scope", () => {
    const registered = scopeSchema(model);
    const kinds = new Map(registered.kinds);
    kinds.delete("test/site");
    expect(() =>
      compileScopePlanInSchema(
        { ...registered, kinds },
        "test/folder",
        "view_on_site",
      ),
    ).toThrow(
      "role home_site points at test/site, which is neither a declared scope or catalog nor a record with scope bindings",
    );
  });

  it("looks up a catalog's visible ids the way it looks up a scope's", () => {
    const registered = scopeSchema(model);
    const kinds = new Map(registered.kinds);
    kinds.set("test/site", "catalog");
    expect(
      describeScopePlan(
        compileScopePlanInSchema(
          { ...registered, kinds },
          "test/folder",
          "view_on_site",
        ),
      ),
    ).toBe(
      "any(lookup(home_site: test/site#view_records), lookup(shared_site: test/site#view_records))",
    );
  });

  it("refuses a via into a record without bindings, naming the path", () => {
    const model = accessModel([site, folder, sheet], [bindSheet()]);
    expect(
      planScope(scopeSchema(model), "test/sheet", "view").failures,
    ).toEqual([
      {
        path: "test/sheet.view → via folder → test/folder.view_on_site",
        message: "test/folder is not a record with scope bindings",
      },
    ]);
  });

  it("refuses a cycle with the path that closes it", () => {
    const model = accessModel(
      [alpha, beta],
      [
        scopeBindings(alpha, { peer: { kind: "scope-column" } }),
        scopeBindings(beta, { peer: { kind: "scope-column" } }),
      ],
    );
    expect(
      planScope(scopeSchema(model), "test/alpha", "view").failures,
    ).toEqual([
      {
        path: "test/alpha.view → via peer → test/beta.view → via peer → test/alpha.view",
        message: "cycle: the rules reach this permission again",
      },
    ]);
  });
});

describe("checkScopeBindings", () => {
  it("passes with zero failures when nothing declares bindings", () => {
    expect(checkScopeBindings(accessModel([]))).toEqual([]);
  });

  it("passes for complete bindings", () => {
    const model = accessModel(
      [site, folder, sheet],
      [bindFolder(), bindSheet()],
    );
    expect(checkScopeBindings(model)).toEqual([]);
  });

  it("reports a missing binding with its path", () => {
    const binding = scopeBindings(folder, {
      home_site: { kind: "scope-column" },
      shared_site: { kind: "scope-join" },
      archived: { kind: "tag" },
      assignee: { kind: "sparse-direct" },
    });
    const model = accessModel([site, folder, sheet], [binding, bindSheet()]);
    expect(checkScopeBindings(model)).toEqual([
      { path: "test/folder.view", message: "role draft_site is not bound" },
    ]);
  });

  it("reports a cycle", () => {
    const model = accessModel(
      [alpha, beta],
      [
        scopeBindings(alpha, { peer: { kind: "scope-column" } }),
        scopeBindings(beta, { peer: { kind: "scope-column" } }),
      ],
    );
    expect(checkScopeBindings(model).map((failure) => failure.path)).toEqual([
      "test/alpha.view → via peer → test/beta.view → via peer → test/alpha.view",
      "test/beta.view → via peer → test/alpha.view → via peer → test/beta.view",
    ]);
  });
});
