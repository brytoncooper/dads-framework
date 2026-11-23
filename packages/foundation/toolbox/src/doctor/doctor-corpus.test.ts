/**
 * The fixture corpus: one tiny repository per signal, and nothing else tripped.
 *
 * Each case is a directory `fixtures/daddy-issues/<signal-id>/` holding a
 * `fixture.json`. The manifest is the repository: a map from path to contents,
 * the recorded output of any command the signal shells out to, and the exact
 * reading the signal must produce. The case is written down rather than checked
 * in as a file tree because several of these repositories are deliberate
 * specimens — a suppression comment, a 401-line file, an inline Rust test
 * module — and a specimen sitting in this repository's own source tree would be
 * measured as this repository's source.
 *
 * Cases are found by listing the corpus rather than by reading an index, so a
 * lane adding a signal adds a directory and nothing anybody else is editing.
 * The directory name is the claim and the manifest's `signal` is the same claim
 * written twice: a manifest that names a different signal is refused here by
 * name rather than quietly counted under the directory it sits in.
 *
 * "Trips exactly that signal and nothing else" is asserted as: the case's own
 * signal reads exactly what the manifest expects and is over its ceiling or
 * above zero on its floor, while every other ceiling has nothing over it and
 * every other floor counts nothing at all.
 *
 * A manifest may also declare a `history`: the commits that produced the tree,
 * each with the files it wrote or deleted, its message, and its date. The
 * signals that read git cannot be specified by a file map at all — how old a
 * marker is, whether a ceiling was ever raised, what share of a quarter was
 * spent moving files — so those cases hand the materializer a history and it
 * replays it with a real `git init` and a real commit per entry, dating each
 * one through the environment so author and committer agree. A manifest with no
 * `history` is materialized exactly as it always was, into a directory that is
 * not a repository, and every git signal reports that it was not measured.
 *
 * A history entry may say `"base": true`, which points `origin/main` at the
 * commit it makes: the line the migration signals judge a branch against, so a
 * case can show a draft fixed on a branch and an edit past the base apart.
 *
 * A manifest may also declare `responses`: the answers a registry or a forge
 * gave, one per URL. A case that declares them is run online against exactly
 * those answers and nothing else — a request for a URL the case never recorded
 * throws by name — which is how the three signals that read the network are
 * specified without a network. A manifest with no `responses` is run offline,
 * and those three report that they were not measured.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRecord, isString, isUnknownArray } from "../parse-guards.js";
import { environmentWithoutGitVariables } from "../verification/git-environment.js";
import { createDoctorContext, type DoctorFetch } from "./doctor-context.js";
import { thresholdFor, type DoctorSignal } from "./doctor-signal.js";
import { DOCTOR_SIGNALS, runDoctorSignals } from "./doctor-signals.js";

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "fixtures", "daddy-issues");

/** One commit a manifest declares: what it wrote, what it said, and when. */
type FixtureCommit = {
  readonly message: string;
  readonly date: string;
  /** Path to contents; `null` deletes the path that commit inherited. */
  readonly files: ReadonlyMap<string, string | null>;
  /** True when `origin/main` points here once the commit is made. */
  readonly base: boolean;
};

/** One recorded answer: the status a server gave, and the body it sent. */
type FixtureResponse = {
  readonly status: number;
  readonly body: string;
};

type FixtureCase = {
  readonly signal: string;
  readonly files: ReadonlyMap<string, string>;
  readonly commands: ReadonlyMap<string, string>;
  readonly history: readonly FixtureCommit[];
  readonly responses: ReadonlyMap<string, FixtureResponse>;
  /** The day the case is about, so an age in a fixture never moves. */
  readonly today: string;
  readonly expected: ReadonlyMap<string, number>;
};

const AUTHOR_NAME = "Dad Fixture";
const AUTHOR_EMAIL = "fixture@dads.invalid";
const HOOKS_DIRECTORY = ".githooks";
/** The day every case is read on, unless its manifest names another. */
const FIXTURE_TODAY = "2026-09-06";
const OK = 200;

/**
 * A case that declares a history builds a repository and every git signal then
 * spawns against it, so the corpus costs processes rather than file reads.
 */
const TIMEOUT = 300_000;

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed;
}

/** Every case in the corpus: its directories, in a stable order. */
function readCaseIds(): readonly string[] {
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readFileContents(value: unknown): string {
  if (isString(value)) return value;
  if (!isRecord(value)) throw new Error("A fixture file is not text.");
  const line: unknown = value["line"];
  const repeat: unknown = value["repeat"];
  if (!isString(line) || typeof repeat !== "number") {
    throw new Error("A repeated fixture file needs a line and a repeat count.");
  }
  return `${Array.from({ length: repeat }, () => line).join("\n")}\n`;
}

function readStringMap(value: unknown): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  if (!isRecord(value)) return entries;
  for (const [key, entry] of Object.entries(value)) {
    entries.set(key, readFileContents(entry));
  }
  return entries;
}

function readCommandMap(value: unknown): ReadonlyMap<string, string> {
  const commands = new Map<string, string>();
  if (!isRecord(value)) return commands;
  for (const [key, entry] of Object.entries(value)) {
    const stdout: unknown = isRecord(entry) ? entry["stdout"] : undefined;
    commands.set(key, isString(stdout) ? stdout : "");
  }
  return commands;
}

/**
 * The recorded answers, keyed by the URL that was asked. A body written as a
 * string is sent verbatim; anything else is the JSON document itself, which is
 * what keeps a recorded packument readable in the manifest.
 */
function readResponseMap(value: unknown): ReadonlyMap<string, FixtureResponse> {
  const responses = new Map<string, FixtureResponse>();
  if (!isRecord(value)) return responses;
  for (const [url, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const status: unknown = entry["status"];
    const body: unknown = entry["body"];
    responses.set(url, {
      status: typeof status === "number" ? status : OK,
      body: isString(body) ? body : JSON.stringify(body ?? null),
    });
  }
  return responses;
}

function readNumberMap(value: unknown): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  if (!isRecord(value)) return numbers;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number") numbers.set(key, entry);
  }
  return numbers;
}

function readFixtureCase(id: string): FixtureCase {
  const manifest = readJson(join(CORPUS, id, "fixture.json"));
  if (!isRecord(manifest)) throw new Error(`${id}: the manifest is not an object.`);
  const signal: unknown = manifest["signal"];
  if (!isString(signal)) throw new Error(`${id}: the manifest names no signal.`);
  if (signal !== id) {
    throw new Error(`${id}: the manifest names ${signal}, not the directory it sits in.`);
  }
  const today: unknown = manifest["today"];
  return {
    signal,
    files: readStringMap(manifest["files"]),
    commands: readCommandMap(manifest["commands"]),
    history: readHistory(manifest["history"]),
    responses: readResponseMap(manifest["responses"]),
    today: isString(today) ? today : FIXTURE_TODAY,
    expected: readNumberMap(manifest["expected"]),
  };
}

// ---------------------------------------------------------------------------
// The history a case declares
// ---------------------------------------------------------------------------

function readHistory(value: unknown): readonly FixtureCommit[] {
  if (!isUnknownArray(value)) return [];
  return value.map((entry) => readCommit(entry));
}

function readCommit(entry: unknown): FixtureCommit {
  if (!isRecord(entry)) throw new Error("A fixture commit is not an object.");
  const message: unknown = entry["message"];
  const date: unknown = entry["date"];
  if (!isString(message) || !isString(date)) {
    throw new Error("A fixture commit needs a message and a date.");
  }
  return {
    message,
    date,
    files: readCommitFiles(entry["files"]),
    base: entry["base"] === true,
  };
}

function readCommitFiles(value: unknown): ReadonlyMap<string, string | null> {
  const written = new Map<string, string | null>();
  if (!isRecord(value)) return written;
  for (const [path, entry] of Object.entries(value)) {
    written.set(path, entry === null ? null : readFileContents(entry));
  }
  return written;
}

// ---------------------------------------------------------------------------
// Materializing one case
// ---------------------------------------------------------------------------

function writeFixtureFile(root: string, path: string, contents: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents.split("{{root}}").join(root));
}

function materialize(testCase: FixtureCase): string {
  const root = mkdtempSync(join(tmpdir(), "dad-doctor-case-"));
  for (const [path, contents] of testCase.files) {
    writeFixtureFile(root, path, contents);
  }
  replayHistory(root, testCase.history);
  return root;
}

/**
 * Runs one git in the case's own directory. Every `GIT_` variable is removed
 * first: git exports `GIT_DIR` into the environment of the hooks it runs, and a
 * child that inherits it would commit these fixtures onto a real branch. The
 * two dates are then put back deliberately, so the commit a case declares is
 * dated the day it says and not the day the suite ran.
 */
function runFixtureGit(root: string, commandArguments: readonly string[], date?: string): void {
  const dates = date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const finished = spawnSync("git", [...commandArguments], {
    cwd: root,
    encoding: "utf8",
    env: { ...environmentWithoutGitVariables(), ...dates },
  });
  if (finished.status !== 0) {
    throw new Error(`git ${commandArguments.join(" ")} failed: ${finished.stderr}`);
  }
}

/**
 * `core.hooksPath` is wired when the case brought a hooks directory, the way
 * `npm run prepare` wires it in a real repository, and set to nothing when it
 * did not: a fixture that is not a specimen of an unwired repository should not
 * read as one, and a fixture that is must not inherit a hooks path from
 * whatever the machine running the suite happens to configure globally.
 */
function replayHistory(root: string, history: readonly FixtureCommit[]): void {
  if (history.length === 0) return;
  runFixtureGit(root, ["init", "--quiet", "-b", "main"]);
  runFixtureGit(root, ["config", "user.name", AUTHOR_NAME]);
  runFixtureGit(root, ["config", "user.email", AUTHOR_EMAIL]);
  runFixtureGit(root, ["config", "commit.gpgsign", "false"]);
  runFixtureGit(root, ["config", "core.excludesFile", "/dev/null"]);
  const wired = existsSync(join(root, HOOKS_DIRECTORY));
  runFixtureGit(root, ["config", "core.hooksPath", wired ? HOOKS_DIRECTORY : ""]);
  for (const commit of history) applyCommit(root, commit);
}

/** The tree a case carries is committed by its first entry, so all of it is tracked. */
function applyCommit(root: string, commit: FixtureCommit): void {
  for (const [path, contents] of commit.files) {
    if (contents === null) rmSync(join(root, path), { force: true });
    else writeFixtureFile(root, path, contents);
  }
  runFixtureGit(root, ["add", "--all", "."]);
  runFixtureGit(root, ["commit", "--quiet", "--allow-empty", "--message", commit.message], commit.date);
  if (commit.base) {
    runFixtureGit(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  }
}

/**
 * The only network a case has: exactly the answers its manifest recorded. A
 * request for anything else throws by name, so a signal that reaches for a URL
 * nobody wrote down cannot be handed an empty body and count a zero.
 */
function fixtureFetch(testCase: FixtureCase): DoctorFetch {
  return (url) => {
    const recorded = testCase.responses.get(url);
    if (recorded === undefined) {
      throw new Error(`${testCase.signal}: no recorded response for ${url}`);
    }
    return Promise.resolve({
      status: recorded.status,
      text: () => Promise.resolve(recorded.body),
    });
  };
}

/**
 * The signals as the report runs them, so a signal that says it could not
 * measure this case reads as nothing found rather than failing the suite. That
 * is the honest answer for the git readings over a case with no history: they
 * have nothing to read, which is exactly what "trips nothing here" means.
 */
async function readSignals(
  testCase: FixtureCase,
  root: string,
): Promise<ReadonlyMap<string, ReadonlyMap<string, number>>> {
  const context = createDoctorContext({
    root,
    today: testCase.today,
    exec: (command, commandArguments) => ({
      status: 0,
      stdout: testCase.commands.get([command, ...commandArguments].join(" ")) ?? "",
    }),
    online: testCase.responses.size > 0,
    fetch: fixtureFetch(testCase),
  });
  const readings = new Map<string, ReadonlyMap<string, number>>();
  for (const outcome of await runDoctorSignals(context, DOCTOR_SIGNALS)) {
    readings.set(outcome.signal.id, new Map([...outcome.readings].map(([key, one]) => [key, one.value])));
  }
  return readings;
}

function tripped(signal: DoctorSignal, readings: ReadonlyMap<string, number>): boolean {
  const values = [...readings.values()];
  if (signal.direction === "floor") {
    return values.reduce((sum, value) => sum + value, 0) > 0;
  }
  const threshold = thresholdFor(signal, "standard") ?? 0;
  return values.some((value) => value > threshold);
}

/** Author time, committer time, author, subject: one line per commit. */
function readReplayedLog(root: string): readonly string[] {
  const listed = spawnSync("git", ["log", "--reverse", "--format=%at %ct %an <%ae> %s"], {
    cwd: root,
    encoding: "utf8",
    env: environmentWithoutGitVariables(),
  });
  return listed.stdout.split("\n").filter((line) => line.length > 0);
}

function expectedLogLine(commit: FixtureCommit): string {
  const seconds = Math.floor(Date.parse(commit.date) / 1000);
  return `${seconds} ${seconds} ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${commit.message}`;
}

describe("the replayed fixture history", () => {
  it(
    "commits what each entry declares, dated the day it names",
    // Replays every fixture history, one repository per case.
    { timeout: TIMEOUT },
    () => {
      const cases = readCaseIds()
        .map((id) => readFixtureCase(id))
        .filter((testCase) => testCase.history.length > 0);
      expect(cases.length).toBeGreaterThan(0);
      for (const testCase of cases) {
        const root = materialize(testCase);
        try {
          expect({
            case: testCase.signal,
            log: readReplayedLog(root),
          }).toStrictEqual({
            case: testCase.signal,
            log: testCase.history.map((commit) => expectedLogLine(commit)),
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it("leaves a manifest with no history as a directory that is no repository", () => {
    const withoutHistory = readCaseIds()
      .map((id) => readFixtureCase(id))
      .find((testCase) => testCase.history.length === 0);
    expect(withoutHistory).toBeDefined();
    const root = materialize(
      withoutHistory ?? {
        signal: "",
        files: new Map(),
        commands: new Map(),
        history: [],
        responses: new Map(),
        today: FIXTURE_TODAY,
        expected: new Map(),
      },
    );
    try {
      expect(existsSync(join(root, ".git"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the daddy issues fixture corpus", () => {
  it("gives every signal a case, and every case a signal", () => {
    const named = readCaseIds().map((id) => readFixtureCase(id).signal);
    const signals = DOCTOR_SIGNALS.map((signal) => signal.id).sort();
    expect([...named].sort()).toStrictEqual(signals);
  });

  it("trips exactly the signal its case names, and no other", { timeout: TIMEOUT }, async () => {
    for (const id of readCaseIds()) {
      const testCase = readFixtureCase(id);
      const root = materialize(testCase);
      try {
        const readings = await readSignals(testCase, root);
        const own = readings.get(testCase.signal) ?? new Map<string, number>();
        expect({ case: id, readings: Object.fromEntries(own) }).toStrictEqual({
          case: id,
          readings: Object.fromEntries(testCase.expected),
        });
        for (const signal of DOCTOR_SIGNALS) {
          const measured = readings.get(signal.id) ?? new Map<string, number>();
          expect({
            case: id,
            signal: signal.id,
            tripped: tripped(signal, measured),
          }).toStrictEqual({
            case: id,
            signal: signal.id,
            tripped: signal.id === testCase.signal,
          });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
