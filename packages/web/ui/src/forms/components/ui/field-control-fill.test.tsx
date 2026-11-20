/**
 * What: field-like controls sit on the card token, not the page.
 * Why: `--background` is dead concrete; a transparent select or search reads
 * as a hole in the toolbar instead of a control.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Combobox, ComboboxTrigger, ComboboxValue } from "./combobox.js";
import { Input } from "./input.js";
import { InputGroup } from "./input-group.js";
import { Select, SelectTrigger, SelectValue } from "./select.js";
import { Textarea } from "./textarea.js";

afterEach(cleanup);

describe("field-like control fill", () => {
  it("paints the select trigger on the card surface", () => {
    render(
      <Select>
        <SelectTrigger aria-label="Status">
          <SelectValue placeholder="Active" />
        </SelectTrigger>
      </Select>,
    );

    const trigger = screen.getByLabelText("Status");
    const tokens = trigger.className.split(/\s+/);
    expect(tokens).toContain("bg-card");
    expect(tokens).not.toContain("bg-transparent");
    expect(tokens).not.toContain("bg-background");
  });

  it("paints the search input on the card surface", () => {
    render(<Input aria-label="Search" />);

    const field = screen.getByLabelText("Search");
    const tokens = field.className.split(/\s+/);
    expect(tokens).toContain("bg-card");
    expect(tokens).not.toContain("bg-transparent");
    expect(tokens).not.toContain("bg-background");
  });

  it("paints textareas, combobox triggers, and input groups on the card surface", () => {
    render(
      <>
        <Textarea aria-label="Notes" />
        <Combobox items={[]} value={null} onValueChange={() => undefined}>
          <ComboboxTrigger aria-label="Company" size="default">
            <ComboboxValue placeholder="Choose" />
          </ComboboxTrigger>
        </Combobox>
        <InputGroup aria-label="Date" />
      </>,
    );

    for (const field of [
      screen.getByLabelText("Notes"),
      screen.getByLabelText("Company"),
      screen.getByLabelText("Date"),
    ]) {
      const tokens = field.className.split(/\s+/);
      expect(tokens).toContain("bg-card");
      expect(tokens).not.toContain("bg-transparent");
      expect(tokens).not.toContain("bg-background");
    }
  });
});
