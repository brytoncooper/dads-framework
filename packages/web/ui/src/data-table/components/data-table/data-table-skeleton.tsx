import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../display/index.js";
import { Skeleton, cn } from "../../../elements/index.js";
import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { useIsPhoneWidth } from "../../hooks/use-is-phone-width.js";

type ToolbarControlWidth =
  "narrow" | "medium" | "select" | "wide" | "extraWide" | "search";

const TOOLBAR_CONTROL_WIDTHS: Record<ToolbarControlWidth, string> = {
  narrow: "w-24",
  medium: "w-32",
  select: "w-36",
  wide: "w-44",
  extraWide: "w-48",
  search: "w-40 lg:w-56",
};

type DataTableSkeletonProps = React.ComponentProps<"div"> & {
  columnCount: number;
  rowCount?: number;
  filterWidths?: readonly ToolbarControlWidth[];
  actionWidths?: readonly ToolbarControlWidth[];
  cellWidths?: string[];
  withPagination?: boolean;
  withSelectionStatus?: boolean;
  shrinkZero?: boolean;
  loadingLabel?: string;
};

/**
 * The loading stand-in for a DataTable, drawn in the same shape the table
 * will take: a table on wide screens, a stack of cards on phones.
 */
export function DataTableSkeleton({
  columnCount,
  rowCount = 10,
  filterWidths = [],
  actionWidths = [],
  cellWidths,
  withPagination = true,
  withSelectionStatus = false,
  shrinkZero = false,
  loadingLabel,
  className,
  ...props
}: DataTableSkeletonProps) {
  const t = useDataTableCopy();
  const isPhoneWidth = useIsPhoneWidth();
  const resolvedLoadingLabel = loadingLabel ?? t("dataTable.state.loading");

  return (
    <div
      {...props}
      role="status"
      aria-label={resolvedLoadingLabel}
      data-slot="data-table-skeleton"
      className={cn("flex min-w-0 w-full flex-col gap-2.5", className)}
    >
      <DataTableSkeletonToolbar
        filterWidths={filterWidths}
        actionWidths={actionWidths}
      />
      {isPhoneWidth ? (
        <DataTableCardsSkeleton rowCount={rowCount} />
      ) : (
        <DataTableDesktopSkeleton
          columnCount={columnCount}
          cellWidths={cellWidths}
          rowCount={rowCount}
          shrinkZero={shrinkZero}
        />
      )}
      {withPagination && (
        <DataTableSkeletonPagination
          withSelectionStatus={withSelectionStatus}
        />
      )}
    </div>
  );
}

function DataTableCardsSkeleton({ rowCount }: { readonly rowCount: number }) {
  return (
    <ul
      aria-hidden="true"
      data-slot="data-table-skeleton-cards"
      className="flex flex-col gap-2"
    >
      {Array.from({ length: rowCount }).map((_, index) => (
        <li
          key={index}
          className="flex flex-col gap-2 rounded-md border bg-card p-3"
        >
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="mt-1 h-8 w-36" />
        </li>
      ))}
    </ul>
  );
}

function DataTableSkeletonToolbar({
  filterWidths,
  actionWidths,
}: {
  filterWidths: readonly ToolbarControlWidth[];
  actionWidths: readonly ToolbarControlWidth[];
}) {
  if (filterWidths.length === 0 && actionWidths.length === 0) return null;

  return (
    <div
      data-slot="data-table-skeleton-toolbar"
      className="flex w-full flex-col flex-wrap gap-2 p-1 [@media(pointer:coarse)]:[&_[data-slot=skeleton]]:min-h-11 [@media(pointer:coarse)]:[&_[data-slot=skeleton]]:min-w-11 sm:flex-row sm:items-center sm:justify-between"
    >
      <div
        data-slot="data-table-skeleton-filters"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
      >
        {filterWidths.map((width, index) => (
          <Skeleton
            key={`${index}-${width}`}
            className={cn("h-8 border-dashed", TOOLBAR_CONTROL_WIDTHS[width])}
          />
        ))}
      </div>
      {actionWidths.length > 0 ? (
        <div
          data-slot="data-table-skeleton-actions"
          className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end"
        >
          {actionWidths.map((width, index) => (
            <Skeleton
              key={`${index}-${width}`}
              className={cn("h-8", TOOLBAR_CONTROL_WIDTHS[width])}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DataTableSkeletonPagination({
  withSelectionStatus,
}: {
  withSelectionStatus: boolean;
}) {
  return (
    <div
      data-slot="data-table-skeleton-pagination"
      className="flex w-full flex-col flex-wrap gap-4 p-1 [@media(pointer:coarse)]:[&_[data-slot=skeleton]]:min-h-11 [@media(pointer:coarse)]:[&_[data-slot=skeleton]]:min-w-11 sm:flex-row sm:items-center sm:justify-between sm:gap-8"
    >
      {withSelectionStatus && <Skeleton className="h-8 w-40 shrink-0" />}
      <div className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:ml-auto sm:w-auto sm:justify-end sm:gap-x-6 lg:gap-x-8">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-18" />
        </div>
        <div className="flex items-center justify-center font-medium text-sm">
          <Skeleton className="h-8 w-20" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="hidden size-8 lg:block" />
          <Skeleton className="size-8" />
          <Skeleton className="size-8" />
          <Skeleton className="hidden size-8 lg:block" />
        </div>
      </div>
    </div>
  );
}

function DataTableDesktopSkeleton({
  columnCount,
  cellWidths = ["auto"],
  rowCount,
  shrinkZero,
}: {
  columnCount: number;
  cellWidths: readonly string[] | undefined;
  rowCount: number;
  shrinkZero: boolean;
}) {
  const widths = Array.from(
    { length: columnCount },
    (_, index) => cellWidths[index % cellWidths.length] ?? "auto",
  );

  return (
    <div className="rounded-md border">
      <Table aria-hidden="true">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {widths.map((width, j) => (
              <TableHead
                key={j}
                style={{
                  width: width,
                  minWidth: shrinkZero ? width : "auto",
                }}
              >
                <Skeleton className="h-6 w-full" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rowCount }).map((_, i) => (
            <TableRow key={i} className="hover:bg-transparent">
              {widths.map((width, j) => (
                <TableCell
                  key={j}
                  style={{
                    width: width,
                    minWidth: shrinkZero ? width : "auto",
                  }}
                >
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
