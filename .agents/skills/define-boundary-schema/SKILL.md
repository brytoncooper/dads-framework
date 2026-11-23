---
name: define-boundary-schema
description: Add or change a Dads boundary schema without coupling independently owned representations.
---

# Define a boundary schema

1. Run `npx dad orient <target-path> --json` and identify the application
   contract that owns the boundary.
2. Declare the shape in Zod. Use `z.strictObject` for untrusted request objects
   that must reject unknown fields. Choose response fields and patch behavior
   explicitly.
3. Use the `@dads-framework/core/contract` schemas for shared wire concepts such as
   entity IDs, request metadata, and pagination.
4. Keep request, response, persistence, and event shapes independently owned.
   Map foreign SDK values at their integration boundary.
5. Prove runtime parsing and the inferred types. If the boundary contributes
   to HTTP, check the generated OpenAPI operation too.
6. Run the verification command returned by `dad orient`.
