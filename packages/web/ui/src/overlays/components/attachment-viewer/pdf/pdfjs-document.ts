/// <reference types="vite/client" />
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentLoadingTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export function openPdfDocument(bytes: Uint8Array): PDFDocumentLoadingTask {
  return getDocument({
    // PDF.js transfers the buffer to its worker. Cached/caller bytes remain owned by the caller.
    data: bytes.slice(),
    isEvalSupported: false,
    wasmUrl: "/pdfjs/wasm/",
  });
}
