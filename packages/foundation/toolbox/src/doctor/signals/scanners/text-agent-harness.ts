/**
 * What a repository has told its automated contributors, and what runs when
 * they edit.
 *
 * Four readings under "you let the babysitter raise them" and "Dad has issues
 * too" share three facts: whether there is an entrypoint at the root, which
 * harness configurations exist, and which programs those configurations run.
 * All three are answered from named paths rather than from the file list,
 * because every harness hides its configuration in a dot directory and the
 * file list a walk produces does not descend into one.
 *
 * `isWorkingRepository` is the gate on the entrypoint reading. A directory
 * with three files in it is a specimen, not a repository somebody contributes
 * to, and asking it for house rules would make every small tree in the world
 * read as a finding. A root manifest — any ecosystem's — is the cheapest
 * honest evidence that somebody works here.
 */

import { isRecord, isString } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";

/** Root files that count as an entrypoint an automated contributor reads. */
export const AGENT_ENTRYPOINTS = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "GEMINI.md", ".cursorrules"];

/** Where each harness keeps the hooks it runs around a tool call. */
export const HARNESS_CONFIGURATIONS = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".cursor/hooks.json",
  ".codex/hooks.json",
];

/** A root manifest, in any ecosystem, that says somebody works in this tree. */
export const ECOSYSTEM_MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
];

/** One program a harness configuration runs. */
export type WiredGuard = {
  readonly path: string;
  readonly command: string;
};

/** The entrypoint at the root, or `undefined` when there is none. */
export function agentEntrypointPath(context: DoctorContext): string | undefined {
  return AGENT_ENTRYPOINTS.find((path) => context.exists(path));
}

/** True when the root carries a manifest of some ecosystem. */
export function isWorkingRepository(context: DoctorContext): boolean {
  return ECOSYSTEM_MANIFESTS.some((path) => context.exists(path));
}

/** Every program the harness configurations run, with the file that wires it. */
export function wiredGuards(context: DoctorContext): readonly WiredGuard[] {
  return HARNESS_CONFIGURATIONS.filter((path) => context.exists(path)).flatMap((path) =>
    guardsInConfiguration(path, context.read(path)),
  );
}

function guardsInConfiguration(path: string, text: string): readonly WiredGuard[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return collectCommands(parsed).map((command) => ({ path, command }));
}

/**
 * Every `command` string anywhere in a configuration. The shape differs per
 * harness — an array of matchers here, a map of event names there — and none
 * of that is the question being asked, which is only whether a program runs.
 */
function collectCommands(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(collectCommands);
  if (!isRecord(value)) return [];
  const command: unknown = value["command"];
  const named = isString(command) && command.trim().length > 0 ? [command] : [];
  return [...named, ...Object.values(value).flatMap(collectCommands)];
}

/** The repository-relative script a wired command runs, when it names one. */
export function guardScriptOf(command: string): string | undefined {
  const found = /(?:^|[\s"'])([\w./-]+\.(?:mjs|cjs|js|ts|sh|py))\b/.exec(command);
  return found?.[1];
}
