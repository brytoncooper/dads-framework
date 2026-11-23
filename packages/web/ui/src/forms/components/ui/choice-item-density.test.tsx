/**
 * What: Select and Combobox choices retain compact desktop rows but expose a
 * 44-pixel minimum target when the primary pointer is coarse.
 * Why: their triggers already expand for touch, while the choices they open
 * remained roughly 32 pixels tall and broke the same interaction contract.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from "./combobox.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function expectCoarsePointerChoice(choice: Element): void {
  expect(choice.className).toContain("[@media(pointer:coarse)]:min-h-11");
}

describe("choice-item density", () => {
  it("expands Select choices for a coarse pointer", async () => {
    render(
      <Select open value="active">
        <SelectTrigger aria-label="Standing">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active">Active</SelectItem>
        </SelectContent>
      </Select>,
    );

    expectCoarsePointerChoice(await screen.findByRole("option", { name: "Active" }));
  });

  it("expands Combobox choices for a coarse pointer", async () => {
    render(
      <Combobox items={["Active"]}>
        <ComboboxInput aria-label="Standing" />
        <ComboboxContent>
          <ComboboxList>
            <ComboboxItem value="Active">Active</ComboboxItem>
          </ComboboxList>
        </ComboboxContent>
      </Combobox>,
    );

    fireEvent.keyDown(screen.getByLabelText("Standing"), { key: "ArrowDown" });

    expectCoarsePointerChoice(await screen.findByRole("option", { name: "Active" }));
  });
});
