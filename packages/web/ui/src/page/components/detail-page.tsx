import { Slot } from "radix-ui";
import * as React from "react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Tabs,
  TabsList,
} from "../../display/index.js";
import { cn, Skeleton } from "../../elements/index.js";
import { ArrowLeft, CircleAlert } from "../../icons/index.js";

import { SectionHeader } from "./content-hierarchy.js";

type DetailBackLinkProps = React.ComponentProps<"a"> & {
  asChild?: boolean;
};

type DetailHeaderProps = Omit<React.ComponentProps<"header">, "title"> & {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
};

type DetailSectionProps = Omit<React.ComponentProps<"section">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
};

type DetailTabsProps = Omit<React.ComponentProps<typeof Tabs>, "children"> & {
  label: string;
  triggers: React.ReactNode;
  children: React.ReactNode;
};

type DetailStateBaseProps = Omit<
  React.ComponentProps<"div">,
  "children" | "role" | "title"
>;

type DetailLoadingStateProps = DetailStateBaseProps & {
  variant: "loading";
  layout: "stacked" | "tabbed";
  label: string;
};

type DetailErrorStateProps = DetailStateBaseProps & {
  variant: "error";
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
};

type DetailStateProps = DetailLoadingStateProps | DetailErrorStateProps;

/** The fixed outer rhythm shared by stacked and tabbed detail pages. */
export function DetailPage({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      data-slot="detail-page"
      className={cn("flex min-w-0 flex-1 flex-col gap-6", className)}
    />
  );
}

/** Router-neutral back navigation with one icon and link treatment. */
export function DetailBackLink({
  asChild = false,
  className,
  children,
  ...props
}: DetailBackLinkProps) {
  const Comp = asChild ? Slot.Root : "a";

  return (
    <Comp
      {...props}
      data-slot="detail-back-link"
      className={cn(
        "inline-flex h-8 w-fit items-center gap-2 rounded-md px-2 text-link text-sm -ml-2 [@media(pointer:coarse)]:min-h-11 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
    >
      <ArrowLeft
        data-slot="detail-back-icon"
        aria-hidden="true"
        className="size-4 shrink-0"
      />
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : children}
    </Comp>
  );
}

/** One title/subtitle/status/action grammar for every detail resource. */
export function DetailHeader({
  title,
  subtitle,
  status,
  actions,
  children,
  className,
  ...props
}: DetailHeaderProps) {
  const hasSubtitle = React.Children.toArray(subtitle).length > 0;
  const hasStatus = React.Children.toArray(status).length > 0;
  const hasActions = React.Children.toArray(actions).length > 0;

  return (
    <header
      {...props}
      data-slot="detail-header"
      className={cn("flex min-w-0 flex-col gap-4", className)}
    >
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="min-w-0 text-3xl font-semibold tracking-tight text-balance">
              {title}
            </h1>
            {hasStatus ? status : null}
          </div>
          {hasSubtitle ? (
            <p className="mt-1 max-w-prose text-foreground text-sm">
              {subtitle}
            </p>
          ) : null}
        </div>
        {hasActions ? (
          <div
            data-slot="detail-actions"
            className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end"
          >
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </header>
  );
}

/** A major detail section with fixed internal rhythm and semantic heading. */
export function DetailSection({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: DetailSectionProps) {
  return (
    <section
      {...props}
      data-slot="detail-section"
      className={cn("flex min-w-0 flex-col gap-4", className)}
    >
      <SectionHeader
        title={title}
        description={description}
        actions={actions}
      />
      {children}
    </section>
  );
}

/** Outlined tabs with one accessible label and a fixed 24px content offset. */
export function DetailTabs({
  label,
  triggers,
  children,
  className,
  ...props
}: DetailTabsProps) {
  return (
    <Tabs
      {...props}
      className={cn(
        "min-w-0 gap-0 [&_[data-slot=tabs-content]]:mt-6",
        className,
      )}
    >
      <TabsList aria-label={label}>{triggers}</TabsList>
      {children}
    </Tabs>
  );
}

/** Shared loading or scoped-failure geometry for a detail body. */
export function DetailState(props: DetailStateProps) {
  if (props.variant === "loading") {
    return <DetailLoadingState {...props} />;
  }
  return <DetailErrorState {...props} />;
}

function DetailLoadingState({
  layout,
  label,
  className,
  ...props
}: DetailLoadingStateProps) {
  return (
    <div
      {...props}
      data-slot="detail-state"
      data-state="loading"
      data-layout={layout}
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("flex min-w-0 flex-col gap-6", className)}
    >
      <span className="sr-only">{label}</span>
      <div data-slot="detail-state-header" className="grid gap-2">
        <Skeleton className="h-8 w-full max-w-56" />
        <Skeleton className="h-4 w-full max-w-72" />
      </div>
      {layout === "tabbed" ? (
        <div data-slot="detail-state-tabs">
          <Skeleton className="h-9 w-full max-w-64" />
        </div>
      ) : null}
      <div data-slot="detail-state-sections" className="grid gap-6">
        <Skeleton className="h-40 w-full" />
        {layout === "stacked" ? <Skeleton className="h-40 w-full" /> : null}
      </div>
    </div>
  );
}

function DetailErrorState({
  title,
  description,
  children,
  className,
  ...props
}: DetailErrorStateProps) {
  const hasDescription = React.Children.toArray(description).length > 0;
  const hasActions = React.Children.toArray(children).length > 0;

  return (
    <Alert
      {...props}
      data-slot="detail-state"
      data-state="error"
      variant="destructive"
      className={className}
    >
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      {(hasDescription || hasActions) && (
        <AlertDescription>
          {hasDescription ? description : null}
          {hasActions ? (
            <div
              data-slot="detail-state-actions"
              className="mt-2 flex flex-wrap items-center gap-2"
            >
              {children}
            </div>
          ) : null}
        </AlertDescription>
      )}
    </Alert>
  );
}
