import { describe, expect, it } from "vitest";
import { loadPageAndTotal, sqlOffsetForPage } from "./load-page-and-total.js";

/** The list-reader helper: race rows+count and unwrap a missing total as 0. */
describe("loadPageAndTotal", () => {
  it("runs rows and total concurrently and unwraps the count", async () => {
    const result = await loadPageAndTotal(
      Promise.resolve([{ id: "a" }, { id: "b" }]),
      Promise.resolve([{ total: 41 }]),
    );
    expect(result.rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(result.total).toBe(41);
  });

  it("treats a missing count row as zero (empty table)", async () => {
    const result = await loadPageAndTotal(Promise.resolve([]), Promise.resolve([]));
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("rejects when either query rejects", async () => {
    await expect(loadPageAndTotal(Promise.reject(new Error("boom")), Promise.resolve([]))).rejects.toThrow("boom");
  });
});

describe("sqlOffsetForPage", () => {
  it("computes the zero-based offset from a one-based page", () => {
    expect(sqlOffsetForPage(1, 25)).toBe(0);
    expect(sqlOffsetForPage(2, 25)).toBe(25);
    expect(sqlOffsetForPage(3, 10)).toBe(20);
  });
});
