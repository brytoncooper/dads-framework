import { SUPPORTED_LOCALES, type Locale } from "@dads-framework/core/contract";

/**
 * The language every outbound request asks to be answered in.
 *
 * A module-level channel rather than an argument on each call, mirroring
 * `unauthorized-response-channel.ts` and for the same reason: every request
 * carries it, and no call site should have to remember. It is also why the
 * language rides a header — a query parameter would have to be threaded
 * through every route contract that returns a label, which is exactly the wire
 * change this design avoids.
 *
 * This module holds no React and reaches no copy kit — the boundary forbids the
 * latter outright (`scope:web` cannot import a `scope:shared` lib's provider
 * state, and a transport should not hold render state anyway). The app's
 * composition root is the one place that holds both, and it is what calls
 * `setRequestLocale` when the reader changes language, alongside clearing the
 * query cache so nothing already fetched answers in the old one.
 *
 * The default is English, and nothing sets it today: the reader's preference
 * will live in a future user-settings document.
 */

let requestedLocale: Locale = SUPPORTED_LOCALES[0];

/** Ask the API to answer in this language from here on. */
export function setRequestLocale(locale: Locale): void {
  requestedLocale = locale;
}

/** The language the next request will ask for. */
export function currentRequestLocale(): Locale {
  return requestedLocale;
}
