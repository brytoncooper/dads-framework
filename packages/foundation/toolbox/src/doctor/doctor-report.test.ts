/**
 * The verdict rules and the shape of the report, held to the plan's example.
 */

import { describe, expect, it } from "vitest";
import { buildDoctorReport, renderDoctorJson, renderDoctorReport, renderIssueExplanation } from "./doctor-report.js";
import type { DoctorSignal, SignalReadings } from "./doctor-signal.js";
import type { SignalOutcome } from "./doctor-signals.js";
import { DADDY_ISSUES, findDaddyIssue } from "./issues.js";

const ENMESHMENT = DADDY_ISSUES.filter((issue) => issue.id === "enmeshment");

function signalNamed(id: string, overrides: Partial<DoctorSignal> = {}): DoctorSignal {
  return {
    id,
    issue: "enmeshment",
    question: "Does any source file exceed 400 counted lines?",
    reads: "text",
    unit: "lines",
    direction: "ceiling",
    thresholds: { standard: 400, strict: 400 },
    sentence: "Three thousand lines in one bed. You call it cohesion.",
    measure: "fileLines",
    run: () => Promise.resolve(new Map()),
    ...overrides,
  };
}

function outcomeOf(signal: DoctorSignal, readings: readonly (readonly [string, number])[]): SignalOutcome {
  const map: SignalReadings = new Map(readings.map(([key, value]) => [key, { value, evidence: [{ path: key }] }]));
  return { signal, readings: map, failure: undefined };
}

function reportOf(outcomes: readonly SignalOutcome[], strict = false) {
  return buildDoctorReport({
    root: "/repo",
    profile: strict ? "strict" : "standard",
    today: undefined,
    outcomes,
    issues: ENMESHMENT,
  });
}

describe("the doctor report", () => {
  it("calls an issue present when a thresholded signal is over", () => {
    const report = reportOf([outcomeOf(signalNamed("files-over-ceiling"), [["big.ts", 401]])]);

    expect(report.issues[0]?.verdict).toBe("present");
    expect(report.issues[0]?.signals[0]?.state).toBe("over");
  });

  it("calls an issue partial when a signal strict judges saw something", () => {
    const heldInStrict = signalNamed("copied-types", {
      thresholds: { standard: null, strict: 0 },
      unit: "count",
    });
    const report = reportOf([outcomeOf(heldInStrict, [["Money", 2]])]);

    expect(report.issues[0]?.verdict).toBe("partial");
    expect(report.issues[0]?.signals[0]?.state).toBe("report");
  });

  it("keeps a signal no profile judges out of the verdict, because it is information", () => {
    const information = signalNamed("blast-radius", {
      thresholds: { standard: null, strict: null },
      unit: "count",
    });
    const report = reportOf([outcomeOf(information, [["http", 23]])]);

    expect(report.issues[0]?.verdict).toBe("absent");
    expect(report.issues[0]?.signals[0]?.state).toBe("report");
    expect(report.issues[0]?.signals[0]?.judgedInStrict).toBe(false);
  });

  it("keeps a floor out of the verdict, because its judge is the baseline", () => {
    const floor = signalNamed("test-count", {
      direction: "floor",
      thresholds: { standard: null, strict: null },
      unit: "count",
    });
    const report = reportOf([outcomeOf(floor, [["@fixture/one", 640]])]);

    expect(report.issues[0]?.verdict).toBe("absent");
    expect(report.issues[0]?.signals[0]?.state).toBe("report");
  });

  it("calls an issue absent when every thresholded signal is under", () => {
    const report = reportOf([outcomeOf(signalNamed("files-over-ceiling"), [["small.ts", 12]])]);

    expect(report.issues[0]?.verdict).toBe("absent");
    expect(report.issues[0]?.signals[0]?.state).toBe("ok");
  });

  it("reports a cross-listed signal under every issue it evidences, measured once", () => {
    const both = DADDY_ISSUES.filter((issue) => issue.id === "enmeshment" || issue.id === "anxious-attachment");
    const outcome = outcomeOf(signalNamed("copied-types", { alsoUnder: ["anxious-attachment"] }), [["copied.ts", 401]]);
    const report = buildDoctorReport({
      root: "/repo",
      profile: "standard",
      today: undefined,
      outcomes: [outcome],
      issues: both,
    });

    const under = report.issues.filter((issue) => issue.signals.some((signal) => signal.id === "copied-types"));
    expect(under.map((issue) => issue.id)).toEqual(["anxious-attachment", "enmeshment"]);
    expect(under.every((issue) => issue.verdict === "present")).toBe(true);
    expect(under[0]?.signals[0]?.readings).toEqual(under[1]?.signals[0]?.readings);
  });

  it("says a signal was not measured rather than reporting it at zero", () => {
    const report = reportOf([
      {
        signal: signalNamed("test-count"),
        readings: new Map(),
        failure: "no report",
      },
    ]);

    expect(report.issues[0]?.signals[0]?.state).toBe("not measured");
    expect(report.issues[0]?.verdict).toBe("absent");
  });

  it("says a signal that ran and found nothing saw nothing, not that it did not run", () => {
    const report = reportOf([
      outcomeOf(signalNamed("files-over-ceiling"), []),
      outcomeOf(
        signalNamed("blast-radius", {
          thresholds: { standard: null, strict: null },
          unit: "count",
        }),
        [],
      ),
    ]);
    const text = renderDoctorReport(report);

    expect(report.issues[0]?.signals.map((signal) => signal.state)).toEqual(["ok", "report"]);
    expect(text).toContain("files-over-ceiling                0 seen");
    expect(text).toContain("blast-radius                      0 seen");
    expect(text).not.toContain("no reading");
  });

  it("keeps the longest signal name a column of its own", () => {
    const text = renderDoctorReport(
      reportOf([outcomeOf(signalNamed("single-implementer-abstractions"), [["Clock", 1]])]),
    );

    expect(text).toContain("single-implementer-abstractions   0 of 1 over");
  });

  it("prints the number, the threshold, where it came from, and the state", () => {
    const text = renderDoctorReport(
      reportOf([
        outcomeOf(signalNamed("files-over-ceiling"), [
          ["big.ts", 401],
          ["small.ts", 12],
        ]),
      ]),
    );

    expect(text).toContain("Enmeshment");
    expect(text).toContain("present");
    expect(text).toContain("files-over-ceiling");
    expect(text).toContain("1 of 2 over");
    expect(text).toContain("(Dad: 400 lines)");
    expect(text).toContain("over");
  });

  it("names the strict profile on a threshold the strict profile tightened", () => {
    const tightened = signalNamed("duplicated-helpers", {
      thresholds: { standard: 1, strict: 0 },
      unit: "count",
    });
    const text = renderDoctorReport(reportOf([outcomeOf(tightened, [])], true));

    expect(text).toContain("(Dad: 0; strict)");
  });

  it("prints the sentence from the essay after the signals", () => {
    const text = renderDoctorReport(reportOf([]));

    expect(text).toContain("no signal reads this issue yet");
    expect(text).toContain("Dad’s answer is not a bigger house.");
  });

  it("carries the evidence for every reading it reports", () => {
    const line = renderDoctorJson(reportOf([outcomeOf(signalNamed("files-over-ceiling"), [["big.ts", 401]])]));
    const parsed: unknown = JSON.parse(line);

    expect(parsed).toMatchObject({
      ok: true,
      profile: "standard",
      issues: [
        {
          id: "enmeshment",
          verdict: "present",
          signals: [
            {
              id: "files-over-ceiling",
              readings: [{ key: "big.ts", value: 401, evidence: [{ path: "big.ts" }] }],
            },
          ],
        },
      ],
    });
  });

  it("explains an issue with its test, its signals, and its cure", () => {
    const issue = findDaddyIssue("enmeshment");
    if (issue === undefined) throw new Error("enmeshment is missing.");
    const text = renderIssueExplanation(issue, [signalNamed("files-over-ceiling")], "standard");

    expect(text).toContain("Essay: DAD.md#enmeshment");
    expect(text).toContain("Companion: docs/daddy-issues.md#enmeshment");
    expect(text).toContain("files-over-ceiling");
    expect(text).toContain("One responsibility per file");
  });
});

describe("the daddy issue catalog", () => {
  it("quotes seventeen issues in the order DAD.md raises them", () => {
    expect(DADDY_ISSUES.map((issue) => issue.id)).toStrictEqual([
      "daddy-issues",
      "anxious-attachment",
      "avoidant-attachment",
      "disorganized-attachment",
      "enmeshment",
      "you-are-looking-for-a-father-figure",
      "you-repeat-the-cycle",
      "you-let-the-babysitter-raise-them",
      "people-pleasing",
      "you-stay-with-people-who-cannot-meet-you",
      "commitment-issues",
      "gaslighting",
      "the-silent-treatment",
      "failure-to-launch",
      "its-not-you-its-my-boundaries",
      "the-paper-wall",
      "dad-has-issues-too",
    ]);
  });

  it("gives every issue a sentence, a cure, and a numbered test", () => {
    for (const issue of DADDY_ISSUES) {
      expect({
        id: issue.id,
        anchor: issue.anchor,
        hasSentence: issue.sentence.length > 0,
        hasCure: issue.cure.length > 0,
        hasQuestions: issue.questions.length > 0,
      }).toStrictEqual({
        id: issue.id,
        anchor: `#${issue.id}`,
        hasSentence: true,
        hasCure: true,
        hasQuestions: true,
      });
    }
  });
});
