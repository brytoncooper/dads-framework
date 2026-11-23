import { describe, expect, it } from "vitest";
import { buildNoteExportFilename, createNoteRecord, escapeCsvFormulaCell, normalizeNoteText } from "./note-rules.js";

describe("note-rules", () => {
  it("normalizes whitespace and line endings deterministically", () => {
    expect(normalizeNoteText("  first line\r\nsecond line\rthird line  ")).toBe("first line\nsecond line\nthird line");
    expect(normalizeNoteText("\n  single line \t")).toBe("single line");
  });

  it("creates a normalized note record from explicit inputs", () => {
    const record = createNoteRecord({
      id: "0194f4a0-1234-7000-8000-000000000001",
      tenantId: "0194f4a0-1234-7000-8000-000000000002",
      text: "  Hello\r\nworld  ",
    });
    expect(record).toEqual({
      id: "0194f4a0-1234-7000-8000-000000000001",
      tenantId: "0194f4a0-1234-7000-8000-000000000002",
      text: "Hello\nworld",
    });
  });

  it("escapes CSV formula prefixes and preserves ordinary text", () => {
    expect(escapeCsvFormulaCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(escapeCsvFormulaCell("  +1+1")).toBe("'  +1+1");
    expect(escapeCsvFormulaCell("-cmd")).toBe("'-cmd");
    expect(escapeCsvFormulaCell("@mention")).toBe("'@mention");
    expect(escapeCsvFormulaCell("Alpha's note")).toBe("Alpha's note");
  });

  it("builds deterministic export filenames", () => {
    expect(buildNoteExportFilename("0194F4A0-1234-7000-8000-000000000001", "csv")).toBe("note-0194f4a0.csv");
    expect(buildNoteExportFilename("0194F4A0-1234-7000-8000-000000000001", "pdf")).toBe("note-0194f4a0.pdf");
    expect(buildNoteExportFilename("  ---  ", "csv")).toBe("note.csv");
  });
});
