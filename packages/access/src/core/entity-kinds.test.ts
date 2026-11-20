/**
 * What/why: the list guards read an entity's kind and its sparse direct
 * grants from here, and the API's boot check refuses every entity this names
 * as undeclared, so each answer is pinned against the fake schema.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { folder, site } from "./test-support/scope-plan.access.js";
import { accessModel } from "./access-model.js";
import { entityHandle } from "./entity-handle.js";
import {
  entitiesWithoutKind,
  entityKindOf,
  isSparseDirectGrant,
} from "./entity-kinds.js";
import { access } from "./model.js";
import { scopeBindings } from "./scope-bindings.js";
import {
  allowVisibleOnRecordUntil,
  expiredVisibleRecordExceptions,
  visibleRecordException,
} from "./visible-record-exceptions.js";

const Unkinded = entityHandle({
  wireName: "test/unkinded",
  idSchema: z.string(),
});
const unkinded = access(Unkinded, { roles: {}, permissions: () => ({}) });
const model = accessModel([folder, site, unkinded]);

describe("entityKindOf", () => {
  it("answers each entity's declared kind", () => {
    expect(entityKindOf(model, "test/site")).toBe("scope");
    expect(entityKindOf(model, "test/folder")).toBe("record");
    expect(entityKindOf(model, "test/unkinded")).toBeUndefined();
    expect(entityKindOf(model, "test/never-registered")).toBeUndefined();
  });

  it("names every access definition with no declared kind", () => {
    expect(entitiesWithoutKind(model)).toContain("test/unkinded");
    expect(entitiesWithoutKind(model)).not.toContain("test/site");
  });
});

describe("isSparseDirectGrant", () => {
  it("is true only for a role the record binds sparse-direct", () => {
    const binding = scopeBindings(folder, {
      home_site: { kind: "scope-column" },
      assignee: { kind: "sparse-direct" },
    });
    const boundModel = accessModel([folder, site], [binding]);
    expect(isSparseDirectGrant(boundModel, "test/folder", "assignee")).toBe(
      true,
    );
    expect(isSparseDirectGrant(boundModel, "test/folder", "home_site")).toBe(
      false,
    );
    expect(isSparseDirectGrant(boundModel, "test/folder", "view")).toBe(false);
    expect(isSparseDirectGrant(boundModel, "test/site", "member")).toBe(false);
  });
});

describe("visible-record exceptions", () => {
  it("registers a dated exception and reports it once its day has passed", () => {
    const exception = allowVisibleOnRecordUntil("2026-11-30", {
      resourceType: "test/folder",
      removedBy: "PR #1",
    });
    const modelWithException = accessModel([folder], [], [exception]);
    expect(
      visibleRecordException(
        modelWithException,
        "test/folder",
        new Date("2026-11-30T23:59:00Z"),
      ),
    ).toEqual({
      resourceType: "test/folder",
      until: "2026-11-30",
      removedBy: "PR #1",
    });
    expect(
      expiredVisibleRecordExceptions(
        modelWithException,
        new Date("2026-11-30T23:59:00Z"),
      ),
    ).toEqual([]);
    expect(
      expiredVisibleRecordExceptions(
        modelWithException,
        new Date("2026-12-01T00:00:00Z"),
      ),
    ).toHaveLength(1);
    expect(
      visibleRecordException(
        modelWithException,
        "test/folder",
        new Date("2026-12-01T00:00:00Z"),
      ),
    ).toBeUndefined();
    expect(
      visibleRecordException(
        model,
        "test/folder",
        new Date("2026-11-30T23:59:00Z"),
      ),
    ).toBeUndefined();
  });

  it("refuses an exception without a date or without what removes it", () => {
    expect(() =>
      allowVisibleOnRecordUntil("soon", {
        resourceType: "test/folder",
        removedBy: "PR #1",
      }),
    ).toThrow("needs a YYYY-MM-DD date");
    expect(() =>
      allowVisibleOnRecordUntil("2026-11-30", {
        resourceType: "test/folder",
        removedBy: " ",
      }),
    ).toThrow("must name what removes it");
  });
});
