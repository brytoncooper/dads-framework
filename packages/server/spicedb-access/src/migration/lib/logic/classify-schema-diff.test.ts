// The classifier decides whether a schema change needs a relationship step:
// it must call destructive exactly what SpiceDB's WriteSchema will refuse
// (removed definitions, relations, allowed types) and nothing else --
// permission changes store no relationships and stay additive.
import { describe, expect, it } from "vitest";
import { classifySchemaDiff } from "./classify-schema-diff.js";

const BASE = `
definition user {}

definition test/document {
  relation owner: user
  relation editor: user | test/team#member
  permission view = owner + editor
}
`;

describe("classifySchemaDiff", () => {
  it("pure additions are additive", () => {
    const next = `${BASE}
definition test/folder {
  relation owner: user
}
`;
    expect(classifySchemaDiff(BASE, next)).toEqual({ kind: "additive" });
  });

  it("permission-only changes are additive — permissions store nothing", () => {
    const next = BASE.replace("permission view = owner + editor", "permission view = owner");
    expect(classifySchemaDiff(BASE, next)).toEqual({ kind: "additive" });
  });

  it("a removed relation is destructive", () => {
    const next = BASE.replace("relation editor: user | test/team#member\n", "");
    expect(classifySchemaDiff(BASE, next)).toEqual({
      kind: "destructive",
      removals: ["relation test/document#editor"],
    });
  });

  it("a removed definition is destructive", () => {
    const next = BASE.replace(/definition test\/document \{[\s\S]*?\}\n/, "");
    expect(classifySchemaDiff(BASE, next)).toEqual({
      kind: "destructive",
      removals: ["definition test/document"],
    });
  });

  it("a removed allowed subject type on a surviving relation is destructive", () => {
    const next = BASE.replace("relation editor: user | test/team#member", "relation editor: user");
    expect(classifySchemaDiff(BASE, next)).toEqual({
      kind: "destructive",
      removals: ["allowed type test/team#member on test/document#editor"],
    });
  });

  it("reads a patch's spaced canonical tokens as the same allowed types", () => {
    const previous = `
definition test/document {
  relation editor: user | test/team#member
  relation reader: user:* | test/team#member
}
`;
    const canonical = `
definition test/document {

  relation editor : user | test/team # member 
  relation reader : user : * | test/team # member 
}
`;
    expect(classifySchemaDiff(previous, canonical)).toEqual({
      kind: "additive",
    });
    expect(classifySchemaDiff(previous, canonical.replace("user : * | ", ""))).toEqual({
      kind: "destructive",
      removals: ["allowed type user:* on test/document#reader"],
    });
  });

  it("a renamed relation is a removal plus an addition — destructive", () => {
    const next = BASE.replace("relation owner:", "relation holder:");
    expect(classifySchemaDiff(BASE, next)).toEqual({
      kind: "destructive",
      removals: ["relation test/document#owner"],
    });
  });

  it("comments and one-line empty definitions parse", () => {
    const previous = `
// a comment with definition words in it
definition authz/migration_version {}
definition test/thing {
  relation owner: user // trailing comment
}
`;
    expect(classifySchemaDiff(previous, previous)).toEqual({
      kind: "additive",
    });
    expect(classifySchemaDiff(previous, "definition user {}\n")).toEqual({
      kind: "destructive",
      removals: ["definition authz/migration_version", "definition test/thing"],
    });
  });
});
