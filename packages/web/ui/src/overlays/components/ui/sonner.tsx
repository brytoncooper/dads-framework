import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

import type { CssCustomProperties } from "../../../elements/index.js";

const TOAST_STYLE: CssCustomProperties = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--radius)",
};

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: (
          <Loader2Icon className="size-4 animate-spin motion-reduce:animate-none" />
        ),
      }}
      style={{ ...props.style, ...TOAST_STYLE }}
      {...props}
    />
  );
};

// `sonner` is a `bannedExternalImports` entry on the `scope:web` boundary, so
// the app and feature libs raise toasts through this re-export rather than the
// vendor — the same rule the icon surface follows.
export { Toaster, toast };

/** How long an undoable notice waits before the change is final to the reader. */
export const UNDO_WINDOW_MS = 8000;

/**
 * Says a reversible change happened and offers to take it back.
 *
 * This replaces "Are you sure?" for anything that can be reversed: the change
 * lands at once, and the notice carries the one button that reverses it. Keep
 * `message` short and past tense ("Scale deactivated."); `undoLabel` comes
 * from the caller's copy catalog. Returns the notice's id, so a caller can
 * `toast.dismiss` an Undo that a later change made pointless.
 */
export function toastUndoable({
  message,
  undoLabel,
  onUndo,
}: {
  readonly message: string;
  readonly undoLabel: string;
  readonly onUndo: () => void;
}): string | number {
  return toast(message, {
    duration: UNDO_WINDOW_MS,
    action: { label: undoLabel, onClick: onUndo },
  });
}
