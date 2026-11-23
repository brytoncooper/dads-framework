import type { PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as React from "react";

import {
  PRINT_RENDER_BATCH_SIZE,
  chunkPages,
  printPageSize,
  printRenderScale,
  printedPageCount,
} from "../logic/pdf-print.js";
import type { PdfPageSource } from "./pdf-types.js";

/** The hidden host for the drawn pages; `pdf-viewer.css` reveals it only in print. */
const PRINT_CONTAINER_CLASS = "attachment-viewer-print";
/** One printed sheet; each breaks onto its own page. */
const PRINT_PAGE_CLASS = "attachment-viewer-print-page";
/** On `<body>` while printing, so the print rules apply to this run only. */
const PRINTING_BODY_CLASS = "attachment-viewer-printing";
/**
 * Zeroes the paper margins for this run only. `@page` cannot be scoped to a
 * body class, so a static rule would also strip the margins from the
 * browser's own Ctrl+P. It is injected for the run and removed with it.
 */
const PRINT_PAGE_MARGIN_CSS = "@media print { @page { margin: 0; } }";

export type PdfPrintStatus = "idle" | "preparing" | "failed";

export type PdfPrintController = {
  readonly status: PdfPrintStatus;
  /** Pages drawn so far, for the progress readout. */
  readonly completed: number;
  /** Pages in the document being prepared, or 0 when idle. */
  readonly total: number;
  /** Draws every page and opens the browser's print dialog. */
  print: () => void;
  /** Abandons a run that is still drawing and cleans up after it. */
  cancel: () => void;
};

type PrintRun = {
  cancelled: boolean;
  readonly container: HTMLElement;
  task: RenderTask | null;
  onAfterPrint: (() => void) | null;
  pageStyle: HTMLStyleElement | null;
  /** The one canvas every page is drawn into in turn, released when the run ends. */
  scratchCanvas: HTMLCanvasElement | null;
  /** Object URLs whose images have not loaded yet; teardown revokes any left over. */
  readonly objectUrls: Set<string>;
};

/**
 * Reads the flag fresh. TypeScript keeps a property narrowed across an
 * `await`, so a second inline `run.cancelled` check after an earlier one
 * would look always-false, though Cancel Printing can flip it meanwhile.
 */
function wasCancelled(run: PrintRun): boolean {
  return run.cancelled;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
}

function releaseCanvas(run: PrintRun): void {
  if (run.scratchCanvas === null) return;
  run.scratchCanvas.width = 0;
  run.scratchCanvas.height = 0;
  run.scratchCanvas = null;
}

/** Resolves once a printed page's image has decoded; a page that will not decode fails the run. */
function loadPrintImage(
  image: HTMLImageElement,
  source: string,
  objectUrl: string | null,
  run: PrintRun,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const forget = () => {
      if (objectUrl === null) return;
      URL.revokeObjectURL(objectUrl);
      run.objectUrls.delete(objectUrl);
    };
    image.onload = () => {
      forget();
      resolve();
    };
    image.onerror = () => {
      forget();
      reject(new Error("A printed page's image failed to decode."));
    };
    image.src = source;
  });
}

/** Draws one page into the run's scratch canvas and appends it to the print container as an image. */
async function appendPrintedPage(page: PDFPageProxy, run: PrintRun): Promise<void> {
  const canvas = run.scratchCanvas;
  if (canvas === null) return;

  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({
    scale: printRenderScale(base.width, base.height),
  });
  // Resizing clears the canvas; one reused canvas keeps memory to one page.
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  const task = page.render({
    canvas,
    viewport,
    // No background: the page is drawn on transparency and the paper is white.
    intent: "print",
  });
  run.task = task;
  await task.promise;
  run.task = null;
  if (wasCancelled(run)) return;

  // What stays in the page is one compressed image per sheet, not a live
  // full-resolution canvas. Some engines hand back no blob; a data URL then
  // carries the page instead.
  const blob = await canvasToPngBlob(canvas);
  if (wasCancelled(run)) return;
  const objectUrl = blob === null ? null : URL.createObjectURL(blob);
  if (objectUrl !== null) run.objectUrls.add(objectUrl);

  const image = document.createElement("img");
  image.className = PRINT_PAGE_CLASS;
  // Laid out at true paper size; the browser scales the larger bitmap down.
  image.style.width = `${String(printPageSize(base.width, base.height).widthIn)}in`;
  run.container.appendChild(image);
  await loadPrintImage(image, objectUrl ?? canvas.toDataURL("image/png"), objectUrl, run);
}

/**
 * Print, done by hand because pdf.js does not publish its print service.
 *
 * Every page of the already-loaded document is drawn at print resolution into
 * one reused canvas, compressed to an image, and added to a hidden container;
 * a print stylesheet then hides the app and shows only those pages, one per
 * sheet. Pages are drawn a few at a time with a yield between batches, so
 * the tab stays responsive and Cancel Printing is heard. The container, the
 * canvas, leftover object URLs, the drawing in progress, the `afterprint`
 * listener, the margin style and the body class are all removed on cancel,
 * after the print dialog closes, and when the viewer closes mid-run.
 */
export function usePdfPrint(pdfDocument: PdfPageSource | null): PdfPrintController {
  const [status, setStatus] = React.useState<PdfPrintStatus>("idle");
  const [completed, setCompleted] = React.useState(0);
  const [total, setTotal] = React.useState(0);
  const runRef = React.useRef<PrintRun | null>(null);

  const teardown = React.useCallback(() => {
    const run = runRef.current;
    runRef.current = null;
    document.body.classList.remove(PRINTING_BODY_CLASS);
    if (run === null) return;
    run.cancelled = true;
    run.task?.cancel();
    for (const url of run.objectUrls) URL.revokeObjectURL(url);
    run.objectUrls.clear();
    run.container.remove();
    releaseCanvas(run);
    if (run.onAfterPrint !== null) {
      window.removeEventListener("afterprint", run.onAfterPrint);
    }
    run.pageStyle?.remove();
  }, []);

  const reset = React.useCallback(() => {
    setStatus("idle");
    setCompleted(0);
    setTotal(0);
  }, []);

  const cancel = React.useCallback(() => {
    teardown();
    reset();
  }, [teardown, reset]);

  const openPrintDialog = React.useCallback(
    (run: PrintRun) => {
      releaseCanvas(run);
      // `afterprint` fires when the dialog closes, printed or not.
      const onAfterPrint = () => {
        teardown();
        reset();
      };
      run.onAfterPrint = onAfterPrint;
      window.addEventListener("afterprint", onAfterPrint);
      const pageStyle = document.createElement("style");
      pageStyle.textContent = PRINT_PAGE_MARGIN_CSS;
      document.head.appendChild(pageStyle);
      run.pageStyle = pageStyle;
      document.body.classList.add(PRINTING_BODY_CLASS);
      window.print();
    },
    [teardown, reset],
  );

  const print = React.useCallback(() => {
    // No document yet, or a run already going: a second press starts nothing.
    if (pdfDocument === null || runRef.current !== null) return;

    const container = document.createElement("div");
    container.className = PRINT_CONTAINER_CLASS;
    container.setAttribute("aria-hidden", "true");
    document.body.appendChild(container);
    const run: PrintRun = {
      cancelled: false,
      container,
      task: null,
      onAfterPrint: null,
      pageStyle: null,
      scratchCanvas: document.createElement("canvas"),
      objectUrls: new Set<string>(),
    };
    runRef.current = run;
    setStatus("preparing");
    setCompleted(0);
    setTotal(pdfDocument.numPages);

    const drawEveryPage = async () => {
      for (const batch of chunkPages(pdfDocument.numPages, PRINT_RENDER_BATCH_SIZE)) {
        for (const pageNumber of batch) {
          const page = await pdfDocument.getPage(pageNumber);
          if (wasCancelled(run)) return;
          await appendPrintedPage(page, run);
          if (wasCancelled(run)) return;
          setCompleted((done) => done + 1);
        }
        // Yield between batches so progress paints and Cancel Printing is heard.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (wasCancelled(run)) return;
      }
      openPrintDialog(run);
    };

    drawEveryPage().catch(() => {
      if (run.cancelled) return;
      teardown();
      setStatus("failed");
      setCompleted(0);
      setTotal(0);
    });
  }, [pdfDocument, teardown, openPrintDialog]);

  // A run must not outlive the viewer or its document. Page proxies are not
  // cleaned up here: they are shared with the pages on screen.
  React.useEffect(
    () => () => {
      teardown();
      reset();
    },
    [pdfDocument, teardown, reset],
  );

  return {
    status,
    completed: printedPageCount(completed, total),
    total,
    print,
    cancel,
  };
}
