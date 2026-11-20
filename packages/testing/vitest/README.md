# `@dads-framework/testing-vitest`

`@dads-framework/testing-vitest` is the Vite binding of the Dads alias
resolver: an optional plugin that answers Vite's and Vitest's module
resolution with the TypeScript `paths` aliases declared by one explicit
tsconfig, without an Nx runtime. Every rule about aliases belongs to
[`@dads-framework/path-aliases`](../path-aliases/README.md); this package binds
it to Vite and nothing else.

## What Dad does for you

Dad wants the resolution boundary written down where you can read it. You hand
him one tsconfig; every alias he honors comes from that file's `paths`, and an
alias shape he cannot honor exactly is a startup failure, not a quiet miss.

## Try it

The npm install below is for the public release.

In a new directory on Node.js 22.12 or newer, install Vitest 4, Vite 7, and the
alias plugin.

```sh
npm init -y
npm pkg set type=module
npm install --save-dev vitest@4 vite@7 @dads-framework/testing-vitest
mkdir -p src
```

Save this as `tsconfig.json`.

```json
{
  "compilerOptions": {
    "paths": { "@app/*": ["./src/*"] }
  }
}
```

Save this as `vitest.config.ts`.

<!-- dads:check-example -->

```ts
import { fileURLToPath } from "node:url";
import { dadsTsconfigPaths } from "@dads-framework/testing-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    dadsTsconfigPaths({
      tsconfig: fileURLToPath(new URL("./tsconfig.json", import.meta.url)),
    }),
  ],
});
```

Create the module and test, then run Vitest.

```sh
printf 'export const label = "Save";\n' > src/button.ts

cat > button.test.mjs <<'JS'
import { expect, test } from "vitest";
import { label } from "@app/button";

test("loads the button label through the tsconfig alias", () => {
  expect(label).toBe("Save");
});
JS

npx vitest run
```

Vitest reports one passing test. The plugin resolves `@app/button` to
`src/button.ts` using the alias in `tsconfig.json`.

## Use it

`dadsTsconfigPaths(options)` is the only export, alongside its
`DadsTsconfigPathsOptions` type. It returns an ordinary Vite plugin named
`dads-tsconfig-paths` with `enforce: "pre"`, so its `resolveId` runs before
Vite's own resolution:

```ts
const plugin = dadsTsconfigPaths({ tsconfig: "/abs/path/tsconfig.json" });

plugin.name; // "dads-tsconfig-paths"
plugin.enforce; // "pre"
plugin.resolveId("@app/ui/button"); // "/abs/path/src/ui/button.ts"
plugin.resolveId("react"); // null — Vite resolves it
```

The tsconfig is read once, when the plugin is created. Absolute paths are
preferred; a relative path resolves from `process.cwd()`. The plugin reads the
tsconfig itself, comments and trailing commas included, and never loads the
TypeScript compiler: your compiler version is yours to choose.

Aliases may be declared on the given tsconfig or inherited through its
`extends` chain, which may be a string or an array of strings and may name a
relative file or a package. `baseUrl` is taken from the config that declares
`paths`, or from the nearest config after it in the chain that sets one;
absent both, alias targets resolve from the declaring config's own directory.

Resolution probes the alias target as a file, then as a package directory,
then with each supported extension, then as `index.<extension>` inside it:
`.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.mts`, `.mjs`, `.cts`, `.cjs`, `.css`,
`.scss`, and `.less`. A specifier written with an explicit extension falls back
to the matching source file, so `@app/source.js` finds `src/source.ts`. A
`?suffix` query is stripped before matching. When a target is a package
directory, its entry point comes from the first of `exports`, `module`, and
`main` that names an existing file. The whole of that behavior, and the table
of refusals below, is
[`@dads-framework/path-aliases`](../path-aliases/README.md)'s, proven there
against both of its file system providers.

## What it refuses to do

- No test selection, no result caching. Choosing which tests to run is
  `@dads-framework/testing`'s job; this plugin only answers where a module is.
- No Nx graph reading and no Nx execution. That is the whole reason the
  package exists.
- No TypeScript compiler. The tsconfig dialect is read by
  `@dads-framework/path-aliases`, so the plugin loads whatever version of
  TypeScript you compile with, or none.
- No resolution of its own. The plugin owns the Vite hook and the option it is
  given; every alias, probe, and refusal is the resolver's, so replacing Vite
  with another bundler is a new adapter rather than a rewrite.
- No implicit tsconfig discovery. There is no search up the directory tree and
  no default: the config that owns resolution is the one you named.
- No claim over absolute or unmatched specifiers. Those return `null` and stay
  Vite's to resolve.

## Contract

`dadsTsconfigPaths(options: DadsTsconfigPathsOptions): Plugin`, where
`DadsTsconfigPathsOptions` is `{ readonly tsconfig: string }`. `resolveId`
returns an absolute file path for a specifier this plugin owns, and `null` for
everything else.

Every failure below is thrown while the plugin is being created — configuration
time, not resolve time — so a broken alias map fails the run instead of
silently resolving less:

| Message                                                                                | When                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `dadsTsconfigPaths requires a non-empty tsconfig path.`                                | `options`, or `options.tsconfig`, is missing or blank     |
| `Dads path aliases tsconfig is not a readable file: <path>`                            | The named tsconfig is not a readable file                 |
| `Unable to read Dads path aliases tsconfig <path>: <detail> at line <l>, column <c>`   | A config in the chain is unreadable or is not valid JSONC |
| `Dads path aliases tsconfig <path> does not declare or inherit compilerOptions.paths.` | No aliases were found                                     |
| `Dads path alias <pattern> in <path> must have exactly one target.`                    | An alias maps to zero, several, or one unusable target    |
| `Dads path alias <pattern> in <path> must use zero or one matching wildcard.`          | Wildcards exceed one, or do not match                     |
| `Dads path aliases supports tsconfig extends only as a string or string array.`        | `extends` is some other shape                             |
| `Dads path aliases cannot resolve tsconfig extends <target> from <path>.`              | A relative `extends` names no file                        |
| `Dads path aliases cannot resolve tsconfig package <name> from <path>.`                | A package `extends` cannot be resolved                    |
| `Dads path aliases found a circular tsconfig extends chain at <path>.`                 | The `extends` chain revisits a config                     |

The package requires Node.js 22 or newer, declares `vite` as its one peer
dependency (`>=6 <9`), and depends on `@dads-framework/path-aliases`. It does
not depend on TypeScript at all.

## Daddy issues this prevents

Alias resolution is where a build quietly stops matching the type checker: the
compiler follows one map, the test runner follows another, and the disagreement
only shows up as an import that works everywhere except in CI. One named
config, one map, and a loud failure when it cannot be honored.
