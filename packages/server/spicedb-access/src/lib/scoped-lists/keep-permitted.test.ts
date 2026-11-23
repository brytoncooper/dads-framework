/**
 * What/why: the page re-check is what makes a wrong scope plan unable to leak
 * a row, so it must drop every denial (and every missing decision), keep SQL
 * order, and use the bulk check when the port has one.
 */
import { describe, expect, it } from "vitest";

import { permissionToken } from "@dads-framework/access";

import type { PermissionQuery } from "@dads-framework/access/runtime";
import { keepPermitted } from "./keep-permitted.js";

const SUBJECT = { type: "user", id: "u1" };
const VIEW = permissionToken("listfixture/folder", "view");
const rows = Array.from({ length: 300 }, (_, index) => ({
  id: `f${index}`,
  position: index,
}));
const allowedId = (id: string): boolean => Number(id.slice(1)) % 3 === 0;

describe("keepPermitted", () => {
  it("drops denials and keeps SQL order with single checks", async () => {
    const asked: PermissionQuery[] = [];
    const kept = await keepPermitted(
      {
        check: (query) => {
          asked.push(query);
          return Promise.resolve(allowedId(query.resource.id));
        },
      },
      SUBJECT,
      VIEW,
      rows,
    );
    expect(kept.map((row) => row.position)).toEqual(rows.filter((row) => allowedId(row.id)).map((row) => row.position));
    expect(asked).toHaveLength(300);
    expect(asked[0]).toEqual({
      subject: SUBJECT,
      permission: "view",
      resource: { type: "listfixture/folder", id: "f0" },
    });
  });

  it("asks the bulk check in bounded batches when the port has one", async () => {
    const batches: (readonly PermissionQuery[])[] = [];
    let singleChecks = 0;
    const kept = await keepPermitted(
      {
        check: () => {
          singleChecks += 1;
          return Promise.resolve(true);
        },
        checkMany: (queries) => {
          batches.push(queries);
          return Promise.resolve(queries.map((query) => allowedId(query.resource.id)));
        },
      },
      SUBJECT,
      VIEW,
      rows,
    );
    expect(kept).toEqual(rows.filter((row) => allowedId(row.id)));
    expect(batches.map((batch) => batch.length)).toEqual([128, 128, 44]);
    expect(singleChecks).toBe(0);
  });

  it("drops a row whose decision is missing", async () => {
    const kept = await keepPermitted(
      {
        check: () => Promise.resolve(true),
        checkMany: () => Promise.resolve([true]),
      },
      SUBJECT,
      VIEW,
      rows.slice(0, 3),
    );
    expect(kept.map((row) => row.id)).toEqual(["f0"]);
  });
});
