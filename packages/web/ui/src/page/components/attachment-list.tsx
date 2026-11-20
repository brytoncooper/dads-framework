import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { useLocaleFormatting } from "@dads-framework/copy";
import {
  Button,
  Skeleton,
  attachmentExtensionOf,
  attachmentKindOf,
  cn,
  formatFileSize,
  type AttachmentItem,
  type AttachmentKind,
  type AttachmentOpenHandler,
} from "../../elements/index.js";
import {
  Download,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Loader2,
} from "../../icons/index.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../overlays/index.js";

import { usePageCopy, type PageCopyTranslator } from "../copy/page-copy.js";

type AttachmentListProps = {
  readonly items: readonly AttachmentItem[];
  readonly status?: "ready" | "loading";
  /** Called by the name and icon button; without it the name is plain text. */
  readonly onOpen?: AttachmentOpenHandler;
  /**
   * Called by the Download button. The list only shows a busy state while the
   * promise runs; a rejection is the caller's to report (use `failure`).
   */
  readonly onDownload: (item: AttachmentItem) => Promise<void> | void;
  /** Extra controls after Download, such as Remove. */
  readonly itemActions?: (item: AttachmentItem) => ReactNode;
  /** Shown when there are no items; defaults to "No files yet". */
  readonly emptyMessage?: ReactNode;
  /** The caller's error, shown under the list. */
  readonly failure?: ReactNode;
  /** Names the list for screen readers, such as "Attachments". */
  readonly label?: string;
  readonly className?: string;
};

/**
 * Stored files as compact one-line rows in a container-responsive grid. Each file has a
 * real open button (name and icon) and a sibling Download button, so
 * downloading never opens and opening never downloads. The caller owns where
 * files come from, what opening does, and any error message.
 */
export function AttachmentList({
  status = "ready",
  emptyMessage,
  failure,
  className,
  ...shown
}: AttachmentListProps) {
  const t = usePageCopy();
  const hasFailure = failure !== undefined && failure !== null;

  return (
    <div className={cn("@container grid gap-3", className)}>
      <AttachmentListBody
        {...shown}
        status={status}
        emptyMessage={emptyMessage ?? t("page.attachments.empty")}
        loadingLabel={t("page.attachments.loading")}
      />
      {hasFailure ? failure : null}
    </div>
  );
}

function AttachmentListBody({
  items,
  status,
  label,
  emptyMessage,
  loadingLabel,
  ...actions
}: Omit<AttachmentListProps, "failure" | "className" | "emptyMessage"> & {
  readonly status: "ready" | "loading";
  readonly emptyMessage: ReactNode;
  readonly loadingLabel: string;
}) {
  if (status === "loading") {
    return (
      <ul aria-busy="true" aria-label={loadingLabel} className={LIST_CLASS}>
        {[0, 1, 2].map((slot) => (
          <li key={slot} aria-hidden="true">
            <Skeleton className="h-9" />
          </li>
        ))}
      </ul>
    );
  }
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }
  return (
    <ul aria-label={label} className={LIST_CLASS}>
      {items.map((item) => (
        <AttachmentRow key={item.id} item={item} {...actions} />
      ))}
    </ul>
  );
}

// Container queries: the list lives in cards and drawers of varying width.
const LIST_CLASS = "grid gap-1.5 @md:grid-cols-2 @3xl:grid-cols-3";

const OPEN_FOCUS_CLASS =
  "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

type ItemProps = Pick<
  AttachmentListProps,
  "onOpen" | "onDownload" | "itemActions"
> & { readonly item: AttachmentItem };

function AttachmentRow({ item, onOpen, onDownload, itemActions }: ItemProps) {
  const metaId = useId();
  const rowContent = (
    <>
      <FileTypeIcon item={item} />
      <span
        className="min-w-0 flex-1 truncate text-sm font-medium"
        title={item.fileName}
      >
        {item.fileName}
      </span>
      <AttachmentMeta item={item} id={metaId} />
    </>
  );

  return (
    <li
      data-slot="attachment-row"
      className="flex min-w-0 items-center gap-1 rounded-md border bg-card px-1 transition-colors hover:bg-accent/50 focus-within:bg-accent/50 motion-reduce:transition-none"
    >
      <OpenArea
        item={item}
        onOpen={onOpen}
        describedBy={metaId}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5"
      >
        {rowContent}
      </OpenArea>
      <DownloadButton item={item} onDownload={onDownload} />
      {itemActions?.(item)}
    </li>
  );
}

/** A real button when the caller can open files, otherwise the same layout as plain content. */
function OpenArea({
  item,
  onOpen,
  describedBy,
  className,
  children,
}: {
  readonly item: AttachmentItem;
  readonly onOpen: AttachmentOpenHandler | undefined;
  /** The aria-label hides the button's text, so the type and size line is read as its description. */
  readonly describedBy?: string;
  readonly className: string;
  readonly children: ReactNode;
}) {
  const t = usePageCopy();
  if (!onOpen) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      aria-label={t("page.attachments.open", { name: item.fileName })}
      aria-describedby={describedBy}
      onClick={() => {
        onOpen(item);
      }}
      className={cn(className, "cursor-pointer text-left", OPEN_FOCUS_CLASS)}
    >
      {children}
    </button>
  );
}

function DownloadButton({
  item,
  onDownload,
}: Pick<ItemProps, "item" | "onDownload">) {
  const t = usePageCopy();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function download() {
    if (busy) return;
    setBusy(true);
    // Called synchronously so the click handler reports the download at once;
    // a throw or rejection is the caller's to report and only ends the busy state.
    const finish = () => {
      if (mounted.current) setBusy(false);
    };
    try {
      void Promise.resolve(onDownload(item)).then(finish, finish);
    } catch {
      finish();
    }
  }

  const label = t("page.attachments.download", { name: item.fileName });

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="border-transparent bg-transparent shadow-none dark:bg-transparent dark:hover:bg-accent"
            aria-label={label}
            aria-busy={busy}
            onClick={download}
          >
            {busy ? (
              <Loader2
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Download aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function FileTypeIcon({ item }: { readonly item: AttachmentItem }) {
  const Icon = iconFor(item);
  return (
    <span
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center text-muted-foreground"
    >
      <Icon className="size-4" />
    </span>
  );
}

function iconFor(item: AttachmentItem) {
  const kind = attachmentKindOf(item);
  if (kind === "pdf") return FileText;
  if (kind === "image") return FileImage;
  const extension = attachmentExtensionOf(item.fileName);
  if (SPREADSHEET_EXTENSIONS.has(extension)) return FileSpreadsheet;
  return File;
}

const SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set([
  "csv",
  "xls",
  "xlsx",
]);

function kindLabel(
  item: AttachmentItem,
  kind: AttachmentKind,
  t: PageCopyTranslator,
): string {
  if (kind === "pdf") return t("page.attachments.kind.pdf");
  if (kind === "image") return t("page.attachments.kind.image");
  const extension = attachmentExtensionOf(item.fileName);
  return extension === ""
    ? t("page.attachments.kind.file")
    : extension.toUpperCase();
}

/** Muted "PDF · 25 kB" line under a file name. */
function AttachmentMeta({
  item,
  id,
}: {
  readonly item: AttachmentItem;
  readonly id?: string;
}) {
  const t = usePageCopy();
  const { formatNumber } = useLocaleFormatting();
  const sizeText = formatFileSize(item.byteSize, formatNumber);
  return (
    <span
      id={id}
      className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
    >
      {kindLabel(item, attachmentKindOf(item), t)} {"·"} {sizeText}
    </span>
  );
}
