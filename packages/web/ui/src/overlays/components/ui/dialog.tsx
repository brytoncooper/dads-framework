"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";

import { Button, cn } from "../../../elements/index.js";
import { useOverlaysCopy } from "../../copy/overlays-copy.js";

const DialogClosePermission = React.createContext<{
  allowCloseFromControl: () => void;
}>({
  allowCloseFromControl: () => undefined,
});

/** Modal dialogs render Radix's Overlay so its scroll lock covers the backdrop. */
const DialogModal = React.createContext(false);

function Dialog({
  modal = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const allowCloseRef = React.useRef(false);
  const allowCloseFromControl = React.useCallback(() => {
    allowCloseRef.current = true;
  }, []);

  return (
    <DialogClosePermission.Provider value={{ allowCloseFromControl }}>
      <DialogModal.Provider value={modal}>
        <DialogPrimitive.Root
          data-slot="dialog"
          {...props}
          modal={modal}
          onOpenChange={(open) => {
            if (open) {
              props.onOpenChange?.(true);
              return;
            }
            if (!allowCloseRef.current) {
              return;
            }
            allowCloseRef.current = false;
            props.onOpenChange?.(false);
          }}
        />
      </DialogModal.Provider>
    </DialogClosePermission.Provider>
  );
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  onClick,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  const { allowCloseFromControl } = React.useContext(DialogClosePermission);
  return (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      onClick={(event) => {
        allowCloseFromControl();
        onClick?.(event);
      }}
      {...props}
    />
  );
}

function DialogOverlay({ className, ...props }: React.ComponentProps<"div">) {
  const modal = React.useContext(DialogModal);
  const Overlay = modal ? DialogPrimitive.Overlay : "div";
  return (
    <Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-scrim/50 dark:bg-scrim/70",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  const t = useOverlaysCopy();
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg motion-reduce:animate-none",
          showCloseButton && "[&_[data-slot=dialog-header]]:pr-12",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogClose className="absolute top-4 right-4 inline-flex size-8 cursor-pointer items-center justify-center rounded-md border border-input bg-background text-foreground ring-offset-background transition-opacity [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 hover:bg-accent focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 motion-reduce:transition-none">
            <XIcon />
            <span className="sr-only">{t("overlays.action.close")}</span>
          </DialogClose>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  const t = useOverlaysCopy();
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {showCloseButton && (
        <DialogCancel>{t("overlays.action.close")}</DialogCancel>
      )}
      {children}
    </div>
  );
}

/** The primary action that follows secondary actions in a DialogFooter. */
function DialogAction({
  variant = "default",
  size = "default",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "asChild">) {
  return (
    <Button
      data-slot="dialog-action"
      variant={variant}
      size={size}
      {...props}
    />
  );
}

/** A secondary dialog action that closes without submitting an enclosing form. */
function DialogCancel({
  variant = "outline",
  size = "default",
  onClick,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "asChild" | "type">) {
  const { allowCloseFromControl } = React.useContext(DialogClosePermission);
  return (
    <DialogPrimitive.Close asChild>
      <Button
        {...props}
        data-slot="dialog-cancel"
        type="button"
        variant={variant}
        size={size}
        onClick={(event) => {
          allowCloseFromControl();
          onClick?.(event);
        }}
      />
    </DialogPrimitive.Close>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogAction,
  DialogCancel,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
