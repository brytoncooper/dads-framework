import {
  LOCALE_HEADER,
  SUPPORTED_LOCALES,
  type Locale,
} from "@dads-framework/core/contract";

/**
 * Which language this request is answered in.
 *
 * The reader's language arrives on `Accept-Language` and is resolved once, here,
 * beside the correlation id — the same shape and the same reason. Server-owned
 * vocabulary (capability labels, workspace destinations, refusal sentences) is
 * stored side by side and resolved against this value, so the wire keeps
 * carrying plain strings and no route contract changes shape.
 *
 * Never throws. A header naming a language this product does not speak, a
 * malformed weight, an absent header and a spoofed array all resolve to
 * English: a request answered in the wrong language is a nuisance, and a
 * request refused for its language is an outage.
 */

/** What a reader gets when nothing they asked for is available. */
export const DEFAULT_REQUEST_LOCALE: Locale = SUPPORTED_LOCALES[0];

type WeightedTag = {
  readonly tag: string;
  readonly quality: number;
};

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

/** Fastify hands a repeated header through as an array; both spellings parse. */
function headerText(header: unknown): string {
  if (typeof header === "string") return header;
  if (isStringArray(header)) return header.join(",");
  return "";
}

/**
 * `q=0.9` off one tag's parameters; anything unreadable weighs full.
 *
 * The empty arm is the one that matters: `Number("")` is 0, so a bare `q=`
 * read as a number is indistinguishable from `q=0` — the one weight that means
 * "never send me this", which would silently DROP the tag the reader asked for.
 * Unreadable and refused are opposite answers, and only the client can say
 * `q=0`.
 */
function qualityOf(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const [name, value] = parameter.split("=");
    if (name?.trim().toLowerCase() !== "q") continue;
    const written = value?.trim() ?? "";
    if (written === "") return 1;
    const quality = Number(written);
    return Number.isFinite(quality) ? quality : 1;
  }
  return 1;
}

function parseAcceptLanguage(header: string): readonly WeightedTag[] {
  return header.split(",").flatMap((part) => {
    const [rawTag, ...parameters] = part.split(";");
    const tag = rawTag?.trim() ?? "";
    return tag === "" ? [] : [{ tag, quality: qualityOf(parameters) }];
  });
}

/** `es-MX` is Spanish: a reader asking for a region wants its language. */
function supportedLocaleForTag<T extends string>(
  tag: string,
  supported: readonly T[],
): T | undefined {
  const normalized = tag.trim().toLowerCase();
  if (normalized === "" || normalized === "*") return undefined;
  const exact = supported.find((locale) => locale.toLowerCase() === normalized);
  if (exact !== undefined) return exact;
  const primarySubtag = normalized.split("-")[0];
  return supported.find((locale) => locale.toLowerCase() === primarySubtag);
}

/**
 * The best language this header asks for that the supported list contains.
 *
 * The supported list is a parameter for the same reason the copy kit's is:
 * `SUPPORTED_LOCALES` holds one entry today, so every answer
 * `resolveRequestLocale` can give is English whatever the header said, and a
 * weight or ordering bug is unobservable through it. Name a second language here
 * and the ranking becomes something a test can watch go wrong.
 *
 * Deliberately not on the lib's barrel: the pipeline reads a locale through
 * `requestLocaleOf` and nothing outside this file has a supported list of its
 * own to pass.
 */
export function preferredLocaleOf<T extends string>(
  header: unknown,
  supported: readonly T[],
): T | undefined {
  const wanted = parseAcceptLanguage(headerText(header))
    .filter((entry) => entry.quality > 0)
    .sort((left, right) => right.quality - left.quality);
  for (const entry of wanted) {
    const matched = supportedLocaleForTag(entry.tag, supported);
    if (matched !== undefined) return matched;
  }
  return undefined;
}

/** The first supported language the header asks for, by weight, else English. */
export function resolveRequestLocale(header: unknown): Locale {
  return preferredLocaleOf(header, SUPPORTED_LOCALES) ?? DEFAULT_REQUEST_LOCALE;
}

/** The language one request asked for — the pipeline's single read. */
export function requestLocaleOf(request: {
  readonly headers: Record<string, unknown>;
}): Locale {
  return resolveRequestLocale(request.headers[LOCALE_HEADER]);
}
