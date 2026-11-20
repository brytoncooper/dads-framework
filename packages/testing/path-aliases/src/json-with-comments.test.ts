import { describe, expect, it } from "vitest";
import { parseJsonWithComments } from "./json-with-comments.js";

/**
 * The tsconfig dialect this package reads for itself: JSON, plus comments in
 * any position and a comma before a closing bracket. A string is content, so
 * nothing inside one is ever read as syntax, and text the reader cannot parse
 * says where it stopped.
 */

describe("parseJsonWithComments", () => {
  it("reads a comment in every position a tsconfig can put one", () => {
    const source = [
      "// a leading line comment",
      "/* and a block one",
      "   over several lines */",
      "{",
      '  /* before a key */ "compilerOptions" /* after it */ : {',
      '    "paths": [ // inside an array',
      '      "src/*" /* between elements */ ,',
      '      "lib/*"',
      "    ], // after a member",
      '    "strict": true /* before the closing brace */',
      "  }",
      "} // and after the document",
    ].join("\n");

    expect(parseJsonWithComments(source)).toEqual({
      compilerOptions: { paths: ["src/*", "lib/*"], strict: true },
    });
  });

  it("reads a line comment that runs to the end of the file", () => {
    expect(parseJsonWithComments('{"a": 1} // no newline after this')).toEqual({
      a: 1,
    });
  });

  it("reads a trailing comma in an object and in an array", () => {
    expect(parseJsonWithComments('{ "a": [1, 2, ], "b": 3, }')).toEqual({
      a: [1, 2],
      b: 3,
    });
    expect(parseJsonWithComments("[ ]")).toEqual([]);
    expect(parseJsonWithComments("{ }")).toEqual({});
  });

  it("reads a trailing comma a comment sits behind", () => {
    expect(parseJsonWithComments('{ "a": 1, /* done */ }')).toEqual({ a: 1 });
  });

  it("keeps comment markers, quotes, and escapes inside strings", () => {
    const source =
      '{ "url": "https://example.test//path", "block": "closes */ here", ' +
      '"quoted": "a \\" and a \\\\", "brace": "}", "comma": "," }';

    expect(parseJsonWithComments(source)).toEqual({
      url: "https://example.test//path",
      block: "closes */ here",
      quoted: 'a " and a \\',
      brace: "}",
      comma: ",",
    });
  });

  it("reads every JSON value shape, and a byte-order mark before them", () => {
    const source = `${String.fromCharCode(0xfeff)}{ "n": -1.5e3, "t": true, "f": false, "z": null, "nested": [[], {}] }`;

    expect(parseJsonWithComments(source)).toEqual({
      n: -1500,
      t: true,
      f: false,
      z: null,
      nested: [[], {}],
    });
  });

  it("names the line and column it stopped at", () => {
    const cases: readonly { readonly source: string; readonly stop: string }[] =
      [
        {
          source: "{ compilerOptions: {} }",
          stop: "expected a property name at line 1, column 3",
        },
        {
          source: "{ 'single': 1 }",
          stop: "expected a property name at line 1, column 3",
        },
        {
          source: '{\n  "a" 1\n}',
          stop: "expected a colon after a property name at line 2, column 7",
        },
        {
          source: '{ "a": tru }',
          stop: "expected a value at line 1, column 8",
        },
        {
          source: '{ "a": 1 "b": 2 }',
          stop: "expected a comma or } at line 1, column 10",
        },
        {
          source: "[ 1 2 ]",
          stop: "expected a comma or ] at line 1, column 5",
        },
        {
          source: '{ "a": ',
          stop: "expected a value at line 1, column 8",
        },
        {
          source: '{ "a": "unterminated }',
          stop: "expected the end of a string at line 1, column 8",
        },
        {
          source: '/* never closed\n{ "a": 1 }',
          stop: "expected the end of a block comment at line 1, column 1",
        },
        {
          source: '{ "a": 1 }\n{ "b": 2 }',
          stop: "expected the end of the file at line 2, column 1",
        },
        {
          source: "",
          stop: "expected a value at line 1, column 1",
        },
      ];

    for (const one of cases) {
      expect(() => parseJsonWithComments(one.source)).toThrow(one.stop);
    }
  });
});
