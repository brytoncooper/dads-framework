import { z } from "zod";

/**
 * THE SLUG SHAPE LAW, IN ONE PLACE.
 *
 * Lowercase letters, digits and single interior hyphens — no leading hyphen,
 * no trailing hyphen, no run of two. It is written to match exactly what a
 * domain's `slugFromName` derivation produces, so a slug the API mints for you
 * and a slug you type by hand are the same kind of thing.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * URL identity: lowercase kebab-case. The kit owns the format; each
 * domain declares its own named slug so this library never learns domain
 * vocabulary.
 *
 * A slug is EDITABLE. It is the name a URL
 * carries, not an identity anything keys off: authorization names branded ids,
 * and so does every stored reference. Renaming the thing never touches it — a
 * slug only ever changes because somebody said so in the `slug` field.
 */
export function slugSchema(description: string) {
  return z
    .string()
    .trim()
    .min(1)
    .regex(SLUG_PATTERN, { message: "Slug must be lowercase kebab-case" })
    .meta({ description });
}

/** Whether a candidate satisfies the shape law above. */
export function isSlugShape(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

/**
 * WORDS A SLUG MAY NOT CLAIM.
 *
 * Two sources, one list. Every route segment reserved by the application —
 * `login`, `design-system`, `my-work`, `no-access`, `orgs`, `staff`,
 * `organizations`, `facilities` — plus the words a URL space reliably grows
 * into later (`api`, `admin`, `assets`, `static`, `settings`, `new`, `logout`,
 * `platform`, `support`). A slug sits in a `$param` position today, so none of
 * these collides yet; the list exists because the day a route wants one of
 * them back, the customer holding it is the one who pays.
 *
 * It is one list rather than one per domain because both slugs land in the
 * same URL space, and a word that would confuse `/orgs/staff` confuses
 * `/orgs/acme/facilities/staff` for the same reason.
 */
export const RESERVED_SLUGS = [
  "admin",
  "api",
  "assets",
  "design-system",
  "facilities",
  "login",
  "logout",
  "my-work",
  "new",
  "no-access",
  "organizations",
  "orgs",
  "platform",
  "settings",
  "staff",
  "static",
  "support",
] as const;

const RESERVED = new Set<string>(RESERVED_SLUGS);

/** Whether a candidate is one of the words {@link RESERVED_SLUGS} withholds. */
export function isReservedSlug(value: string): boolean {
  return RESERVED.has(value);
}
