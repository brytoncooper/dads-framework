import { expect, test } from "vitest";
import { loadLeaf } from "./loader.js";

test("literal dynamic import keeps the leaf-only module", async () => {
  const leafModule = await loadLeaf();
  expect(leafModule.leaf).toBe("baseline");
  expect(Object.keys(leafModule).sort()).toEqual(["leaf"]);
});
