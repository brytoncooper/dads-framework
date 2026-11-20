import {
  FONT_SIZE,
  LINE_HEIGHT,
  PAGE_MARGIN,
  requireFixedPagePdf,
  type FixedPagePdf,
  type FixedPagePdfRenderer,
} from "../src/lib/fixed-page-pdf.js";

/** Writes uncompressed PDF text streams and a byte-offset cross-reference table. */
class ReferencePagePdfWriter implements FixedPagePdfRenderer {
  render(document: FixedPagePdf): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      requireFixedPagePdf(document);
      return encodePdf(pdfObjects(document));
    });
  }
}

export function openReferencePagePdfWriter(): FixedPagePdfRenderer {
  return new ReferencePagePdfWriter();
}

function pdfObjects(document: FixedPagePdf): readonly string[] {
  const pageIds = document.pages.map(
    (_, index) => `${String(5 + 2 * index)} 0 R`,
  );
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${String(pageIds.length)} /Kids [${pageIds.join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [index, lines] of document.pages.entries()) {
    const stream = pageStream(lines, document.height);
    objects.push(
      `<< /Length ${String(stream.length)} >>\nstream\n${stream}endstream`,
    );
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(document.width)} ${String(document.height)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(4 + 2 * index)} 0 R >>`,
    );
  }
  return objects;
}

function pageStream(lines: readonly string[], height: number): string {
  const start = height - PAGE_MARGIN - FONT_SIZE;
  const content = lines.map((line) => {
    const escaped = line.replace(/[\\()]/g, "\\$&");
    return `(${escaped}) Tj T*`;
  });
  return [
    `BT /F1 ${String(FONT_SIZE)} Tf ${String(PAGE_MARGIN)} ${String(start)} Td ${String(LINE_HEIGHT)} TL`,
    ...content,
    "ET",
    "",
  ].join("\n");
}

function encodePdf(objects: readonly string[]): Uint8Array {
  let source = "%PDF-1.4\n";
  const offsets = ["0000000000 65535 f "];
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(source.length).padStart(10, "0")} 00000 n `);
    source += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }
  const start = source.length;
  source += `xref\n0 ${String(offsets.length)}\n${offsets.join("\n")}\n`;
  source += `trailer\n<< /Size ${String(offsets.length)} /Root 1 0 R >>\nstartxref\n${String(start)}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}
