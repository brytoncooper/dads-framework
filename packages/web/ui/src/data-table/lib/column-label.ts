/**
 * The words a column goes by outside its header cell — in the Columns menu and
 * as a card field's label. `meta.label` when set; else the header when it is
 * plain text; else the column id spelled as words ("loadedAt" → "Loaded At").
 */
export function readColumnLabel(column: {
  readonly id: string;
  readonly metaLabel: string | undefined;
  readonly header: unknown;
}): string {
  if (column.metaLabel !== undefined && column.metaLabel !== "") {
    return column.metaLabel;
  }
  if (typeof column.header === "string" && column.header !== "") {
    return column.header;
  }
  return humanizeColumnId(column.id);
}

/** "loadedAt", "loaded_at", or "loaded-at" → "Loaded At". */
export function humanizeColumnId(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
