/**
 * The only way a signal reaches the network, and everything it refuses to do.
 *
 * Three of the doctor's readings cannot be taken from the working tree at all:
 * when a dependency was last published, whether the default branch is
 * protected, how long the gate has been taking. Each of those lives on somebody
 * else's server, which makes them the only signals whose answer depends on
 * something outside the repository — so they are the only ones that have to say
 * what they refuse to do.
 *
 * They refuse four things. They do not reach out unless the run was told it
 * may, and a run that was not says so by name rather than reporting a zero it
 * never measured. They never retry, because a report that is a different report
 * on the second attempt is not a measurement. They only ever read: no request
 * carries a method, a body, or a credential, and the one command in this file
 * reads a configured value. And they never follow an instruction in a response:
 * every field a signal uses is named here by hand, and a body that says
 * anything else is text nobody acts on.
 *
 * A status other than 200 is a failure that names the status. It is never a
 * zero: "the registry answered 500" and "this dependency was published last
 * week" are different facts, and only one of them is evidence.
 */

import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import { NOT_MEASURED_OFFLINE, type DoctorContext } from "../../doctor-context.js";

const OK = 200;
const GIT = "git";
const ORIGIN_URL = ["config", "--get", "remote.origin.url"];
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** Where the last publish date of a package is read from. */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** Where the branch protection and the workflow runs are read from. */
export const GITHUB_API = "https://api.github.com";

/** The failure reported when the workspace names no `origin`. */
export const NO_ORIGIN_REMOTE = "no origin remote";

/** The failure reported when `origin` is somewhere this signal cannot ask. */
export const NOT_A_GITHUB_REMOTE = "origin is not a GitHub remote";

/**
 * Refused before the signal does any work, so an offline run costs nothing and
 * reads the same on every line: `not measured (offline)`.
 */
export function requireOnline(context: DoctorContext): void {
  if (!context.online) throw new Error(NOT_MEASURED_OFFLINE);
}

// ---------------------------------------------------------------------------
// Which repository this is
// ---------------------------------------------------------------------------

/** One repository on GitHub, as a remote names it. */
export type GitHubRepository = {
  readonly owner: string;
  readonly repository: string;
};

/** `https://github.com/owner/repo.git`, with or without a user in front. */
const WEB_REMOTE = /^https?:\/\/(?:[^@/]*@)?([^/]+)\/(.+)$/;
/** `git@github.com:owner/repo.git` and its `ssh://` spelling. */
const SECURE_SHELL_REMOTE = /^(?:ssh:\/\/)?[^@\s]*@([^:/]+)[:/](.+)$/;

/**
 * The repository a remote names, or `undefined` when it names none this signal
 * can ask about. A remote on another forge, or a directory on this machine, is
 * not a repository with no protection; it is a question GitHub cannot answer.
 */
export function parseRemoteUrl(url: string): GitHubRepository | undefined {
  const trimmed = url.trim();
  const matched = WEB_REMOTE.exec(trimmed) ?? SECURE_SHELL_REMOTE.exec(trimmed);
  if (matched === null) return undefined;
  if (!GITHUB_HOSTS.has(matched[1] ?? "")) return undefined;
  return parseRemotePath(matched[2] ?? "");
}

function parseRemotePath(path: string): GitHubRepository | undefined {
  const segments = path
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (segments.length !== 2) return undefined;
  const owner = segments[0] ?? "";
  const repository = segments[1] ?? "";
  if (owner.length === 0 || repository.length === 0) return undefined;
  return { owner, repository };
}

/**
 * The repository `origin` points at. Read through the context's command seam,
 * which is how a fixture hands a signal a remote without a checkout to clone,
 * and with the one argument list that only reads a configured value.
 */
export function requireOriginRepository(context: DoctorContext): GitHubRepository {
  const read = context.exec(GIT, ORIGIN_URL);
  const url = read.status === 0 ? read.stdout.trim() : "";
  if (url.length === 0) throw new Error(NO_ORIGIN_REMOTE);
  const named = parseRemoteUrl(url);
  if (named === undefined) throw new Error(NOT_A_GITHUB_REMOTE);
  return named;
}

/** The API path of one repository, which both GitHub signals start from. */
export function repositoryUrl(named: GitHubRepository): string {
  return `${GITHUB_API}/repos/${named.owner}/${named.repository}`;
}

// ---------------------------------------------------------------------------
// Reading one answer
// ---------------------------------------------------------------------------

/**
 * One GET whose body has to be a JSON object. Any other status and any body
 * that is not one are failures naming what came back, so the signal reports
 * that it could not measure rather than a number it did not measure.
 */
export async function readJsonObject(context: DoctorContext, url: string): Promise<Record<string, unknown>> {
  const answered = await context.fetch(url);
  if (answered.status !== OK) {
    throw new Error(`${url} answered ${answered.status}`);
  }
  const parsed = parseJsonBody(answered.body);
  if (!isRecord(parsed)) {
    throw new Error(`${url} answered ${answered.status} with no JSON object`);
  }
  return parsed;
}

function parseJsonBody(body: string): unknown {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return undefined;
  }
}

/** The objects in a named field, and nothing else that field may hold. */
export function readObjectArray(document: Record<string, unknown>, field: string): readonly Record<string, unknown>[] {
  const value: unknown = document[field];
  if (!isUnknownArray(value)) return [];
  return value.filter((entry) => isRecord(entry));
}

/** A named string field, or `undefined` when the body carries none. */
export function readStringField(document: Record<string, unknown>, field: string): string | undefined {
  const value: unknown = document[field];
  return isString(value) ? value : undefined;
}
