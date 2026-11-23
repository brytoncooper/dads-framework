/**
 * Marks a 404 the access edge answered because the caller may not reach the
 * route, as opposed to one a handler answered for a record that is not there.
 * The body stays the bare `RESOURCE_NOT_FOUND` envelope either way.
 *
 * It leaks nothing about existence: the edge asks only whether the caller
 * holds the permission, and answers the same for a missing record as for one
 * the caller may not see. It lets our own clients and tests tell "this page
 * read something its user may not read" from "the record is gone"
 * (docs/enforcement.md, "Refused page reads").
 */
export const ACCESS_REFUSAL_HEADER = "x-access-refusal";

/** The header's value on an access refusal. */
export const ACCESS_REFUSAL_VALUE = "refused";
