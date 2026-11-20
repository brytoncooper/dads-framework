import { describe, expect, it } from "vitest";

import { decodeSortParam, encodeSortParam } from "./sort-param.js";

describe("encodeSortParam", () => {
  it("leaves the param off an unsorted table", () => {
    expect(encodeSortParam([])).toBeUndefined();
  });

  it("writes an ascending column as its bare id", () => {
    expect(encodeSortParam([{ id: "name", desc: false }])).toBe("name");
  });

  it("writes a descending column with a `.desc` suffix", () => {
    expect(encodeSortParam([{ id: "name", desc: true }])).toBe("name.desc");
  });

  it("joins a multi-column sort with commas, in order", () => {
    expect(
      encodeSortParam([
        { id: "status", desc: true },
        { id: "createdAt", desc: false },
      ]),
    ).toBe("status.desc,createdAt");
  });
});

describe("decodeSortParam", () => {
  it("reads a bare id as ascending", () => {
    expect(decodeSortParam("name")).toEqual([{ id: "name", desc: false }]);
  });

  it("reads the `.desc` and `.asc` suffixes", () => {
    expect(decodeSortParam("name.desc")).toEqual([{ id: "name", desc: true }]);
    expect(decodeSortParam("name.asc")).toEqual([{ id: "name", desc: false }]);
  });

  it("reads the `-` and `+` prefixes people type by hand", () => {
    expect(decodeSortParam("-name")).toEqual([{ id: "name", desc: true }]);
    expect(decodeSortParam("+name")).toEqual([{ id: "name", desc: false }]);
  });

  it("reads a multi-column sort, in order", () => {
    expect(decodeSortParam("status.desc,createdAt")).toEqual([
      { id: "status", desc: true },
      { id: "createdAt", desc: false },
    ]);
  });

  it("drops empty tokens instead of inventing a column", () => {
    expect(decodeSortParam("")).toEqual([]);
    expect(decodeSortParam(",,")).toEqual([]);
    expect(decodeSortParam("name,,")).toEqual([{ id: "name", desc: false }]);
  });

  it("keeps a column literally named after a direction", () => {
    expect(decodeSortParam("desc")).toEqual([{ id: "desc", desc: false }]);
    expect(decodeSortParam("asc.desc")).toEqual([{ id: "asc", desc: true }]);
  });

  it("round-trips what encodeSortParam writes", () => {
    const sort = [
      { id: "status", desc: true },
      { id: "createdAt", desc: false },
    ];
    const encoded = encodeSortParam(sort);

    expect(encoded).toBeDefined();
    expect(decodeSortParam(encoded ?? "")).toEqual(sort);
  });
});
