/**
 * The hooks the repository points git at: ceiling 0.
 *
 * A boundary that only runs in CI is a boundary a change meets after it has
 * already been written, reviewed, and argued about. `core.hooksPath` is the one
 * setting that decides whether the same gate meets a change at commit and at
 * push, and it is a setting rather than a file, so a repository can carry a
 * perfectly good `.githooks/` directory and still have nothing wired to it.
 *
 * Two ways to fail, one number. The path is unset, so nothing runs; or the path
 * is set and names a directory the repository does not carry, so nothing runs
 * and the configuration says otherwise, which is worse. The hooks are counted
 * as tracked files: an untracked hook is one machine's private habit, and the
 * question is what the repository does for everybody who clones it.
 *
 * Executability is deliberately not checked. It is not portable, and a hook
 * that exists and is not executable is a different conversation from a hook
 * nobody wired at all.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DoctorContext } from "../../doctor-context.js";
import type { DoctorSignal, SignalReadings } from "../../doctor-signal.js";
import { gitConfigValue, requireGitWorkspace, runGit } from "../scanners/git-history.js";

const HOOKS_PATH_SETTING = "core.hooksPath";
const GIT_CONFIG = ".git/config";

function findEnclosingHooks(root: string, configured: string): readonly string[] {
  const shown = runGit(root, "rev-parse", ["--show-toplevel"]);
  if (shown.status !== 0) return [];
  const topLevel = shown.stdout.trim();
  if (topLevel.length === 0) return [];
  const hooksDir = resolve(topLevel, configured);
  try {
    return readdirSync(hooksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${configured.replace(/\/$/, "")}/${entry.name}`);
  } catch {
    return [];
  }
}

function readHooksWiring(context: DoctorContext): SignalReadings {
  requireGitWorkspace(context.root);
  const configured = gitConfigValue(context.root, HOOKS_PATH_SETTING);
  if (configured === undefined) {
    return new Map([
      [
        HOOKS_PATH_SETTING,
        {
          value: 1,
          evidence: [{ path: GIT_CONFIG, name: HOOKS_PATH_SETTING }],
        },
      ],
    ]);
  }
  const prefix = `${configured.replace(/\/$/, "")}/`;
  const localHooks = context.files().filter((path) => path.startsWith(prefix));
  const hooks = localHooks.length > 0 ? localHooks : findEnclosingHooks(context.root, configured);
  return new Map([
    [
      HOOKS_PATH_SETTING,
      {
        value: hooks.length === 0 ? 1 : 0,
        evidence:
          hooks.length === 0 ? [{ path: configured, name: HOOKS_PATH_SETTING }] : hooks.map((path) => ({ path })),
      },
    ],
  ]);
}

export const hooksNotWiredSignal: DoctorSignal = {
  id: "hooks-not-wired",
  issue: "its-not-you-its-my-boundaries",
  question: "Is `core.hooksPath` unset, or are the hooks it names missing?",
  reads: "git",
  unit: "count",
  direction: "ceiling",
  thresholds: { standard: 0, strict: 0 },
  sentence: "Someone has to mean no before production does.",
  run: (context) => Promise.resolve(readHooksWiring(context)),
};
