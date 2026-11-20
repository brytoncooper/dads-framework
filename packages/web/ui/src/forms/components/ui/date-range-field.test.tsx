/**
 * What: a date range is one labeled bordered control holding two native date
 * inputs that keep the end from being picked before the start.
 * Why: a reader picks one range, not two unrelated fields, and a reversed
 * range should be hard to choose and plain when it happens.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DateRangeField, type DateRange } from "./date-range-field.js";

afterEach(cleanup);

function renderRange(
  value: DateRange,
  extra: { invalid?: boolean; errorId?: string } = {},
) {
  const onChange = vi.fn();
  render(
    <DateRangeField
      label="Date Range"
      startLabel="Start date"
      endLabel="End date"
      separator="to"
      value={value}
      onChange={onChange}
      {...extra}
    />,
  );
  return onChange;
}

describe("DateRangeField", () => {
  it("names one group and both of its days", () => {
    renderRange({ start: "2026-11-10", end: "2026-11-11" });

    expect(screen.getByRole("group", { name: "Date Range" })).toBeTruthy();
    expect(screen.getByLabelText("Start date")).toHaveProperty(
      "value",
      "2026-11-10",
    );
    expect(screen.getByLabelText("End date")).toHaveProperty(
      "value",
      "2026-11-11",
    );
  });

  it("keeps the end from being picked before the start", () => {
    renderRange({ start: "2026-11-10", end: "2026-11-12" });

    expect(screen.getByLabelText("End date").getAttribute("min")).toBe(
      "2026-11-10",
    );
    expect(screen.getByLabelText("Start date").getAttribute("max")).toBe(
      "2026-11-12",
    );
  });

  it("reports each day's edit with the other day kept", () => {
    const onChange = renderRange({ start: "2026-11-10", end: "2026-11-12" });

    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-11-14" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      start: "2026-11-10",
      end: "2026-11-14",
    });
    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ start: "", end: "2026-11-12" });
  });

  it("marks an invalid range and points to its message", () => {
    renderRange(
      { start: "2026-11-12", end: "2026-11-10" },
      { invalid: true, errorId: "range-error" },
    );

    const group = screen.getByRole("group", { name: "Date Range" });
    expect(group.getAttribute("aria-invalid")).toBe("true");
    expect(group.getAttribute("aria-describedby")).toBe("range-error");
    expect(group.className).toContain("aria-invalid:border-destructive");
    expect(screen.getByLabelText("End date").getAttribute("aria-invalid")).toBe(
      "true",
    );
  });
});
