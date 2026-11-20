/**
 * What: a column is named by its meta label, else its plain-text header, else
 * its id spelled as words.
 * Why: phone cards and the Columns menu show a column without its header cell;
 * an unnamed field forces the reader to guess what a value means.
 */
import { describe, expect, it } from "vitest";

import { humanizeColumnId, readColumnLabel } from "./column-label.js";

describe("readColumnLabel", () => {
  it("prefers the meta label", () => {
    expect(
      readColumnLabel({ id: "loadedAt", metaLabel: "Loaded", header: "X" }),
    ).toBe("Loaded");
  });

  it("falls back to a plain-text header", () => {
    expect(
      readColumnLabel({ id: "loadedAt", metaLabel: undefined, header: "Load" }),
    ).toBe("Load");
  });

  it("spells the id as words when the header is rendered", () => {
    expect(
      readColumnLabel({
        id: "loadedAt",
        metaLabel: undefined,
        header: () => null,
      }),
    ).toBe("Loaded At");
  });
});

describe("humanizeColumnId", () => {
  it("splits camel, snake, and kebab case", () => {
    expect(humanizeColumnId("loadedAt")).toBe("Loaded At");
    expect(humanizeColumnId("loaded_at")).toBe("Loaded At");
    expect(humanizeColumnId("net-weight")).toBe("Net Weight");
  });
});
