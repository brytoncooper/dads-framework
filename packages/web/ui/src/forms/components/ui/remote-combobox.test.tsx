/**
 * What: a remote combobox asks the server for the typed term instead of
 * filtering a page it already holds.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxSearch,
  ComboboxTrigger,
  ComboboxValue,
} from "./combobox.js";
import { RemoteCombobox } from "./remote-combobox.js";

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

beforeAll(() => vi.stubGlobal("ResizeObserver", ResizeObserverStub));
afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

type Option = { readonly value: string; readonly label: string };

describe("RemoteCombobox", () => {
  it("loads page 1 for the typed query", async () => {
    const loadPage = vi.fn(({ query, page }: { query: string; page: number }) =>
      Promise.resolve({
        items: query === "soy" ? [{ value: "SOY", label: "Soybeans" }] : [{ value: "CORN", label: "Corn" }],
        hasMore: false,
        page,
      }),
    );

    render(
      <RemoteCombobox loadPage={loadPage} value={null} onValueChange={() => undefined} debounceMs={10}>
        <ComboboxTrigger aria-label="Ingredient" size="default">
          <ComboboxValue placeholder="Choose" />
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxSearch placeholder="Search Ingredients" />
          <ComboboxEmpty>None</ComboboxEmpty>
          <ComboboxList>
            {(option: Option) => (
              <ComboboxItem key={option.value} value={option}>
                {option.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </RemoteCombobox>,
    );

    await waitFor(() => {
      expect(loadPage).toHaveBeenCalled();
    });
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ query: "", page: 1 }));

    fireEvent.click(screen.getByRole("combobox", { name: "Ingredient" }));
    fireEvent.change(await screen.findByPlaceholderText("Search Ingredients"), {
      target: { value: "soy" },
    });

    await waitFor(() => {
      expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ query: "soy", page: 1 }));
    });
    expect(await screen.findByRole("option", { name: "Soybeans" })).toBeDefined();
  });

  it("keeps the typed query after a multi-select pick so the next page stays on that term", async () => {
    const loadPage = vi.fn(({ query, page }: { query: string; page: number }) =>
      Promise.resolve({
        items:
          query === "soy"
            ? [
                { value: "SOY", label: "Soybeans" },
                { value: "SOY-MEAL", label: "Soy Meal" },
              ]
            : [{ value: "CORN", label: "Corn" }],
        hasMore: false,
        page,
      }),
    );

    function MultiPicker() {
      const [selected, setSelected] = useState<Option[]>([]);
      return (
        <RemoteCombobox<Option>
          multiple
          loadPage={loadPage}
          value={selected}
          onValueChange={setSelected}
          debounceMs={10}
        >
          <ComboboxTrigger aria-label="Ingredients" size="default">
            <ComboboxValue placeholder="Choose" />
          </ComboboxTrigger>
          <ComboboxContent>
            <ComboboxSearch placeholder="Search Ingredients" />
            <ComboboxEmpty>None</ComboboxEmpty>
            <ComboboxList>
              {(option: Option) => (
                <ComboboxItem key={option.value} value={option}>
                  {option.label}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </RemoteCombobox>
      );
    }

    render(<MultiPicker />);

    await waitFor(() => {
      expect(loadPage).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole("combobox", { name: "Ingredients" }));
    fireEvent.change(await screen.findByPlaceholderText("Search Ingredients"), {
      target: { value: "soy" },
    });
    await waitFor(() => {
      expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ query: "soy", page: 1 }));
    });

    fireEvent.click(await screen.findByRole("option", { name: "Soybeans" }));

    const search = await screen.findByPlaceholderText("Search Ingredients");
    if (!(search instanceof HTMLInputElement)) {
      throw new Error("search is not an input");
    }
    expect(search.value).toBe("soy");
  });
});
