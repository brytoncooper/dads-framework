import { z } from "zod";

/**
 * The language primitives both sides of the wire agree on, without either side
 * importing the other.
 *
 * These are **declaration** primitives, not payload. A capability label is
 * written side by side in a contributor's declaration and RESOLVED to the
 * request's locale before it reaches the wire, so every existing response field
 * stays a plain string and no contract changes shape. The reader's saved locale
 * in the identity-owned user settings document is the deliberate exception:
 * there the locale tag is the account data being stored, not a localized label
 * crossing the wire.
 *
 * The same three names exist in `@dads-framework/copy`, deliberately. A
 * contract lib may depend only on other contract libs, so the web side cannot
 * import this one — five lines duplicated across a boundary that already
 * forbids sharing, checked by an application’s locale parity test,
 * which is the one place in the repo that can see both.
 */

/** Every language this product speaks, in preference order. */
export const SUPPORTED_LOCALES = ["en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * One phrase in every language this product speaks.
 *
 * Strict, so a locale nobody supports cannot be declared and silently ignored,
 * and non-empty, so an unwritten translation is a refusal rather than a blank
 * label. Add a locale here and to `SUPPORTED_LOCALES` together — the type-level
 * pin in the colocated test fails when only one of them moves.
 */
export const localizedTextSchema = z
  .strictObject({
    en: z.string().min(1).meta({ description: "English" }),
  })
  .readonly();

export type LocalizedText = z.infer<typeof localizedTextSchema>;

/**
 * The header a reader's language arrives on.
 *
 * `Accept-Language` rather than a query parameter, for the same reason
 * `REQUEST_ID_HEADER` is a header: a query parameter would have to be added to
 * every route contract that returns a label, and the wire is exactly what this
 * design keeps still. One place sets it on the client, one place reads it on
 * the server.
 */
export const LOCALE_HEADER = "accept-language";
