/**
 * The two word lists the commitment-issues reading matches, kept apart from
 * the signal that uses them.
 *
 * The signal asks whether a deferred-work comment about who may do something
 * sits within twenty lines of a route declaration. A module that spelled both
 * halves of that question — the words below, and the route-shaped lines the
 * signal recognises — would answer it about itself. `hatch-names.ts` splits
 * the escape hatches for the same reason and explains it at length; this is
 * the same move, one lane later.
 *
 * So the words live here, where nothing route-shaped is written, and the
 * patterns that recognise a route live beside the signal, where none of these
 * words appear in a comment.
 */

/** A comment that puts work off until later. */
export const DEFERRED_WORK_MARK = /\b(?:TODO|FIXME)\b/;

/**
 * A comment about who is allowed to do something. The list is the vocabulary
 * an unfinished permission check is written in, not every word about access:
 * "access the file" is not a deferred authorization decision, so bare `access`
 * is left out and `access control` is spelled in full.
 */
export const PERMISSION_WORD =
  /\b(?:permissions?|authn?|authz|authoriz(?:e|ed|ation)|authoris(?:e|ed|ation)|access control)\b/i;
