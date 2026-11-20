# `@dads-framework/path-aliases`

`@dads-framework/path-aliases` resolves the TypeScript `paths` aliases declared
by one explicit tsconfig — its own, or any it inherits through `extends` — to
absolute paths of files that exist. It reads through a file system port with
two providers: `nodeFileSystem`, which is the disk, and `inMemoryFileSystem`,
which is a map. Both are put through the same conformance suite.

## What Dad does for you

Dad wants the resolution boundary written down where you can read it. You hand
him one tsconfig; every alias he honors comes from that file's `paths`, and an
alias shape he cannot honor exactly is a startup failure, not a quiet miss.

## Try it

```ts
import {
  createAliasResolver,
  nodeFileSystem,
} from "@dads-framework/path-aliases";

const resolveAlias = createAliasResolver({
  tsconfig: "/repo/tsconfig.json",
  fileSystem: nodeFileSystem,
});

resolveAlias("@app/ui/button"); // "/repo/src/ui/button.tsx"
resolveAlias("react"); // null — not this resolver's to answer
```

With `"paths": { "@app/*": ["src/*"] }` in that tsconfig, `@app/ui/button`
answers the file the compiler would have picked. A bare specifier such as
`react` is left to whoever asked.

## Use it

| Export                                                                                         | What it is                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `createAliasResolver({ tsconfig, fileSystem })`                                                | builds the resolver, and refuses every configuration it cannot honor      |
| `AliasResolver`                                                                                | `(specifier: string) => string \| null`                                   |
| `AliasFileSystem`                                                                              | the port: `isFile`, `readText`, `resolvePackage`                          |
| `nodeFileSystem`                                                                               | the provider over `node:fs` and `node:module`                             |
| `inMemoryFileSystem(files)`                                                                    | the provider over a map of absolute paths to text                         |
| `runAliasResolverConformance({ root, fileSystem })`                                            | the suite every provider is run through; an empty finding list is passing |
| `aliasResolverConformanceLaws()`                                                               | the twenty-five law names the suite reports under, in run order           |
| `AliasFileSystemFactory`, `AliasResolverConformanceSubject`, `AliasResolverConformanceFinding` | the shapes that suite takes and answers                                   |

Aliases may be declared on the given tsconfig or inherited through its
`extends` chain, which may be a string or an array of strings and may name a
relative file or a package. The config that declares `paths` is the nearest one
in the chain; its targets resolve against the `baseUrl` of that config, or of
the nearest config after it that sets one, or against its own directory.

Resolution probes an alias target as a file, then as a package directory whose
entry point is the first of `exports`, `module`, and `main` that names an
existing file, then with each supported extension and as `index.<extension>`
inside it: `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.mts`, `.mjs`, `.cts`,
`.cjs`, `.css`, `.scss`, and `.less`. A specifier written with an explicit
extension falls back to the matching source file, so `@app/source.js` finds
`src/source.ts`. A `?suffix` query is stripped before matching.

`exports` contributes `exports["."]` when that is a string, otherwise its
`import` condition and then its `default` condition; any other `exports` shape,
an unreadable `package.json`, and no `package.json` at all leave `module` and
`main` to answer, and then the extension and `index.<extension>` probes.

## What it refuses to do

- **It does not load the TypeScript compiler.** The tsconfig dialect —
  comments, trailing commas, and strings containing either — is read by this
  package, so your compiler version is yours to choose, or to skip.
- **It does not touch a disk of its own.** Every file question goes through the
  port, which is why the in-memory stand-in exists and why both providers run
  one suite.
- **It does not discover a tsconfig.** There is no search up the directory tree
  and no default: the config that owns resolution is the one you named.
- **It does not guess at an alias shape it does not support.** Two targets for
  one alias, more than one `*`, or a wildcard count that differs between
  pattern and target is a configuration-time error rather than a weaker match.
- **It does not claim a specifier it cannot prove.** A bare specifier, an
  absolute path, and an alias whose target names no existing file all answer
  `null` and stay the caller's to resolve.
- **It does not resolve every specifier under `baseUrl`.** An alias is honored
  because `paths` declares it, not because a file happens to sit beside the
  ones that are declared.

## Contract

`createAliasResolver(options: AliasResolverOptions): AliasResolver`, where
`AliasResolverOptions` is `{ readonly tsconfig: string; readonly fileSystem:
AliasFileSystem }`. The resolver answers an absolute file path for a specifier
it owns and `null` for everything else.

Every failure below is thrown while the resolver is being built —
configuration time, not resolve time — so a broken alias map fails the run
instead of silently resolving less:

| Message                                                                                | When                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `Dads path aliases requires a non-empty tsconfig path.`                                | `tsconfig` is blank                                       |
| `Dads path aliases tsconfig is not a readable file: <path>`                            | The named tsconfig is not a readable file                 |
| `Unable to read Dads path aliases tsconfig <path>: <detail> at line <l>, column <c>`   | A config in the chain is unreadable or is not valid JSONC |
| `Dads path aliases tsconfig <path> does not declare or inherit compilerOptions.paths.` | No aliases were found                                     |
| `Dads path alias <pattern> in <path> must have exactly one target.`                    | An alias maps to zero, several, or one unusable target    |
| `Dads path alias <pattern> in <path> must use zero or one matching wildcard.`          | Wildcards exceed one, or do not match                     |
| `Dads path aliases supports tsconfig extends only as a string or string array.`        | `extends` is some other shape                             |
| `Dads path aliases cannot resolve tsconfig extends <target> from <path>.`              | A relative `extends` names no file                        |
| `Dads path aliases cannot resolve tsconfig package <name> from <path>.`                | A package `extends` cannot be resolved                    |
| `Dads path aliases found a circular tsconfig extends chain at <path>.`                 | The `extends` chain revisits a config                     |

`runAliasResolverConformance` answers a list of findings and throws nothing; an
empty list is conformance. Each finding names the case, the law, and what the
provider did instead. A subject is `{ root, fileSystem }`, where `root` is an
absolute directory the suite builds its fixtures under and `fileSystem` builds
a provider serving exactly the files it is handed.

The package requires Node.js 22 or newer and has no dependencies at all.

## Daddy issues this prevents

Alias resolution is where a build quietly stops matching the type checker: the
compiler follows one map, the test runner follows another, and the
disagreement only shows up as an import that works everywhere except in CI. One
named config, one map, and a loud failure when it cannot be honored.
