import * as React from "react";

import { cn } from "../../elements/index.js";

type DetailCardProps = Omit<React.ComponentProps<"section">, "title"> & {
  /** Rendered as an h2 so section headings stay level 2. */
  title: React.ReactNode;
  /** Decorative leading icon; the caller passes it with aria-hidden. */
  icon?: React.ReactNode;
  description?: React.ReactNode;
  /** Card-level actions: right of the title on sm+, under it on phones. */
  actions?: React.ReactNode;
  /** Removes the body's horizontal padding for an edge-to-edge Table. */
  flush?: boolean;
  /** Bordered, left-aligned footer row for the card's primary action. */
  footer?: React.ReactNode;
};

function hasContent(node: React.ReactNode): boolean {
  return React.Children.toArray(node).length > 0;
}

/** One white surface for one subject: title, optional actions, body, footer. */
export function DetailCard({
  title,
  icon,
  description,
  actions,
  flush = false,
  footer,
  className,
  children,
  ...props
}: DetailCardProps) {
  return (
    <section
      {...props}
      data-slot="detail-card"
      data-flush={flush ? "true" : undefined}
      className={cn("flex min-w-0 flex-col rounded-lg border bg-card text-card-foreground shadow-xs", className)}
    >
      <header
        data-slot="detail-card-header"
        className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between sm:px-6 sm:pt-5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            {hasContent(icon) ? (
              <span
                data-slot="detail-card-icon"
                className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
              >
                {icon}
              </span>
            ) : null}
            <h2 className="min-w-0 text-lg font-semibold text-balance">{title}</h2>
          </div>
          {hasContent(description) ? (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {hasContent(actions) ? (
          <div data-slot="detail-card-actions" className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </header>
      <div
        data-slot="detail-card-body"
        className={cn(
          "min-w-0",
          flush
            ? "pt-4 sm:[&_td:first-child]:pl-6 sm:[&_td:last-child]:pr-6 sm:[&_th:first-child]:pl-6 sm:[&_th:last-child]:pr-6"
            : "px-4 py-4 sm:px-6 sm:pb-6",
        )}
      >
        {children}
      </div>
      {hasContent(footer) ? (
        <footer data-slot="detail-card-footer" className="flex flex-wrap items-center gap-2 border-t px-4 py-3 sm:px-6">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
