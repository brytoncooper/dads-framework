import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords } from "./parse-csv.js";
import { toCsv } from "./to-csv.js";

describe("parseCsv", () => {
  it("returns an empty array for empty input or a bare UTF-8 BOM", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("\uFEFF")).toEqual([]);
  });

  it("parses LF, CRLF, and standalone CR line endings without phantom trailing rows", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\r1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips an optional UTF-8 BOM from the first cell", () => {
    expect(parseCsv("\uFEFFCustomer,Tons\nPrairie,12.5\n")).toEqual([
      ["Customer", "Tons"],
      ["Prairie", "12.5"],
    ]);
    expect(parseCsv('\uFEFF"Customer",Tons\nPrairie,12.5\n')).toEqual([
      ["Customer", "Tons"],
      ["Prairie", "12.5"],
    ]);
  });

  it("handles quoted fields with escaped quotes, commas, and embedded newlines", () => {
    const csv = '"Prairie ""Feed"" Co","Line 1\nLine 2, Inc","CRLF\r\nCell"\r\n"","a,b","""quoted"""\r\n';
    expect(parseCsv(csv)).toEqual([
      ['Prairie "Feed" Co', "Line 1\nLine 2, Inc", "CRLF\r\nCell"],
      ["", "a,b", '"quoted"'],
    ]);
  });

  it("preserves empty fields including leading, middle, and trailing commas", () => {
    expect(parseCsv(",a,,\n")).toEqual([["", "a", "", ""]]);
    expect(parseCsv("a,")).toEqual([["a", ""]]);
    expect(parseCsv("Header\n\n")).toEqual([["Header"], [""]]);
  });

  it("round-trips output produced by toCsv", () => {
    const csv = toCsv(
      [
        { name: 'Prairie "Feed" Co', note: "Line 1\nLine 2, ok", tons: 12.5 },
        { name: "River\r\nBend", note: "", tons: 0 },
      ],
      [
        { key: "name", header: "Customer" },
        { key: "note", header: "Note" },
        { key: "tons", header: "Tons" },
      ],
    );

    expect(parseCsv(csv)).toEqual([
      ["Customer", "Note", "Tons"],
      ['Prairie "Feed" Co', "Line 1\nLine 2, ok", "12.5"],
      ["River\r\nBend", "", "0"],
    ]);
  });

  it("rejects malformed RFC 4180 quoting", () => {
    expect(() => parseCsv('"unterminated')).toThrow(SyntaxError);
    expect(() => parseCsv('"abc"def,1')).toThrow(SyntaxError);
    expect(() => parseCsv('abc"def,1')).toThrow(SyntaxError);
  });
});

describe("parseCsvRecords", () => {
  it("returns an empty array for empty or header-only CSV", () => {
    expect(parseCsvRecords("")).toEqual([]);
    expect(parseCsvRecords("Customer,Tons\n")).toEqual([]);
  });

  it("maps rows onto header keys and defaults missing trailing cells to empty string", () => {
    const csv = '\uFEFFCustomer,Tons,Notes\r\n"Prairie ""Feed"" Co",12.5,"Line 1\nLine 2"\r\nRiver,3\r\n';
    expect(parseCsvRecords(csv)).toEqual([
      { Customer: 'Prairie "Feed" Co', Tons: "12.5", Notes: "Line 1\nLine 2" },
      { Customer: "River", Tons: "3", Notes: "" },
    ]);
  });
});
