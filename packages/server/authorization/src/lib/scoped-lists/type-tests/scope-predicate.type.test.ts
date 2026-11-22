/**
 * What/why: a scoped list's WHERE is rendered from the compiled plan, so the
 * SQL each operator lowers to, the one-array-parameter rule, the NULL-safe
 * negation, and every wiring refusal are pinned here without a database.
 * Agreement with SpiceDB is proved by prove-scope-matches-lookup.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  describeScopePlan,
  type ScopeBindings,
} from "@dads-framework/access/scopes";

import {
  answerScope,
  planScopedList,
  type ScopeAnswer,
  scopeQuestionKey,
  scopeQuestions,
} from "@dads-framework/access/runtime";
import { scopePredicate } from "../scope-predicate.js";
import { scopeSqlBindings } from "../scope-sql-bindings.js";
import {
  fixtureAccess,
  folders,
  folderScope,
  folderSql,
  sheetScope,
  sheetSql,
} from "../testing/scoped-list-fixture.js";

const SUBJECT = { type: "listfixture/member", id: "m1" };
const dialect = new PgDialect();

/** An answer whose every question returns `ids`. */
function answerEvery(
  resourceType: string,
  permission: string,
  idsFor: (key: string) => readonly string[],
): ScopeAnswer {
  const plan = planScopedList(fixtureAccess, resourceType, permission);
  return {
    resourceType,
    permission,
    plan,
    subject: SUBJECT,
    idsByQuestion: new Map(
      scopeQuestions(plan, resourceType).map((question) => {
        const key = scopeQuestionKey(question);
        return [key, idsFor(key)];
      }),
    ),
  };
}

describe("scopeQuestions / answerScope", () => {
  it("asks each scope lookup once, and a via's direct grant on the walked-to record", () => {
    const plan = planScopedList(fixtureAccess, "listfixture/sheet", "view");
    expect(scopeQuestions(plan, "listfixture/sheet")).toEqual([
      { resourceType: "listfixture/site", permission: "view_records" },
      { resourceType: "listfixture/site", permission: "archive_records" },
      { resourceType: "listfixture/site", permission: "audit_records" },
      { resourceType: "listfixture/site", permission: "blocked_here" },
      { resourceType: "listfixture/folder", permission: "assignee" },
      { resourceType: "listfixture/site", permission: "manage_records" },
    ]);
  });

  it("keeps empty answers rather than short-circuiting the list", async () => {
    const asked: string[] = [];
    const answer = await answerScope({
      resourceType: "listfixture/folder",
      permission: "view",
      plan: planScopedList(fixtureAccess, "listfixture/folder", "view"),
      subject: SUBJECT,
      lookups: {
        lookupResources: (query) => {
          asked.push(`${query.resourceType}#${query.permission}`);
          return Promise.resolve(
            query.permission === "view_records" ? ["s1"] : [],
          );
        },
      },
    });
    expect(asked).toEqual([
      "listfixture/site#view_records",
      "listfixture/site#archive_records",
      "listfixture/site#audit_records",
      "listfixture/site#blocked_here",
      "listfixture/folder#assignee",
    ]);
    expect(answer.idsByQuestion.get("listfixture/site#view_records")).toEqual([
      "s1",
    ]);
    expect(answer.idsByQuestion.get("listfixture/folder#assignee")).toEqual([]);
  });
});

describe("scopePredicate", () => {
  it("renders the sheet plan: a via into the folder, a not, and every folder operator", () => {
    const answer = answerEvery("listfixture/sheet", "view", (key) => [
      `${key}-id`,
    ]);
    expect(describeScopePlan(answer.plan)).toBe(
      [
        "any(",
        "all(via(folder: listfixture/folder, any(",
        "lookup(home_site: listfixture/site#view_records), ",
        "lookup(shared_site: listfixture/site#view_records), ",
        "all(lookup(fallback_site: listfixture/site#archive_records), tag(archived)), ",
        "all(lookup(shared_site: listfixture/site#audit_records), not(lookup(shared_site: listfixture/site#blocked_here))), ",
        "direct(assignee))), ",
        "not(lookup(site: listfixture/site#blocked_here))), ",
        "lookup(site: listfixture/site#manage_records))",
      ].join(""),
    );

    const query = dialect.sqlToQuery(
      scopePredicate(answer, sheetSql, [folderSql]),
    );
    expect(query.sql).toBe(
      [
        '((EXISTS (SELECT 1 FROM "scoped_list_folders" WHERE "scoped_list_folders"."id" = "scoped_list_sheets"."folder_id" AND (',
        '"scoped_list_folders"."home_site_id" = ANY($1::uuid[]) OR ',
        '(EXISTS (SELECT 1 FROM "scoped_list_folder_shares" WHERE "scoped_list_folder_shares"."folder_id" = "scoped_list_folders"."id" AND "scoped_list_folder_shares"."site_id" = ANY($2::uuid[]))) OR ',
        '(("scoped_list_folders"."home_site_id" = ANY($3::uuid[]) AND NOT EXISTS (SELECT 1 FROM "scoped_list_folder_shares" WHERE "scoped_list_folder_shares"."folder_id" = "scoped_list_folders"."id")) AND ("scoped_list_folders"."archived")) OR ',
        '((EXISTS (SELECT 1 FROM "scoped_list_folder_shares" WHERE "scoped_list_folder_shares"."folder_id" = "scoped_list_folders"."id" AND "scoped_list_folder_shares"."site_id" = ANY($4::uuid[]))) AND NOT COALESCE(((EXISTS (SELECT 1 FROM "scoped_list_folder_shares" WHERE "scoped_list_folder_shares"."folder_id" = "scoped_list_folders"."id" AND "scoped_list_folder_shares"."site_id" = ANY($5::uuid[])))), FALSE)) OR ',
        '"scoped_list_folders"."id" = ANY($6::uuid[]))) AND ',
        'NOT COALESCE(("scoped_list_sheets"."site_id" = ANY($7::uuid[])), FALSE)) OR ',
        '"scoped_list_sheets"."site_id" = ANY($8::uuid[]))',
      ].join(""),
    );
    expect(query.params).toEqual([
      ["listfixture/site#view_records-id"],
      ["listfixture/site#view_records-id"],
      ["listfixture/site#archive_records-id"],
      ["listfixture/site#audit_records-id"],
      ["listfixture/site#blocked_here-id"],
      ["listfixture/folder#assignee-id"],
      ["listfixture/site#blocked_here-id"],
      ["listfixture/site#manage_records-id"],
    ]);
  });

  it("passes a large id set as one array parameter, never one parameter per id", () => {
    const ids = Array.from({ length: 70_000 }, (_, index) => `id-${index}`);
    const answer = answerEvery("listfixture/folder", "view", () => ids);
    const query = dialect.sqlToQuery(scopePredicate(answer, folderSql));
    expect(query.params).toHaveLength(6);
    expect(query.params[0]).toHaveLength(70_000);
  });

  it("refuses an answer for another record type", () => {
    const answer = answerEvery("listfixture/sheet", "view", () => []);
    expect(() => scopePredicate(answer, folderSql)).toThrow(
      "scope answer is for listfixture/sheet but the SQL bindings are for listfixture/folder",
    );
  });

  it("refuses an answer missing one of the plan's questions", () => {
    const answer = answerEvery("listfixture/folder", "view", () => []);
    const partial: ScopeAnswer = {
      ...answer,
      idsByQuestion: new Map(
        [...answer.idsByQuestion].filter(
          ([key]) => key !== "listfixture/folder#assignee",
        ),
      ),
    };
    expect(() => scopePredicate(partial, folderSql)).toThrow(
      "scope answer has no ids for listfixture/folder#assignee; build it with answerScope for the same plan",
    );
  });
});

describe("scopeSqlBindings", () => {
  it("makes a kind mismatch a type error when the declared kinds are in view", () => {
    expect(() =>
      scopeSqlBindings(sheetScope, {
        table: folders,
        id: folders.id,
        roles: {
          // @ts-expect-error — folder is declared scope-column, not tag
          folder: { kind: "tag", condition: sql`true` },
          site: { kind: "scope-column", column: folders.homeSiteId },
        },
      }),
    ).toThrow("role folder is bound as scope-column but its SQL is for tag");

    expect(() =>
      scopeSqlBindings(sheetScope, {
        table: folders,
        id: folders.id,
        // @ts-expect-error — the declared scope-column role site needs SQL
        roles: {
          folder: { kind: "scope-column", column: folders.homeSiteId },
        },
      }),
    ).toThrow("role site is bound as scope-column but has no SQL");
  });

  it("refuses mismatched, missing, extra, and sparse-direct SQL at registration", () => {
    const erased: ScopeBindings = folderScope;
    expect(() =>
      scopeSqlBindings(erased, {
        table: folders,
        id: folders.id,
        roles: {
          home_site: { kind: "tag", condition: sql`true` },
          fallback_site: { kind: "derived", matches: (ids) => ids },
          archived: { kind: "tag", condition: sql`true` },
          assignee: { kind: "scope-column", column: folders.id },
          shelf: { kind: "scope-column", column: folders.id },
        },
      }),
    ).toThrow(
      [
        "scope SQL bindings for listfixture/folder do not match its scope bindings:",
        "  role home_site is bound as scope-column but its SQL is for tag",
        "  role shared_site is bound as scope-join but has no SQL",
        "  role assignee is sparse-direct and takes no SQL; the plan matches it on the id column",
        "  SQL names role shelf, which the scope bindings do not bind",
      ].join("\n"),
    );
  });
});
