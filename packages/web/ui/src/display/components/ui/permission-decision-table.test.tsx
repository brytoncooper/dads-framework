// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PermissionDecisionTable } from "./permission-decision-table.js";

afterEach(cleanup);

it("pairs each accessible permission row with the decision supplied by the host", () => {
  render(
    <PermissionDecisionTable
      caption="Effective permissions"
      permissionHeading="Action"
      decisionHeading="Access"
      allowedLabel="Allowed"
      deniedLabel="Denied"
      decisions={[
        { id: "details", label: "View details", allowed: true },
        { id: "edit", label: "Edit details", allowed: false },
      ]}
    />,
  );

  const table = screen.getByRole("table", { name: "Effective permissions" });
  expect(
    within(table).getByRole("columnheader", { name: "Action" }),
  ).toBeDefined();
  expect(
    within(table).getByRole("rowheader", { name: "View details" }),
  ).toBeDefined();
  expect(
    within(table).getByRole("row", { name: "View details Allowed" }),
  ).toBeDefined();
  expect(
    within(table).getByRole("row", { name: "Edit details Denied" }),
  ).toBeDefined();
});
