/**
 * jsdom lays nothing out, so a virtualized rail would draw no rows. This gives
 * every element a fixed height: `rowHeight` for a measured row (it carries
 * `data-index`) and `viewportHeight` for everything else, including the
 * rail's scroll container. Call it in `beforeEach` and the returned restore
 * function in `afterEach`.
 *
 *   let restore = () => {};
 *   beforeEach(() => { restore = mockRailGeometry(); });
 *   afterEach(() => restore());
 */
export function mockRailGeometry({
  viewportHeight = 560,
  rowHeight = 56,
  width = 272,
}: {
  readonly viewportHeight?: number;
  readonly rowHeight?: number;
  readonly width?: number;
} = {}): () => void {
  const prototype = HTMLElement.prototype;
  const heightDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "offsetHeight",
  );
  const widthDescriptor = Object.getOwnPropertyDescriptor(
    prototype,
    "offsetWidth",
  );
  Object.defineProperty(prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset["index"] === undefined ? viewportHeight : rowHeight;
    },
  });
  Object.defineProperty(prototype, "offsetWidth", {
    configurable: true,
    get() {
      return width;
    },
  });
  return () => {
    if (heightDescriptor) {
      Object.defineProperty(prototype, "offsetHeight", heightDescriptor);
    }
    if (widthDescriptor) {
      Object.defineProperty(prototype, "offsetWidth", widthDescriptor);
    }
  };
}

/**
 * Points `window.matchMedia` at a fixed answer, so the two-pane desktop
 * layout (and the index address's auto-open) can be switched on in a test.
 * Returns a restore function.
 */
export function mockDesktopWidth(matches: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  // Defined as a property value so the answer need not carry the deprecated
  // addListener/removeListener members of MediaQueryList.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(window, "matchMedia");
    } else {
      Object.defineProperty(window, "matchMedia", original);
    }
  };
}
