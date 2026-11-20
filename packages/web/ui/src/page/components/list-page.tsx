import * as React from "react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../display/index.js";
import { cn } from "../../elements/index.js";

type ListPageHeaderProps = Omit<React.ComponentProps<"header">, "title"> & {
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /**
   * An `ObjectSwitch` (Orders | Releases). It sits beside the title on wide
   * screens; on phones it takes the title's place as a title dropdown, and the
   * heading stays for assistive technology.
   */
  readonly objectSwitch?: React.ReactNode;
};

type ListEmptyStateProps = Omit<React.ComponentProps<"div">, "title"> & {
  readonly icon?: React.ReactNode;
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
};

/** Establishes the shared vertical rhythm without owning page state. */
export function ListPageShell({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-slot="list-page-shell"
      className={cn("flex min-w-0 flex-1 flex-col gap-6", className)}
    />
  );
}

/**
 * Renders one page heading with optional copy, an optional object switch
 * beside it, and feature-owned action content.
 */
export function ListPageHeader({
  title,
  description,
  objectSwitch,
  children,
  className,
  ...props
}: ListPageHeaderProps) {
  const hasDescription = React.Children.toArray(description).length > 0;
  const hasObjectSwitch = React.Children.toArray(objectSwitch).length > 0;

  return (
    <header
      {...props}
      data-slot="list-page-header"
      className={cn(
        "flex w-full min-w-0 flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1
            className={cn(
              "text-3xl font-semibold tracking-tight text-balance",
              hasObjectSwitch && "max-md:sr-only",
            )}
          >
            {title}
          </h1>
          {objectSwitch}
        </div>
        {hasDescription && (
          <p
            data-slot="list-page-description"
            className="max-w-prose text-foreground text-sm"
          >
            {description}
          </p>
        )}
      </div>
      {children}
    </header>
  );
}

/** Keeps feature-owned page actions in one responsive cluster. */
export function ListPageActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-slot="list-page-actions"
      className={cn(
        "flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end",
        className,
      )}
    />
  );
}

/**
 * Gives feature-owned empty copy and actions the shared page-level treatment.
 */
export function ListEmptyState({
  icon,
  title,
  description,
  children,
  className,
  ...props
}: ListEmptyStateProps) {
  const hasIcon = React.Children.toArray(icon).length > 0;
  const hasDescription = React.Children.toArray(description).length > 0;
  const hasActions = React.Children.toArray(children).length > 0;

  return (
    <Empty
      {...props}
      data-slot="list-empty-state"
      className={cn("rounded-md border border-dashed", className)}
    >
      <EmptyHeader>
        {hasIcon && (
          <EmptyMedia variant="icon" aria-hidden="true">
            {icon}
          </EmptyMedia>
        )}
        <EmptyTitle role="heading" aria-level={2}>
          {title}
        </EmptyTitle>
        {hasDescription && (
          <EmptyDescription className="text-foreground">
            {description}
          </EmptyDescription>
        )}
      </EmptyHeader>
      {hasActions && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
