/**
 * What `dad doctor` accepts, what it refuses, and what it never reads.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  diagnoseRepository,
  parseDoctorArguments,
} from "./cli-doctor-commands.js";
import { createDoctorContext } from "./doctor/doctor-context.js";
import { renderDoctorReport } from "./doctor/doctor-report.js";
import { DADDY_ISSUES, findDaddyIssue } from "./doctor/issues.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "dad-doctor-cli-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "value.ts"), "export const value = 1;\n");
  return root;
}

describe("dad doctor arguments", () => {
  it("asks for the report unless a gate flag says otherwise", () => {
    expect(parseDoctorArguments([]).gate).toBeUndefined();
    expect(
      parseDoctorArguments(["--today", "2026-09-07"]).gate,
    ).toBeUndefined();
    expect(parseDoctorArguments(["--gate"]).gate?.update).toBe(false);
    expect(parseDoctorArguments(["--report", "--json"]).gate).toMatchObject({
      report: true,
      json: true,
    });
    expect(
      parseDoctorArguments(["--file", "src/a.ts", "--file", "./--draft b.ts"])
        .gate?.files,
    ).toStrictEqual(["src/a.ts", "--draft b.ts"]);
    expect(parseDoctorArguments(["--base", "origin/main"]).gate?.base).toBe(
      "origin/main",
    );
  });

  it("refuses the mode combinations that would mean two things at once", () => {
    const refusals: readonly (readonly [readonly string[], string])[] = [
      [
        ["--seed", "--update", "--today", "2026-09-07"],
        "--seed and --update are exclusive.",
      ],
      [
        ["--base", "origin/main", "--update"],
        "--base only reads; it cannot be combined with --update or --seed.",
      ],
      [
        ["--file", "src/a.ts", "--base", "origin/main"],
        "--file cannot be combined with --base or --seed.",
      ],
      [["--seed"], "--seed needs --today YYYY-MM-DD."],
      [
        ["--reason", "why"],
        "--reason records a seeded entry; it needs --seed.",
      ],
      [
        ["--update", "--key", "src/a.ts"],
        "--key names the one key --seed records; it needs --seed.",
      ],
      [
        ["explain", "enmeshment", "--gate"],
        "doctor explain reports; it cannot be a gate.",
      ],
    ];

    for (const [commandArguments, refusal] of refusals) {
      expect(() => parseDoctorArguments([...commandArguments])).toThrow(
        refusal,
      );
    }
  });

  it("records a seeded entry with the reason and the date it was given", () => {
    const parsed = parseDoctorArguments([
      "--seed",
      "--today",
      "2026-09-07",
      "--reason",
      "fastify has no second provider",
      "--key",
      "@fixture/http-adapter",
    ]);

    expect(parsed.gate).toMatchObject({
      seed: true,
      today: "2026-09-07",
      reason: "fastify has no second provider",
      key: "@fixture/http-adapter",
    });
  });

  it("carries --online on the arguments and leaves it off by default", () => {
    expect(parseDoctorArguments(["--online"]).online).toBe(true);
    expect(parseDoctorArguments([]).online).toBe(false);
  });

  it("refuses an option it does not know", () => {
    expect(() => parseDoctorArguments(["--verbose"])).toThrow(
      "Unknown option --verbose.",
    );
  });

  it("refuses a profile that is neither standard nor strict", () => {
    expect(() => parseDoctorArguments(["--profile", "relaxed"])).toThrow(
      "--profile must be standard or strict.",
    );
  });

  it("refuses an issue id no daddy issue carries", () => {
    expect(() => parseDoctorArguments(["--issue", "abandonment"])).toThrow(
      "No daddy issue is named abandonment.",
    );
  });

  it("refuses a date that is not written YYYY-MM-DD", () => {
    expect(() => parseDoctorArguments(["--today", "yesterday"])).toThrow(
      "--today must be a date written YYYY-MM-DD.",
    );
  });

  it("refuses a second path", () => {
    expect(() => parseDoctorArguments(["one", "two"])).toThrow(
      "doctor takes at most one path.",
    );
  });

  it("narrows to every --issue it was given, in the order DAD.md raises them", () => {
    const parsed = parseDoctorArguments([
      "--issue",
      "gaslighting",
      "--issue",
      "enmeshment",
    ]);

    expect(parsed.issues.map((issue) => issue.id)).toStrictEqual([
      "enmeshment",
      "gaslighting",
    ]);
  });

  it("reports every issue when none was named", () => {
    expect(parseDoctorArguments([]).issues).toHaveLength(DADDY_ISSUES.length);
  });

  it("reads the explain subcommand and its issue id", () => {
    expect(parseDoctorArguments(["explain", "the-paper-wall"]).explain).toBe(
      "the-paper-wall",
    );
    expect(() => parseDoctorArguments(["explain"])).toThrow(
      "doctor explain requires an issue id.",
    );
  });
});

describe("dad doctor over a repository", () => {
  it("reads no clock, so two runs over one tree print the same bytes", async () => {
    const root = temporaryRepository();
    try {
      const context = createDoctorContext({ root, today: undefined });
      expect(context.today).toBeUndefined();

      const options = {
        root,
        profile: "standard" as const,
        today: undefined,
        issues: DADDY_ISSUES,
      };
      const first = renderDoctorReport(await diagnoseRepository(options));
      const second = renderDoctorReport(await diagnoseRepository(options));
      expect(first).toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to guess a TypeScript program a workspace never declared", () => {
    const root = temporaryRepository();
    try {
      const context = createDoctorContext({ root, today: undefined });
      expect(() => context.program()).toThrow(
        "no tsconfig.json in this workspace",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a signal cross-listed under the issue it was given", async () => {
    const root = temporaryRepository();
    try {
      const issue = findDaddyIssue("the-paper-wall");
      if (issue === undefined) throw new Error("the-paper-wall is missing.");
      const report = await diagnoseRepository({
        root,
        profile: "standard",
        today: "2026-09-06",
        issues: [issue],
      });

      expect(report.issues[0]?.signals.map((signal) => signal.id)).toContain(
        "single-implementer-abstractions",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports without failing, and narrows to the issue it was given", async () => {
    const root = temporaryRepository();
    try {
      const issue = findDaddyIssue("enmeshment");
      if (issue === undefined) throw new Error("enmeshment is missing.");
      const report = await diagnoseRepository({
        root,
        profile: "standard",
        today: "2026-09-06",
        issues: [issue],
      });

      expect(report.issues).toHaveLength(1);
      expect(report.issues[0]?.verdict).toBe("absent");
      expect(report.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exits zero from the installed executable and one on a refused flag", () => {
    const root = temporaryRepository();
    try {
      const executable = join(PACKAGE_ROOT, "bin", "dad.js");
      const reported = spawnSync(
        process.execPath,
        [executable, "doctor", root, "--issue", "enmeshment"],
        { cwd: root, encoding: "utf8" },
      );
      expect(reported.status).toBe(0);
      expect(reported.stdout).toContain("Enmeshment");

      // Narrowed to an issue with no online signal, so nothing reaches the network.
      const online = spawnSync(
        process.execPath,
        [executable, "doctor", root, "--online", "--issue", "enmeshment"],
        { cwd: root, encoding: "utf8" },
      );
      expect(online.status).toBe(0);
      expect(online.stdout).toContain("Enmeshment");

      const gated = spawnSync(
        process.execPath,
        [executable, "doctor", root, "--gate", "--issue", "enmeshment"],
        { cwd: root, encoding: "utf8" },
      );
      expect(gated.status).toBe(0);
      expect(gated.stdout).toContain("source budgets: 0 listed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
