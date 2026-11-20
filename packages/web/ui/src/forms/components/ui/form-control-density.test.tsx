/**
 * What: single-line form controls expose the same 36-pixel default and
 * 32-pixel compact density contract.
 * Why: toolbars currently mix controls whose heights can only be corrected
 * with local classes, so visually equivalent controls drift apart.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Combobox, ComboboxInput } from "./combobox.js";
import { Input } from "./input.js";
import { InputGroup, InputGroupInput } from "./input-group.js";
import { Select, SelectTrigger, SelectValue } from "./select.js";

afterEach(cleanup);

function expectDefaultControlHeight(control: Element): void {
  expect(control.getAttribute("data-size")).toBe("default");
  expect(control.className).toContain("data-[size=default]:h-9");
}

function expectCompactControlHeight(control: Element): void {
  expect(control.getAttribute("data-size")).toBe("sm");
  expect(control.className).toContain("data-[size=sm]:h-8");
}

function expectCoarsePointerHeight(control: Element): void {
  expect(control.className).toContain("[@media(pointer:coarse)]:min-h-11");
}

describe("single-line form-control density", () => {
  it("gives Input an explicit default and compact size", () => {
    render(
      <>
        <Input aria-label="Default Input" />
        <Input aria-label="Compact Input" size="sm" />
      </>,
    );

    expectDefaultControlHeight(screen.getByLabelText("Default Input"));
    expectCompactControlHeight(screen.getByLabelText("Compact Input"));
    expectCoarsePointerHeight(screen.getByLabelText("Default Input"));
    expectCoarsePointerHeight(screen.getByLabelText("Compact Input"));
    expect(screen.getByLabelText("Compact Input").hasAttribute("size")).toBe(
      false,
    );
  });

  it("keeps Select on the same default and compact size contract", () => {
    render(
      <>
        <Select>
          <SelectTrigger aria-label="Default Select">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
        </Select>
        <Select>
          <SelectTrigger aria-label="Compact Select" size="sm">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
        </Select>
      </>,
    );

    expectDefaultControlHeight(screen.getByLabelText("Default Select"));
    expectCompactControlHeight(screen.getByLabelText("Compact Select"));
    expectCoarsePointerHeight(screen.getByLabelText("Default Select"));
    expectCoarsePointerHeight(screen.getByLabelText("Compact Select"));
  });

  it("sizes InputGroup itself and lets its input fill that height", () => {
    render(
      <InputGroup size="sm">
        <InputGroupInput aria-label="Compact Input Group" />
      </InputGroup>,
    );

    const input = screen.getByLabelText("Compact Input Group");
    const group = input.closest('[data-slot="input-group"]');

    expect(group).not.toBeNull();
    expectCompactControlHeight(group ?? document.body);
    expect(group?.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expectCompactControlHeight(input);
    expect(input.className).toContain("h-full");
  });

  it("passes ComboboxInput density to its owning InputGroup", () => {
    render(
      <Combobox items={[]}>
        <ComboboxInput aria-label="Compact Combobox" size="sm" />
      </Combobox>,
    );

    const input = screen.getByLabelText("Compact Combobox");
    const group = input.closest('[data-slot="input-group"]');

    expect(group).not.toBeNull();
    expectCompactControlHeight(group ?? document.body);
  });
});
