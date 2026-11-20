import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PAGINATION_DEFAULT_PER_PAGE,
  PAGINATION_MAX_PER_PAGE,
  paginatedResponseSchema,
  paginationMetaSchema,
  paginationQuerySchema,
} from "./pagination.schema.js";

describe("pagination contract", () => {
  it("parses a captured paginated list", () => {
    const schema = paginatedResponseSchema(z.object({ id: z.uuid() }));
    const fixture: unknown = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "__fixtures__", "paginated-list.json"),
        "utf8",
      ),
    );
    expect(() => schema.parse(fixture)).not.toThrow();
  });

  it("strips undeclared data from returned pagination metadata", () => {
    const meta = { total: 1, page: 1, perPage: 25 };
    expect(paginationMetaSchema.parse({ ...meta, internalCount: 42 })).toEqual(
      meta,
    );
  });

  it("applies documented defaults", () => {
    const parsed = paginationQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(PAGINATION_DEFAULT_PER_PAGE);
  });

  it("coerces string query params", () => {
    const parsed = paginationQuerySchema.parse({ page: "3", perPage: "50" });
    expect(parsed).toEqual({ page: 3, perPage: 50 });
  });

  it("pins the perPage ceiling", () => {
    expect(() =>
      paginationQuerySchema.parse({ perPage: PAGINATION_MAX_PER_PAGE + 1 }),
    ).toThrow();
  });
});

describe("pagination strictness", () => {
  it("rejects an unmodelled query parameter", () => {
    expect(() =>
      paginationQuerySchema.parse({ page: "1", perPagee: "25" }),
    ).toThrow();
  });

  it("keeps strictness through .extend(), which is how list queries inherit it", () => {
    const listQuery = paginationQuerySchema.extend({
      status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    });
    expect(listQuery.parse({ status: "ACTIVE" }).page).toBe(1);
    expect(() => listQuery.parse({ staus: "ACTIVE" })).toThrow();
  });
});
