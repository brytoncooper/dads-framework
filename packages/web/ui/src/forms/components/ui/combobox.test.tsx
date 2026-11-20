/**
 * What: a combobox whose options are re-derived on every render still holds
 * the option that was picked.
 * Why: forms map their options from whatever else is on the form — a plant
 * selection, a search result, a fetched catalog — so the array is a new array
 * of new objects on every render. Base UI compares an item to the selected
 * value with `Object.is` unless told otherwise, so under that ordinary shape
 * an option is highlighted, taken, and then reported as not selected, which
 * reads to the person typing as a picker that will not pick.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Combobox,
  ComboboxAction,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSearch,
  ComboboxTrigger,
  ComboboxValue,
} from "./combobox.js";

/** Floating UI measures its anchor; jsdom has no observer to measure with. */
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

const CATALOG = [
  { id: "SOY48", name: "Soybean meal 48" },
  { id: "CORN", name: "Ground corn" },
];

type Ingredient = { readonly value: string; readonly label: string };

/**
 * A fresh array of fresh objects, exactly as a `.map()` in a render body
 * produces — nothing here is memoized, because the forms that hit this were
 * not memoizing either.
 */
function deriveOptions(): Ingredient[] {
  return CATALOG.map((row) => ({ value: row.id, label: row.name }));
}

/** Holds the chosen option itself, the shape `onValueChange` hands back. */
function CatalogPicker() {
  const [chosen, setChosen] = useState<Ingredient | null>(null);
  const [revision, setRevision] = useState(0);
  const options = deriveOptions();

  return (
    <>
      <Combobox items={options} value={chosen} onValueChange={setChosen}>
        <ComboboxInput aria-label="Ingredient" />
        <ComboboxContent>
          <ComboboxList>
            {options.map((option) => (
              <ComboboxItem key={option.value} value={option}>
                {option.label}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <button
        type="button"
        onClick={() => {
          setRevision(revision + 1);
        }}
      >
        Re-render {revision}
      </button>
      <p data-testid="chosen">{chosen?.value ?? "none"}</p>
    </>
  );
}

function input(): HTMLElement {
  return screen.getByLabelText("Ingredient");
}

async function option(label: string): Promise<HTMLElement> {
  return await screen.findByRole("option", { name: label });
}

/** Opens the list the way a keyboard does, which jsdom can actually deliver. */
function openList(): void {
  fireEvent.keyDown(input(), { key: "ArrowDown" });
}

describe("an option picked out of a re-derived array", () => {
  it("is reported as selected once it is taken", async () => {
    render(<CatalogPicker />);

    openList();
    fireEvent.click(await option("Soybean meal 48"));

    expect(screen.getByTestId("chosen").textContent).toBe("SOY48");
    openList();
    expect(
      (await option("Soybean meal 48")).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("stays selected across a re-render that maps the options again", async () => {
    render(<CatalogPicker />);

    openList();
    fireEvent.click(await option("Soybean meal 48"));
    fireEvent.click(screen.getByRole("button", { name: /Re-render/ }));

    expect(screen.getByTestId("chosen").textContent).toBe("SOY48");
    expect(input().getAttribute("value")).toBe("Soybean meal 48");
    openList();
    expect(
      (await option("Soybean meal 48")).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("leaves the option that was not taken unselected", async () => {
    render(<CatalogPicker />);

    openList();
    fireEvent.click(await option("Soybean meal 48"));
    openList();

    expect((await option("Ground corn")).getAttribute("aria-selected")).toBe(
      "false",
    );
  });
});

/** No `value`, so nothing but `getKey` can say what makes two rows the same. */
type Material = { readonly code: string; readonly name: string };

const materialKey = (material: Material): string => material.code;
const materialLabel = (material: Material): string => material.name;

function MaterialPicker() {
  const [chosen, setChosen] = useState<Material | null>(null);
  const [revision, setRevision] = useState(0);
  const options = CATALOG.map((row) => ({ code: row.id, name: row.name }));

  return (
    <>
      <Combobox
        items={options}
        value={chosen}
        onValueChange={setChosen}
        getKey={materialKey}
        itemToStringLabel={materialLabel}
      >
        <ComboboxInput aria-label="Ingredient" />
        <ComboboxContent>
          <ComboboxList>
            {options.map((option) => (
              <ComboboxItem key={option.code} value={option}>
                {option.name}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <button
        type="button"
        onClick={() => {
          setRevision(revision + 1);
        }}
      >
        Re-render {revision}
      </button>
    </>
  );
}

describe("an item shape that carries no `value` key", () => {
  it("matches on the key `getKey` names", async () => {
    render(<MaterialPicker />);

    openList();
    fireEvent.click(await option("Ground corn"));
    fireEvent.click(screen.getByRole("button", { name: /Re-render/ }));

    openList();
    expect((await option("Ground corn")).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      (await option("Soybean meal 48")).getAttribute("aria-selected"),
    ).toBe("false");
  });
});

describe("a closed trigger with search in the popup", () => {
  it("clips a long selected label inside the trigger", () => {
    render(
      <Combobox
        items={["A very long selected ingredient label"]}
        value="A very long selected ingredient label"
        onValueChange={() => undefined}
      >
        <ComboboxTrigger aria-label="Ingredient" size="default">
          <ComboboxValue placeholder="Choose an Ingredient" />
        </ComboboxTrigger>
      </Combobox>,
    );

    const value = screen
      .getByRole("combobox", { name: "Ingredient" })
      .querySelector('[data-slot="combobox-trigger-value"]');
    expect(value).not.toBeNull();
    if (!(value instanceof HTMLElement)) {
      throw new Error("Combobox trigger value wrapper was not rendered");
    }
    expect(value.className).toContain("flex-1");
    expect(value.className).toContain("overflow-hidden");
    expect(value.className).toContain("text-ellipsis");
  });

  it("keeps the input out of the closed field and filters once the list is open", async () => {
    render(
      <Combobox
        items={deriveOptions()}
        value={null}
        onValueChange={() => undefined}
      >
        <ComboboxTrigger aria-label="Ingredient" size="default">
          <ComboboxValue placeholder="Choose an Ingredient" />
        </ComboboxTrigger>
        <ComboboxContent>
          <ComboboxSearch placeholder="Search Ingredients" />
          <ComboboxList>
            {(option: Ingredient) => (
              <ComboboxItem key={option.value} value={option}>
                {option.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>,
    );

    expect(screen.queryByPlaceholderText("Search Ingredients")).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Ingredient" }));
    const search = await screen.findByPlaceholderText("Search Ingredients");
    fireEvent.change(search, { target: { value: "ground" } });

    expect(await option("Ground corn")).toBeDefined();
    expect(
      screen.queryByRole("option", { name: "Soybean meal 48" }),
    ).toBeNull();
  });
});

describe("a combobox list mounted in a given container", () => {
  it("renders the list inside the container instead of the document body", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      <Combobox
        items={deriveOptions()}
        value={null}
        onValueChange={() => undefined}
      >
        <ComboboxTrigger aria-label="Ingredient" size="default">
          <ComboboxValue placeholder="Choose an Ingredient" />
        </ComboboxTrigger>
        <ComboboxContent container={container}>
          <ComboboxSearch placeholder="Search Ingredients" />
          <ComboboxList>
            {(option: Ingredient) => (
              <ComboboxItem key={option.value} value={option}>
                {option.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Ingredient" }));
    const search = await screen.findByPlaceholderText("Search Ingredients");
    expect(container.contains(search)).toBe(true);
    container.remove();
  });
});

describe("a combobox action", () => {
  it("reports its click from the open list and does not pick an option", async () => {
    const onAction = vi.fn();
    const onValueChange = vi.fn();
    render(
      <Combobox
        items={deriveOptions()}
        value={null}
        onValueChange={onValueChange}
      >
        <ComboboxInput aria-label="Ingredient" />
        <ComboboxContent>
          <ComboboxList>
            {deriveOptions().map((option) => (
              <ComboboxItem key={option.value} value={option}>
                {option.label}
              </ComboboxItem>
            ))}
          </ComboboxList>
          <ComboboxAction onClick={onAction}>Add Ingredient</ComboboxAction>
        </ComboboxContent>
      </Combobox>,
    );

    openList();
    const add = await screen.findByRole("button", { name: "Add Ingredient" });
    expect(add.closest('[data-slot="combobox-content"]')).not.toBeNull();
    expect(add.getAttribute("data-slot")).toBe("button");
    fireEvent.click(add);

    expect(onAction).toHaveBeenCalledOnce();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
