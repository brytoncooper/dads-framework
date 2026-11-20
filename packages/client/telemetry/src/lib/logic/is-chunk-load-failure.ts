/**
 * Whether a failure is a code-split chunk that would not load.
 *
 * Worth telling apart because it is usually NOT a bug. The common cause is an
 * open tab whose bundle was replaced by a deploy: the browser asks for a
 * hashed asset that no longer exists, and the right answer is to reload, which
 * `subscribeSpaVersionReload` already does. Reporting those would bury the
 * rare real one — a bad deploy, a broken CDN path — under routine noise.
 *
 * Matching on message text, which is ugly and deliberate: browsers give
 * dynamic-import failures no error class and no code, and the wording differs
 * per engine. The list below is what Chrome, Firefox, Safari and Vite's own
 * preload helper actually say.
 */

const CHUNK_LOAD_SIGNATURES = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "unable to preload css",
  "loading chunk",
  "loading css chunk",
];

export function isChunkLoadFailure(error: unknown): boolean {
  const message = messageOf(error).toLowerCase();
  if (message.length === 0) return false;
  return CHUNK_LOAD_SIGNATURES.some((signature) => message.includes(signature));
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}
