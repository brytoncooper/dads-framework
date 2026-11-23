import pdfmake from "pdfmake";
import { describe, expect, it } from "vitest";

import { PdfmakePdfRenderer } from "./pdfmake-pdf-renderer.js";

describe("PdfmakePdfRenderer", () => {
  it("retries text metrics after the PDF stream cannot be created", async () => {
    const createPdf = pdfmake.createPdf.bind(pdfmake);
    let attempts = 0;
    const failure = new Error("Stream creation failed");
    pdfmake.createPdf = (definition) => {
      attempts += 1;
      const pdf = createPdf(definition);
      if (attempts === 1) pdf.getStream = () => Promise.reject(failure);
      return pdf;
    };

    try {
      const renderer = new PdfmakePdfRenderer();
      await expect(renderer.textMetrics()).rejects.toBe(failure);
      const metrics = await renderer.textMetrics();

      expect(metrics.width("Hello", 12)).toBeCloseTo(27.336, 3);
      expect(attempts).toBe(2);
    } finally {
      pdfmake.createPdf = createPdf;
    }
  });

  it("shares loading and successful metrics without reading a destroyed document", async () => {
    const createPdf = pdfmake.createPdf.bind(pdfmake);
    let attempts = 0;
    let destroyed = false;
    const measuredText = "José Álvarez — AV…";
    let expectedWidth = 0;
    pdfmake.createPdf = (definition) => {
      attempts += 1;
      const pdf = createPdf(definition);
      const getStream = pdf.getStream.bind(pdf);
      pdf.getStream = async () => {
        const document = await getStream();
        document.font("Helvetica").fontSize(12);
        expectedWidth = document.widthOfString(measuredText);
        const destroy = document.destroy.bind(document);
        document.destroy = (error) => {
          destroyed = true;
          document.widthOfString = () => {
            throw new Error("The PDF document has been destroyed");
          };
          return destroy(error);
        };
        return document;
      };
      return pdf;
    };

    try {
      const renderer = new PdfmakePdfRenderer();
      const first = renderer.textMetrics();
      expect(renderer.textMetrics()).toBe(first);
      const metrics = await first;

      expect(destroyed).toBe(true);
      expect(metrics.width("Hello", 12)).toBeCloseTo(27.336, 3);
      expect(metrics.width(measuredText, 12)).toBeCloseTo(expectedWidth, 8);
      expect(await renderer.textMetrics()).toBe(metrics);
      expect(attempts).toBe(1);
    } finally {
      pdfmake.createPdf = createPdf;
    }
  });

  it("destroys a failed stream and retries text metrics", async () => {
    const createPdf = pdfmake.createPdf.bind(pdfmake);
    let attempts = 0;
    let destroyed = false;
    const failure = new Error("Metrics stream failed");
    pdfmake.createPdf = (definition) => {
      attempts += 1;
      const pdf = createPdf(definition);
      if (attempts !== 1) return pdf;
      const getStream = pdf.getStream.bind(pdf);
      pdf.getStream = async () => {
        const document = await getStream();
        const destroy = document.destroy.bind(document);
        document.destroy = (error) => {
          destroyed = true;
          return destroy(error);
        };
        document.resume = () => {
          queueMicrotask(() => document.emit("error", failure));
          return document;
        };
        return document;
      };
      return pdf;
    };

    try {
      const renderer = new PdfmakePdfRenderer();
      await expect(renderer.textMetrics()).rejects.toBe(failure);
      expect(destroyed).toBe(true);
      expect((await renderer.textMetrics()).width("Hello", 12)).toBeCloseTo(27.336, 3);
      expect(attempts).toBe(2);
    } finally {
      pdfmake.createPdf = createPdf;
    }
  });

  it("measures Helvetica text with the font used in generated PDFs", async () => {
    const metrics = await new PdfmakePdfRenderer().textMetrics();

    expect(metrics.width("Hello", 12)).toBeCloseTo(27.336, 3);
    expect(metrics.width("", 12)).toBe(0);
    expect(metrics.width("WW", 12)).toBeGreaterThan(metrics.width("ii", 12));
    expect(metrics.lineHeight(12)).toBeCloseTo(11.1, 3);
  });

  it("scales measurements without leaking the previous font size", async () => {
    const metrics = await new PdfmakePdfRenderer().textMetrics();
    const width = metrics.width("Ticket 123", 12);

    expect(metrics.width("Ticket 123", 24)).toBeCloseTo(width * 2, 5);
    expect(metrics.width("Ticket 123", 12)).toBeCloseTo(width, 5);
    expect(metrics.lineHeight(24)).toBeCloseTo(metrics.lineHeight(12) * 2, 5);
  });

  it("measures bold text with Helvetica Bold's wider glyphs", async () => {
    const metrics = await new PdfmakePdfRenderer().textMetrics();

    // Regular width unchanged; Helvetica Bold's i, k, and l are wider.
    expect(metrics.width("Ticket 123", 12, true)).toBeCloseTo(57.792, 3);
    expect(metrics.width("Ticket 123", 12, true)).toBeGreaterThan(metrics.width("Ticket 123", 12, false));
    expect(metrics.width("Weight", 12, true)).toBeGreaterThan(metrics.width("Weight", 12));
    expect(metrics.width("", 12, true)).toBe(0);
    expect(metrics.width("Ticket 123", 24, true)).toBeCloseTo(metrics.width("Ticket 123", 12, true) * 2, 5);
    expect(metrics.lineHeight(12)).toBeCloseTo(11.1, 3);
  });

  it("treats an omitted bold flag as regular", async () => {
    const metrics = await new PdfmakePdfRenderer().textMetrics();

    expect(metrics.width("Ticket 123", 12)).toBe(metrics.width("Ticket 123", 12, false));
    expect(metrics.width("Ticket 123", 12, false)).toBeCloseTo(54.876, 3);
  });

  it("renders a definition to real PDF bytes", async () => {
    const bytes = await new PdfmakePdfRenderer().render({
      content: [{ text: "Batch Ticket FIN-14", style: "header" }, { text: "12.5 tons — Prairie Feed Co" }],
      styles: { header: { fontSize: 16, bold: true } },
    });
    expect(bytes.length).toBeGreaterThan(500);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
