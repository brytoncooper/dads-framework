/** @vitest-environment jsdom */
// The rail draws only rows in view, highlights the addressed record, keeps two pages loaded ahead, and always offers Load More.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MasterDetailList,
  type MasterDetailListProps,
} from "./master-detail-list.js";
import {
  type MasterDetailLinkProps,
  MasterDetailRow,
} from "./master-detail-row.js";
import { mockDesktopWidth, mockRailGeometry } from "./testing/rail-geometry.js";

type Pump = { readonly slug: string; readonly name: string };

function pumps(count: number): Pump[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `pump-${index + 1}`,
    name: `Pump ${index + 1}`,
  }));
}

/** The row link holding a record's name; names run into their second line in the accessible name. */
function rowLink(name: string): HTMLAnchorElement | null {
  return screen.queryByText(name)?.closest("a") ?? null;
}

function renderList(overrides: Partial<MasterDetailListProps<Pump>> = {}) {
  const props: MasterDetailListProps<Pump> = {
    items: pumps(150),
    total: 400,
    pageSize: 50,
    status: "success",
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    onRetry: vi.fn(),
    getKey: (pump) => pump.slug,
    renderRow: (pump, selected) => (
      <MasterDetailRow
        href={`/assets/${pump.slug}`}
        title={pump.name}
        subtitle="Conveyor"
        selected={selected}
      />
    ),
    emptyLabel: "No assets match this view.",
    loadingLabel: "Loading assets…",
    errorLabel: "Assets could not be loaded.",
    ...overrides,
  };
  render(<MasterDetailList {...props} />);
  return props;
}

let restoreGeometry: () => void = () => undefined;
let restoreWidth: () => void = () => undefined;
beforeEach(() => {
  restoreGeometry = mockRailGeometry({ viewportHeight: 560, rowHeight: 56 });
  restoreWidth = mockDesktopWidth(false);
});
afterEach(() => {
  cleanup();
  restoreGeometry();
  restoreWidth();
});

describe("MasterDetailList", () => {
  it("draws only the rows in view plus a small overscan", () => {
    renderList();
    expect(rowLink("Pump 1")).not.toBeNull();
    expect(rowLink("Pump 140")).toBeNull();
    expect(screen.getAllByRole("link").length).toBeLessThan(40);
  });

  it("marks the addressed record as the current page", () => {
    renderList({ selectedKey: "pump-2" });
    const selected = rowLink("Pump 2");
    expect(selected?.getAttribute("aria-current")).toBe("page");
    expect(selected?.className).toContain("border-l-primary");
    const other = rowLink("Pump 3");
    expect(other?.getAttribute("aria-current")).toBeNull();
    expect(other?.className).not.toContain("border-l-primary");
  });

  it("shows a row's context label as its last, muted line", () => {
    renderList({
      items: pumps(3),
      total: 3,
      hasNextPage: false,
      renderRow: (pump, selected) => (
        <MasterDetailRow
          href={`/assets/${pump.slug}`}
          title={pump.name}
          subtitle="Conveyor"
          contextLabel="North Plant"
          selected={selected}
        />
      ),
    });
    const facility = screen.getAllByText("North Plant")[0];
    expect(facility?.getAttribute("data-slot")).toBe(
      "master-detail-row-context",
    );
    expect(facility?.className).toContain("text-muted-foreground");
    expect(facility?.previousElementSibling?.textContent).toBe("Conveyor");
    expect(facility?.nextElementSibling).toBeNull();
  });

  it("omits an absent context label", () => {
    renderList({ items: pumps(3), total: 3, hasNextPage: false });
    expect(
      document.querySelector('[data-slot="master-detail-row-context"]'),
    ).toBeNull();
  });

  it("shows how much of the list is loaded while it is incomplete", () => {
    renderList();
    expect(screen.getByRole("status").textContent).toBe("150 of 400 loaded");
  });

  it("hides the loaded count once every row is loaded", () => {
    renderList({ items: pumps(12), total: 12, hasNextPage: false });
    expect(screen.queryByText(/loaded$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Load More" })).toBeNull();
  });

  it("offers Load More as a fallback that fetches the next page", () => {
    const props = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Load More" }));
    expect(props.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("disables Load More while the next page is in flight", () => {
    renderList({ isFetchingNextPage: true });
    const button = screen.getByRole("button", { name: "Loading…" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("does not prefetch while more than two pages remain past the visible rows", () => {
    const props = renderList({ items: pumps(150) });
    expect(props.fetchNextPage).not.toHaveBeenCalled();
  });

  it("prefetches when fewer than two pages remain past the visible rows", () => {
    const props = renderList({ items: pumps(50), total: 400 });
    expect(props.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("never prefetches a complete list", () => {
    const props = renderList({
      items: pumps(50),
      total: 50,
      hasNextPage: false,
    });
    expect(props.fetchNextPage).not.toHaveBeenCalled();
  });

  it("shows the empty, loading and error states as one quiet line each", () => {
    renderList({ items: [], total: 0, hasNextPage: false });
    expect(screen.getByText("No assets match this view.")).toBeTruthy();
    cleanup();

    renderList({ status: "pending", items: [] });
    expect(
      screen.getByRole("status", { name: "Loading assets…" }),
    ).toBeTruthy();
    cleanup();

    const props = renderList({ status: "error", items: [] });
    expect(screen.getByText("Assets could not be loaded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("MasterDetailList scroll position on selection", () => {
  // jsdom has no element scrolling: make `scrollTo` move the scroller as a
  // browser does, with the scroll event arriving a moment later.
  let restoreScrollTo: () => void = () => undefined;
  beforeEach(() => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTo",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        this.scrollTop = options.top ?? 0;
        setTimeout(() => this.dispatchEvent(new Event("scroll")), 0);
      },
    });
    restoreScrollTo = () => {
      if (original) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", original);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
      }
    };
  });
  afterEach(() => {
    restoreScrollTo();
  });

  // A scroller can only scroll as far as its content: the virtual list's `ul` height past the viewport.
  let restoreScrollExtent: () => void = () => undefined;
  beforeEach(() => {
    const scrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    const clientHeight = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "clientHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        const content = this.firstElementChild;
        return content instanceof HTMLElement
          ? Number.parseFloat(content.style.height) || 0
          : 0;
      },
    });
    Object.defineProperty(Element.prototype, "clientHeight", {
      configurable: true,
      get: () => 560,
    });
    restoreScrollExtent = () => {
      if (scrollHeight) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollHeight",
          scrollHeight,
        );
      }
      if (clientHeight) {
        Object.defineProperty(Element.prototype, "clientHeight", clientHeight);
      }
    };
  });
  afterEach(() => {
    restoreScrollExtent();
  });

  function listProps(selectedKey?: string): MasterDetailListProps<Pump> {
    return {
      items: pumps(150),
      total: 150,
      pageSize: 50,
      status: "success",
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      onRetry: vi.fn(),
      getKey: (pump) => pump.slug,
      ...(selectedKey === undefined ? {} : { selectedKey }),
      renderRow: (pump, selected) => (
        <MasterDetailRow
          href={`/assets/${pump.slug}`}
          title={pump.name}
          selected={selected}
        />
      ),
      emptyLabel: "none",
      loadingLabel: "loading",
      errorLabel: "error",
    };
  }

  /** Lets the scroll event and the virtualizer's frame-by-frame settling run. */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  }

  function scroller(): HTMLElement {
    const element = document.querySelector<HTMLElement>(
      '[data-slot="master-detail-list"]',
    );
    if (element === null) throw new Error("list scroller not rendered");
    return element;
  }

  it("keeps the scroll position when the reader clicks another row", () => {
    const { rerender } = render(<MasterDetailList {...listProps("pump-1")} />);
    scroller().scrollTop = 2240;
    fireEvent.scroll(scroller());

    rerender(<MasterDetailList {...listProps("pump-45")} />);
    rerender(<MasterDetailList {...listProps("pump-46")} />);

    expect(scroller().scrollTop).toBe(2240);
  });

  it("keeps the same list element when the selected record changes", () => {
    const { rerender } = render(<MasterDetailList {...listProps()} />);
    const before = scroller();
    scroller().scrollTop = 2240;
    fireEvent.scroll(scroller());

    rerender(<MasterDetailList {...listProps("pump-45")} />);

    expect(scroller()).toBe(before);
    expect(scroller().scrollTop).toBe(2240);
  });

  it("scrolls a deep-linked row into view when the list arrives after the address", async () => {
    const pending: MasterDetailListProps<Pump> = {
      ...listProps("pump-120"),
      items: [],
      total: 0,
      status: "pending",
    };
    const { rerender } = render(<MasterDetailList {...pending} />, {
      reactStrictMode: true,
    });

    rerender(<MasterDetailList {...listProps("pump-120")} />);
    await settle();

    expect(rowLink("Pump 120")).not.toBeNull();
    expect(scroller().scrollTop).toBeGreaterThan(0);
    expect(rowLink("Pump 120")?.getAttribute("aria-current")).toBe("page");
  });

  it("scrolls a deep-linked row into view when the list is already loaded", async () => {
    // The app renders under StrictMode, which mounts every effect twice in development.
    render(<MasterDetailList {...listProps("pump-120")} />, {
      reactStrictMode: true,
    });
    await settle();

    expect(rowLink("Pump 120")).not.toBeNull();
    expect(scroller().scrollTop).toBeGreaterThan(0);
  });

  it("scrolls a deep-linked last row that only overlaps the bottom edge of the pane", async () => {
    // 11 rows of 56px in a 580px pane: the last row spans 560-616, so it is in the
    // virtualizer's range at scrollTop 0 but its bottom is clipped.
    restoreGeometry();
    restoreGeometry = mockRailGeometry({ viewportHeight: 580, rowHeight: 56 });
    const props = { ...listProps("pump-11"), items: pumps(11), total: 11 };
    render(<MasterDetailList {...props} />, { reactStrictMode: true });
    await settle();

    expect(rowLink("Pump 11")?.getAttribute("aria-current")).toBe("page");
    expect(scroller().scrollTop).toBeGreaterThan(0);
  });

  it("reveals a deep-linked row once, then leaves the reader's scroll alone", async () => {
    const { rerender } = render(
      <MasterDetailList {...listProps("pump-120")} />,
      { reactStrictMode: true },
    );
    await settle();
    expect(scroller().scrollTop).toBeGreaterThan(0);

    scroller().scrollTop = 0;
    fireEvent.scroll(scroller());
    rerender(<MasterDetailList {...listProps("pump-121")} />);
    await settle();

    expect(scroller().scrollTop).toBe(0);
  });
});

describe("MasterDetailRow search", () => {
  it("opens a record with the section's list search only, never params the open record added", async () => {
    const { MasterDetailLayout } = await import("./master-detail-layout.js");
    render(
      <MasterDetailLayout
        label="Assets"
        selected
        listSearch={{ status: "archived", sort: "-name", q: undefined }}
        rail={
          <MasterDetailRow
            href="/assets/pump-2?from=record#details"
            title="Pump 2"
            selected={false}
          />
        }
      >
        <p>record</p>
      </MasterDetailLayout>,
    );
    expect(rowLink("Pump 2")?.getAttribute("href")).toBe(
      "/assets/pump-2?status=archived&sort=-name#details",
    );
  });

  it("passes the raw destination and list search to the app link component", async () => {
    const { MasterDetailLayout } = await import("./master-detail-layout.js");
    const RouterLink = ({ href, search, ...props }: MasterDetailLinkProps) => (
      <a href={href} data-search-page={search?.["page"]} {...props} />
    );

    render(
      <MasterDetailLayout
        label="Assets"
        selected
        listSearch={{ page: 2 }}
        rail={
          <MasterDetailRow
            href="/assets/pump-2"
            title="Pump 2"
            selected
            linkComponent={RouterLink}
          />
        }
      >
        <p>record</p>
      </MasterDetailLayout>,
    );

    const link = rowLink("Pump 2");
    expect(link?.getAttribute("href")).toBe("/assets/pump-2");
    expect(link?.getAttribute("data-search-page")).toBe("2");
    expect(link?.getAttribute("aria-current")).toBe("page");
  });
});

describe("MasterDetailList auto-open at the index address", () => {
  it("opens the first record once on desktop", () => {
    restoreWidth();
    restoreWidth = mockDesktopWidth(true);
    const onAutoOpen = vi.fn();
    renderList({ onAutoOpen });
    expect(onAutoOpen).toHaveBeenCalledTimes(1);
    expect(onAutoOpen).toHaveBeenCalledWith({ slug: "pump-1", name: "Pump 1" });
  });

  it("leaves a phone on the list", () => {
    const onAutoOpen = vi.fn();
    renderList({ onAutoOpen });
    expect(onAutoOpen).not.toHaveBeenCalled();
  });

  it("does nothing for an empty list", () => {
    restoreWidth();
    restoreWidth = mockDesktopWidth(true);
    const onAutoOpen = vi.fn();
    renderList({ onAutoOpen, items: [], total: 0, hasNextPage: false });
    expect(onAutoOpen).not.toHaveBeenCalled();
  });
});

describe("MasterDetailRow", () => {
  it("links to the record and shows its name, second line and badge", () => {
    render(
      <MasterDetailRow
        href="/assets/pump-1"
        title="Pump 1"
        subtitle="Conveyor"
        badge={<span>Tag Needed</span>}
        selected={false}
      />,
    );
    const link = rowLink("Pump 1");
    expect(link?.getAttribute("href")).toBe("/assets/pump-1");
    expect(link?.textContent).toContain("Conveyor");
    expect(link?.textContent).toContain("Tag Needed");
  });
});
