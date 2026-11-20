/**
 * The PDF stage: page thumbnails, every page in one continuous scroll, Find
 * in Document, and the floating toolbar.
 *
 * The attachment viewer loads this file with a dynamic `import()`, so pdf.js
 * (and its worker, a separate asset the browser fetches on first use) never
 * joins the main bundle. Every pdfjs-dist import lives in this file or in the
 * `pdf/` folder beside it, which nothing else imports.
 */
import "./pdf-viewer.css";

import {
  ArrowLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  PanelLeftIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SearchIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import * as React from "react";

import { useLocaleFormatting } from "@dads-framework/copy";
import { Spinner } from "../../../elements/index.js";

import { useOverlaysCopy } from "../../copy/overlays-copy.js";
import { FullScreenButton } from "./full-screen-button.js";
import { railDefaultOpen } from "./logic/pdf-thumbnail.js";
import { hasZoomStep } from "./logic/view-zoom.js";
import { PdfFindBar } from "./pdf/pdf-find-bar.js";
import { PdfPageField, type PdfPageFieldHandle } from "./pdf/pdf-page-field.js";
import { PdfPrintButton } from "./pdf/pdf-print-button.js";
import { PdfThumbnailRail } from "./pdf/pdf-thumbnail-rail.js";
import { usePdfPrint } from "./pdf/use-pdf-print.js";
import {
  type PdfViewerController,
  usePdfViewer,
} from "./pdf/use-pdf-viewer.js";
import {
  ToolbarDivider,
  ToolbarIconButton,
  ToolbarReadout,
  ViewerToolbar,
} from "./viewer-toolbar.js";

export type PdfDocumentViewProps = {
  readonly data: ArrayBuffer;
  /** Called when the bytes cannot be read as a PDF. */
  readonly onFailed: () => void;
};

export function PdfDocumentView({ data, onFailed }: PdfDocumentViewProps) {
  const t = useOverlaysCopy();
  const pdf = usePdfViewer(data, onFailed);
  const print = usePdfPrint(pdf.document);
  const isReady = pdf.status === "ready";

  // Open beside the page on a desktop-width window, closed on a phone so the
  // page keeps the room. The viewer fills the window, so the window's width
  // is the stage's width.
  const [isRailOpen, setIsRailOpen] = React.useState(() =>
    railDefaultOpen(window.innerWidth),
  );
  const [isFindOpen, setIsFindOpen] = React.useState(false);
  const pageFieldRef = React.useRef<PdfPageFieldHandle | null>(null);
  useWindowShortcuts({
    pageFieldRef,
    isFindOpen,
    openFind: () => {
      setIsFindOpen(true);
    },
    closeFind: () => {
      setIsFindOpen(false);
    },
  });

  return (
    <div className="flex min-h-0 flex-1">
      {isRailOpen && pdf.document !== null && (
        <PdfThumbnailRail
          pdfDocument={pdf.document}
          pageCount={pdf.pageCount}
          currentPage={pdf.pageNumber}
          rotation={pdf.rotation}
          onSelectPage={pdf.goToPage}
        />
      )}

      <div className="relative min-w-0 flex-1 bg-muted dark:bg-scrim">
        {/* pdf.js needs this container absolutely positioned and scrollable.
            The bottom padding keeps the last page clear of the toolbar. */}
        <div
          ref={pdf.containerRef}
          tabIndex={0}
          className="absolute inset-0 overflow-auto pb-20 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <div ref={pdf.viewerElementRef} className="pdfViewer" />
        </div>

        {isFindOpen && pdf.eventBus !== null && (
          <PdfFindBar
            eventBus={pdf.eventBus}
            onClose={() => {
              setIsFindOpen(false);
            }}
          />
        )}

        {print.status === "failed" && (
          <p
            role="alert"
            className="absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground shadow-sm"
          >
            {t("overlays.attachmentViewer.pdf.print.failed")}
          </p>
        )}

        {isReady ? (
          <PdfToolbar
            pdf={pdf}
            isRailOpen={isRailOpen}
            onToggleRail={() => {
              setIsRailOpen((open) => !open);
            }}
            isFindOpen={isFindOpen}
            onToggleFind={() => {
              setIsFindOpen((open) => !open);
            }}
            pageFieldRef={pageFieldRef}
            printButton={<PdfPrintButton print={print} />}
          />
        ) : (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner className="size-6 text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Ctrl/Cmd+F opens Find in Document, and Escape is staged: the first press
 * abandons a half-typed page number, or closes the find bar, and only a press
 * with neither open reaches the dialog and closes the viewer. The dialog
 * listens for Escape on the document in the capture phase, so this listens on
 * the window in the capture phase, which runs first. The viewer fills the
 * window and is modal, so owning these keys takes nothing from the page
 * behind it.
 */
function useWindowShortcuts({
  pageFieldRef,
  isFindOpen,
  openFind,
  closeFind,
}: {
  pageFieldRef: React.RefObject<PdfPageFieldHandle | null>;
  isFindOpen: boolean;
  openFind: () => void;
  closeFind: () => void;
}) {
  const latest = React.useRef({ isFindOpen, openFind, closeFind });
  React.useEffect(() => {
    latest.current = { isFindOpen, openFind, closeFind };
  });

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isFindShortcut =
        (event.metaKey || event.ctrlKey) &&
        (event.key === "f" || event.key === "F");
      if (isFindShortcut) {
        event.preventDefault();
        latest.current.openFind();
        return;
      }
      if (event.key !== "Escape") return;
      const pageField = pageFieldRef.current;
      if (pageField?.isEditing()) {
        event.preventDefault();
        event.stopPropagation();
        pageField.abandon();
        return;
      }
      if (latest.current.isFindOpen) {
        event.preventDefault();
        event.stopPropagation();
        latest.current.closeFind();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [pageFieldRef]);
}

function PdfToolbar({
  pdf,
  isRailOpen,
  onToggleRail,
  isFindOpen,
  onToggleFind,
  pageFieldRef,
  printButton,
}: {
  pdf: PdfViewerController;
  isRailOpen: boolean;
  onToggleRail: () => void;
  isFindOpen: boolean;
  onToggleFind: () => void;
  pageFieldRef: React.RefObject<PdfPageFieldHandle | null>;
  printButton: React.ReactNode;
}) {
  const t = useOverlaysCopy();
  const { formatNumber } = useLocaleFormatting();
  const isOnFirstPage = pdf.pageNumber <= 1;
  const isOnLastPage = pdf.pageNumber >= pdf.pageCount;

  return (
    <ViewerToolbar label={t("overlays.attachmentViewer.pdf.toolbar")}>
      <ToolbarIconButton
        label={
          isRailOpen
            ? t("overlays.attachmentViewer.pdf.thumbnails.hide")
            : t("overlays.attachmentViewer.pdf.thumbnails.show")
        }
        pressed={isRailOpen}
        onClick={onToggleRail}
      >
        <PanelLeftIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.pdf.find")}
        pressed={isFindOpen}
        onClick={onToggleFind}
      >
        <SearchIcon />
      </ToolbarIconButton>
      {printButton}

      <ToolbarDivider />

      <ToolbarIconButton
        label={t("overlays.attachmentViewer.pdf.firstPage")}
        disabled={isOnFirstPage}
        onClick={() => {
          pdf.goToPage(1);
        }}
      >
        <ChevronsLeftIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.pdf.previousPage")}
        disabled={isOnFirstPage}
        onClick={() => {
          pdf.goToPage(pdf.pageNumber - 1);
        }}
      >
        <ChevronLeftIcon />
      </ToolbarIconButton>
      <PdfPageField
        ref={pageFieldRef}
        pageNumber={pdf.pageNumber}
        pageCount={pdf.pageCount}
        onCommit={pdf.goToPage}
      />
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.pdf.nextPage")}
        disabled={isOnLastPage}
        onClick={() => {
          pdf.goToPage(pdf.pageNumber + 1);
        }}
      >
        <ChevronRightIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.pdf.lastPage")}
        disabled={isOnLastPage}
        onClick={() => {
          pdf.goToPage(pdf.pageCount);
        }}
      >
        <ChevronsRightIcon />
      </ToolbarIconButton>

      <ToolbarDivider />

      <ToolbarIconButton
        label={t("overlays.attachmentViewer.zoomOut")}
        disabled={!hasZoomStep(pdf.scale, "out")}
        onClick={() => {
          pdf.zoom("out");
        }}
      >
        <ZoomOutIcon />
      </ToolbarIconButton>
      <ToolbarReadout>
        {formatNumber(pdf.scale, {
          style: "percent",
          maximumFractionDigits: 0,
        })}
      </ToolbarReadout>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.zoomIn")}
        disabled={!hasZoomStep(pdf.scale, "in")}
        onClick={() => {
          pdf.zoom("in");
        }}
      >
        <ZoomInIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.pdf.fitWidth")}
        onClick={pdf.fitWidth}
      >
        <ArrowLeftRightIcon />
      </ToolbarIconButton>
      <FullScreenButton />

      <ToolbarDivider />

      <ToolbarIconButton
        label={t("overlays.attachmentViewer.rotateCounterclockwise")}
        onClick={() => {
          pdf.rotate("counterclockwise");
        }}
      >
        <RotateCcwIcon />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t("overlays.attachmentViewer.rotateClockwise")}
        onClick={() => {
          pdf.rotate("clockwise");
        }}
      >
        <RotateCwIcon />
      </ToolbarIconButton>
    </ViewerToolbar>
  );
}
