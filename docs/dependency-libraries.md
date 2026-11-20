# Share an application contract with another repository

Choose a dependency library when two repositories need the same
application-owned contract. This example lets a second project type-check
an asset record independently of the catalog application's storage or HTTP
implementation. Run these commands in an initialized Dads project named
`catalog`.

```sh
npx dad add library asset-records
npm install
npm test --workspace catalog-asset-records
npm pack --workspace catalog-asset-records
```

The library lives in `libraries/asset-records` and is named
`catalog-asset-records`. If the owning project is `@example/catalog`, the
library is `@example/catalog-asset-records`. The command registers the
library with npm workspaces and gives it its own owner and verification
command in `dads.project.json`. In a Dads starter, the library check also
runs as part of `npm run verify:checks`.

Define the shared API in `src/contract.ts` and export it from `src/index.ts`.
The starter contract is a TypeScript type. If callers receive the contract
over a network or from another external source, export a runtime parser for
that boundary. Keep database and application implementation details in their
owning packages.

## Try the packed dependency

The example pack command creates `catalog-asset-records-0.1.0.tgz` at the
owning repository root. Install it by path from a second npm project.

```sh
npm install /path/to/catalog/catalog-asset-records-0.1.0.tgz
```

Use the package name to import the contract.

```ts
import type { AssetRecordsContract } from "catalog-asset-records";

const asset: AssetRecordsContract = { id: "asset-123" };
```

The tarball contains the built ESM entry point and its TypeScript declarations.
For ongoing use, version the library in its `package.json` and distribute it
through the same package channel as your other dependencies.

Use `--dry-run` to preview the package name and files. Repeating the command
preserves your edits. If it reports an incomplete registration, restore the
missing owned file or manifest entry before running it again.
