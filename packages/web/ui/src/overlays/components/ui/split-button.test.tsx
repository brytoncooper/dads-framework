/**
 * What: SplitButton runs its primary action from the main button and lists the
 * related actions behind a labelled caret that opens by keyboard.
 * Why: pages replace long rows of buttons with one control, so a user must
 * still reach every action without a mouse and see which ones are unavailable.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SplitButton, type SplitButtonItem } from "./split-button.js";

class ResizeObserverStub {
  observe(): undefined {
    return undefined;
  }
  unobserve(): undefined {
    return undefined;
  }
  disconnect(): undefined {
    return undefined;
  }
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function openMenu(label = "More actions"): void {
  fireEvent.keyDown(screen.getByRole("button", { name: label }), {
    key: "Enter",
  });
}

function items(overrides: Partial<SplitButtonItem> = {}): SplitButtonItem[] {
  return [
    { id: "record", label: "Record", onSelect: vi.fn(), ...overrides },
    {
      id: "delete",
      label: "Delete",
      onSelect: vi.fn(),
      destructive: true,
    },
  ];
}

describe("split button", () => {
  it("runs the primary action without opening the menu", () => {
    const onClick = vi.fn();
    render(
      <SplitButton onClick={onClick} items={items()}>
        Edit
      </SplitButton>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("names the caret and opens the menu from the keyboard", () => {
    render(
      <SplitButton onClick={vi.fn()} items={items()}>
        Edit
      </SplitButton>,
    );
    const caret = screen.getByRole("button", { name: "More actions" });
    expect(caret.getAttribute("aria-haspopup")).toBe("menu");
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Record" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDefined();
  });

  it("lets a page rename the caret", () => {
    render(
      <SplitButton onClick={vi.fn()} items={items()} menuLabel="Meter actions">
        Edit
      </SplitButton>,
    );
    expect(screen.getByRole("button", { name: "Meter actions" })).toBeDefined();
  });

  it("runs the chosen item and closes the menu", () => {
    const [record, remove] = items();
    if (!record || !remove) throw new Error("Expected two items");
    render(
      <SplitButton onClick={vi.fn()} items={[record, remove]}>
        Edit
      </SplitButton>,
    );
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Record" }));
    expect(record.onSelect).toHaveBeenCalledTimes(1);
    expect(remove.onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("styles destructive items and withholds disabled ones", () => {
    const [record, remove] = items({ disabled: true });
    if (!record || !remove) throw new Error("Expected two items");
    render(
      <SplitButton onClick={vi.fn()} items={[record, remove]}>
        Edit
      </SplitButton>,
    );
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Delete" }).getAttribute("data-variant")).toBe("destructive");
    const disabled = screen.getByRole("menuitem", { name: "Record" });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(disabled);
    expect(record.onSelect).not.toHaveBeenCalled();
  });

  it("points a row at the text that explains why it is unavailable", () => {
    const [record, remove] = items({ disabled: true, describedBy: "why" });
    if (!record || !remove) throw new Error("Expected two items");
    render(
      <SplitButton onClick={vi.fn()} items={[record, remove]}>
        Edit
      </SplitButton>,
    );
    openMenu();
    expect(screen.getByRole("menuitem", { name: "Record" }).getAttribute("aria-describedby")).toBe("why");
  });

  it("disables the primary action and the caret together", () => {
    render(
      <SplitButton onClick={vi.fn()} items={items()} disabled>
        Edit
      </SplitButton>,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "More actions" })).toHaveProperty("disabled", true);
  });

  it("passes Button variant and size through to both halves", () => {
    render(
      <SplitButton onClick={vi.fn()} items={items()} variant="outlineDestructive" size="sm">
        Edit
      </SplitButton>,
    );
    const primary = screen.getByRole("button", { name: "Edit" });
    const caret = screen.getByRole("button", { name: "More actions" });
    expect(primary.getAttribute("data-variant")).toBe("outlineDestructive");
    expect(primary.getAttribute("data-size")).toBe("sm");
    expect(caret.getAttribute("data-variant")).toBe("outlineDestructive");
    expect(caret.getAttribute("data-size")).toBe("icon-sm");
  });
});
