import type * as React from "react";

import { cn } from "../../../elements/index.js";

import {
  type MasterDetailListSearch,
  useMasterDetailListSearch,
} from "./master-detail-layout.js";

export type MasterDetailLinkProps = React.ComponentPropsWithoutRef<"a"> & {
  readonly href: string;
  readonly search: MasterDetailListSearch | undefined;
};

function MasterDetailAnchor({ href, search, ...props }: MasterDetailLinkProps) {
  if (search === undefined) return <a href={href} {...props} />;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value !== undefined) params.set(key, String(value));
  }

  const fragmentIndex = href.indexOf("#");
  const pathAndQuery = fragmentIndex < 0 ? href : href.slice(0, fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : href.slice(fragmentIndex);
  const queryIndex = pathAndQuery.indexOf("?");
  const path =
    queryIndex < 0 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);
  const query = params.toString();
  return (
    <a
      href={query ? `${path}?${query}${fragment}` : `${path}${fragment}`}
      {...props}
    />
  );
}

/**
 * One rail row: the record's name over a muted second line (its template,
 * type or area), and a status badge at the end. It links to the record's own
 * address, carrying the list's own search params (never the open record's), so deep links and Back work. The
 * selected row carries a primary left accent.
 */
export function MasterDetailRow({
  href,
  title,
  subtitle,
  contextLabel,
  linkComponent: Link = MasterDetailAnchor,
  badge,
  selected,
}: {
  /** The record’s address. */
  readonly href: string;
  readonly title: string;
  readonly subtitle?: React.ReactNode;
  /** An optional context label below the subtitle. */
  readonly contextLabel?: string;
  readonly linkComponent?: React.ComponentType<MasterDetailLinkProps>;
  readonly badge?: React.ReactNode;
  readonly selected: boolean;
}) {
  const listSearch = useMasterDetailListSearch();
  return (
    <Link
      href={href}
      search={listSearch}
      aria-current={selected ? "page" : undefined}
      data-slot="master-detail-row"
      className={cn(
        "flex min-h-14 items-center gap-2 border-b border-l-2 border-border border-l-transparent px-3 py-2 text-sm outline-none transition-colors motion-reduce:transition-none",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
        selected &&
          "border-l-primary bg-primary/10 font-semibold hover:bg-primary/10",
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-foreground leading-snug">{title}</span>
        {subtitle ? (
          <span className="truncate font-normal text-muted-foreground text-xs leading-snug">
            {subtitle}
          </span>
        ) : null}
        {contextLabel ? (
          <span
            data-slot="master-detail-row-context"
            className="truncate font-normal text-muted-foreground text-xs leading-snug"
          >
            {contextLabel}
          </span>
        ) : null}
      </span>
      {badge ? <span className="shrink-0">{badge}</span> : null}
    </Link>
  );
}
