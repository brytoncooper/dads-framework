# @dads-framework/csv

Call `toCsv(rows, columns)` to export records with column headers. It produces
comma-separated cells, LF line endings, and a final newline. A column selects
a property by name, with nested paths such as `address.city` or `items[0]`.

## Try it

```ts
import { toCsv } from "@dads-framework/csv";

const csv = toCsv(
  [{ customer: { name: "River, Inc." } }],
  [{ key: "customer.name", header: "Customer" }],
);
console.log(csv.trimEnd());
// Customer
// "River, Inc."
```

The column list controls the header names and order. Before exporting data
that a spreadsheet may interpret as formulas, apply the application's policy
for spreadsheet-safe values.

## Cell values

The serializer quotes commas, quotes, and line breaks. Missing and null cells
are blank. Booleans produce `1` or a blank, dates use epoch milliseconds,
and structured values use JSON.
