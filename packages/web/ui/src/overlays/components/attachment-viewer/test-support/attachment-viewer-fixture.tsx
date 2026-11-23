import { render } from "@testing-library/react";
import { vi } from "vitest";

import type { AttachmentItem } from "../../../../elements/index.js";

import { AttachmentViewer, type AttachmentDownloadOutcome, type AttachmentViewerProps } from "../attachment-viewer.js";
import type { AttachmentSource, AttachmentSourceLoader } from "../use-attachment-source.js";

export const pdfItem: AttachmentItem = {
  id: "file-pdf",
  fileName: "Lockout-Procedure-Leg-1.pdf",
  contentType: "application/pdf",
  byteSize: 25_000,
};

export const imageItem: AttachmentItem = {
  id: "file-image",
  fileName: "nameplate.png",
  contentType: "image/png",
  byteSize: 480_000,
};

export const spreadsheetItem: AttachmentItem = {
  id: "file-sheet",
  fileName: "parts.xlsx",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  byteSize: 90_000,
};

export function urlSource(url: string): AttachmentSource {
  return { kind: "url", url };
}

export function stubFetchOk(byteLength = 8) {
  const fetchStub = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ArrayBuffer(byteLength))));
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

/** Sets or, when given nothing, removes a static `URL` method jsdom lacks. */
export function defineUrlMethod(
  name: "createObjectURL" | "revokeObjectURL",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor === undefined) {
    Reflect.deleteProperty(URL, name);
    return;
  }
  Object.defineProperty(URL, name, descriptor);
}

export function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<AttachmentDownloadOutcome>((resolvePromise) => {
    resolve = () => {
      resolvePromise("saved");
    };
  });
  return { promise, resolve };
}

export function renderViewer(overrides: Partial<AttachmentViewerProps> = {}) {
  const props: AttachmentViewerProps = {
    item: pdfItem,
    onOpenChange: vi.fn(),
    loadSource: vi.fn<AttachmentSourceLoader>(() => Promise.resolve(urlSource("https://files.test/signed"))),
    onDownload: vi.fn<AttachmentViewerProps["onDownload"]>(() => Promise.resolve<AttachmentDownloadOutcome>("saved")),
    ...overrides,
  };
  const view = render(<AttachmentViewer {...props} />);
  return { props, ...view };
}
