import { LoaderCircleIcon, PrinterIcon } from "lucide-react";

import { useOverlaysCopy } from "../../../copy/overlays-copy.js";
import { ToolbarIconButton, ToolbarReadout } from "../viewer-toolbar.js";
import type { PdfPrintController } from "./use-pdf-print.js";

/**
 * Print and its three faces. Idle, it starts a run. While pages are being
 * prepared it spins, shows how many are done, and pressing it cancels the
 * run. After a failed run it turns red, says so, and pressing it tries again.
 */
export function PdfPrintButton({ print }: { print: PdfPrintController }) {
  const t = useOverlaysCopy();
  const isPreparing = print.status === "preparing";
  const hasFailed = print.status === "failed";

  function label(): string {
    if (isPreparing) return t("overlays.attachmentViewer.pdf.print.cancel");
    if (hasFailed) return t("overlays.attachmentViewer.pdf.print.retry");
    return t("overlays.attachmentViewer.pdf.print");
  }

  return (
    <>
      <ToolbarIconButton
        label={label()}
        tone={hasFailed ? "error" : "default"}
        onClick={isPreparing ? print.cancel : print.print}
      >
        {isPreparing ? <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" /> : <PrinterIcon />}
      </ToolbarIconButton>
      {isPreparing && (
        <ToolbarReadout live>
          {t("overlays.attachmentViewer.pdf.print.progress", {
            done: print.completed,
            total: print.total,
          })}
        </ToolbarReadout>
      )}
    </>
  );
}
