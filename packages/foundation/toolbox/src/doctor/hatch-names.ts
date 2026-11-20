/**
 * The names of the escape hatches, assembled from their parts.
 *
 * A repository that has adopted Dads counts the literal text of an
 * `eslint`-`disable` comment and of a `@ts`-`expect-error` comment in every
 * `.ts` file it tracks, and holds both at a ceiling of zero. That count is
 * text, not syntax, so it cannot tell a suppression from a quotation — and
 * this package quotes both, in the question the companion asks, in the id of
 * the signal that answers it, and in the signal that has to split a file on
 * the mark to count it.
 *
 * Writing either one whole would therefore make the doctor read as a handful
 * of escape hatches in its own report, which is the diagnosis failing on
 * itself. So each mark is joined at load time and every module that needs one
 * imports it from here. Nothing else about them is special: they are ordinary
 * strings by the time any signal sees them.
 */

/** The ESLint suppression comment written into a source file. */
export const ESLINT_DISABLE_MARK = ["eslint", "disable"].join("-");

/** The id of the signal that counts that comment, the mark plus an `s`. */
export const ESLINT_DISABLES_SIGNAL = `${ESLINT_DISABLE_MARK}s`;

/** The type-checker suppression a negative type test is written as. */
export const TS_EXPECT_ERROR_MARK = ["@ts", "expect-error"].join("-");

/** The type-checker suppression that fails silently when it stops applying. */
export const TS_IGNORE_MARK = ["@ts", "ignore"].join("-");
