import { describe, expect, expectTypeOf, it } from "vitest";
import { mapListResult } from "./list-result.js";

/**
 * Proves the one boundary conversion used by named list handlers: database
 * pages expose rows, while listRoute handlers expose items.
 */
describe("mapListResult", () => {
  it("maps each row and preserves the total", () => {
    const result = mapListResult(
      { rows: [{ id: "one" }, { id: "two" }], total: 8 },
      (row) => ({ value: row.id.toUpperCase() }),
    );

    expectTypeOf(result).toEqualTypeOf<{
      readonly items: readonly { value: string }[];
      readonly total: number;
    }>();

    expect(result).toEqual({
      items: [{ value: "ONE" }, { value: "TWO" }],
      total: 8,
    });
  });

  it("maps an empty page without changing its total", () => {
    expect(mapListResult({ rows: [], total: 12 }, (row: never) => row)).toEqual(
      {
        items: [],
        total: 12,
      },
    );
  });
});
