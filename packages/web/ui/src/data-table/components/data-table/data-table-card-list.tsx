import { type Cell, type Column, flexRender, type Row, type Table as TanstackTable } from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";
import * as React from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../display/index.js";
import { cn } from "../../../elements/index.js";

import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { planCardFields, type CardColumn } from "../../lib/card-fields.js";
import { readColumnLabel } from "../../lib/column-label.js";
import { readPrimaryCardHref } from "../../lib/read-primary-row-link.js";
import { type DataTableRowGroupOf, startsRowGroup } from "../../lib/row-groups.js";
import { DataTableRowHitArea } from "./data-table-row-hit-area.js";

const CARD_TOGGLE_SLOT = "data-table-card-toggle";

const INTERACTIVE_ABOVE_CARD_TARGET =
  "[&_a:not([data-slot=data-table-row-hit-area])]:relative [&_a:not([data-slot=data-table-row-hit-area])]:z-10 [&_button:not([data-slot=data-table-card-toggle])]:relative [&_button:not([data-slot=data-table-card-toggle])]:z-10 [&_[role=checkbox]]:relative [&_[role=checkbox]]:z-10";

/**
 * The phone layout of a DataTable: one card per row. The identifying column
 * heads the card and a few summary fields sit under it.
 *
 * A card whose row has a primary link is one tap target that opens the
 * record, where every field is shown; a chevron says so. A card without one
 * expands in place on tap to reveal every other field, including columns the
 * reader hid on a wide screen, so nothing is ever out of reach. Columns the
 * page switched off for a mode (not reader-hideable) stay off.
 */
export function DataTableCardList<TData>({
  table,
  rowGroupOf,
}: {
  readonly table: TanstackTable<TData>;
  readonly rowGroupOf?: DataTableRowGroupOf<TData>;
}) {
  return (
    <ul data-slot="data-table-cards" className="flex flex-col gap-2">
      {table.getRowModel().rows.map((row, index, rows) => (
        <React.Fragment key={row.id}>
          {rowGroupOf !== undefined && startsRowGroup(rows, index, rowGroupOf) ? (
            <li data-slot="data-table-card-group" className="px-1 pt-2 font-semibold text-muted-foreground text-xs">
              {rowGroupOf(row.original).label}
            </li>
          ) : null}
          <DataTableCard row={row} />
        </React.Fragment>
      ))}
    </ul>
  );
}

function DataTableCard<TData>({ row }: { readonly row: Row<TData> }) {
  const t = useDataTableCopy();
  const [expanded, setExpanded] = React.useState(false);
  const { cardRef, href, cells } = useCardCells(row);
  const expandable = href === null && cells.details.length > 0;

  return (
    <li
      ref={cardRef}
      data-slot="data-table-card"
      data-state={row.getIsSelected() ? "selected" : undefined}
      className={cn(
        "relative rounded-md border bg-card p-3 text-sm data-[state=selected]:bg-table-row-selected",
        INTERACTIVE_ABOVE_CARD_TARGET,
      )}
    >
      <Collapsible open={expandable && expanded} onOpenChange={setExpanded} className="flex flex-col gap-2">
        {href ? <DataTableRowHitArea href={href} /> : null}
        {expandable ? (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              data-slot={CARD_TOGGLE_SLOT}
              aria-label={t("dataTable.action.details")}
              className="absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </CollapsibleTrigger>
        ) : null}
        <CardHeading cells={cells} opensRecord={href !== null} expandable={expandable} expanded={expanded} />
        {cells.summary.length > 0 ? <CardFieldList slot="data-table-card-summary" cells={cells.summary} /> : null}
        {expandable ? (
          <CollapsibleContent>
            <CardFieldList slot="data-table-card-details" cells={cells.details} />
          </CollapsibleContent>
        ) : null}
        {cells.actions ? <CardActions cell={cells.actions} /> : null}
      </Collapsible>
    </li>
  );
}

/** A row's cells sorted into the card's places. */
type CardCells<TData> = {
  readonly selection: Cell<TData, unknown> | undefined;
  readonly heading: Cell<TData, unknown> | undefined;
  readonly actions: Cell<TData, unknown> | undefined;
  readonly summary: readonly Cell<TData, unknown>[];
  readonly details: readonly Cell<TData, unknown>[];
};

/**
 * Plans where each of a row's cells goes on its card, and reads the record
 * link the rendered card exposes (a card with a link opens the record instead
 * of expanding).
 */
function useCardCells<TData>(row: Row<TData>): {
  cardRef: React.RefObject<HTMLLIElement | null>;
  href: string | null;
  cells: CardCells<TData>;
} {
  const cardRef = React.useRef<HTMLLIElement>(null);
  const [href, setHref] = React.useState<string | null>(null);
  const cells = readCardCells(row);
  const cellKey = cells.map((cell) => cell.id).join("|");

  React.useLayoutEffect(() => {
    const card = cardRef.current;
    const next = card ? readPrimaryCardHref(card) : null;
    setHref((current) => (current === next ? current : next));
  }, [row.id, cellKey]);

  return { cardRef, href, cells: placeCardCells(cells) };
}

function placeCardCells<TData>(cells: readonly Cell<TData, unknown>[]): CardCells<TData> {
  const cellById = new Map(cells.map((cell) => [cell.column.id, cell]));
  const plan = planCardFields(cells.map((cell) => toCardColumn(cell.column)));
  const pick = (id: string | undefined) => (id === undefined ? undefined : cellById.get(id));
  return {
    selection: pick(plan.selectionId),
    heading: pick(plan.headingId),
    actions: pick(plan.actionsId),
    summary: plan.summaryIds.flatMap((id) => pick(id) ?? []),
    details: plan.detailIds.flatMap((id) => pick(id) ?? []),
  };
}

function CardHeading<TData>({
  cells,
  opensRecord,
  expandable,
  expanded,
}: {
  readonly cells: CardCells<TData>;
  readonly opensRecord: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {cells.selection ? <CellContent cell={cells.selection} /> : null}
      {cells.heading ? (
        <div data-slot="data-table-card-heading" className="min-w-0 flex-1 font-medium break-words">
          <CellContent cell={cells.heading} />
        </div>
      ) : null}
      <CardChevron opensRecord={opensRecord} expandable={expandable} expanded={expanded} />
    </div>
  );
}

function CardActions<TData>({ cell }: { readonly cell: Cell<TData, unknown> }) {
  return (
    <div data-slot="data-table-card-actions" className="flex flex-wrap items-center justify-end gap-2">
      <CellContent cell={cell} />
    </div>
  );
}

function CardChevron({
  opensRecord,
  expandable,
  expanded,
}: {
  readonly opensRecord: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
}) {
  if (opensRecord) {
    return (
      <ChevronRight
        aria-hidden="true"
        data-slot="data-table-card-chevron"
        className="ml-auto size-4 shrink-0 text-muted-foreground"
      />
    );
  }
  if (!expandable) return null;
  return (
    <ChevronDown
      aria-hidden="true"
      data-slot="data-table-card-chevron"
      className={cn(
        "ml-auto size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
        expanded && "rotate-180",
      )}
    />
  );
}

function readCardCells<TData>(row: Row<TData>): Cell<TData, unknown>[] {
  return row.getAllCells().filter((cell) => cell.column.getIsVisible() || cell.column.getCanHide());
}

function CardFieldList<TData>({
  cells,
  slot,
}: {
  readonly cells: readonly Cell<TData, unknown>[];
  readonly slot: string;
}) {
  return (
    <dl data-slot={slot} className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {cells.map((cell) => (
        <div key={cell.id} className="contents">
          <dt className="text-muted-foreground">
            {readColumnLabel({
              id: cell.column.id,
              metaLabel: cell.column.columnDef.meta?.label,
              header: cell.column.columnDef.header,
            })}
          </dt>
          <dd className="min-w-0 break-words">
            <CellContent cell={cell} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CellContent<TData>({ cell }: { readonly cell: Cell<TData, unknown> }) {
  return <>{flexRender(cell.column.columnDef.cell, cell.getContext())}</>;
}

/** A column as the card layout reads it; unset meta flags stay unset. */
function toCardColumn<TData>(column: Column<TData>): CardColumn {
  const meta = column.columnDef.meta;
  return {
    id: column.id,
    readerHidden: !column.getIsVisible(),
    ...(meta?.cardHeading === undefined ? {} : { cardHeading: meta.cardHeading }),
    ...(meta?.cardSummary === undefined ? {} : { cardSummary: meta.cardSummary }),
  };
}
