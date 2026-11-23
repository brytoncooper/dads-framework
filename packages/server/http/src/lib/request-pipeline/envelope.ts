/**
 * The success envelope (docs/architecture/api-conventions.md): every data
 * response is `{ data }` — `{ data, meta }` when the route declares meta
 * (paginated lists) — built here and nowhere else. Error responses use the
 * error envelope from `@dads-framework/core/errors/map-error-to-http-response`.
 */
export type DataEnvelope<T, Meta = undefined> = Meta extends undefined
  ? { readonly data: T }
  : { readonly data: T; readonly meta: Meta };

export function envelope(data: unknown, meta?: unknown): { data: unknown; meta?: unknown } {
  return meta === undefined ? { data } : { data, meta };
}
