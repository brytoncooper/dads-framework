import {
  DownloadIcon,
  FileIcon,
  FileImageIcon,
  FileTextIcon,
  FileXIcon,
  LoaderCircleIcon,
} from "lucide-react";
import * as React from "react";

import { useLocaleFormatting } from "../../../copy/index.js";
import {
  Button,
  Spinner,
  attachmentKindOf,
  cn,
  formatFileSize,
  type AttachmentItem,
  type AttachmentKind,
} from "../../../elements/index.js";
import {
  useOverlaysCopy,
  type OverlaysCopyKey,
} from "../../copy/overlays-copy.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog.js";
import { ImageStage } from "./image-stage.js";
import type { PdfDocumentViewProps } from "./pdf-document-view.js";
import {
  DEFAULT_MAX_PREVIEW_BYTES,
  useAttachmentSource,
  type AttachmentPreviewState,
  type AttachmentSourceLoader,
} from "./use-attachment-source.js";

export { DEFAULT_MAX_PREVIEW_BYTES } from "./use-attachment-source.js";
export type {
  AttachmentSource,
  AttachmentSourceLoader,
} from "./use-attachment-source.js";

const KIND_LABEL_KEY: Record<AttachmentKind, OverlaysCopyKey> = {
  pdf: "overlays.attachmentViewer.kind.pdf",
  image: "overlays.attachmentViewer.kind.image",
  other: "overlays.attachmentViewer.kind.other",
};

/** What `onDownload` reports back: `"failed"` shows an error inside the viewer. */
export type AttachmentDownloadOutcome = "saved" | "failed";

export type AttachmentViewerProps = {
  /** The file to show. `null` keeps the viewer closed. */
  readonly item: AttachmentItem | null;
  readonly onOpenChange: (open: boolean) => void;
  /** Called once per open; may sign a fresh short-lived link each time. */
  readonly loadSource: AttachmentSourceLoader;
  /**
   * Files larger than this many bytes are not previewed: the viewer offers
   * Download instead and never calls `loadSource`. Defaults to
   * `DEFAULT_MAX_PREVIEW_BYTES` (25 MiB).
   */
  readonly maxPreviewBytes?: number;
  /**
   * Saves the file. The viewer shows a busy state until the returned promise
   * settles. If it rejects, or resolves to `"failed"`, the viewer shows an
   * error beside its Download button; a message shown behind the dialog would
   * go unseen.
   */
  readonly onDownload: (
    item: AttachmentItem,
  ) => Promise<AttachmentDownloadOutcome>;
};

/**
 * Shows one stored file full screen with a
 * header with the file name, Download and Close; PDFs with page thumbnails,
 * continuous scroll, Find in Document, print, zoom and rotate; photos with
 * zoom, fit and rotate; and a Download fallback for other types or files that
 * fail to load. The PDF renderer is fetched the first time a PDF is opened.
 */
export function AttachmentViewer({
  item,
  onOpenChange,
  loadSource,
  maxPreviewBytes = DEFAULT_MAX_PREVIEW_BYTES,
  onDownload,
}: AttachmentViewerProps) {
  const { state, markFailed } = useAttachmentSource(
    item,
    loadSource,
    maxPreviewBytes,
  );
  const t = useOverlaysCopy();
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  const [downloadFailedId, setDownloadFailedId] = React.useState<string | null>(
    null,
  );

  // The dialog keeps animating for a moment after `item` becomes null. Without
  // the last opened file the content would vanish before the dialog does.
  const lastOpenViewRef = React.useRef<{
    readonly item: AttachmentItem;
    readonly state: AttachmentPreviewState;
  } | null>(null);
  React.useEffect(() => {
    if (item !== null) lastOpenViewRef.current = { item, state };
  });
  const shown = item !== null ? { item, state } : lastOpenViewRef.current;

  async function download(target: AttachmentItem) {
    if (downloadingId !== null) return;
    setDownloadingId(target.id);
    setDownloadFailedId(null);
    try {
      const outcome = await onDownload(target);
      if (outcome === "failed") setDownloadFailedId(target.id);
    } catch {
      setDownloadFailedId(target.id);
    } finally {
      setDownloadingId(null);
    }
  }

  // Radix returns focus only to a DialogTrigger, and this viewer is opened
  // from a file name elsewhere on the page, so remember the opener ourselves.
  const openerRef = React.useRef<HTMLElement | null>(null);

  return (
    <Dialog open={item !== null} modal onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Previewing is read-only, so (unlike form dialogs) Escape is a safe
        // way out. The PDF view claims Escape first while its find bar or page
        // box is in use. The viewer fills the window, so there is no backdrop.
        onEscapeKeyDown={() => {
          onOpenChange(false);
        }}
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          openerRef.current = active instanceof HTMLElement ? active : null;
        }}
        // Runs once the close animation has finished and the content is gone:
        // focus goes back to the file that opened the viewer, a reopened file
        // starts without the last viewing's download error, and the last
        // file's bytes are not held until the next open.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = openerRef.current;
          openerRef.current = null;
          if (opener?.isConnected) opener.focus();
          setDownloadFailedId(null);
          lastOpenViewRef.current = null;
        }}
        className={cn(
          "top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:max-w-none",
          "text-foreground",
        )}
      >
        {shown !== null && (
          <>
            <ViewerHeader
              item={shown.item}
              isDownloading={downloadingId === shown.item.id}
              onDownload={() => void download(shown.item)}
            />
            {downloadFailedId === shown.item.id && (
              <p
                role="alert"
                className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
              >
                {t("overlays.attachmentViewer.download.failed")}
              </p>
            )}
            <ViewerBody
              item={shown.item}
              state={shown.state}
              isDownloading={downloadingId === shown.item.id}
              onDownload={() => void download(shown.item)}
              onPreviewFailed={markFailed}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ViewerHeader({
  item,
  isDownloading,
  onDownload,
}: {
  item: AttachmentItem;
  isDownloading: boolean;
  onDownload: () => void;
}) {
  const t = useOverlaysCopy();
  const { formatNumber } = useLocaleFormatting();
  const kind = attachmentKindOf(item);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b bg-background py-2 pr-3 pl-4">
      <span className="hidden size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground sm:flex">
        <KindIcon kind={kind} className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <DialogTitle
          className="truncate text-base leading-tight"
          title={item.fileName}
        >
          {item.fileName}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {t(KIND_LABEL_KEY[kind])}
          {" · "}
          {formatFileSize(item.byteSize, formatNumber)}
        </DialogDescription>
      </div>
      <DownloadButton isBusy={isDownloading} onClick={onDownload} />
      <DialogClose asChild>
        <Button type="button" size="sm">
          {t("overlays.action.close")}
        </Button>
      </DialogClose>
    </header>
  );
}

function DownloadButton({
  isBusy,
  onClick,
  variant = "outline",
}: {
  isBusy: boolean;
  onClick: () => void;
  variant?: "outline" | "default";
}) {
  const t = useOverlaysCopy();
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      aria-busy={isBusy}
      onClick={() => {
        if (!isBusy) onClick();
      }}
    >
      {isBusy ? (
        <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
      ) : (
        <DownloadIcon />
      )}
      {t("overlays.attachmentViewer.download")}
    </Button>
  );
}

function ViewerBody({
  item,
  state,
  isDownloading,
  onDownload,
  onPreviewFailed,
}: {
  item: AttachmentItem;
  state: AttachmentPreviewState;
  isDownloading: boolean;
  onDownload: () => void;
  onPreviewFailed: () => void;
}) {
  const t = useOverlaysCopy();
  const { formatNumber } = useLocaleFormatting();

  switch (state.status) {
    case "idle":
    case "loading":
      return <StageLoading />;
    case "unsupported":
      return (
        <FallbackPanel
          icon={<FileIcon />}
          title={t("overlays.attachmentViewer.unsupported.title")}
          hint={t("overlays.attachmentViewer.unsupported.hint")}
          isDownloading={isDownloading}
          onDownload={onDownload}
        />
      );
    case "tooLarge":
      return (
        <FallbackPanel
          icon={<FileIcon />}
          title={t("overlays.attachmentViewer.tooLarge.title")}
          hint={t("overlays.attachmentViewer.tooLarge.hint", {
            size: formatFileSize(item.byteSize, formatNumber),
          })}
          isDownloading={isDownloading}
          onDownload={onDownload}
        />
      );
    case "failed":
      return (
        <FallbackPanel
          icon={<FileXIcon />}
          title={t("overlays.attachmentViewer.failed.title")}
          hint={t("overlays.attachmentViewer.failed.hint")}
          isDownloading={isDownloading}
          onDownload={onDownload}
        />
      );
    case "ready":
      return state.prepared.kind === "pdf" ? (
        <PdfStage
          key={item.id}
          data={state.prepared.data}
          onFailed={onPreviewFailed}
        />
      ) : (
        <ImageStage
          key={state.prepared.src}
          src={state.prepared.src}
          fileName={item.fileName}
          onFailed={onPreviewFailed}
        />
      );
  }
}

function StageLoading() {
  const t = useOverlaysCopy();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted text-sm text-muted-foreground dark:bg-black">
      <Spinner className="size-6" />
      {t("overlays.attachmentViewer.loading")}
    </div>
  );
}

function FallbackPanel({
  icon,
  title,
  hint,
  isDownloading,
  onDownload,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  isDownloading: boolean;
  onDownload: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-muted/40 px-6 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-8">
        {icon}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-base font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      <DownloadButton
        variant="default"
        isBusy={isDownloading}
        onClick={onDownload}
      />
    </div>
  );
}

type PdfStageView = React.ComponentType<PdfDocumentViewProps>;

/** Fetches the pdf.js chunk on first use; a failed fetch shows the Download fallback. */
function PdfStage({ data, onFailed }: PdfDocumentViewProps) {
  const [loaded, setLoaded] = React.useState<{ View: PdfStageView } | null>(
    null,
  );
  const onFailedRef = React.useRef(onFailed);
  React.useEffect(() => {
    onFailedRef.current = onFailed;
  });

  React.useEffect(() => {
    let cancelled = false;
    import("./pdf-document-view.js").then(
      (module) => {
        if (!cancelled) setLoaded({ View: module.PdfDocumentView });
      },
      () => {
        if (!cancelled) onFailedRef.current();
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (loaded === null) return <StageLoading />;
  return <loaded.View data={data} onFailed={onFailed} />;
}

function KindIcon({
  kind,
  className,
}: {
  kind: AttachmentKind;
  className?: string;
}) {
  switch (kind) {
    case "pdf":
      return <FileTextIcon className={className} />;
    case "image":
      return <FileImageIcon className={className} />;
    case "other":
      return <FileIcon className={className} />;
  }
}
