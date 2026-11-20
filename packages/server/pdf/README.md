# @dads-framework/pdf — PDF rendering

`PdfRenderer` accepts a `PdfmakeDefinition` and returns PDF bytes. The
definition is pdfmake's public document format. `PdfDefinition` remains an
alternate import of the same type.
`textMetrics()` returns the default Helvetica font's text width and line height
in PDF points for placing bounded text. Its metrics use the same font as rendering.
Server processes and local desktop runtimes can both import it. Node
only (`node:module`, `node:path`, the native `@napi-rs/canvas`): never import
it from browser code.

## Try it

In a project using Node.js 22 or later, install the example dependencies.
Run from a directory where you can write the PDF.

```sh
npm install @dads-framework/pdf
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import { writeFile } from "node:fs/promises";
import { createFixedPagePdfRenderer } from "@dads-framework/pdf";

const bytes = await createFixedPagePdfRenderer().render({
  width: 300,
  height: 200,
  pages: [["Daily report", "Ready for review"]],
});
await writeFile("daily-report.pdf", bytes);
console.log("Wrote daily-report.pdf");
```

Open `daily-report.pdf` to see one page with the two lines of text.

## Portable fixed-page output

Use `createFixedPagePdfRenderer()` for simple documents with uniform page
dimensions in PDF points and printable ASCII lines in 12-point Helvetica.
The renderer rejects text that would overflow a page. The shared laws check
actual PDF bytes, page dimensions, and extracted text using both the pdfmake
adapter and an independent test writer of standard PDF objects and streams.

Use `@dads-framework/pdf/pdfmake` for the vendor-specific document definition
and renderer. That integration retains pdfmake features such as rich layout,
and the existing package-root imports remain available. The portable proof
covers fixed-page text output. Rasterization and rich documents have separate
provider-specific tests.
