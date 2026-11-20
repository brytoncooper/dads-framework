import { useCallback, useEffect, useRef, useState } from "react";

import {
  attachmentKindOf,
  type AttachmentItem,
} from "../../../elements/index.js";

/** Where the bytes of a stored file can be read from, as the caller knows it. */
export type AttachmentSource =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "blob"; readonly blob: Blob };

/**
 * Asks the caller for a readable source of a file. It runs once per open, so a
 * caller that signs short-lived links can sign a fresh one each time.
 */
export type AttachmentSourceLoader = (
  item: AttachmentItem,
  signal: AbortSignal,
) => Promise<AttachmentSource>;

/** A source turned into what the matching preview needs to draw it. */
export type PreparedAttachment =
  | { readonly kind: "pdf"; readonly data: ArrayBuffer }
  | { readonly kind: "image"; readonly src: string };

/**
 * Files larger than this are offered for download instead of previewed. A
 * preview fetches the whole file before drawing anything (no progress, and the
 * bytes are held twice while a PDF renders), so very large files are not worth it.
 */
export const DEFAULT_MAX_PREVIEW_BYTES = 25 * 1024 * 1024;

export type AttachmentPreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly prepared: PreparedAttachment }
  | { readonly status: "unsupported" }
  | { readonly status: "tooLarge" }
  | { readonly status: "failed" };

const IDLE_STATE: AttachmentPreviewState = { status: "idle" };

async function readBytes(
  source: AttachmentSource,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (source.kind === "blob") return source.blob.arrayBuffer();

  // `credentials: "omit"`: the link is already signed, and the bucket answers
  // with a wildcard origin that browsers refuse to pair with credentials.
  const response = await fetch(source.url, { signal, credentials: "omit" });
  if (!response.ok) {
    throw new Error(`The file could not be read (HTTP ${response.status}).`);
  }
  return response.arrayBuffer();
}

function describeState(
  item: AttachmentItem | null,
  entry: {
    readonly itemId: string | null;
    readonly state: AttachmentPreviewState;
  },
  maxPreviewBytes: number,
): AttachmentPreviewState {
  if (item === null) return IDLE_STATE;
  if (entry.itemId === item.id) return entry.state;
  if (attachmentKindOf(item) === "other") return { status: "unsupported" };
  return item.byteSize > maxPreviewBytes
    ? { status: "tooLarge" }
    : { status: "loading" };
}

/**
 * Loads the file behind `item` for preview and cleans up after it.
 *
 * - Opening a different file, or closing, aborts the read that is in flight.
 * - Object URLs made for blob images are revoked when the file changes.
 * - File types the viewer cannot draw, and files larger than
 *   `maxPreviewBytes`, never call `loadSource`.
 */
export function useAttachmentSource(
  item: AttachmentItem | null,
  loadSource: AttachmentSourceLoader,
  maxPreviewBytes: number = DEFAULT_MAX_PREVIEW_BYTES,
): {
  readonly state: AttachmentPreviewState;
  readonly markFailed: () => void;
} {
  // The state remembers which file it describes, so the render that follows a
  // switch to another file never shows the previous file's preview.
  const [entry, setEntry] = useState<{
    readonly itemId: string | null;
    readonly state: AttachmentPreviewState;
  }>({ itemId: null, state: IDLE_STATE });

  // Callers pass inline functions; reading the latest one through a ref keeps
  // a re-render from restarting the load.
  const loadSourceRef = useRef(loadSource);
  useEffect(() => {
    loadSourceRef.current = loadSource;
  });

  const itemRef = useRef(item);
  useEffect(() => {
    itemRef.current = item;
  });

  const maxPreviewBytesRef = useRef(maxPreviewBytes);
  useEffect(() => {
    maxPreviewBytesRef.current = maxPreviewBytes;
  });

  const itemId = item?.id ?? null;

  useEffect(() => {
    const currentItem = itemRef.current;
    if (itemId === null || currentItem === null) {
      setEntry({ itemId: null, state: IDLE_STATE });
      return;
    }

    const kind = attachmentKindOf(currentItem);
    if (kind === "other") {
      setEntry({ itemId, state: { status: "unsupported" } });
      return;
    }

    if (currentItem.byteSize > maxPreviewBytesRef.current) {
      setEntry({ itemId, state: { status: "tooLarge" } });
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | null = null;
    setEntry({ itemId, state: { status: "loading" } });

    async function prepare(
      target: AttachmentItem,
    ): Promise<PreparedAttachment> {
      const source = await loadSourceRef.current(target, controller.signal);
      if (kind === "pdf") {
        return {
          kind: "pdf",
          data: await readBytes(source, controller.signal),
        };
      }
      if (source.kind === "url") return { kind: "image", src: source.url };

      // The load may have been abandoned while the source was resolving; an
      // object URL made now would never be revoked.
      if (controller.signal.aborted) throw new Error("The load was aborted.");
      objectUrl = URL.createObjectURL(source.blob);
      return { kind: "image", src: objectUrl };
    }

    prepare(currentItem).then(
      (prepared) => {
        if (controller.signal.aborted) return;
        setEntry({ itemId, state: { status: "ready", prepared } });
      },
      () => {
        if (controller.signal.aborted) return;
        setEntry({ itemId, state: { status: "failed" } });
      },
    );

    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [itemId]);

  const markFailed = useCallback(() => {
    setEntry((current) =>
      current.state.status === "ready"
        ? { itemId: current.itemId, state: { status: "failed" } }
        : current,
    );
  }, []);

  const state = describeState(item, entry, maxPreviewBytes);
  return { state, markFailed };
}
