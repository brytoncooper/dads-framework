import { expect, test } from "vitest";
import { reexportMarker, view } from "./view.js";

test("Web consumers keep the export-star surface", () => {
  expect(view).toBe("baseline");
  expect(reexportMarker).toBe("reexport-marker");
});
