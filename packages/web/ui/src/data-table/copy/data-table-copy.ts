import {
  createCopyHook,
  defineCopy,
  type CopyKey,
  type CopyTranslator,
} from "@dads-framework/copy";

/** Whole visible and accessible phrases owned by the shared DataTable kit. */
export const dataTableCopy = defineCopy({
  "dataTable.action.addFilter": { en: "Add Filter" },
  "dataTable.action.addSort": { en: "Add Sort" },
  "dataTable.action.clear": { en: "Clear" },
  "dataTable.action.clearFilter": { en: "Clear Filter" },
  "dataTable.action.clearNamedFilter": {
    en: "Clear {columnLabel} Filter",
  },
  "dataTable.action.clearFilters": { en: "Clear Filters" },
  "dataTable.action.reset": { en: "Reset" },
  "dataTable.action.resetAllFilters": { en: "Reset All Filters" },
  "dataTable.action.resetFilters": { en: "Reset Filters" },
  "dataTable.action.resetSorting": { en: "Reset Sorting" },
  "dataTable.action.removeFilter": { en: "Remove Filter" },
  "dataTable.action.removeSort": { en: "Remove Sort" },
  "dataTable.action.columns": { en: "Columns" },
  "dataTable.action.showAllColumns": { en: "Show All" },
  "dataTable.action.details": { en: "Details" },
  "dataTable.action.filters": { en: "Filters" },
  "dataTable.action.filtersApplied_one": { en: "Filters, {count} Applied" },
  "dataTable.action.filtersApplied_other": { en: "Filters, {count} Applied" },
  "dataTable.action.showResults": { en: "Show Results" },
  "dataTable.action.showCountResults_one": { en: "Show {count} Result" },
  "dataTable.action.showCountResults_other": { en: "Show {count} Results" },
  "dataTable.action.clearAll": { en: "Clear All" },
  "dataTable.action.removeAppliedFilter": {
    en: "Remove {filterLabel}: {valueLabel}",
  },

  "dataTable.columns.heading": { en: "Shown Columns" },
  "dataTable.columns.hiddenCount_one": { en: "{count} Column Hidden" },
  "dataTable.columns.hiddenCount_other": { en: "{count} Columns Hidden" },

  "dataTable.state.loading": { en: "Loading Table" },
  "dataTable.state.updating": { en: "Updating Table" },
  "dataTable.state.noResults": { en: "No results." },
  "dataTable.state.emptyView": { en: "Nothing in this view." },
  "dataTable.state.noFilterResults": { en: "No rows match these filters." },
  "dataTable.state.noFields": { en: "No fields found." },
  "dataTable.state.noOptions": { en: "No options found." },
  "dataTable.filter.searchGroup": { en: "Search {filterLabel}" },

  "dataTable.filter.trigger": { en: "Filter" },
  "dataTable.filter.heading.active": { en: "Filters" },
  "dataTable.filter.heading.empty": { en: "No Filters Applied" },
  "dataTable.filter.description.active": {
    en: "Change filters to narrow these rows.",
  },
  "dataTable.filter.description.empty": {
    en: "Add filters to narrow these rows.",
  },
  "dataTable.filter.where": { en: "Where" },
  "dataTable.filter.selectJoinOperator": { en: "Combine Filters" },
  "dataTable.filter.selectField": { en: "Select Field" },
  "dataTable.filter.searchFields": { en: "Search fields" },
  "dataTable.filter.enterAValue": { en: "Enter a value" },
  "dataTable.filter.enterValue": { en: "Enter a value" },
  "dataTable.filter.true": { en: "True" },
  "dataTable.filter.false": { en: "False" },
  "dataTable.filter.selectOption": { en: "Select an option" },
  "dataTable.filter.selectOptions": { en: "Select options" },
  "dataTable.filter.searchOptions": { en: "Search options" },
  "dataTable.filter.pickADate": { en: "Choose a date" },
  "dataTable.filter.pickDate": { en: "Choose a date" },
  "dataTable.filter.selectDate": { en: "Select date" },
  "dataTable.filter.selectDateRange": { en: "Select date range" },
  "dataTable.filter.typeToAdd": { en: "Type to add a filter" },
  "dataTable.filter.byValue": { en: 'Filter by "{value}"' },
  "dataTable.filter.selectedCount": { en: "{count} selected" },
  "dataTable.filter.dateRange": { en: "{from} - {to}" },
  "dataTable.filter.namedValue": { en: "{columnLabel} filter value" },
  "dataTable.filter.namedValues": { en: "{columnLabel} filter values" },
  "dataTable.filter.namedBoolean": {
    en: "{columnLabel} true or false filter",
  },
  "dataTable.filter.namedDate": { en: "{columnLabel} date filter" },
  "dataTable.filter.namedEmpty": { en: "{columnLabel} filter is empty" },
  "dataTable.filter.namedNotEmpty": {
    en: "{columnLabel} filter is not empty",
  },
  "dataTable.filter.searchNamedOptions": {
    en: "Search {columnLabel} options",
  },
  "dataTable.filter.selectNamedDate": {
    en: "Select {columnLabel} date",
  },
  "dataTable.filter.selectNamedDateRange": {
    en: "Select {columnLabel} date range",
  },
  "dataTable.filter.namedMinimum": { en: "{columnLabel} minimum value" },
  "dataTable.filter.namedMaximum": { en: "{columnLabel} maximum value" },
  "dataTable.filter.namedSlider": { en: "{columnLabel} slider" },
  "dataTable.filter.searchNamed": { en: "Search {columnLabel}" },
  "dataTable.filter.pillValue": { en: "{filterLabel}: {valueList}" },
  "dataTable.filter.appliedValue": { en: "{filterLabel}: {valueLabel}" },
  "dataTable.filter.appliedList": { en: "Applied Filters" },
  "dataTable.filter.openCommandMenu": {
    en: "Open Filter Menu",
  },

  "dataTable.join.and": { en: "and" },
  "dataTable.join.or": { en: "or" },

  "dataTable.operator.contains": { en: "Contains" },
  "dataTable.operator.doesNotContain": { en: "Does not contain" },
  "dataTable.operator.is": { en: "Is" },
  "dataTable.operator.isNot": { en: "Is not" },
  "dataTable.operator.isEmpty": { en: "Is empty" },
  "dataTable.operator.isNotEmpty": { en: "Is not empty" },
  "dataTable.operator.isLessThan": { en: "Is less than" },
  "dataTable.operator.isLessThanOrEqual": {
    en: "Is less than or equal to",
  },
  "dataTable.operator.isGreaterThan": { en: "Is greater than" },
  "dataTable.operator.isGreaterThanOrEqual": {
    en: "Is greater than or equal to",
  },
  "dataTable.operator.isBetween": { en: "Is between" },
  "dataTable.operator.isBefore": { en: "Is before" },
  "dataTable.operator.isAfter": { en: "Is after" },
  "dataTable.operator.isOnOrBefore": { en: "Is on or before" },
  "dataTable.operator.isOnOrAfter": { en: "Is on or after" },
  "dataTable.operator.isRelativeToToday": {
    en: "Is relative to today",
  },
  "dataTable.operator.hasAnyOf": { en: "Has any of" },
  "dataTable.operator.hasNoneOf": { en: "Has none of" },

  "dataTable.sort.trigger": { en: "Sort" },
  "dataTable.sort.heading.active": { en: "Sort By" },
  "dataTable.sort.heading.empty": { en: "No Sorting Applied" },
  "dataTable.sort.description.active": {
    en: "Change the sort to organize these rows.",
  },
  "dataTable.sort.description.empty": {
    en: "Add a sort to organize these rows.",
  },
  "dataTable.sort.ascending": { en: "Asc" },
  "dataTable.sort.descending": { en: "Desc" },

  "dataTable.pagination.rowsPerPage": { en: "Rows per Page" },
  "dataTable.pagination.page": { en: "Page {page} of {pageCount}" },
  "dataTable.pagination.selectedRows_one": {
    en: "{count} of {totalCount} row selected.",
  },
  "dataTable.pagination.selectedRows_other": {
    en: "{count} of {totalCount} rows selected.",
  },
  "dataTable.pagination.first": { en: "Go to First Page" },
  "dataTable.pagination.previous": { en: "Go to Previous Page" },
  "dataTable.pagination.next": { en: "Go to Next Page" },
  "dataTable.pagination.last": { en: "Go to Last Page" },

  "dataTable.date.label": { en: "Date" },
  "dataTable.date.from": { en: "From" },
  "dataTable.date.to": { en: "To" },
  "dataTable.range.to": { en: "to" },

  "dataTable.sortable.notOverDroppable": {
    en: "The item is no longer over a drop area. Press escape to cancel.",
  },
  "dataTable.sortable.grabbed": {
    en: 'Grabbed item "{itemId}". Current position is {position} of {total}. Use arrow keys to move, space to drop.',
  },
  "dataTable.sortable.movedUp": {
    en: 'Item "{itemId}" moved up to position {position} of {total}.',
  },
  "dataTable.sortable.movedDown": {
    en: 'Item "{itemId}" moved down to position {position} of {total}.',
  },
  "dataTable.sortable.droppedWithoutChanges": {
    en: 'Item "{itemId}" dropped. No changes were made.',
  },
  "dataTable.sortable.droppedAtPosition": {
    en: 'Item "{itemId}" dropped at position {position} of {total}.',
  },
  "dataTable.sortable.cancelled": {
    en: 'Sorting cancelled. Item "{itemId}" returned to position {position} of {total}.',
  },
  "dataTable.sortable.movingUp": {
    en: 'Item "{itemId}" is moving up to position {position} of {total}.',
  },
  "dataTable.sortable.movingDown": {
    en: 'Item "{itemId}" is moving down to position {position} of {total}.',
  },
  "dataTable.sortable.instructions.vertical": {
    en: "To pick up an item, press space or enter. While dragging, use the up and down keys to move the item. Press space or enter again to drop the item in its new position, or press escape to cancel.",
  },
  "dataTable.sortable.instructions.horizontal": {
    en: "To pick up an item, press space or enter. While dragging, use the left and right keys to move the item. Press space or enter again to drop the item in its new position, or press escape to cancel.",
  },
  "dataTable.sortable.instructions.mixed": {
    en: "To pick up an item, press space or enter. While dragging, use the arrow keys to move the item. Press space or enter again to drop the item in its new position, or press escape to cancel.",
  },
});

export type DataTableCopyKey = CopyKey<typeof dataTableCopy>;
export type DataTableCopyTranslator = CopyTranslator<typeof dataTableCopy>;

export const useDataTableCopy = createCopyHook(dataTableCopy);
