import { expect, test } from "vitest";
import { direct } from "./direct.js";
import { server } from "./server.js";
import { taxedAmount } from "./tax-consumer.js";

test("API consumers keep the exported leaf value", () => {
  expect(direct).toBe("baseline");
  expect(server).toBe("baseline");
  expect(taxedAmount).toBe(20);
});
