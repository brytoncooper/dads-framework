/**
 * What: a labeled switch uses a 44-pixel row while the visible switch keeps
 * its compact track dimensions.
 * Why: immediate Boolean controls need a reliable visible label and touch
 * target without making the switch itself visually oversized.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SwitchField } from "./switch.js";

afterEach(cleanup);

describe("a labeled switch field", () => {
  it("associates its visible label and description with the switch", () => {
    render(
      <SwitchField
        id="handled-here"
        label="Handled Here"
        description="Make this product available at this facility."
      />,
    );

    const control = screen.getByRole("switch", { name: "Handled Here" });
    const descriptionId = control.getAttribute("aria-describedby");

    expect(descriptionId).toBe("handled-here-description");
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Make this product available at this facility.",
    );
  });

  it("makes the labeled row the touch target without enlarging the track", () => {
    render(<SwitchField id="auto-tare" label="Auto-Tare" />);

    const control = screen.getByRole("switch", { name: "Auto-Tare" });
    const row = control.closest('[data-slot="switch-field"]');

    expect(row?.className).toContain("min-h-11");
    expect(control.className).toContain("data-[size=default]:h-[1.15rem]");
    expect(control.className).not.toContain("min-h-11");

    fireEvent.click(screen.getByText("Auto-Tare"));
    expect(control.getAttribute("aria-checked")).toBe("true");
  });
});
