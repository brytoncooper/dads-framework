import { describe, expect, it } from "vitest";
import { attachmentKindOf, fileSizeParts } from "./attachment-item.js";

describe("attachmentKindOf", () => {
  it("trusts the MIME type first", () => {
    expect(
      attachmentKindOf({ contentType: "application/pdf", fileName: "a" }),
    ).toBe("pdf");
    expect(
      attachmentKindOf({ contentType: "image/png", fileName: "scan.pdf" }),
    ).toBe("image");
    expect(
      attachmentKindOf({ contentType: "image/jpeg", fileName: "photo" }),
    ).toBe("image");
  });

  it("ignores MIME parameters and letter case", () => {
    expect(
      attachmentKindOf({
        contentType: "Application/PDF; charset=binary",
        fileName: "a",
      }),
    ).toBe("pdf");
  });

  it("falls back to the file extension for generic types", () => {
    expect(
      attachmentKindOf({
        contentType: "application/octet-stream",
        fileName: "Lockout-Procedure-Leg-1.PDF",
      }),
    ).toBe("pdf");
    expect(attachmentKindOf({ contentType: "", fileName: "panel.JPeG" })).toBe(
      "image",
    );
    expect(
      attachmentKindOf({
        contentType: "binary/octet-stream",
        fileName: "a.webp",
      }),
    ).toBe("image");
  });

  it("treats everything else as other", () => {
    expect(
      attachmentKindOf({ contentType: "text/csv", fileName: "parts.csv" }),
    ).toBe("other");
    expect(
      attachmentKindOf({
        contentType: "application/octet-stream",
        fileName: "README",
      }),
    ).toBe("other");
    expect(attachmentKindOf({ contentType: "", fileName: ".pdf" })).toBe(
      "other",
    );
    expect(attachmentKindOf({ contentType: "", fileName: "notes." })).toBe(
      "other",
    );
  });

  it("does not preview SVG images", () => {
    expect(
      attachmentKindOf({ contentType: "image/svg+xml", fileName: "logo.svg" }),
    ).toBe("other");
  });
});

describe("fileSizeParts", () => {
  it("sizes files in decimal units", () => {
    expect(fileSizeParts(4)).toEqual({ value: 4, unit: "byte" });
    expect(fileSizeParts(1_500)).toEqual({ value: 1.5, unit: "kilobyte" });
    expect(fileSizeParts(5_242_880)).toEqual({
      value: 5.24288,
      unit: "megabyte",
    });
  });

  it("switches unit exactly at 1 kB and 1 MB", () => {
    expect(fileSizeParts(999)).toEqual({ value: 999, unit: "byte" });
    expect(fileSizeParts(1_000)).toEqual({ value: 1, unit: "kilobyte" });
    expect(fileSizeParts(999_999).unit).toBe("kilobyte");
    expect(fileSizeParts(1_000_000)).toEqual({ value: 1, unit: "megabyte" });
  });
});
