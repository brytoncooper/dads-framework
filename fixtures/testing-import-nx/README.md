# Nx testing importer fixture

The importer tests create a disposable Nx-shaped workspace from this fixture's
contract: one argv-safe `nx:run-commands` target, plus native, continuous,
shell, and Nx-Vite-path targets that must remain in the audit report.

From the repository root, build the workspace and run the importer test:

```sh
npm run build
npm test -w @dads-framework/testing -- src/nx/import-nx.test.ts
```

The test creates its own workspace and asserts which targets appear in the
imported manifest and which stay in the audit report.
