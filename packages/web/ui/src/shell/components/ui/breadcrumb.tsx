import { MoreHorizontal } from "lucide-react";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "../../../elements/index.js";

import { useShellCopy } from "../../copy/shell-copy.js";

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
  const t = useShellCopy();
  return <nav aria-label={t("shell.breadcrumb.label")} data-slot="breadcrumb" {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden text-sm text-muted-foreground sm:gap-2",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li data-slot="breadcrumb-item" className={cn("inline-flex min-w-0 items-center gap-1.5", className)} {...props} />
  );
}

function BreadcrumbLink({
  asChild,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot.Root : "a";

  return (
    <Comp
      data-slot="breadcrumb-link"
      className={cn(
        "inline-flex min-w-0 items-center rounded-sm font-medium text-link transition-colors [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 hover:underline hover:underline-offset-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      aria-current="page"
      className={cn("truncate font-medium text-foreground", className)}
      {...props}
    />
  );
}

function BreadcrumbLocked({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-locked"
      className={cn("truncate font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("px-0.5 text-muted-foreground", className)}
      {...props}
    >
      {children ?? "/"}
    </li>
  );
}

function BreadcrumbEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  const t = useShellCopy();
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontal aria-hidden className="size-4" />
      <span className="sr-only">{t("shell.breadcrumb.more")}</span>
    </span>
  );
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbLocked,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
};
