/**
 * What: a drop made from the keyboard (Space, ArrowDown, Space on a handle)
 * reports the move through `onMove` and `onValueChange`, just as a pointer
 * drop does.
 * Why: dnd-kit's KeyboardSensor prevents the default of the activating
 * keydown, so reading `defaultPrevented` as a consumer opt-out silently
 * dropped every keyboard move.
 * @vitest-environment jsdom
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
} from "./sortable.js";

const ROW_HEIGHT = 40;
const ITEMS = ["a", "b", "c"];
const originalRectDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "getBoundingClientRect",
);

// jsdom lays nothing out; stack the list items so "below" has meaning, and make
// the list as tall as its items because the vertical sortable restricts a drag
// to its parent element (an empty parent would pin every drag in place).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: function getBoundingClientRect(this: HTMLElement): DOMRect {
      const parent = this.parentElement;
      const isRow = this.tagName === "LI" && parent !== null;
      const isList = this.tagName === "UL";
      const top = isRow
        ? Array.from(parent.children).indexOf(this) * ROW_HEIGHT
        : 0;
      let height = 0;
      if (isRow) height = ROW_HEIGHT;
      if (isList) height = this.children.length * ROW_HEIGHT;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 400,
        bottom: top + height,
        width: 400,
        height,
        toJSON: () => ({}),
      };
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  if (originalRectDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "getBoundingClientRect",
      originalRectDescriptor,
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
  }
});
afterEach(cleanup);

// dnd-kit attaches the keyboard listeners one timer tick after activation.
async function press(code: string) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      code,
      key: code === "Space" ? " " : code,
    });
  });
}
async function keyboardMoveFirstItemDown() {
  screen.getByRole("button", { name: "Move a" }).focus();
  await press("Space");
  await press("ArrowDown");
  await press("Space");
}
function renderList(props: {
  readonly onMove?: (event: { activeIndex: number; overIndex: number }) => void;
  readonly onValueChange?: (items: string[]) => void;
}) {
  render(
    <Sortable value={ITEMS} {...props}>
      <SortableContent asChild>
        <ul>
          {ITEMS.map((item) => (
            <SortableItem key={item} value={item} asChild>
              <li>
                <SortableItemHandle aria-label={`Move ${item}`}>
                  {item}
                </SortableItemHandle>
              </li>
            </SortableItem>
          ))}
        </ul>
      </SortableContent>
    </Sortable>,
  );
}

describe("Sortable keyboard drops", () => {
  it("calls onMove with the active and over indexes", async () => {
    const onMove = vi.fn();
    renderList({ onMove });

    await keyboardMoveFirstItemDown();

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ activeIndex: 0, overIndex: 1 }),
    );
  });

  it("reorders through onValueChange when no onMove is given", async () => {
    const onValueChange = vi.fn();
    renderList({ onValueChange });

    await keyboardMoveFirstItemDown();

    expect(onValueChange).toHaveBeenCalledWith(["b", "a", "c"]);
  });
});
