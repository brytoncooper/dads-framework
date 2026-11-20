/**
 * The read-only Git seam, first-parent history, and report dates.
 *
 * The first is a refusal: `dad doctor` reports, so the only git it may run is
 * git that cannot change the repository it is pointed at. A signal author who
 * needs a new command reaches for `runGit`, and the refusal has to be in the
 * module rather than in a review comment, because a review comment is not there
 * on the day somebody adds a checkout to a signal that "just needs to compare
 * two versions".
 *
 * The second is that dates are arithmetic on the day the report is about.
 * Nothing here reads a clock, so an age is a subtraction and the interesting
 * cases are the two edges: a commit dated after the day the report is about
 * cannot be a negative age, and a window's lower bound has to survive a month
 * boundary.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentWithoutGitVariables } from "../../../verification/git-environment.js";
import { createDoctorContext } from "../../doctor-context.js";
import { marksRaisedInHistorySignal } from "../gaslighting/marks-raised-in-history.js";
import {
  daysBefore,
  isAfter,
  isGitWorkspace,
  isReadOnlyGitSubcommand,
  readCommitLog,
  runGit,
  shiftDays,
  shortSha,
} from "./git-history.js";
import { BASELINE_PATH } from "./ratchet-baseline-history.js";

const WRITING = ["init", "commit", "checkout", "push", "add", "reset"];
const READING = ["blame", "log", "rev-parse", "show"];

describe("the git the doctor is allowed to run", () => {
  it("refuses every subcommand that could change a repository", () => {
    for (const subcommand of WRITING) {
      expect(isReadOnlyGitSubcommand(subcommand, [])).toBe(false);
      expect(() => runGit(tmpdir(), subcommand, [])).toThrow(
        `git ${subcommand} is refused`,
      );
    }
  });

  it("allows config only to read a value, never to set one", () => {
    expect(isReadOnlyGitSubcommand("config", ["--get", "core.hooksPath"])).toBe(
      true,
    );
    expect(
      isReadOnlyGitSubcommand("config", ["core.hooksPath", ".githooks"]),
    ).toBe(false);
    expect(() =>
      runGit(tmpdir(), "config", ["core.hooksPath", ".githooks"]),
    ).toThrow("git config is refused");
  });

  it("allows the subcommands the signals read history with", () => {
    for (const subcommand of READING) {
      expect(isReadOnlyGitSubcommand(subcommand, [])).toBe(true);
    }
  });

  it("does not call a directory that was never committed a repository", () => {
    const root = mkdtempSync(join(tmpdir(), "dad-doctor-not-a-repository-"));
    try {
      expect(isGitWorkspace(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ages measured against the day the report is about", () => {
  it("counts whole days from a commit to that day", () => {
    expect(daysBefore("2025-01-01T00:00:00Z", "2026-09-06")).toBe(613);
    expect(daysBefore("2026-09-05T23:00:00Z", "2026-09-06")).toBe(0);
  });

  it("never reports a commit made after that day as a negative age", () => {
    expect(daysBefore("2026-12-01T00:00:00Z", "2026-09-06")).toBe(0);
  });

  it("moves a window's lower bound across month boundaries", () => {
    expect(shiftDays("2026-09-06", -90)).toBe("2026-06-08");
    expect(shiftDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("compares two commit dates, and answers no when either is missing", () => {
    expect(isAfter("2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(true);
    expect(isAfter("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")).toBe(false);
    expect(isAfter(undefined, "2026-01-01T00:00:00Z")).toBe(false);
    expect(isAfter("2026-01-01T00:00:00Z", undefined)).toBe(false);
  });
});

function fixtureGit(root: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

function stageFloor(root: string, floor: number): void {
  const baseline = {
    floors: { docsConformancePackages: { packages: { floor } } },
  };
  writeFileSync(join(root, BASELINE_PATH), JSON.stringify(baseline));
  fixtureGit(root, ["add", BASELINE_PATH]);
}

it("judges the merge against its first parent and excludes side-branch marks", async () => {
  const root = mkdtempSync(join(tmpdir(), "dad-doctor-first-parent-"));
  try {
    fixtureGit(root, ["init", "--quiet", "-b", "main"]);
    fixtureGit(root, ["config", "user.name", "Dad Fixture"]);
    fixtureGit(root, ["config", "user.email", "fixture@dads.invalid"]);
    fixtureGit(root, ["config", "commit.gpgsign", "false"]);
    fixtureGit(root, ["config", "core.hooksPath", ""]);
    mkdirSync(join(root, ".agents"));
    stageFloor(root, 18);
    fixtureGit(root, ["commit", "-m", "initial floor"]);
    fixtureGit(root, ["switch", "-c", "side"]);
    stageFloor(root, 20);
    fixtureGit(root, ["commit", "-m", "older side-branch floor"]);
    fixtureGit(root, ["switch", "main"]);
    stageFloor(root, 24);
    fixtureGit(root, ["commit", "-m", "raise main floor"]);
    fixtureGit(root, ["merge", "--no-commit", "--no-ff", "-X", "ours", "side"]);
    stageFloor(root, 23);
    fixtureGit(root, ["commit", "-m", "merge side with a lower floor"]);

    const log = readCommitLog(root);
    expect(log.map((commit) => commit.message)).toStrictEqual([
      "merge side with a lower floor",
      "raise main floor",
      "initial floor",
    ]);
    expect(log[0]?.changes).toStrictEqual([
      { status: "M", path: BASELINE_PATH },
    ]);

    const merge = runGit(root, "rev-parse", ["HEAD"]).stdout.trim();
    const key = "floors/docsConformancePackages/packages";
    const readings = await marksRaisedInHistorySignal.run(
      createDoctorContext({ root }),
    );
    expect(readings.get(key)).toStrictEqual({
      value: 1,
      evidence: [
        { path: BASELINE_PATH, name: `${shortSha(merge)} ${key} 24 -> 23` },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
