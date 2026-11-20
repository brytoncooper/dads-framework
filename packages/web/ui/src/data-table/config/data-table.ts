import type { DataTableCopyKey } from "../copy/data-table-copy.js";

type CopyLabeledValue = {
  readonly labelKey: DataTableCopyKey;
  readonly value: string;
};

export type DataTableConfig = typeof dataTableConfig;

export const dataTableConfig = {
  textOperators: [
    { labelKey: "dataTable.operator.contains", value: "iLike" },
    { labelKey: "dataTable.operator.doesNotContain", value: "notILike" },
    { labelKey: "dataTable.operator.is", value: "eq" },
    { labelKey: "dataTable.operator.isNot", value: "ne" },
    { labelKey: "dataTable.operator.isEmpty", value: "isEmpty" },
    { labelKey: "dataTable.operator.isNotEmpty", value: "isNotEmpty" },
  ] as const satisfies readonly CopyLabeledValue[],
  numericOperators: [
    { labelKey: "dataTable.operator.is", value: "eq" },
    { labelKey: "dataTable.operator.isNot", value: "ne" },
    { labelKey: "dataTable.operator.isLessThan", value: "lt" },
    { labelKey: "dataTable.operator.isLessThanOrEqual", value: "lte" },
    { labelKey: "dataTable.operator.isGreaterThan", value: "gt" },
    { labelKey: "dataTable.operator.isGreaterThanOrEqual", value: "gte" },
    { labelKey: "dataTable.operator.isBetween", value: "isBetween" },
    { labelKey: "dataTable.operator.isEmpty", value: "isEmpty" },
    { labelKey: "dataTable.operator.isNotEmpty", value: "isNotEmpty" },
  ] as const satisfies readonly CopyLabeledValue[],
  dateOperators: [
    { labelKey: "dataTable.operator.is", value: "eq" },
    { labelKey: "dataTable.operator.isNot", value: "ne" },
    { labelKey: "dataTable.operator.isBefore", value: "lt" },
    { labelKey: "dataTable.operator.isAfter", value: "gt" },
    { labelKey: "dataTable.operator.isOnOrBefore", value: "lte" },
    { labelKey: "dataTable.operator.isOnOrAfter", value: "gte" },
    { labelKey: "dataTable.operator.isBetween", value: "isBetween" },
    {
      labelKey: "dataTable.operator.isRelativeToToday",
      value: "isRelativeToToday",
    },
    { labelKey: "dataTable.operator.isEmpty", value: "isEmpty" },
    { labelKey: "dataTable.operator.isNotEmpty", value: "isNotEmpty" },
  ] as const satisfies readonly CopyLabeledValue[],
  selectOperators: [
    { labelKey: "dataTable.operator.is", value: "eq" },
    { labelKey: "dataTable.operator.isNot", value: "ne" },
    { labelKey: "dataTable.operator.isEmpty", value: "isEmpty" },
    { labelKey: "dataTable.operator.isNotEmpty", value: "isNotEmpty" },
  ] as const satisfies readonly CopyLabeledValue[],
  multiSelectOperators: [
    { labelKey: "dataTable.operator.hasAnyOf", value: "inArray" },
    { labelKey: "dataTable.operator.hasNoneOf", value: "notInArray" },
    { labelKey: "dataTable.operator.isEmpty", value: "isEmpty" },
    { labelKey: "dataTable.operator.isNotEmpty", value: "isNotEmpty" },
  ] as const satisfies readonly CopyLabeledValue[],
  booleanOperators: [
    { labelKey: "dataTable.operator.is", value: "eq" },
    { labelKey: "dataTable.operator.isNot", value: "ne" },
  ] as const satisfies readonly CopyLabeledValue[],
  sortOrders: [
    { labelKey: "dataTable.sort.ascending", value: "asc" },
    { labelKey: "dataTable.sort.descending", value: "desc" },
  ] as const satisfies readonly CopyLabeledValue[],
  filterVariants: [
    "text",
    "number",
    "range",
    "date",
    "dateRange",
    "boolean",
    "select",
    "multiSelect",
  ] as const,
  operators: [
    "iLike",
    "notILike",
    "eq",
    "ne",
    "inArray",
    "notInArray",
    "isEmpty",
    "isNotEmpty",
    "lt",
    "lte",
    "gt",
    "gte",
    "isBetween",
    "isRelativeToToday",
  ] as const,
  joinOperators: ["and", "or"] as const,
  joinOperatorLabelKeys: {
    and: "dataTable.join.and",
    or: "dataTable.join.or",
  } satisfies Readonly<Record<"and" | "or", DataTableCopyKey>>,
};
