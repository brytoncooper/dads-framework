import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { AdoptionCommandError, createTaskTranscript, formatFailure, formatTranscript } from "./adoption-commands.mjs";

const SPEAK_AND_FAIL = ["-e", 'process.stdout.write("out\\n");process.stderr.write("err\\n");process.exit(3);'];

test("captures a command's output instead of streaming it", async () => {
  const transcript = createTaskTranscript("fixture");

  const entry = await transcript.run(process.execPath, ["-e", 'process.stdout.write("hello\\n")']);

  assert.equal(entry.status, 0);
  assert.equal(entry.stdout, "hello\n");
  assert.equal(transcript.entries.length, 1);
});

test("throws with the whole failing command attached", async () => {
  const transcript = createTaskTranscript("fixture");

  const error = await transcript.run(process.execPath, SPEAK_AND_FAIL, { cwd: process.cwd() }).then(
    () => null,
    (thrown) => thrown,
  );

  assert.ok(error instanceof AdoptionCommandError);
  assert.equal(error.entry.status, 3);
  assert.match(error.message, /status 3/);
  const report = formatFailure("fixture", error, transcript);
  assert.match(report, /FAILED fixture/);
  assert.match(report, /transcript:/);
  assert.match(report, /out/);
  assert.match(report, /err/);
  assert.match(report, /exit: status 3/);
});

test("an attempted command records its failure without throwing", async () => {
  const transcript = createTaskTranscript("fixture");

  const entry = await transcript.attempt(process.execPath, SPEAK_AND_FAIL);

  assert.equal(entry.status, 3);
  assert.equal(entry.stderr, "err\n");
});

test("reports a failure that was never a command", () => {
  const report = formatFailure("fixture", new Error("declarations changed"));

  assert.match(report, /FAILED fixture/);
  assert.match(report, /error:/);
  assert.match(report, /declarations changed/);
});

test("renders a transcript in the order the commands ran", async () => {
  const transcript = createTaskTranscript("fixture");
  transcript.note("nothing to import");
  await transcript.run(process.execPath, ["-e", 'process.stdout.write("second\\n")']);

  assert.match(formatTranscript(transcript), /# nothing to import\n\$ .*\n {2}second/);
});

test("refuses a command that is not an executable and an argument list", async () => {
  const transcript = createTaskTranscript("fixture");

  await assert.rejects(() => transcript.run(process.execPath), /argument array/);
});
