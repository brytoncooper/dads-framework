import type { FastifyReply } from "fastify";

const ACCEPT_LANGUAGE_VARY_FIELD = "Accept-Language";

function varyFieldNames(header: string | number | readonly string[] | undefined): readonly string[] {
  if (header === undefined) return [];
  const text = Array.isArray(header) ? header.join(",") : String(header);
  return text
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field !== "");
}

function uniqueVaryFieldNames(...headers: readonly (string | number | readonly string[] | undefined)[]): string[] {
  const fieldNames: string[] = [];
  const seen = new Set<string>();
  for (const fieldName of headers.flatMap(varyFieldNames)) {
    const normalized = fieldName.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    fieldNames.push(fieldName);
  }
  return fieldNames;
}

/**
 * Mark a route response as selected by the reader's request language.
 *
 * This runs before a raw route may hijack its socket and again before ordinary
 * responses are sent. The second pass preserves Vary fields a route added after
 * the first pass. A wildcard already covers every request field.
 *
 * `Content-Language` is deliberately absent: `ctx.locale` records a reader
 * preference, while canonical and user-authored response data does not yet have
 * one truthful representation language across current endpoints.
 */
export function addRequestLanguageVaryHeader(reply: FastifyReply): void {
  const fields = uniqueVaryFieldNames(reply.raw.getHeader("vary"), reply.getHeader("vary"));
  const hasWildcard = fields.some((field) => field === "*");
  if (!hasWildcard && !fields.some((field) => field.toLowerCase() === ACCEPT_LANGUAGE_VARY_FIELD.toLowerCase())) {
    fields.push(ACCEPT_LANGUAGE_VARY_FIELD);
  }
  const next = hasWildcard ? "*" : fields.join(", ");
  void reply.header("Vary", next);
  if (!reply.raw.headersSent) {
    reply.raw.setHeader("Vary", next);
  }
}
