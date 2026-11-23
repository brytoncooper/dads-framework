# `@dads-framework/documents`

Document export and parsing utilities with optional heavy peer dependencies: zero-dependency CSV (`/csv`), PDF rendering and generation (`/pdf`, `/pdf/pdfmake`), and XLSX spreadsheets (`/xlsx`).

## Try it

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/documents
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import { toCsv } from "@dads-framework/documents/csv";

const csv = toCsv(
  [{ customer: { name: "River, Inc." } }],
  [{ key: "customer.name", header: "Customer" }],
);
process.stdout.write(csv);
```

The script prints the header and a quoted cell on separate lines.

```text
Customer
"River, Inc."
```

The starter applies its spreadsheet-safety policy to note text and passes the result to `toCsv`. [`apps/kit-workbench/domains/notes/server/exports.ts`](../../apps/kit-workbench/domains/notes/server/exports.ts)

## Use it

The column list controls the header names and order. Before exporting data
that a spreadsheet may interpret as formulas, apply the application's policy
for spreadsheet-safe values.

## Cell values

The serializer quotes commas, quotes, and line breaks. Missing and null cells
are blank. Booleans produce `1` or a blank, dates use epoch milliseconds,
and structured values use JSON.

## Subpaths and optional dependencies

- `@dads-framework/documents/csv`: zero-dependency CSV serialization.
- `@dads-framework/documents/pdf`: PDF utilities and pdfmake adapter (`@dads-framework/documents/pdf/pdfmake`, optional peers `pdfmake`, `pdfjs-dist`, `@napi-rs/canvas`).
- `@dads-framework/documents/xlsx`: spreadsheet table reading and writing (optional peer `exceljs`).

Optional peers load lazily on first use. Calling a subpath whose peer is not installed rejects with an actionable error naming the subpath and `npm install <pkg>` command.

## What it refuses to do

- It does not bundle heavy PDF or spreadsheet runtimes into the default install; optional renderers stay behind optional peer dependencies on their dedicated subpaths.
- It does not guess spreadsheet formula-escaping policies or accept arbitrary untrusted document formulas silently; callers apply their application policy before serializing.
