/**
 * What: the attachment viewer routes each file type to the right preview, and
 * falls back to Download for unsupported types and failed loads.
 * Why: a person who cannot preview a file must still be able to get it, and a
 * stale preview must never outlive the file it belongs to. pdf.js never loads
 * in jsdom, so the PDF adapter is replaced by a stand-in.
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachmentItem } from "../../../elements/index.js";

import { AttachmentViewer, DEFAULT_MAX_PREVIEW_BYTES } from "./attachment-viewer.js";
import type { AttachmentDownloadOutcome, AttachmentViewerProps } from "./attachment-viewer.js";
import type { AttachmentSource, AttachmentSourceLoader } from "./use-attachment-source.js";

import {
  deferred,
  defineUrlMethod,
  imageItem,
  pdfItem,
  renderViewer,
  spreadsheetItem,
  stubFetchOk,
  urlSource,
} from "./test-support/attachment-viewer-fixture.js";

vi.mock("./pdf-document-view.js", () => ({
  PdfDocumentView: (props: { data: ArrayBuffer; onFailed: () => void }) => (
    <div data-testid="pdf-view" data-bytes={props.data.byteLength}>
      <button type="button" onClick={props.onFailed}>
        Simulate render failure
      </button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AttachmentViewer", () => {
  it("renders nothing while no file is selected", () => {
    renderViewer({ item: null });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the dialog after the file and shows its type and size", async () => {
    stubFetchOk();
    renderViewer();

    const dialog = await screen.findByRole("dialog", {
      name: "Lockout-Procedure-Leg-1.pdf",
    });
    expect(dialog.textContent).toContain("PDF · 25 kB");
  });

  it("reads a PDF and hands its bytes to the PDF view", async () => {
    const fetchStub = stubFetchOk(32);
    const { props } = renderViewer();

    const view = await screen.findByTestId("pdf-view");

    expect(view.getAttribute("data-bytes")).toBe("32");
    expect(props.loadSource).toHaveBeenCalledWith(pdfItem, expect.any(AbortSignal));
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [fetchedUrl, fetchInit] = fetchStub.mock.calls[0] ?? [];
    expect(fetchedUrl).toBe("https://files.test/signed");
    expect(fetchInit?.credentials).toBe("omit");
    expect(fetchInit?.signal).toBeInstanceOf(AbortSignal);
  });

  describe("very large files", () => {
    const hugePdf: AttachmentItem = {
      ...pdfItem,
      id: "file-huge",
      byteSize: DEFAULT_MAX_PREVIEW_BYTES + 1,
    };

    it("offers Download instead of a preview and never loads the file", async () => {
      const fetchStub = stubFetchOk();
      const { props } = renderViewer({ item: hugePdf });

      expect(await screen.findByText("This File Is Too Large to Preview")).toBeTruthy();
      expect(screen.getByText(/It is 26\.2 MB\./)).toBeTruthy();
      expect(props.loadSource).not.toHaveBeenCalled();
      expect(fetchStub).not.toHaveBeenCalled();
      expect(screen.queryByTestId("pdf-view")).toBeNull();
    });

    it("still downloads the file from the too-large panel", async () => {
      const { props } = renderViewer({ item: hugePdf });
      await screen.findByText("This File Is Too Large to Preview");

      const panelDownload = screen.getAllByRole("button", { name: "Download" }).at(-1);
      if (panelDownload === undefined) {
        throw new Error("expected the too-large panel's Download button");
      }
      fireEvent.click(panelDownload);

      await waitFor(() => {
        expect(props.onDownload).toHaveBeenCalledWith(hugePdf);
      });
    });

    it("applies to photos too", async () => {
      const { props } = renderViewer({
        item: { ...imageItem, byteSize: DEFAULT_MAX_PREVIEW_BYTES + 1 },
      });

      await screen.findByText("This File Is Too Large to Preview");
      expect(props.loadSource).not.toHaveBeenCalled();
    });

    it("previews a file exactly at the limit", async () => {
      stubFetchOk();
      renderViewer({
        item: { ...pdfItem, byteSize: DEFAULT_MAX_PREVIEW_BYTES },
      });

      expect(await screen.findByTestId("pdf-view")).toBeTruthy();
    });

    it("respects a custom maxPreviewBytes", async () => {
      const { props } = renderViewer({
        item: imageItem,
        maxPreviewBytes: 1000,
      });

      await screen.findByText("This File Is Too Large to Preview");
      expect(props.loadSource).not.toHaveBeenCalled();
    });

    it("previews a large file when the caller raises the limit", async () => {
      stubFetchOk();
      renderViewer({ item: hugePdf, maxPreviewBytes: 100 * 1024 * 1024 });

      expect(await screen.findByTestId("pdf-view")).toBeTruthy();
    });
  });

  it("shows an image with the file name as its alt text", async () => {
    renderViewer({ item: imageItem });

    const image = await screen.findByAltText("nameplate.png");

    expect(image.getAttribute("src")).toBe("https://files.test/signed");
  });

  describe("image controls", () => {
    // jsdom does no layout: give the stage room and the photo a size.
    const stageWidth = 1032; // 1000px of room once the stage padding is taken off
    const stageHeight = 896; // 800px of room
    let restoreSizes: () => void = () => undefined;

    afterEach(() => {
      restoreSizes();
    });

    async function openSizedPhoto() {
      const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
      const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get: () => stageWidth,
      });
      Object.defineProperty(HTMLElement.prototype, "clientHeight", {
        configurable: true,
        get: () => stageHeight,
      });
      restoreSizes = () => {
        if (widthDescriptor !== undefined) {
          Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDescriptor);
        }
        if (heightDescriptor !== undefined) {
          Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDescriptor);
        }
      };

      renderViewer({ item: imageItem });
      const image = await screen.findByAltText("nameplate.png");
      Object.defineProperty(image, "naturalWidth", { value: 4000 });
      Object.defineProperty(image, "naturalHeight", { value: 3000 });
      fireEvent.load(image);
      return image;
    }

    it("opens the photo fitted to the window and switches to actual size and back", async () => {
      const image = await openSizedPhoto();
      expect(image.style.width).toBe("1000px");
      expect(screen.getByText("25%")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Actual Size" }));
      expect(image.style.width).toBe("4000px");
      expect(screen.getByText("100%")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Fit to Window" }));
      expect(image.style.width).toBe("1000px");
    });

    it("zooms in and out through the preset steps", async () => {
      const image = await openSizedPhoto();

      fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
      expect(image.style.width).toBe("2000px");
      expect(screen.getByText("50%")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Zoom Out" }));
      expect(image.style.width).toBe("1000px");
    });

    it("turns the photo and refits it on its side", async () => {
      const image = await openSizedPhoto();

      fireEvent.click(screen.getByRole("button", { name: "Rotate Clockwise" }));
      expect(image.style.transform).toContain("rotate(90deg)");
      // On its side the photo's 4000px edge must fit the 800px of height.
      expect(image.style.width).toBe("800px");

      fireEvent.click(screen.getByRole("button", { name: "Rotate Counterclockwise" }));
      expect(image.style.transform).toContain("rotate(0deg)");
    });

    it("groups the image controls in a labelled toolbar", async () => {
      await openSizedPhoto();

      expect(screen.getByRole("toolbar", { name: "Image Controls" })).toBeTruthy();
    });
  });

  it("draws a blob image from an object URL and revokes it on close", async () => {
    // jsdom has no object URLs; the originals are restored afterwards.
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectURL = vi.fn(() => "blob:preview-1");
    const revokeObjectURL = vi.fn();
    defineUrlMethod("createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });
    defineUrlMethod("revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
      writable: true,
    });

    try {
      const { rerender, props } = renderViewer({
        item: imageItem,
        loadSource: () =>
          Promise.resolve({
            kind: "blob",
            blob: new Blob(["png"], { type: "image/png" }),
          }),
      });

      const image = await screen.findByAltText("nameplate.png");
      expect(image.getAttribute("src")).toBe("blob:preview-1");

      rerender(<AttachmentViewer {...props} item={null} />);

      expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
    } finally {
      defineUrlMethod("createObjectURL", originalCreate);
      defineUrlMethod("revokeObjectURL", originalRevoke);
    }
  });

  it("makes no object URL when the viewer closes before the blob source arrives", async () => {
    // jsdom has no object URLs; the originals are restored afterwards.
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const createObjectURL = vi.fn(() => "blob:never-revoked");
    defineUrlMethod("createObjectURL", {
      value: createObjectURL,
      configurable: true,
      writable: true,
    });

    try {
      let resolveSource: (source: AttachmentSource) => void = () => undefined;
      const loadSource = vi.fn<AttachmentSourceLoader>(
        () =>
          new Promise<AttachmentSource>((resolve) => {
            resolveSource = resolve;
          }),
      );
      const { rerender, props } = renderViewer({
        item: imageItem,
        loadSource,
      });
      await waitFor(() => {
        expect(loadSource).toHaveBeenCalledTimes(1);
      });

      rerender(<AttachmentViewer {...props} item={null} />);
      resolveSource({
        kind: "blob",
        blob: new Blob(["png"], { type: "image/png" }),
      });
      await new Promise((done) => setTimeout(done, 0));

      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      defineUrlMethod("createObjectURL", originalCreate);
    }
  });

  it("offers Download for a type it cannot preview, without loading it", async () => {
    const { props } = renderViewer({ item: spreadsheetItem });

    expect(await screen.findByText("We Can't Preview This File Type")).toBeTruthy();
    expect(props.loadSource).not.toHaveBeenCalled();

    const [downloadButton] = screen.getAllByRole("button", {
      name: "Download",
    });
    if (downloadButton === undefined) throw new Error("Download missing");
    fireEvent.click(downloadButton);
    expect(props.onDownload).toHaveBeenCalledWith(spreadsheetItem);
  });

  it("shows the failure and Download when the source cannot be loaded", async () => {
    renderViewer({
      loadSource: () => Promise.reject(new Error("link request failed")),
    });

    expect(await screen.findByText("Couldn't Open This File")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Download" }).length).toBeGreaterThan(1);
  });

  it("shows the failure when the file cannot be fetched (for example blocked by CORS)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    renderViewer();

    expect(await screen.findByText("Couldn't Open This File")).toBeTruthy();
    expect(screen.queryByTestId("pdf-view")).toBeNull();
  });

  it("shows the failure when the storage answers with an error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }),
      ),
    );
    renderViewer();

    expect(await screen.findByText("Couldn't Open This File")).toBeTruthy();
  });

  it("shows the failure when the PDF view cannot render the file", async () => {
    stubFetchOk();
    renderViewer();

    fireEvent.click(await screen.findByRole("button", { name: "Simulate render failure" }));

    expect(await screen.findByText("Couldn't Open This File")).toBeTruthy();
    expect(screen.queryByTestId("pdf-view")).toBeNull();
  });

  it("shows the failure when an image cannot be drawn", async () => {
    renderViewer({ item: imageItem });

    fireEvent.error(await screen.findByAltText("nameplate.png"));

    expect(await screen.findByText("Couldn't Open This File")).toBeTruthy();
  });

  it("calls onDownload from the toolbar and shows busy until it settles", async () => {
    stubFetchOk();
    const pending = deferred();
    const onDownload = vi.fn(() => pending.promise);
    renderViewer({ onDownload });
    await screen.findByTestId("pdf-view");

    const button = screen.getByRole("button", { name: "Download" });
    fireEvent.click(button);
    expect(onDownload).toHaveBeenCalledWith(pdfItem);
    expect(button.getAttribute("aria-busy")).toBe("true");

    fireEvent.click(button);
    expect(onDownload).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => {
      expect(button.getAttribute("aria-busy")).toBe("false");
    });
  });

  it("shows an error beside Download when onDownload rejects, and clears it on retry", async () => {
    stubFetchOk();
    const onDownload = vi
      .fn<AttachmentViewerProps["onDownload"]>()
      .mockRejectedValueOnce(new Error("link request failed"))
      .mockResolvedValueOnce("saved");
    renderViewer({ onDownload });
    await screen.findByTestId("pdf-view");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The file couldn't be downloaded. Try again.");
    // The preview stays up: a failed download is not a failed preview.
    expect(screen.getByTestId("pdf-view")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(onDownload).toHaveBeenCalledTimes(2);
  });

  it("shows the same error when onDownload reports a failure instead of rejecting", async () => {
    stubFetchOk();
    const onDownload = vi.fn<AttachmentViewerProps["onDownload"]>(() =>
      Promise.resolve<AttachmentDownloadOutcome>("failed"),
    );
    renderViewer({ onDownload });
    await screen.findByTestId("pdf-view");

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("does not show a failed download again when the same file is reopened", async () => {
    stubFetchOk();
    const { props, rerender } = renderViewer({
      onDownload: vi.fn<AttachmentViewerProps["onDownload"]>(() =>
        Promise.resolve<AttachmentDownloadOutcome>("failed"),
      ),
    });
    await screen.findByTestId("pdf-view");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    rerender(<AttachmentViewer {...props} item={null} />);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    rerender(<AttachmentViewer {...props} item={pdfItem} />);
    await screen.findByTestId("pdf-view");

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes from the Close button", async () => {
    stubFetchOk();
    const { props } = renderViewer();
    await screen.findByTestId("pdf-view");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("fills the window, with the file name, Download, and Close in the header", async () => {
    stubFetchOk();
    renderViewer();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("h-dvh");
    expect(dialog.className).toContain("w-screen");
    const header = dialog.querySelector("header");
    expect(header?.textContent).toContain("Lockout-Procedure-Leg-1.pdf");
    expect(header?.textContent).toContain("Download");
    expect(header?.textContent).toContain("Close");
  });

  it("closes on Escape", async () => {
    stubFetchOk();
    const { props } = renderViewer();
    await screen.findByTestId("pdf-view");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("aborts the previous load when another file is opened", async () => {
    const signals: AbortSignal[] = [];
    const loadSource = vi.fn<AttachmentSourceLoader>(
      (_item, signal) =>
        new Promise<AttachmentSource>(() => {
          signals.push(signal);
        }),
    );
    const { rerender, props } = renderViewer({ loadSource });
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });

    rerender(<AttachmentViewer {...props} item={imageItem} />);

    await waitFor(() => {
      expect(signals).toHaveLength(2);
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("aborts the load when the viewer closes", async () => {
    const signals: AbortSignal[] = [];
    const loadSource = vi.fn<AttachmentSourceLoader>(
      (_item, signal) =>
        new Promise<AttachmentSource>(() => {
          signals.push(signal);
        }),
    );
    const { rerender, props } = renderViewer({ loadSource });
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });

    rerender(<AttachmentViewer {...props} item={null} />);

    expect(signals[0]?.aborted).toBe(true);
  });

  it("does not reload the file when the parent re-renders with a new loader function", async () => {
    stubFetchOk();
    const firstLoader = vi.fn<AttachmentSourceLoader>(() => Promise.resolve(urlSource("https://files.test/signed")));
    const { rerender, props } = renderViewer({ loadSource: firstLoader });
    await screen.findByTestId("pdf-view");

    const secondLoader = vi.fn<AttachmentSourceLoader>(() => Promise.resolve(urlSource("https://files.test/other")));
    rerender(<AttachmentViewer {...props} loadSource={secondLoader} />);

    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(secondLoader).not.toHaveBeenCalled();
  });

  describe("returning focus", () => {
    function Harness({ showOpener = true }: { showOpener?: boolean }) {
      const [item, setItem] = React.useState<AttachmentItem | null>(null);
      return (
        <>
          {showOpener && (
            <button
              type="button"
              onClick={() => {
                setItem(pdfItem);
              }}
            >
              Open file
            </button>
          )}
          <AttachmentViewer
            item={item}
            onOpenChange={(open) => {
              if (!open) setItem(null);
            }}
            loadSource={() => Promise.resolve(urlSource("https://files.test/signed"))}
            onDownload={() => Promise.resolve("saved")}
          />
        </>
      );
    }

    async function openFromButton() {
      stubFetchOk();
      const result = render(<Harness />);
      const opener = screen.getByRole("button", { name: "Open file" });
      opener.focus();
      fireEvent.click(opener);
      await screen.findByTestId("pdf-view");
      return { opener, ...result };
    }

    it("returns focus to the opener when closed with Escape", async () => {
      const { opener } = await openFromButton();

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(document.activeElement).toBe(opener);
    });

    it("returns focus to the opener when closed with Close", async () => {
      const { opener } = await openFromButton();

      fireEvent.click(screen.getByRole("button", { name: "Close" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
      expect(document.activeElement).toBe(opener);
    });

    it("does not throw when the opener left the page while the viewer was open", async () => {
      const { rerender } = await openFromButton();
      rerender(<Harness showOpener={false} />);

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
      });
    });
  });
});
