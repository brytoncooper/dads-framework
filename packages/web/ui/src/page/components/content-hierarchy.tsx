import * as React from "react";
import { cn } from "../../elements/index.js";

type SectionHeaderProps = Omit<
  React.ComponentProps<"header">,
  "children" | "title"
> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
};

type MetadataItemProps = Omit<React.ComponentProps<"div">, "title"> & {
  label: React.ReactNode;
};

/** A major section heading with optional guidance and feature-owned actions. */
export function SectionHeader({
  title,
  description,
  actions,
  className,
  ...props
}: SectionHeaderProps) {
  const hasDescription = React.Children.toArray(description).length > 0;
  const hasActions = React.Children.toArray(actions).length > 0;

  return (
    <header
      {...props}
      data-slot="section-header"
      className={cn(
        "flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">
          {title}
        </h2>
        {hasDescription ? (
          <p className="mt-1 max-w-prose text-foreground text-sm">
            {description}
          </p>
        ) : null}
      </div>
      {hasActions ? (
        <div
          data-slot="section-actions"
          className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/** The fixed third-level heading beneath a page section. */
export function SubsectionHeading({
  className,
  ...props
}: React.ComponentProps<"h3">) {
  return (
    <h3
      {...props}
      data-slot="subsection-heading"
      className={cn("text-xl font-semibold text-balance", className)}
    />
  );
}

/** A responsive description list; features still format every value. */
export function MetadataList({
  className,
  ...props
}: React.ComponentProps<"dl">) {
  return (
    <dl
      {...props}
      data-slot="metadata-list"
      role="group"
      className={cn("grid gap-x-8 gap-y-4 sm:grid-cols-2", className)}
    />
  );
}

/** One feature-owned label and value inside a MetadataList. */
export function MetadataItem({
  label,
  children,
  className,
  ...props
}: MetadataItemProps) {
  return (
    <div
      {...props}
      data-slot="metadata-item"
      className={cn("min-w-0", className)}
    >
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="mt-1 min-w-0">{children}</dd>
    </div>
  );
}

type FormActionsProps = React.ComponentProps<"div"> & {
  /**
   * "end" (default) right-aligns on wide screens and keeps the primary action
   * last. "start" left-aligns with the content above; DOM order is visual
   * order, so put the primary action first.
   */
  align?: "end" | "start";
};

const FORM_ACTIONS_ALIGN_CLASS: Record<
  NonNullable<FormActionsProps["align"]>,
  string
> = {
  end: "flex-col-reverse sm:flex-row sm:flex-wrap sm:items-center sm:justify-end",
  start: "flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-start",
};

/** Responsive actions for ordinary, non-overlay forms; end-aligned by default. */
export function FormActions({
  align = "end",
  className,
  ...props
}: FormActionsProps) {
  return (
    <div
      {...props}
      data-slot="form-actions"
      data-align={align}
      className={cn("flex gap-2", FORM_ACTIONS_ALIGN_CLASS[align], className)}
    />
  );
}
