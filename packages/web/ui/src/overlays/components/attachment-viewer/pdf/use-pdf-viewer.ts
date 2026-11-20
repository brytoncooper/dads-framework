/**
 * pdf.js, wired to two elements and torn down properly. Together with the
 * rest of `pdf/` and `pdf-document-view.tsx`, this is reached only through the
 * lazy document view, so pdf.js never joins the main bundle.
 */
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import * as React from "react";

import { clampPageNumber } from "../logic/pdf-page-input.js";
import {
  INITIAL_ROTATION,
  nextRotation,
  normalizeRotation,
  type RotateDirection,
  type ViewRotation,
} from "../logic/view-rotation.js";
import { nextZoomScale, type ZoomDirection } from "../logic/view-zoom.js";
import {
  guardStructTree,
  isStructTreeSource,
} from "./pdf-struct-tree-guard.js";
import type { PdfEventBus, PdfPageSource } from "./pdf-types.js";
import { openPdfDocument } from "./pdfjs-document.js";
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "./pdfjs-viewer.js";

/**
 * pdf.js's own scale for "fit the page width, but no larger than 125%": a
 * phone gets the whole width and a wide screen does not blow a letter page up
 * to 250%.
 */
const OPENING_SCALE_VALUE = "auto";

/** pdf.js's own name for "make the page as wide as the viewing area". */
const FIT_WIDTH_SCALE_VALUE = "page-width";

/**
 * pdf.js detaches a document with `setDocument(null)` in its own teardown but
 * declares the parameter as non-null. The gap is stated once here so teardown
 * does not need a type assertion.
 */
type DetachableDocumentTarget = {
  setDocument(document: PDFDocumentProxy | null): void;
};

function detachDocument(target: DetachableDocumentTarget): void {
  target.setDocument(null);
}

/**
 * pdf.js types `pagesPromise` as `any`. It settles once every page's size is
 * known and rejects when the pages cannot be read.
 */
type PagesPromiseSource = {
  readonly pagesPromise: Promise<void> | null | undefined;
};

function whenPagesFail(source: PagesPromiseSource, onFail: () => void): void {
  source.pagesPromise?.catch(onFail);
}

/**
 * A malformed structure tree on any page rejects uncaught inside pdf.js
 * (pdf.js #19694, #19822). Every page shares one prototype, so guarding the
 * first page's prototype covers them all.
 */
function guardPageStructTrees(page: object): void {
  const pagePrototype: unknown = Object.getPrototypeOf(page);
  if (isStructTreeSource(pagePrototype)) guardStructTree(pagePrototype);
}

export type PdfViewerController = {
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  readonly viewerElementRef: React.RefObject<HTMLDivElement | null>;
  readonly status: "loading" | "ready";
  /** The loaded document, for thumbnails and print. Null until it opens. */
  readonly document: PdfPageSource | null;
  /** The viewer's event bus, for the find bar. Null until the viewer is built. */
  readonly eventBus: PdfEventBus | null;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly scale: number;
  readonly rotation: ViewRotation;
  goToPage: (page: number) => void;
  zoom: (direction: ZoomDirection) => void;
  fitWidth: () => void;
  rotate: (direction: RotateDirection) => void;
};

/**
 * Builds a pdf.js viewer on two elements, loads `data` into it, and tears it
 * all down: listeners, observer, document, worker task. The viewer lays every
 * page out in one continuous scroll and reports the page in view.
 */
export function usePdfViewer(
  data: ArrayBuffer,
  onFailed: () => void,
): PdfViewerController {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const viewerElementRef = React.useRef<HTMLDivElement | null>(null);
  const viewerRef = React.useRef<PDFViewer | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready">("loading");
  const [loadedDocument, setLoadedDocument] =
    React.useState<PDFDocumentProxy | null>(null);
  const [eventBus, setEventBus] = React.useState<EventBus | null>(null);
  const [pageNumber, setPageNumber] = React.useState(1);
  const [pageCount, setPageCount] = React.useState(0);
  const [scale, setScale] = React.useState(1);
  const [rotation, setRotation] =
    React.useState<ViewRotation>(INITIAL_ROTATION);

  // Read inside the load promise, so a new callback never restarts the load.
  const onFailedRef = React.useRef(onFailed);
  React.useEffect(() => {
    onFailedRef.current = onFailed;
  });

  React.useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerElementRef.current;
    if (container === null || viewerElement === null) return;

    const { bus, linkService, viewer } = createViewer(container, viewerElement);
    viewerRef.current = viewer;
    setEventBus(bus);

    setStatus("loading");
    setPageNumber(1);
    setPageCount(0);
    setRotation(INITIAL_ROTATION);

    const unsubscribe = subscribeViewer(bus, viewer, {
      setPageCount,
      setPageNumber,
      setScale,
      setRotation,
      setStatus,
    });

    const disconnect = keepNamedScaleOnResize(container, viewer);

    const stopLoading = loadDocument(data, viewer, linkService, {
      onFailed: () => {
        onFailedRef.current();
      },
      setPageCount,
      setLoadedDocument,
    });

    return () => {
      disconnect();
      unsubscribe();
      detachDocument(viewer);
      linkService.setDocument(null);
      viewerRef.current = null;
      setEventBus(null);
      setLoadedDocument(null);
      stopLoading();
    };
  }, [data]);

  const goToPage = React.useCallback((page: number) => {
    const viewer = viewerRef.current;
    if (viewer === null || viewer.pagesCount < 1) return;
    viewer.currentPageNumber = clampPageNumber(page, viewer.pagesCount);
  }, []);

  const zoom = React.useCallback((direction: ZoomDirection) => {
    const viewer = viewerRef.current;
    if (viewer === null) return;
    viewer.currentScale = nextZoomScale(viewer.currentScale, direction);
  }, []);

  const fitWidth = React.useCallback(() => {
    const viewer = viewerRef.current;
    if (viewer === null) return;
    viewer.currentScaleValue = FIT_WIDTH_SCALE_VALUE;
  }, []);

  const rotate = React.useCallback((direction: RotateDirection) => {
    const viewer = viewerRef.current;
    if (viewer === null) return;
    viewer.pagesRotation = nextRotation(viewer.pagesRotation, direction);
  }, []);

  return {
    containerRef,
    viewerElementRef,
    status,
    document: loadedDocument,
    eventBus,
    pageNumber,
    pageCount,
    scale,
    rotation,
    goToPage,
    zoom,
    fitWidth,
    rotate,
  };
}

function createViewer(
  container: HTMLDivElement,
  viewerElement: HTMLDivElement,
) {
  const bus = new EventBus();
  // `LinkTarget.BLANK` opens links in a new tab, and pdf.js marks them
  // `rel="noopener noreferrer nofollow"` by default.
  const linkService = new PDFLinkService({
    eventBus: bus,
    externalLinkTarget: LinkTarget.BLANK,
  });
  // Answers the find bar's `find` requests and paints the matches.
  const findController = new PDFFindController({
    linkService,
    eventBus: bus,
  });
  // No scripting manager and no annotation editor: PDFs are read-only here.
  const viewer = new PDFViewer({
    container,
    viewer: viewerElement,
    eventBus: bus,
    linkService,
    findController,
    textLayerMode: 1,
    // pdf.js's page-border image is swapped for a plain shadow in
    // pdf-viewer.css; telling pdf.js keeps its page-width maths exact.
    removePageBorders: true,
  });
  linkService.setViewer(viewer);
  return { bus, linkService, viewer };
}

function subscribeViewer(
  bus: EventBus,
  viewer: PDFViewer,
  {
    setPageCount,
    setPageNumber,
    setScale,
    setRotation,
    setStatus,
  }: {
    readonly setPageCount: (count: number) => void;
    readonly setPageNumber: (page: number) => void;
    readonly setScale: (scale: number) => void;
    readonly setRotation: (rotation: ViewRotation) => void;
    readonly setStatus: (status: "ready") => void;
  },
): () => void {
  const onPagesInit = () => {
    viewer.currentScaleValue = OPENING_SCALE_VALUE;
    setPageCount(viewer.pagesCount);
    setScale(viewer.currentScale);
    setStatus("ready");
  };
  const onPageChanging = (event: { pageNumber: number }) => {
    setPageNumber(event.pageNumber);
  };
  const onScaleChanging = (event: { scale: number }) => {
    setScale(event.scale);
  };
  // pdf.js re-lays out every page on a rotate and leaves the scroll offset
  // where it was, which is now somewhere else in the document. Put the
  // reader back on the page they were reading.
  const onRotationChanging = (event: {
    pagesRotation: number;
    pageNumber: number;
  }) => {
    setRotation(normalizeRotation(event.pagesRotation));
    viewer.currentPageNumber = event.pageNumber;
  };
  bus.on("pagesinit", onPagesInit);
  bus.on("pagechanging", onPageChanging);
  bus.on("scalechanging", onScaleChanging);
  bus.on("rotationchanging", onRotationChanging);

  return () => {
    bus.off("pagesinit", onPagesInit);
    bus.off("pagechanging", onPageChanging);
    bus.off("scalechanging", onScaleChanging);
    bus.off("rotationchanging", onRotationChanging);
  };
}

function keepNamedScaleOnResize(
  container: HTMLDivElement,
  viewer: PDFViewer,
): () => void {
  // pdf.js resolves a named scale such as "page-width" once, when it is set.
  // Without this, resizing the window (or opening the thumbnail rail)
  // leaves the page at its old width.
  let refitHandle = 0;
  const resizeObserver = new ResizeObserver(() => {
    window.cancelAnimationFrame(refitHandle);
    refitHandle = window.requestAnimationFrame(() => {
      const current = viewer.currentScaleValue;
      if (current && Number.isNaN(Number(current))) {
        viewer.currentScaleValue = current;
      }
    });
  });
  resizeObserver.observe(container);

  return () => {
    window.cancelAnimationFrame(refitHandle);
    resizeObserver.disconnect();
  };
}

function loadDocument(
  data: ArrayBuffer,
  viewer: PDFViewer,
  linkService: PDFLinkService,
  {
    onFailed,
    setPageCount,
    setLoadedDocument,
  }: {
    readonly onFailed: () => void;
    readonly setPageCount: (count: number) => void;
    readonly setLoadedDocument: (document: PDFDocumentProxy) => void;
  },
): () => void {
  let superseded = false;
  // Read through a call: TypeScript keeps `superseded` narrowed to false
  // across an `await`, though teardown can set it meanwhile.
  const wasSuperseded = () => superseded;
  let openedDocument: PDFDocumentProxy | null = null;
  let task: PDFDocumentLoadingTask | null = null;
  try {
    task = openPdfDocument(new Uint8Array(data));
  } catch {
    onFailed();
  }

  const fail = () => {
    if (!superseded) onFailed();
  };

  task?.promise
    .then(async (pdfDocument) => {
      if (superseded) {
        await pdfDocument.destroy().catch(() => undefined);
        return;
      }
      openedDocument = pdfDocument;
      guardPageStructTrees(await pdfDocument.getPage(1));
      if (wasSuperseded()) return;
      viewer.setDocument(pdfDocument);
      linkService.setDocument(pdfDocument);
      setPageCount(pdfDocument.numPages);
      setLoadedDocument(pdfDocument);
      // A document whose pages cannot be read opens but never fires
      // `pagesinit`, which would leave the spinner up forever.
      whenPagesFail(viewer, fail);
    })
    .catch(fail);

  return () => {
    superseded = true;
    void task?.destroy().catch(() => undefined);
    if (openedDocument !== null) {
      void openedDocument.cleanup().catch(() => undefined);
      void openedDocument.destroy().catch(() => undefined);
    }
  };
}
