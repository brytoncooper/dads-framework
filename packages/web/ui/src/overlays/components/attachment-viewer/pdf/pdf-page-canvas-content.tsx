import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as React from "react";

import type { PdfPageCanvasProps } from "../pdf-page-canvas.js";
import { openPdfDocument } from "./pdfjs-document.js";

export function PdfPageCanvasContent({ bytes, scale, className, onError }: PdfPageCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let cancelled = false;
    const wasCancelled = () => cancelled;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let renderTask: RenderTask | null = null;

    async function drawPage(targetCanvas: HTMLCanvasElement) {
      loadingTask = openPdfDocument(bytes);
      const document = await loadingTask.promise;
      const page = await document.getPage(1);
      if (wasCancelled()) return;
      const viewport = page.getViewport({ scale });
      const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
      const pixelViewport = page.getViewport({ scale: scale * pixelRatio });
      targetCanvas.width = Math.ceil(pixelViewport.width);
      targetCanvas.height = Math.ceil(pixelViewport.height);
      targetCanvas.style.width = `${String(viewport.width)}px`;
      targetCanvas.style.height = `${String(viewport.height)}px`;
      renderTask = page.render({
        canvas: targetCanvas,
        viewport: pixelViewport,
      });
      await renderTask.promise;
    }

    void drawPage(canvas).catch(() => {
      if (!cancelled) onErrorRef.current?.();
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [bytes, scale]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
