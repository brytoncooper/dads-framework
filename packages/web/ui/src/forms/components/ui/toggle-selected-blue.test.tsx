/**
 * What: a selected ToggleGroupItem or Toggle always carries the app's primary
 * blue, with no variant passed and with the leftover `variant="primary"`.
 * Why: design ruling — the faint accent (yellow) selected state is never
 * used, so the primitive offers no way to pick it.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Toggle } from "./toggle.js";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group.js";

afterEach(cleanup);

function expectPrimaryBlueSelectedLook(element: HTMLElement) {
  expect(element.className).toContain("data-[state=on]:bg-primary");
  expect(element.className).toContain(
    "data-[state=on]:text-primary-foreground",
  );
  expect(element.className).not.toContain("bg-accent");
}

describe("toggle selected look", () => {
  it("is primary blue on a ToggleGroup with no variant", () => {
    render(
      <ToggleGroup type="single" value="on" aria-label="Mode">
        <ToggleGroupItem value="off">Off</ToggleGroupItem>
        <ToggleGroupItem value="on">On</ToggleGroupItem>
      </ToggleGroup>,
    );

    const selected = screen.getByRole("radio", { name: "On" });
    expect(selected.getAttribute("data-state")).toBe("on");
    expect(selected.getAttribute("data-variant")).toBe("primary");
    expectPrimaryBlueSelectedLook(selected);
    expectPrimaryBlueSelectedLook(screen.getByRole("radio", { name: "Off" }));
  });

  it("stays primary blue when a caller still passes variant primary", () => {
    render(
      <ToggleGroup type="single" variant="primary" value="on" aria-label="Mode">
        <ToggleGroupItem value="on">On</ToggleGroupItem>
      </ToggleGroup>,
    );

    expectPrimaryBlueSelectedLook(screen.getByRole("radio", { name: "On" }));
  });

  it("is primary blue on a standalone Toggle", () => {
    render(
      <Toggle pressed aria-label="Bold">
        B
      </Toggle>,
    );

    expectPrimaryBlueSelectedLook(screen.getByRole("button", { name: "Bold" }));
  });
});
