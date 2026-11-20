/**
 * RFC-4180 quoting: commas, quotes, and newlines in cell values must round-trip.
 */
import { describe, expect, it } from "vitest";
import { toCsv } from "./to-csv.js";

describe("toCsv", () => {
  it("writes headers and escapes the awkward cases", () => {
    const csv = toCsv(
      [
        { name: 'Prairie "Feed" Co', tons: 12.5 },
        { name: "Line\nBreak, Inc", tons: 3 },
      ],
      [
        { key: "name", header: "Customer" },
        { key: "tons", header: "Tons" },
      ],
    );
    expect(csv.startsWith("Customer,Tons\n")).toBe(true);
    expect(csv).toContain('"Prairie ""Feed"" Co"');
    expect(csv).toContain('"Line\nBreak, Inc"');
  });
});

it("writes an LF-terminated header for an empty export", () => {
  expect(toCsv([], [{ key: "value", header: 'name,"label"' }])).toBe(
    '"name,""label"""\n',
  );
  expect(toCsv([], [])).toBe("\n");
});

it("preserves nulls, booleans, dates, numbers, and structured cells", () => {
  const keys = [
    "missing",
    "nil",
    "truth",
    "falsehood",
    "at",
    "n",
    "big",
    "data",
  ];
  expect(
    toCsv(
      [
        {
          nil: null,
          truth: true,
          falsehood: false,
          at: new Date(42),
          n: -2.5,
          big: 12n,
          data: { a: 1 },
        },
      ],
      keys.map((key) => ({ key, header: key })),
    ),
  ).toBe(
    'missing,nil,truth,falsehood,at,n,big,data\n,,1,,42,-2.5,12,"{""a"":1}"\n',
  );
});

it("reads nested keys and lets a literal key take precedence", () => {
  expect(
    toCsv(
      [
        {
          "nested.value": "literal",
          nested: { value: "not used", "a.b": "quoted" },
          items: ["one"],
        },
        { nested: { value: "fallback" }, items: ["two"] },
      ],
      ["nested.value", 'nested["a.b"]', "items[0]"].map((key) => ({
        key,
        header: key,
      })),
    ),
  ).toBe(
    'nested.value,"nested[""a.b""]",items[0]\nliteral,quoted,one\nfallback,,two\n',
  );
});

it("quotes carriage returns and refuses values without a CSV representation", () => {
  expect(
    toCsv([{ value: "part\rrest" }], [{ key: "value", header: "Value" }]),
  ).toBe('Value\n"part\rrest"\n');
  expect(() =>
    toCsv([{ value: Symbol("invalid") }], [{ key: "value", header: "Value" }]),
  ).toThrow(TypeError);
});

it("does not treat a literal unmatched bracket as a nested path", () => {
  expect(toCsv([{ a: "unrelated" }], [{ key: "a[", header: "Value" }])).toBe(
    "Value\n\n",
  );
  expect(() => toCsv([], [{ key: "", header: "Value" }])).toThrow(
    "column key is required",
  );
});
