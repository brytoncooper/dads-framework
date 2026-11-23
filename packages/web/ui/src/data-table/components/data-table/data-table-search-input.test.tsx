/**
 * What: the toolbar search box keeps what the reader typed while the URL
 * catches up, writes once typing settles, and follows the URL when it changes
 * from outside.
 * Why: the box used to show the URL value directly; a route that holds a new
 * URL back until its list loads made it show the old term, so the next key
 * replaced everything typed in between.
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_TABLE_SEARCH_SETTLE_MS, DataTableSearchInput } from "./data-table-search-input.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function searchBox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Search" });
}

function type(text: string): void {
  fireEvent.change(searchBox(), { target: { value: text } });
}

function settle(): void {
  act(() => {
    vi.advanceTimersByTime(DATA_TABLE_SEARCH_SETTLE_MS);
  });
}

describe("DataTableSearchInput", () => {
  it("writes once typing settles, not per key", () => {
    const onCommit = vi.fn();
    render(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);

    type("C");
    type("Cl");
    act(() => {
      vi.advanceTimersByTime(DATA_TABLE_SEARCH_SETTLE_MS - 1);
    });
    expect(onCommit).not.toHaveBeenCalled();

    settle();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Cl");
  });

  it("keeps the typed text while the URL still holds the old term", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);

    type("Cl");
    settle();
    type("Clear");
    settle();
    expect(searchBox().value).toBe("Clear");

    // The router commits the first write late, after the reader typed on.
    rerender(<DataTableSearchInput aria-label="Search" value="Cl" onCommit={onCommit} />);
    expect(searchBox().value).toBe("Clear");

    rerender(<DataTableSearchInput aria-label="Search" value="Clear" onCommit={onCommit} />);
    expect(searchBox().value).toBe("Clear");
    expect(onCommit.mock.calls).toEqual([["Cl"], ["Clear"]]);
  });

  // TanStack Router never commits a navigation a newer one overtook, so an
  // overtaken write never arrives as `value`; the tests below model that.
  it("follows Reset after the router dropped an overtaken write", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DataTableSearchInput aria-label="Search" value="pump" onCommit={onCommit} />);

    type("");
    type("valve");
    settle();
    expect(onCommit.mock.calls).toEqual([[""], ["valve"]]);
    // "" was overtaken and never lands; "valve" does.
    rerender(<DataTableSearchInput aria-label="Search" value="valve" onCommit={onCommit} />);
    expect(searchBox().value).toBe("valve");

    rerender(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);
    expect(searchBox().value).toBe("");
  });

  it("follows Reset after the same term was written, cleared, and written again", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DataTableSearchInput aria-label="Search" value="foo" onCommit={onCommit} />);

    type("ab");
    settle();
    type("");
    type("ab");
    settle();
    expect(onCommit.mock.calls).toEqual([["ab"], [""], ["ab"]]);
    // Only the newest "ab" lands; the first "ab" and the "" were overtaken.
    rerender(<DataTableSearchInput aria-label="Search" value="ab" onCommit={onCommit} />);
    expect(searchBox().value).toBe("ab");

    rerender(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);
    expect(searchBox().value).toBe("");
  });

  it("follows Back to a term a newer write overtook", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);

    type("a");
    settle();
    type("ab");
    settle();
    rerender(<DataTableSearchInput aria-label="Search" value="ab" onCommit={onCommit} />);
    rerender(<DataTableSearchInput aria-label="Search" value="a" onCommit={onCommit} />);
    expect(searchBox().value).toBe("a");
  });

  it("resends on Enter a written term whose navigation was dropped", () => {
    const onCommit = vi.fn();
    render(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);

    type("acme");
    settle();
    // A view tab built from the held-back URL superseded "acme"; `value`
    // never changes.
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(onCommit.mock.calls).toEqual([["acme"], ["acme"]]);
  });

  it("forgets a pending write once the box is typed back to the URL's term", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DataTableSearchInput aria-label="Search" value="x" onCommit={onCommit} />);

    type("xy");
    settle();
    type("x");
    settle();
    expect(onCommit.mock.calls).toEqual([["xy"], ["x"]]);

    // Back to "xy" from outside, long after: not an echo of the dropped write.
    rerender(<DataTableSearchInput aria-label="Search" value="xy" onCommit={onCommit} />);
    expect(searchBox().value).toBe("xy");
  });

  it("keeps both writes across a blur when their echoes arrive in order", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);

    type("a");
    settle();
    type("ab");
    settle();
    fireEvent.blur(searchBox());
    rerender(<DataTableSearchInput aria-label="Search" value="a" onCommit={onCommit} />);
    expect(searchBox().value).toBe("ab");

    rerender(<DataTableSearchInput aria-label="Search" value="ab" onCommit={onCommit} />);
    expect(searchBox().value).toBe("ab");
    expect(onCommit.mock.calls).toEqual([["a"], ["ab"]]);
  });

  it("follows an outside value after Enter, and Enter's own echo does not move the box", () => {
    const onCommit = vi.fn();
    const { rerender } = render(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);

    type("pump");
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    type("pumps");
    rerender(<DataTableSearchInput aria-label="Search" value="pump" onCommit={onCommit} />);
    expect(searchBox().value).toBe("pumps");

    fireEvent.blur(searchBox());
    rerender(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);
    expect(searchBox().value).toBe("");
  });

  it("follows the URL when the term changes from outside", () => {
    const { rerender } = render(<DataTableSearchInput aria-label="Search" value="pump" onCommit={vi.fn()} />);
    rerender(<DataTableSearchInput aria-label="Search" value="" onCommit={vi.fn()} />);
    expect(searchBox().value).toBe("");
  });

  it("clears at once, and a timer set before the clear cannot write the old term back", () => {
    const onCommit = vi.fn();
    render(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);

    type("pum");
    type("");
    expect(onCommit).not.toHaveBeenCalled();

    settle();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("writes at once on Enter", () => {
    const onCommit = vi.fn();
    render(<DataTableSearchInput aria-label="Search" value="" onCommit={onCommit} />);

    type("pump");
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("pump");

    settle();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
