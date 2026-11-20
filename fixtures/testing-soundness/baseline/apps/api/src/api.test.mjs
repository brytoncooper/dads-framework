import { expect, test } from "vitest";
import { direct } from "./direct.js";
import { server } from "./server.js";

test("API consumers keep the exported leaf value", () => {
  expect(direct).toBe("baseline");
  expect(server).toBe("baseline");
});
