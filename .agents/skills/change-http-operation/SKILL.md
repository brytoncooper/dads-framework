---
name: change-http-operation
description: Change a Dads HTTP contract without leaking ownership or leaving generated clients and proof behind.
---

# Change an HTTP operation

1. Locate the route card and run `npx dad orient <route-path> --json`. Identify the application contract that owns meaning.
2. Change request and response schemas independently. Do not derive one side
   from the other merely because their fields currently match.
3. Update the thin route, declared failures, OpenAPI proof, generated client,
   and every application-owned adapter affected by the contract.
4. If access changes, follow `secure-http-operation`. If transport behavior
   changes, follow `extend-http-framework` instead of adding it to a handler.
5. Run `npx dad test:recommend --changed --json`, the returned commands,
   and `npx dad verify --changed --json`.

Report contract compatibility and every proof actually run. A green focused
test is not proof that unrun integration or composition checks passed.
