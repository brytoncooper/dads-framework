/** A paged reader result before a route handler maps database rows to API items. */
export type ListPage<Row> = {
  readonly rows: readonly Row[];
  readonly total: number;
};

/** Convert a reader's rows page into the items result required by listRoute. */
export function mapListResult<Row, Item>(
  page: ListPage<Row>,
  mapper: (row: Row) => Item,
): { readonly items: readonly Item[]; readonly total: number } {
  return {
    items: page.rows.map((row) => mapper(row)),
    total: page.total,
  };
}
