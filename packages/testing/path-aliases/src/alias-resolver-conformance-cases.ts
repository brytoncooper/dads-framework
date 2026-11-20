/**
 * The fixtures the conformance suite asks every provider about.
 *
 * They are data rather than code: a tsconfig chain, the files around it, and
 * either the answer the resolver must give or the refusal it must raise. The
 * suite that runs them is `alias-resolver-conformance.ts`; keeping the two
 * apart is what lets a reader see the whole list of laws on one screen.
 *
 * Every path in a case is written relative to that case's own directory, so no
 * two cases can see each other's files.
 */

const emptyModule = "export {};\n";

/** A path inside one case's own directory, so no two cases share a file. */
export type FixturePath = (relative: string) => string;

export type Resolution = {
  readonly law: string;
  readonly specifier: string;
  /** When true, the specifier is the fixture-relative path made absolute. */
  readonly asAbsolutePath?: boolean;
  /** The fixture-relative file it must answer, or `null` to defer. */
  readonly to: string | null;
};

export type ResolutionCase = {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly tsconfig: string;
  readonly resolutions: readonly Resolution[];
};

export type RefusalCase = {
  readonly name: string;
  readonly law: string;
  readonly files: Readonly<Record<string, string>>;
  readonly tsconfig: string;
  /** The message the refusal must carry, in the fixture's own paths. */
  readonly message: (at: FixturePath) => string;
};

// --- Aliases that resolve -------------------------------------------------

const inheritedAliasesCase: ResolutionCase = {
  name: "inherited-aliases",
  tsconfig: "project/tsconfig.json",
  files: {
    "config/tsconfig.paths.json": `{
  // JSONC and inherited paths are both intentional.
  "compilerOptions": {
    "paths": {
      "@fixture/core": ["./src/core.ts"],
      "@fixture/ui/*": ["./src/ui/*"],
      "@fixture/package": ["./src/package"],
      "@fixture/source.js": ["./src/source.js"]
    }
  }
}
`,
    "project/tsconfig.json": `{
  "extends": "../config/tsconfig.paths.json",
  "compilerOptions": { "strict": true }
}
`,
    "config/src/core.ts": emptyModule,
    "config/src/ui/button.tsx": emptyModule,
    "config/src/package/index.mts": emptyModule,
    "config/src/source.ts": emptyModule,
  },
  resolutions: [
    {
      law: "resolves-exact-alias",
      specifier: "@fixture/core",
      to: "config/src/core.ts",
    },
    {
      law: "resolves-wildcard-alias",
      specifier: "@fixture/ui/button",
      to: "config/src/ui/button.tsx",
    },
    {
      law: "resolves-extensionless-index",
      specifier: "@fixture/package",
      to: "config/src/package/index.mts",
    },
    {
      law: "resolves-explicit-extension",
      specifier: "@fixture/source.js",
      to: "config/src/source.ts",
    },
    {
      law: "strips-query-suffix",
      specifier: "@fixture/source.js?worker",
      to: "config/src/source.ts",
    },
    { law: "defers-bare-specifier", specifier: "react", to: null },
    { law: "defers-unmatched-alias", specifier: "@fixture/missing", to: null },
    {
      law: "defers-absolute-specifier",
      specifier: "config/src/core.ts",
      asAbsolutePath: true,
      to: null,
    },
  ],
};

const packageExtendsCase: ResolutionCase = {
  name: "package-extends",
  tsconfig: "tsconfig.json",
  files: {
    "tsconfig.json": '{ "extends": "@fixture/config" }\n',
    "node_modules/@fixture/config/package.json":
      '{ "name": "@fixture/config", "version": "0.0.0" }\n',
    "node_modules/@fixture/config/tsconfig.json":
      '{ "compilerOptions": { "paths": { "@fixture/core": ["./src/core.ts"] } } }\n',
    "node_modules/@fixture/config/src/core.ts": emptyModule,
  },
  resolutions: [
    {
      law: "resolves-package-extends",
      specifier: "@fixture/core",
      to: "node_modules/@fixture/config/src/core.ts",
    },
  ],
};

// --- A package directory an alias points at -------------------------------

/**
 * One alias pointing at a package directory that holds every candidate entry
 * file and an `index.mjs`, so a case only has to write the manifest it is
 * about — or leave it out.
 */
type PackageEntryCase = {
  readonly name: string;
  readonly law: string;
  readonly manifest?: string;
  readonly entry: string;
};

const packageEntryCases: readonly PackageEntryCase[] = [
  {
    name: "exports-import-condition",
    law: "resolves-package-entry",
    manifest:
      '{ "exports": { ".": { "import": "./exported.mjs" } }, "module": "./module.mjs", "main": "./main.cjs" }',
    entry: "exported.mjs",
  },
  {
    name: "exports-default-condition",
    law: "resolves-package-entry",
    manifest:
      '{ "exports": { ".": { "default": "./exported.mjs" } }, "main": "./main.cjs" }',
    entry: "exported.mjs",
  },
  {
    name: "exports-as-a-string",
    law: "resolves-package-entry",
    manifest: '{ "exports": "./exported.mjs" }',
    entry: "exported.mjs",
  },
  {
    name: "exports-root-as-a-string",
    law: "resolves-package-entry",
    manifest: '{ "exports": { ".": "./exported.mjs" } }',
    entry: "exported.mjs",
  },
  {
    name: "exports-of-another-condition-falls-to-module",
    law: "resolves-package-entry",
    manifest:
      '{ "exports": { ".": { "require": "./main.cjs" } }, "module": "./module.mjs", "main": "./main.cjs" }',
    entry: "module.mjs",
  },
  {
    name: "module-before-main",
    law: "resolves-package-entry",
    manifest: '{ "module": "./module.mjs", "main": "./main.cjs" }',
    entry: "module.mjs",
  },
  {
    name: "main-alone",
    law: "resolves-package-entry",
    manifest: '{ "main": "./main.cjs" }',
    entry: "main.cjs",
  },
  {
    name: "exports-of-a-subpath-only",
    law: "resolves-package-entry",
    manifest: '{ "exports": { "./sub": "./exported.mjs" } }',
    entry: "index.mjs",
  },
  {
    name: "no-manifest-at-all",
    law: "resolves-package-without-manifest",
    entry: "index.mjs",
  },
  {
    name: "a-manifest-that-does-not-parse",
    law: "ignores-unparsable-manifest",
    manifest: "{ not json",
    entry: "index.mjs",
  },
];

function packageEntryResolutionCase(
  declared: PackageEntryCase,
): ResolutionCase {
  const files: Record<string, string> = {
    "tsconfig.json":
      '{ "compilerOptions": { "paths": { "@fixture/package": ["./src/package"] } } }\n',
    "src/package/exported.mjs": emptyModule,
    "src/package/module.mjs": emptyModule,
    "src/package/main.cjs": emptyModule,
    "src/package/index.mjs": emptyModule,
  };
  if (declared.manifest !== undefined) {
    files["src/package/package.json"] = declared.manifest;
  }
  return {
    name: declared.name,
    files,
    tsconfig: "tsconfig.json",
    resolutions: [
      {
        law: declared.law,
        specifier: "@fixture/package",
        to: `src/package/${declared.entry}`,
      },
    ],
  };
}

/** Every case whose law is an answer the resolver must give. */
export function aliasResolutionCases(): readonly ResolutionCase[] {
  return [
    inheritedAliasesCase,
    packageExtendsCase,
    ...packageEntryCases.map(packageEntryResolutionCase),
  ];
}

// --- Configurations that are refused --------------------------------------

/** One tsconfig declaring the aliases a refusal case is about. */
function aliasesTsconfig(paths: string): string {
  return `{ "compilerOptions": { "paths": ${paths} } }\n`;
}

/** Every case whose law is a refusal raised while the resolver is built. */
export const aliasRefusalCases: readonly RefusalCase[] = [
  {
    name: "a-tsconfig-that-is-not-there",
    law: "refuses-missing-tsconfig",
    files: {},
    tsconfig: "absent.json",
    message: (at) =>
      `Dads path aliases tsconfig is not a readable file: ${at("absent.json")}`,
  },
  {
    name: "a-tsconfig-that-is-a-directory",
    law: "refuses-directory-tsconfig",
    files: { "directory.json/inside.txt": "" },
    tsconfig: "directory.json",
    message: (at) =>
      `Dads path aliases tsconfig is not a readable file: ${at("directory.json")}`,
  },
  {
    name: "a-config-that-does-not-parse",
    law: "refuses-unparsable-config",
    files: {
      "tsconfig.json":
        "{ compilerOptions: { paths: { '@fixture/*': ['src/*'] } } }\n",
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Unable to read Dads path aliases tsconfig ${at("tsconfig.json")}: expected a property name at line 1, column 3`,
  },
  {
    name: "an-extended-config-that-does-not-parse",
    law: "refuses-unparsable-extended-config",
    files: {
      "base.json": '{ "compilerOptions": { "paths": [ } }\n',
      "tsconfig.json": '{ "extends": "./base.json" }\n',
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Unable to read Dads path aliases tsconfig ${at("base.json")}: expected a value at line 1, column 35`,
  },
  {
    name: "a-tsconfig-that-declares-no-aliases",
    law: "refuses-config-without-paths",
    files: { "tsconfig.json": '{ "compilerOptions": { "strict": true } }\n' },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path aliases tsconfig ${at("tsconfig.json")} does not declare or inherit compilerOptions.paths.`,
  },
  {
    name: "an-alias-with-two-targets",
    law: "refuses-alias-without-one-target",
    files: {
      "tsconfig.json": aliasesTsconfig(
        '{ "@fixture/*": ["src/*", "fallback/*"] }',
      ),
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path alias @fixture/* in ${at("tsconfig.json")} must have exactly one target.`,
  },
  {
    name: "an-alias-with-no-target",
    law: "refuses-alias-without-one-target",
    files: { "tsconfig.json": aliasesTsconfig('{ "@fixture/*": [] }') },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path alias @fixture/* in ${at("tsconfig.json")} must have exactly one target.`,
  },
  {
    name: "an-alias-whose-target-is-not-a-string",
    law: "refuses-alias-without-one-target",
    files: { "tsconfig.json": aliasesTsconfig('{ "@fixture/*": [null] }') },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path alias @fixture/* in ${at("tsconfig.json")} must have exactly one target.`,
  },
  {
    name: "an-alias-with-two-wildcards",
    law: "refuses-mismatched-wildcards",
    files: {
      "tsconfig.json": aliasesTsconfig('{ "@fixture/*/*": ["./src/*/*"] }'),
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path alias @fixture/*/* in ${at("tsconfig.json")} must use zero or one matching wildcard.`,
  },
  {
    name: "a-target-that-drops-the-wildcard",
    law: "refuses-mismatched-wildcards",
    files: {
      "tsconfig.json": aliasesTsconfig('{ "@fixture/*": ["./src/one"] }'),
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path alias @fixture/* in ${at("tsconfig.json")} must use zero or one matching wildcard.`,
  },
  {
    name: "a-target-that-adds-a-wildcard",
    law: "refuses-mismatched-wildcards",
    files: {
      "tsconfig.json": aliasesTsconfig('{ "@fixture/exact": ["./src/*"] }'),
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path alias @fixture/exact in ${at("tsconfig.json")} must use zero or one matching wildcard.`,
  },
  {
    name: "an-extends-of-another-shape",
    law: "refuses-extends-shape",
    files: {
      "tsconfig.json":
        '{ "extends": null, "compilerOptions": { "paths": { "@fixture/*": ["./src/*"] } } }\n',
    },
    tsconfig: "tsconfig.json",
    message: () =>
      "Dads path aliases supports tsconfig extends only as a string or string array.",
  },
  {
    name: "a-relative-extends-that-names-no-file",
    law: "refuses-unresolvable-relative-extends",
    files: {
      "base/keep.txt": "",
      "tsconfig.json":
        '{ "extends": "./base", "compilerOptions": { "paths": { "@fixture/*": ["./src/*"] } } }\n',
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path aliases cannot resolve tsconfig extends ./base from ${at("tsconfig.json")}.`,
  },
  {
    name: "a-package-extends-that-cannot-be-resolved",
    law: "refuses-unresolvable-package-extends",
    files: {
      "tsconfig.json":
        '{ "extends": "@dads-framework/no-such-tsconfig-package", "compilerOptions": { "paths": { "@fixture/*": ["./src/*"] } } }\n',
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path aliases cannot resolve tsconfig package @dads-framework/no-such-tsconfig-package from ${at("tsconfig.json")}.`,
  },
  {
    name: "an-extends-chain-that-revisits-a-config",
    law: "refuses-circular-extends",
    files: {
      "left.json": '{ "extends": "./shared.json" }\n',
      "right.json": '{ "extends": "./shared.json" }\n',
      "shared.json": '{ "compilerOptions": { "strict": true } }\n',
      "tsconfig.json":
        '{ "extends": ["./left.json", "./right.json"], "compilerOptions": { "paths": { "@fixture/*": ["./src/*"] } } }\n',
    },
    tsconfig: "tsconfig.json",
    message: (at) =>
      `Dads path aliases found a circular tsconfig extends chain at ${at("shared.json")}.`,
  },
];
