/**
 * What: a phone card places every visible column exactly once — heading,
 * summary, details, selection, or actions.
 * Why: the card replaces the table below `md`; a column that fell through the
 * plan would be business data hidden by screen width.
 */
import { describe, expect, it } from "vitest";

import { planCardFields } from "./card-fields.js";

describe("planCardFields", () => {
  it("heads with the identifying column and summarises the next three", () => {
    const plan = planCardFields([
      { id: "select" },
      { id: "name" },
      { id: "status" },
      { id: "customer" },
      { id: "product" },
      { id: "loadedAt" },
      { id: "carrier" },
      { id: "actions" },
    ]);

    expect(plan).toEqual({
      selectionId: "select",
      headingId: "name",
      summaryIds: ["status", "customer", "product"],
      detailIds: ["loadedAt", "carrier"],
      actionsId: "actions",
    });
  });

  it("keeps the name as the phone card heading when Code is the first table column", () => {
    const plan = planCardFields([{ id: "code" }, { id: "name", cardHeading: true }, { id: "status" }]);

    expect(plan.headingId).toBe("name");
    expect(plan.summaryIds).toEqual(["code", "status"]);
  });

  it("uses opted-in summary columns when any column opts in", () => {
    const plan = planCardFields([
      { id: "name" },
      { id: "status" },
      { id: "customer", cardSummary: true },
      { id: "carrier" },
    ]);

    expect(plan.summaryIds).toEqual(["customer"]);
    expect(plan.detailIds).toEqual(["status", "carrier"]);
  });

  it("keeps opted-out columns in the details", () => {
    const plan = planCardFields([{ id: "name" }, { id: "notes", cardSummary: false }, { id: "status" }]);

    expect(plan.summaryIds).toEqual(["status"]);
    expect(plan.detailIds).toEqual(["notes"]);
  });

  it("keeps reader-hidden columns in the details, never the summary", () => {
    const plan = planCardFields([
      { id: "name" },
      { id: "status", readerHidden: true },
      { id: "customer", cardSummary: true, readerHidden: true },
      { id: "carrier" },
    ]);

    expect(plan.summaryIds).toEqual(["carrier"]);
    expect(plan.detailIds).toEqual(["status", "customer"]);
  });

  it("drops no visible column", () => {
    const ids = ["select", "a", "b", "c", "d", "e", "f", "actions"];
    const plan = planCardFields(ids.map((id) => ({ id })));
    const placed = [plan.selectionId, plan.headingId, ...plan.summaryIds, ...plan.detailIds, plan.actionsId];

    expect(placed.sort()).toEqual([...ids].sort());
  });
});
