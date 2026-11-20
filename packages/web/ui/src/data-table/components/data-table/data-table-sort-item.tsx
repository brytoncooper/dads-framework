import type { ColumnSort, SortDirection } from "@tanstack/react-table";
import { ChevronsUpDown, GripVertical, Trash2 } from "lucide-react";
import * as React from "react";

import { Button } from "../../../elements/index.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../forms/index.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../overlays/index.js";

import { dataTableConfig } from "../../config/data-table.js";
import { useDataTableCopy } from "../../copy/data-table-copy.js";
import { SortableItem, SortableItemHandle } from "../ui/sortable.js";

const REMOVE_SORT_SHORTCUTS = ["backspace", "delete"];

type DataTableSortItemProps = {
  sort: ColumnSort;
  sortItemId: string;
  columns: { id: string; label: string }[];
  columnLabels: Map<string, string>;
  onSortUpdate: (sortId: string, updates: Partial<ColumnSort>) => void;
  onSortRemove: (sortId: string) => void;
};

export function DataTableSortItem({
  sort,
  sortItemId,
  columns,
  columnLabels,
  onSortUpdate,
  onSortRemove,
}: DataTableSortItemProps) {
  const t = useDataTableCopy();
  const fieldListboxId = `${sortItemId}-field-listbox`;
  const fieldTriggerId = `${sortItemId}-field-trigger`;
  const directionListboxId = `${sortItemId}-direction-listbox`;

  const [showFieldSelector, setShowFieldSelector] = React.useState(false);
  const [showDirectionSelector, setShowDirectionSelector] =
    React.useState(false);

  const onItemKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (showFieldSelector || showDirectionSelector) {
        return;
      }

      if (REMOVE_SORT_SHORTCUTS.includes(event.key.toLowerCase())) {
        event.preventDefault();
        onSortRemove(sort.id);
      }
    },
    [sort.id, showFieldSelector, showDirectionSelector, onSortRemove],
  );

  return (
    <SortableItem value={sort.id} asChild>
      <div
        role="listitem"
        id={sortItemId}
        tabIndex={-1}
        className="flex items-center gap-2"
        onKeyDown={onItemKeyDown}
      >
        <Popover open={showFieldSelector} onOpenChange={setShowFieldSelector}>
          <PopoverTrigger asChild>
            <Button
              id={fieldTriggerId}
              aria-controls={fieldListboxId}
              variant="outline"
              className="w-44 justify-between rounded font-normal"
            >
              <span className="truncate">{columnLabels.get(sort.id)}</span>
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            id={fieldListboxId}
            className="w-(--radix-popover-trigger-width) p-0"
          >
            <Command>
              <CommandInput placeholder={t("dataTable.filter.searchFields")} />
              <CommandList>
                <CommandEmpty>{t("dataTable.state.noFields")}</CommandEmpty>
                <CommandGroup>
                  {columns.map((column) => (
                    <CommandItem
                      key={column.id}
                      value={column.id}
                      onSelect={(value) => {
                        onSortUpdate(sort.id, { id: value });
                      }}
                    >
                      <span className="truncate">{column.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Select
          open={showDirectionSelector}
          onOpenChange={setShowDirectionSelector}
          value={sort.desc ? "desc" : "asc"}
          onValueChange={(value: SortDirection) => {
            onSortUpdate(sort.id, { desc: value === "desc" });
          }}
        >
          <SelectTrigger
            size="sm"
            aria-controls={directionListboxId}
            className="w-24 rounded"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent
            id={directionListboxId}
            className="min-w-(--radix-select-trigger-width)"
          >
            <SelectGroup>
              {dataTableConfig.sortOrders.map((order) => (
                <SelectItem key={order.value} value={order.value}>
                  {t(order.labelKey)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          aria-controls={sortItemId}
          aria-label={t("dataTable.action.removeSort")}
          variant="outline"
          size="icon"
          className="size-8 shrink-0 rounded"
          onClick={() => {
            onSortRemove(sort.id);
          }}
        >
          <Trash2 />
        </Button>
        <SortableItemHandle asChild>
          <Button
            variant="outline"
            size="icon"
            className="size-8 shrink-0 rounded"
          >
            <GripVertical />
          </Button>
        </SortableItemHandle>
      </div>
    </SortableItem>
  );
}
