import type { RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as React from "react";

import { thumbnailDimensions } from "../logic/pdf-thumbnail.js";
import type { ViewRotation } from "../logic/view-rotation.js";
import type { PdfPageSource } from "./pdf-types.js";

/** A drawn thumbnail, compressed to an image and sized for its slot. */
export type ThumbnailImage = {
  /** A `data:image/png` URL holding the finished drawing. */
  readonly src: string;
  /** The CSS size, in px, the image takes up: the same as the canvas it replaces. */
  readonly cssWidth: number;
  readonly cssHeight: number;
};

/**
 * Draws one page small, but only once it is within a screenful of the rail's
 * visible area, then hands back a compressed image of it and releases the
 * canvas. pdf.js publishes no thumbnail view, so each thumbnail is a page
 * drawn by hand; drawing them all up front would make the worker rasterise
 * every page the moment the rail opens. A drawn canvas holds a raw bitmap for
 * as long as it lives, so the finished drawing is swapped for a PNG and the
 * canvas is zeroed. The draw is cancelled if the page leaves the rail first.
 */
export function useThumbnailRender(
  pdfDocument: PdfPageSource,
  pageNumber: number,
  rotation: ViewRotation,
  targetRef: React.RefObject<HTMLElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  rootRef: React.RefObject<HTMLElement | null>,
): ThumbnailImage | null {
  const [image, setImage] = React.useState<ThumbnailImage | null>(null);

  React.useEffect(() => {
    const target = targetRef.current;
    if (target === null) return;

    let cancelled = false;
    let started = false;
    let renderTask: RenderTask | null = null;
    // Read through a call: TypeScript keeps `cancelled` narrowed to false
    // across each `await`, though teardown can set it meanwhile.
    const wasCancelled = () => cancelled;

    const draw = async () => {
      if (started || cancelled) return;
      started = true;

      const page = await pdfDocument.getPage(pageNumber);
      const canvas = canvasRef.current;
      if (wasCancelled() || canvas === null) return;

      const turned = (page.rotate + rotation) % 360;
      const base = page.getViewport({ scale: 1, rotation: turned });
      const dims = thumbnailDimensions(base.width, base.height, {
        devicePixelRatio: window.devicePixelRatio,
      });
      const viewport = page.getViewport({
        scale: dims.scale * dims.devicePixelRatio,
        rotation: turned,
      });

      canvas.width = dims.canvasWidth;
      canvas.height = dims.canvasHeight;
      canvas.style.width = `${String(dims.cssWidth)}px`;
      canvas.style.height = `${String(dims.cssHeight)}px`;

      renderTask = page.render({ canvas, viewport });
      await renderTask.promise;
      const drawn = canvasRef.current;
      if (wasCancelled() || drawn === null) return;

      setImage({
        src: drawn.toDataURL("image/png"),
        cssWidth: dims.cssWidth,
        cssHeight: dims.cssHeight,
      });
      drawn.width = 0;
      drawn.height = 0;
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        // A cancelled draw rejects on teardown, and a page that will not draw
        // small is not worth interrupting the reader for: the slot stays blank.
        draw().catch(() => undefined);
      },
      { root: rootRef.current, rootMargin: "200px" },
    );
    observer.observe(target);

    return () => {
      cancelled = true;
      observer.disconnect();
      renderTask?.cancel();
    };
  }, [pdfDocument, pageNumber, rotation, targetRef, canvasRef, rootRef]);

  return image;
}
