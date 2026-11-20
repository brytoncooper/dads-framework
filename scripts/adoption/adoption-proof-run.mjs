/**
 * The scaffolding an adoption proof needs before it can prove anything: a
 * throwaway workspace, a phase timer, and the context every task reads.
 *
 * The workspace is created fresh and removed at the end of every run. Nothing
 * survives a run on purpose: the proofs are only worth their name if the pack,
 * the install, the import and the program all happen again.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { createPhaseTimer } from "./adoption-phase-timing.mjs";

export function createAdoptionWorkspace(prefix) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), prefix));
  const tarballRoot = join(temporaryRoot, "tarballs");
  mkdirSync(tarballRoot);
  return {
    temporaryRoot,
    tarballRoot,
    subdirectory(name) {
      const directory = join(temporaryRoot, name);
      mkdirSync(directory);
      return directory;
    },
    dispose() {
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

/**
 * A proof context is everything a task needs and nothing it can change: the
 * repository root, its own scratch directory, the loaded packages, the tarball
 * map that packing fills in, and the timer it records its phases against.
 */
export function createProofContext({ root, workRoot, packages, timer }) {
  return Object.freeze({
    root,
    workRoot,
    packages,
    tarballs: new Map(),
    time: (phase, run) => timer.time(phase, run),
  });
}

export { createPhaseTimer };

export function writePhaseTable(label, timer) {
  process.stderr.write(`${timer.formatTable(`${label} phases`)}\n`);
}

export function writeReceipt(receipt) {
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

export function reportFatal(error) {
  process.exitCode = 1;
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
}
