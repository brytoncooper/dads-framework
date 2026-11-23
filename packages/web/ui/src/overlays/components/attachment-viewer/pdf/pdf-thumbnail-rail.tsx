import * as React from "react";

import { cn } from "../../../../elements/index.js";

import { useOverlaysCopy } from "../../../copy/overlays-copy.js";
import { THUMBNAIL_MAX_WIDTH } from "../logic/pdf-thumbnail.js";
import type { ViewRotation } from "../logic/view-rotation.js";
import type { PdfPageSource } from "./pdf-types.js";
import { useKeepThumbnailInView } from "./use-keep-thumbnail-in-view.js";
import { useThumbnailRender } from "./use-thumbnail-render.js";

/**
 * The column of page thumbnails beside the document. Choosing one jumps to
 * that page; the page in view is highlighted and kept in sight as the reader
 * scrolls, so the rail and the page stay in step whichever one they drive.
 * Each thumbnail draws itself only as it nears view.
 */
export function PdfThumbnailRail({
  pdfDocument,
  pageCount,
  currentPage,
  rotation,
  onSelectPage,
}: {
  pdfDocument: PdfPageSource;
  pageCount: number;
  currentPage: number;
  rotation: ViewRotation;
  onSelectPage: (page: number) => void;
}) {
  const t = useOverlaysCopy();
  const railRef = React.useRef<HTMLElement | null>(null);

  useKeepThumbnailInView(railRef, currentPage, rotation);

  return (
    <nav
      ref={railRef}
      aria-label={t("overlays.attachmentViewer.pdf.thumbnails")}
      className="flex w-40 shrink-0 flex-col gap-3 overflow-x-hidden overflow-y-auto border-r bg-background p-3"
    >
      {Array.from({ length: pageCount }, (_unused, index) => {
        const pageNumber = index + 1;
        return (
          <PdfThumbnail
            key={`${String(pageNumber)}-${String(rotation)}`}
            pdfDocument={pdfDocument}
            pageNumber={pageNumber}
            rotation={rotation}
            isCurrent={pageNumber === currentPage}
            onSelect={onSelectPage}
            railRef={railRef}
          />
        );
      })}
    </nav>
  );
}

function PdfThumbnail({
  pdfDocument,
  pageNumber,
  rotation,
  isCurrent,
  onSelect,
  railRef,
}: {
  pdfDocument: PdfPageSource;
  pageNumber: number;
  rotation: ViewRotation;
  isCurrent: boolean;
  onSelect: (page: number) => void;
  railRef: React.RefObject<HTMLElement | null>;
}) {
  const t = useOverlaysCopy();
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const image = useThumbnailRender(pdfDocument, pageNumber, rotation, buttonRef, canvasRef, railRef);
  const slotClassName = "mx-auto block max-w-full rounded-sm bg-card shadow-sm ring-1 ring-border";

  return (
    <button
      ref={buttonRef}
      type="button"
      data-page={pageNumber}
      aria-label={t("overlays.attachmentViewer.pdf.thumbnail", {
        page: pageNumber,
      })}
      aria-current={isCurrent ? "page" : undefined}
      onClick={() => {
        onSelect(pageNumber);
      }}
      className={cn(
        "flex shrink-0 cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-transparent p-1.5 transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none",
        isCurrent && "border-primary bg-accent",
      )}
    >
      {/* The canvas is swapped for a compressed image once drawn; both share
          one size, so the swap does not shift the rail. */}
      {image === null ? (
        <canvas
          ref={canvasRef}
          aria-hidden
          className={cn(slotClassName, "aspect-[8.5/11]")}
          style={{ width: THUMBNAIL_MAX_WIDTH }}
        />
      ) : (
        <img
          src={image.src}
          alt=""
          aria-hidden
          className={slotClassName}
          style={{ width: image.cssWidth, height: image.cssHeight }}
        />
      )}
      <span className={cn("text-xs text-muted-foreground tabular-nums", isCurrent && "font-medium text-foreground")}>
        {pageNumber}
      </span>
    </button>
  );
}
