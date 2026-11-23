// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PdfPageCanvasContent } from "./pdf-page-canvas-content.js";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  destroy: vi.fn(() => Promise.resolve()),
  cancel: vi.fn(),
  render: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock("./pdfjs-document.js", () => ({ openPdfDocument: mocks.open }));

beforeEach(() => {
  mocks.cancel.mockClear();
  mocks.destroy.mockClear();
  mocks.render.mockReset();
  mocks.getPage.mockReset();
  mocks.open.mockReset();
  vi.stubGlobal("devicePixelRatio", 2);
  mocks.render.mockImplementation(() => ({
    promise: Promise.resolve(),
    cancel: mocks.cancel,
  }));
  mocks.getPage.mockResolvedValue({
    getViewport: ({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    }),
    render: mocks.render,
  });
  mocks.open.mockImplementation(() => ({
    promise: Promise.resolve({ getPage: mocks.getPage }),
    destroy: mocks.destroy,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PdfPageCanvasContent", () => {
  it("draws page one at the requested physical scale with a sharp backing canvas", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const view = render(<PdfPageCanvasContent bytes={bytes} scale={4 / 3} />);
    await waitFor(() => {
      expect(mocks.render).toHaveBeenCalledOnce();
    });

    const canvas = view.container.querySelector("canvas");
    expect(mocks.open).toHaveBeenCalledWith(bytes);
    expect(mocks.getPage).toHaveBeenCalledWith(1);
    expect(canvas?.style.width).toBe("816px");
    expect(canvas?.style.height).toBe("1056px");
    expect(canvas?.width).toBe(1632);
    expect(canvas?.height).toBe(2112);
    view.unmount();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("cancels the previous render before drawing a replacement", async () => {
    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
    const view = render(<PdfPageCanvasContent bytes={first} scale={1} />);
    await waitFor(() => {
      expect(mocks.render).toHaveBeenCalledOnce();
    });
    view.rerender(<PdfPageCanvasContent bytes={second} scale={2} />);
    await waitFor(() => {
      expect(mocks.render).toHaveBeenCalledTimes(2);
    });
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("reports unreadable PDFs through the caller's error handler", async () => {
    mocks.open.mockImplementation(() => ({
      promise: Promise.reject(new Error("Unreadable PDF")),
      destroy: mocks.destroy,
    }));
    const onError = vi.fn();
    render(<PdfPageCanvasContent bytes={new Uint8Array([0])} scale={1} onError={onError} />);
    await waitFor(() => {
      expect(onError).toHaveBeenCalledOnce();
    });
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
