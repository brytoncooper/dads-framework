/**
 * What: every actionable Dropdown Menu and Command row exposes a 44-pixel
 * coarse-pointer target while retaining compact desktop density.
 * Why: table and navigation triggers already met the touch contract, but the
 * menus they opened still presented roughly 32-pixel choices.
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Command, CommandItem, CommandList } from "./command.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";

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

function expectCoarsePointerChoice(choice: Element): void {
  expect(choice.className).toContain("[@media(pointer:coarse)]:min-h-11");
}

describe("popover menu-item density", () => {
  it("expands every actionable Dropdown Menu row", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>View</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked>Visible</DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup value="name">
            <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expectCoarsePointerChoice(screen.getByRole("menuitem", { name: "Open" }));
    expectCoarsePointerChoice(screen.getByRole("menuitemcheckbox", { name: "Visible" }));
    expectCoarsePointerChoice(screen.getByRole("menuitemradio", { name: "Name" }));
    expectCoarsePointerChoice(screen.getByRole("menuitem", { name: "More" }));
  });

  it("expands Command choices", () => {
    render(
      <Command>
        <CommandList>
          <CommandItem>Open Product</CommandItem>
        </CommandList>
      </Command>,
    );

    expectCoarsePointerChoice(screen.getByRole("option", { name: "Open Product" }));
  });
});
