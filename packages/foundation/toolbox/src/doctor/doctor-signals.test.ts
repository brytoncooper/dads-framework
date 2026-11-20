/**
 * The registry, which is six lane modules concatenated.
 *
 * Each lane owns its own file, so the two things a lane can break without
 * touching another one are checked here: an id a second lane already used, and
 * an issue heading that does not exist. The third check is the gate's: the
 * baseline section a signal is judged under is its measure name or its id, and
 * two signals sharing one section would judge each other's exceptions.
 */

import { describe, expect, it } from "vitest";
import { baselineSectionOf } from "./doctor-gate.js";
import { DOCTOR_SIGNALS } from "./doctor-signals.js";
import { DADDY_ISSUES } from "./issues.js";

function duplicates(names: readonly string[]): readonly string[] {
  return names.filter((name, index) => names.indexOf(name) !== index);
}

describe("the concatenated signal registry", () => {
  it("carries each id once, so no lane can shadow another lane's signal", () => {
    expect(duplicates(DOCTOR_SIGNALS.map((signal) => signal.id))).toStrictEqual(
      [],
    );
  });

  it("reports every signal under an issue the catalog declares", () => {
    const known = new Set(DADDY_ISSUES.map((issue) => issue.id));
    const unknown = DOCTOR_SIGNALS.flatMap((signal) =>
      [signal.issue, ...(signal.alsoUnder ?? [])]
        .filter((issue) => !known.has(issue))
        .map((issue) => `${signal.id}: ${issue}`),
    );

    expect(unknown).toStrictEqual([]);
  });

  it("gives each signal its own baseline section", () => {
    expect(duplicates(DOCTOR_SIGNALS.map(baselineSectionOf))).toStrictEqual([]);
  });

  it("keeps the sixteen section names the source-budget measures wrote", () => {
    const named = DOCTOR_SIGNALS.flatMap((signal) =>
      signal.measure === undefined ? [] : [signal.measure],
    ).sort();

    expect(named).toStrictEqual([
      "barrelImpurity",
      "clippyAllows",
      "docsConformancePackages",
      "doctorCases",
      "duplicatedHelpers",
      "eslintDisables",
      "fileLines",
      "invariantsFiles",
      "kindMatrixViolations",
      "lintRules",
      "rustInlineTests",
      "soundnessCases",
      "testCount",
      "testFileLines",
      "tsExpectErrorOutsideTypeTests",
      "typeTestNegativeCases",
    ]);
  });
});
