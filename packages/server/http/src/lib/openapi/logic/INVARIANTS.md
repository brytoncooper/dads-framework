# OpenAPI schema invariants

- INV-OPENAPI-1: Schema-local recursive references resolve within their owning component and local definitions are namespaced components, never dangling document-root references — enforced by `schema-components.ts` and `schema-components.test.ts`.
