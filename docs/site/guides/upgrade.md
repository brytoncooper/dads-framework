# Upgrade a Dads project

Check the target release's package README and generated API reference before
updating your dependencies. Keep first-party Dads packages on the same
release version when upgrading the starter.

1. Keep a verified baseline of the app and its lockfile. Upgrade one
   capability and the bindings it needs.
2. Compare emitted contracts with the previous version. Regenerate clients
   with the app's current generation script and fix consumers of changed
   fields or exports.
3. Rehearse pending migrations against a restored database. Keep applied
   migration files intact.
4. Run authorization denial tests and the app's complete verification
   command. Check the app's smoke test before promoting the new version.

Package splits and incompatible public changes need version-specific notes.
Consult the affected package README when moving between versions.

## Moving from earlier source checkouts

If an older source branch split tables, forms, display, and shell components
across packages, migrate the imports to the current `@dads-framework/ui`
subpaths. See the [UI package reference](../../../packages/web/ui/README.md).
Update imports and dependency declarations in the same change, and rerun the
table and form tests that consume those components.

When moving an existing route to the [HTTP kit](../../../packages/server/http/README.md),
migrate its request and response schemas, regenerate its consumer, and prove
its existing denial behavior.
