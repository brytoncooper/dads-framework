/**
 * The baseline file: read it, write it, and get the same bytes back.
 *
 * The gate rewrites a committed file, so the proof that matters is not that
 * the writer is tidy but that it is idempotent: this repository's own baseline,
 * read and written by the code that replaced the script which produced it,
 * comes back byte for byte. That is what let the migration happen without an
 * edit to `.agents/source-budgets.json`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  matchesExemptGlob,
  parseGateBaseline,
  serializeBaseline,
} from "./doctor-gate-baseline.js";
import { BASELINE_PATH, type BaselineSections } from "./doctor-gate-model.js";

const WORKSPACE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

const SEEDED = "seeded before the gate existed";

function sections(
  raw: Record<string, Record<string, { value: number; reason?: string }>>,
): BaselineSections {
  return new Map(
    Object.entries(raw).map(([name, entries]) => [
      name,
      new Map(
        Object.entries(entries).map(([key, entry]) => [
          key,
          { value: entry.value, reason: entry.reason },
        ]),
      ),
    ]),
  );
}

describe("the baseline the gate writes", () => {
  it("is written deterministically", () => {
    const text = serializeBaseline({
      countedLines: "non-blank, non-comment",
      exempt: ["**/dist/**", "**/*.generated.ts"],
      ceilings: sections({
        testFileLines: { "z.test.ts": { value: 610, reason: SEEDED } },
        fileLines: {
          "src/z.ts": { value: 500, reason: SEEDED },
          "src/a.ts": { value: 700, reason: SEEDED },
        },
      }),
      floors: sections({
        soundnessCases: { cases: { value: 21, reason: SEEDED } },
      }),
    });

    expect(text).toBe(serializeBaseline(parseGateBaseline(text)));
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "ceilings": {');
    expect(text.indexOf('"fileLines"')).toBeLessThan(
      text.indexOf('"testFileLines"'),
    );
    expect(text.indexOf('"src/a.ts"')).toBeLessThan(text.indexOf('"src/z.ts"'));
    expect(text.indexOf('"mark": 700')).toBeLessThan(text.indexOf('"reason"'));
    expect(parseGateBaseline(text).exempt).toStrictEqual([
      "**/*.generated.ts",
      "**/dist/**",
    ]);
  });

  it("is shaped the way Prettier would shape it", () => {
    // `format:check` runs over the baseline, so a writer that disagreed with
    // the formatter would leave the tree dirty after every `--update`.
    // Prettier collapses an array that fits the print width and an empty
    // object, and keeps an object broken once its first key is on its own line.
    const empty = {
      countedLines: "counted",
      ceilings: new Map(),
      floors: new Map(),
    };
    const short = serializeBaseline({ ...empty, exempt: ["b/**", "a/**"] });
    const long = serializeBaseline({
      ...empty,
      exempt: [`${"a".repeat(70)}/**`, "b/**"],
    });

    expect(short).toContain('\n  "exempt": ["a/**", "b/**"],\n');
    expect(short.endsWith('\n  "ceilings": {},\n  "floors": {}\n}\n')).toBe(
      true,
    );
    expect(long).toContain('\n  "exempt": [\n    "aaa');
    expect(long).toBe(serializeBaseline(parseGateBaseline(long)));
  });

  it("reproduces this repository's own baseline byte for byte", () => {
    const recorded = readFileSync(join(WORKSPACE_ROOT, BASELINE_PATH), "utf8");

    expect(serializeBaseline(parseGateBaseline(recorded))).toBe(recorded);
  });

  it("keeps the key a floor's count moved to, written before the reason", () => {
    const moved = "23 tests moved to @scope/to on 2026-09-07";
    const floors: BaselineSections = new Map([
      [
        "testCount",
        new Map([
          ["@scope/from", { value: 4, reason: moved, movedTo: "@scope/to" }],
          ["@scope/to", { value: 27, reason: SEEDED }],
        ]),
      ],
    ]);
    const text = serializeBaseline({
      countedLines: "non-blank, non-comment",
      exempt: [],
      ceilings: new Map(),
      floors,
    });

    expect(text.indexOf('"floor": 4')).toBeLessThan(text.indexOf('"movedTo"'));
    expect(text.indexOf('"movedTo": "@scope/to"')).toBeLessThan(
      text.indexOf(`"reason": ${JSON.stringify(moved)}`),
    );
    expect(serializeBaseline(parseGateBaseline(text))).toBe(text);
    expect(
      parseGateBaseline(text).floors.get("testCount")?.get("@scope/from"),
    ).toStrictEqual({ value: 4, reason: moved, movedTo: "@scope/to" });
  });

  it("refuses a movedTo that names nothing, and one on a ceiling", () => {
    expect(() =>
      parseGateBaseline(
        '{"ceilings":{},"floors":{"testCount":{"a":{"floor":4,"movedTo":7}}}}',
      ),
    ).toThrow(/testCount a: movedTo must name another key in this section/);
    expect(() =>
      parseGateBaseline(
        '{"ceilings":{"fileLines":{"src/a.ts":{"mark":420,"movedTo":"src/b.ts"}}},"floors":{}}',
      ),
    ).toThrow(/fileLines src\/a\.ts: movedTo belongs to a floor entry/);
  });

  it("reads an entry with no reason rather than dropping it", () => {
    const parsed = parseGateBaseline(
      '{"ceilings":{"fileLines":{"src/a.ts":{"mark":420}}},"floors":{}}',
    );

    expect(parsed.ceilings.get("fileLines")?.get("src/a.ts")).toStrictEqual({
      value: 420,
      reason: undefined,
    });
  });
});

describe("what a baseline exempts", () => {
  it("matches ** across separators, * inside one, and nothing else", () => {
    expect(
      matchesExemptGlob(
        "packages/a/src/schema.generated.ts",
        "**/*.generated.ts",
      ),
    ).toBe(true);
    expect(matchesExemptGlob("schema.generated.ts", "**/*.generated.ts")).toBe(
      true,
    );
    expect(matchesExemptGlob("packages/a/dist/index.js", "**/dist/**")).toBe(
      true,
    );
    expect(matchesExemptGlob("packages/a/src/index.ts", "**/dist/**")).toBe(
      false,
    );
    expect(
      matchesExemptGlob(
        "packages/a/src/legacy/one.ts",
        "packages/a/src/legacy/**",
      ),
    ).toBe(true);
    expect(matchesExemptGlob("packages/a/b/one.ts", "packages/*/one.ts")).toBe(
      false,
    );
  });
});
