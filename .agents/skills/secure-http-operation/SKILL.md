---
name: secure-http-operation
description: Secure a Dad HTTP operation with typed relationship checks, authorized list lookup, and denial proof.
---

# Secure an HTTP operation

1. Declare entity, role, and permission handles in the owning access module
   with `@dads-framework/access`. Compose the definitions with `accessModel`.
2. Use `requires(permission, fromParam(...))` from `@dads-framework/http` for
   one resource. For scoped lists, use the route's scoped lookup contract
   and filter the data query with the returned scopes.
3. Prove an authenticated caller without the relationship receives the marked
   denial response. Prove a granted caller can read the intended resource.
4. Bind Postgres relationship writes to the data transaction through
   `@dads-framework/postgres-access`. With a separate graph backend, use the
   access-change journal in `@dads-framework/authorization`.
5. Declare reusable allow and deny cases with `world()` and run them against
   the application's authorization backend. Test published list scope as well.
6. Run the focused commands from `npx dad test:recommend --changed --json`.

Map session identity to the declared subject at the application boundary.
