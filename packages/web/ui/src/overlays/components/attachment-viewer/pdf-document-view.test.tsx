/**
 * What: the PDF stage's controls: thumbnails, page navigation, the page box,
 * Find in Document, zoom, rotate, and the staged Escape.
 * Why: these are how a technician gets around a long manual. pdf.js never
 * loads in jsdom, so the pdf.js wiring is replaced by a stand-in controller
 * and event bus, and thumbnails are left undrawn.
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PdfDocumentView } from "./pdf-document-view.js";
import type { PdfEventBus } from "./pdf/pdf-types.js";
import type { PdfViewerController } from "./pdf/use-pdf-viewer.js";

vi.mock("./pdf/use-pdf-viewer.js", () => ({
  usePdfViewer: () => fakeController(),
}));
vi.mock("./pdf/use-thumbnail-render.js", () => ({
  useThumbnailRender: () => null,
}));

type BusListener = Parameters<PdfEventBus["on"]>[1];

function createFakeBus() {
  const listeners = new Map<string, BusListener[]>();
  const dispatched: { name: string; data: object }[] = [];
  const bus: PdfEventBus = {
    on: (name, listener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    off: (name, listener) => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((each) => each !== listener),
      );
    },
    dispatch: (name, data) => {
      dispatched.push({ name, data });
    },
  };
  return {
    bus,
    emit(name: string, payload: object) {
      for (const listener of listeners.get(name) ?? []) {
        Reflect.apply(listener, undefined, [payload]);
      }
    },
    lastDispatched(name: string): object | undefined {
      return dispatched.filter((entry) => entry.name === name).at(-1)?.data;
    },
    dispatchedNames: () => dispatched.map((entry) => entry.name),
  };
}

let fakeBus = createFakeBus();
let controllerState: Partial<PdfViewerController> = {};
const goToPage = vi.fn<(page: number) => void>();
const zoom = vi.fn<PdfViewerController["zoom"]>();
const fitWidth = vi.fn<() => void>();
const rotate = vi.fn<PdfViewerController["rotate"]>();

function fakeController(): PdfViewerController {
  return {
    containerRef: { current: null },
    viewerElementRef: { current: null },
    status: "ready",
    document: {
      numPages: 5,
      getPage: () => new Promise<never>(() => undefined),
    },
    eventBus: fakeBus.bus,
    pageNumber: 1,
    pageCount: 5,
    scale: 1.25,
    rotation: 0,
    goToPage,
    zoom,
    fitWidth,
    rotate,
    ...controllerState,
  };
}

function renderView() {
  const view = render(<PdfDocumentView data={new ArrayBuffer(8)} onFailed={vi.fn()} />);
  return {
    ...view,
    showPage: (pageNumber: number) => {
      controllerState = { ...controllerState, pageNumber };
      view.rerender(<PdfDocumentView data={new ArrayBuffer(8)} onFailed={vi.fn()} />);
    },
  };
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");

beforeEach(() => {
  fakeBus = createFakeBus();
  controllerState = {};
  // jsdom has neither; the rail keeps its current thumbnail in view with them.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  if (originalScrollIntoView === undefined) {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  } else {
    Object.defineProperty(Element.prototype, "scrollIntoView", originalScrollIntoView);
  }
});

function pageBox(): HTMLInputElement {
  const box = screen.getByRole("textbox", { name: "Page Number" });
  if (!(box instanceof HTMLInputElement)) throw new Error("not an input");
  return box;
}

describe("PdfDocumentView", () => {
  it("shows the page in view and the page count, and follows scrolling", () => {
    const { showPage } = renderView();

    expect(pageBox().value).toBe("1");
    expect(screen.getByText("of 5")).toBeTruthy();

    showPage(3);

    expect(pageBox().value).toBe("3");
  });

  it("jumps to the first, previous, next, and last page", () => {
    const { showPage } = renderView();
    showPage(3);

    fireEvent.click(screen.getByRole("button", { name: "First Page" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous Page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next Page" }));
    fireEvent.click(screen.getByRole("button", { name: "Last Page" }));

    expect(goToPage.mock.calls).toEqual([[1], [2], [4], [5]]);
  });

  it("disables the backward controls on page 1 and the forward ones on the last page", () => {
    const { showPage } = renderView();
    const isDisabled = (name: string) => screen.getByRole("button", { name }).hasAttribute("disabled");

    expect(isDisabled("First Page")).toBe(true);
    expect(isDisabled("Previous Page")).toBe(true);
    expect(isDisabled("Last Page")).toBe(false);

    showPage(5);

    expect(isDisabled("Next Page")).toBe(true);
    expect(isDisabled("Last Page")).toBe(true);
    expect(isDisabled("First Page")).toBe(false);
  });

  it("goes to a typed page on Enter and ignores text that is not a page", () => {
    renderView();

    fireEvent.change(pageBox(), { target: { value: "4" } });
    fireEvent.keyDown(pageBox(), { key: "Enter" });
    expect(goToPage).toHaveBeenLastCalledWith(4);

    goToPage.mockClear();
    fireEvent.change(pageBox(), { target: { value: "abc" } });
    fireEvent.keyDown(pageBox(), { key: "Enter" });
    expect(goToPage).not.toHaveBeenCalled();
    expect(pageBox().value).toBe("1");
  });

  it("drops a half-typed page on Escape without going anywhere", () => {
    renderView();
    pageBox().focus();
    fireEvent.change(pageBox(), { target: { value: "4" } });

    fireEvent.keyDown(pageBox(), { key: "Escape" });

    expect(pageBox().value).toBe("1");
    expect(goToPage).not.toHaveBeenCalled();
  });

  describe("thumbnails", () => {
    it("lists every page, marks the page in view, and jumps on a click", () => {
      const { showPage } = renderView();
      const rail = screen.getByRole("navigation", { name: "Page Thumbnails" });
      expect(rail.querySelectorAll("button")).toHaveLength(5);

      showPage(2);
      expect(screen.getByRole("button", { name: "Page 2" }).getAttribute("aria-current")).toBe("page");

      fireEvent.click(screen.getByRole("button", { name: "Page 4" }));
      expect(goToPage).toHaveBeenCalledWith(4);
    });

    it("hides and shows the rail from the toolbar", () => {
      renderView();

      fireEvent.click(screen.getByRole("button", { name: "Hide Page Thumbnails" }));
      expect(screen.queryByRole("navigation", { name: "Page Thumbnails" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Show Page Thumbnails" }));
      expect(screen.getByRole("navigation", { name: "Page Thumbnails" })).toBeTruthy();
    });

    it("starts hidden on a phone-width window", () => {
      vi.stubGlobal("innerWidth", 390);
      renderView();

      expect(screen.queryByRole("navigation", { name: "Page Thumbnails" })).toBeNull();
      expect(screen.getByRole("button", { name: "Show Page Thumbnails" })).toBeTruthy();
    });
  });

  describe("find in document", () => {
    function openFind() {
      fireEvent.click(screen.getByRole("button", { name: "Find in Document" }));
      return screen.getByRole("searchbox", { name: "Find in Document" });
    }

    it("searches as the reader types and steps through matches", async () => {
      renderView();
      const searchBox = openFind();
      expect(document.activeElement).toBe(searchBox);

      fireEvent.change(searchBox, { target: { value: "torque" } });
      await waitFor(() => {
        expect(fakeBus.lastDispatched("find")).toMatchObject({
          type: "",
          query: "torque",
          highlightAll: true,
        });
      });

      fireEvent.keyDown(searchBox, { key: "Enter" });
      expect(fakeBus.lastDispatched("find")).toMatchObject({
        type: "again",
        findPrevious: false,
      });

      fireEvent.click(screen.getByRole("button", { name: "Previous Match" }));
      expect(fakeBus.lastDispatched("find")).toMatchObject({
        type: "again",
        findPrevious: true,
      });

      fireEvent.click(screen.getByRole("button", { name: "Next Match" }));
      expect(fakeBus.lastDispatched("find")).toMatchObject({
        type: "again",
        findPrevious: false,
      });
    });

    it("shows the running match count and says when nothing matches", () => {
      renderView();
      const searchBox = openFind();
      fireEvent.change(searchBox, { target: { value: "torque" } });

      fireEvent.click(screen.getByRole("button", { name: "Next Match" }));
      act(() => {
        fakeBus.emit("updatefindcontrolstate", {
          state: 0,
          matchesCount: { current: 2, total: 7 },
        });
      });
      expect(screen.getByText("2 of 7")).toBeTruthy();

      act(() => {
        fakeBus.emit("updatefindcontrolstate", {
          state: 1,
          matchesCount: { current: 0, total: 0 },
        });
      });
      expect(screen.getByText("No matches")).toBeTruthy();
    });

    it("re-runs the search when an option is toggled", () => {
      renderView();
      openFind();

      fireEvent.click(screen.getByRole("button", { name: "Match Case" }));

      expect(fakeBus.lastDispatched("find")).toMatchObject({
        type: "casesensitivitychange",
        caseSensitive: true,
      });
      expect(screen.getByRole("button", { name: "Match Case" }).getAttribute("aria-pressed")).toBe("true");
    });

    it("closes on Escape and clears its highlights", () => {
      renderView();
      const searchBox = openFind();

      fireEvent.keyDown(searchBox, { key: "Escape" });

      expect(screen.queryByRole("searchbox")).toBeNull();
      expect(fakeBus.dispatchedNames()).toContain("findbarclose");
    });

    it("opens with Ctrl+F", () => {
      renderView();

      fireEvent.keyDown(window, { key: "f", ctrlKey: true });

      expect(screen.getByRole("searchbox", { name: "Find in Document" })).toBeTruthy();
    });
  });

  it("zooms, fits the width, and shows the zoom as a percentage", () => {
    renderView();

    expect(screen.getByText("125%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom Out" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit Width" }));

    expect(zoom.mock.calls).toEqual([["in"], ["out"]]);
    expect(fitWidth).toHaveBeenCalledTimes(1);
  });

  it("rotates the pages both ways", () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Rotate Clockwise" }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate Counterclockwise" }));

    expect(rotate.mock.calls).toEqual([["clockwise"], ["counterclockwise"]]);
  });

  it("offers Print in the toolbar", () => {
    renderView();

    expect(screen.getByRole("toolbar", { name: "PDF Controls" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print" })).toBeTruthy();
  });
});
