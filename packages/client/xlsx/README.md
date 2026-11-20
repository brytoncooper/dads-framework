# @dads-framework/client-xlsx

The one .xlsx seam for the web app. Features describe a workbook as a
`WorkbookSpec` (sheet name, columns, optional dropdowns and example rows) and
get an `ArrayBuffer` back; uploads go the other way — an `ArrayBuffer` in,
plain `{ rowNumber, cells }` rows out, keyed by header-row text with every
value coerced to a trimmed string.

`exceljs` is imported here and nowhere else. No vendor type appears in an
exported signature, so swapping the workbook engine touches only this lib.

Workbooks written by this package store metadata in a hidden
`_Workbook Metadata` sheet. The reader also opens ordinary workbooks and returns
their requested sheets.

## Try it

Install the codec in a browser TypeScript app and run the example through
the app’s bundler.

```sh
npm install @dads-framework/client-xlsx
```

Build an inventory template and read its example row back.

<!-- dads:check-example -->

```ts
import { xlsxWorkbookCodec } from "@dads-framework/client-xlsx";

const file = await xlsxWorkbookCodec.build({
  sheets: [
    {
      sheetName: "Inventory",
      columns: [{ header: "SKU", key: "sku", cellKind: "text" }],
      exampleRows: [{ sku: "0012" }],
    },
  ],
});

const { sheets } = await xlsxWorkbookCodec.read(file, ["Inventory"]);
console.log(sheets[0]?.rows[0]?.cells.SKU);
```

The console prints `0012` with the leading zeros intact. For a browser upload,
pass the selected file's `await file.arrayBuffer()` to `read` and validate the
returned cell values before importing inventory records.

## Workbook contract

`xlsxWorkbookCodec` bundles build, read, and update behind the `WorkbookCodec`
type. Reads preserve source row numbers, omit missing sheets and blank cells,
and normalize typed Excel values into text. Edits identify cells by sheet,
row number, and column header.

The interoperability test reads and edits a workbook built directly from
SpreadsheetML parts. Run `python3 test-fixtures/write-external-inventory.py`
from this package to regenerate that workbook.

## Portable table reads

The shared reader laws cover cell text, cached numeric formulas, and sparse
row positions. ExcelJS and a test-only SpreadsheetML reader both run those
laws against ExcelJS output and an independently authored workbook. Template
styling, dropdowns, metadata, and edits have separate ExcelJS-specific tests.
