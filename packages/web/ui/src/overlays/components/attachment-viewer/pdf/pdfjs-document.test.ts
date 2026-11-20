import { describe, expect, it, vi } from "vitest";

import { openPdfDocument } from "./pdfjs-document.js";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mocks.getDocument,
  GlobalWorkerOptions: {},
}));

describe("openPdfDocument", () => {
  it("copies caller bytes before transferring them to the worker", () => {
    const original = new Uint8Array([37, 80, 68, 70]);
    openPdfDocument(original);
    const options: unknown = mocks.getDocument.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      data: original,
      isEvalSupported: false,
      wasmUrl: "/pdfjs/wasm/",
    });
    if (
      typeof options !== "object" ||
      options === null ||
      !("data" in options)
    ) {
      throw new Error("PDF.js did not receive document data");
    }
    expect(options.data).not.toBe(original);
  });
});
