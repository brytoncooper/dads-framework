# Nx testing importer fixture

The importer tests create a disposable Nx-shaped workspace from this fixture's
contract: one argv-safe `nx:run-commands` target, plus native, continuous,
shell, and Nx-Vite-path targets that must remain in the audit report.

The fixture is intentionally not registered in the root workspace yet.
