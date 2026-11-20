import { expect, test } from "vitest";
import { leaf } from "./leaf.js";

test("leaf keeps its declared value", () => {
  expect(leaf).toBe("baseline");
});
