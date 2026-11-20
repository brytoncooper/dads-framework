import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Linter } from "eslint";
import ts from "typescript";
import tseslint from "typescript-eslint";

import { withModuleAugmentationRules } from "./module-augmentation-rules.mjs";

const filename = "fixture.ts";
const vendorName = "vendor-augmentation-fixture";
const source = `import "vendor-augmentation-fixture";

declare module "vendor-augmentation-fixture" {
  interface VendorMetadata<T> {
    readonly caption?: string;
  }

  interface ExtraShape {
    readonly caption: string;
  }
}

export interface OrdinaryShape {
  readonly item: string;
}

export type UnusedParameter<T> = string;
`;

test("allows required vendor interface merges and their unused type parameters only", () => {
  const root = mkdtempSync(join(tmpdir(), "dads-lint-augmentation-"));
  try {
    const vendorRoot = join(root, "node_modules", vendorName);
    mkdirSync(vendorRoot, { recursive: true });
    writeFileSync(
      join(vendorRoot, "index.d.ts"),
      "export interface VendorMetadata<T> { readonly item: T; }\n",
    );
    const sourcePath = join(root, filename);
    writeFileSync(sourcePath, source);
    const program = ts.createProgram([sourcePath], {
      module: ts.ModuleKind.NodeNext,
      strict: true,
    });

    const linter = new Linter({ cwd: root });
    const messages = linter.verify(
      source,
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { programs: [program] },
        },
        plugins: {
          "@typescript-eslint": withModuleAugmentationRules(tseslint.plugin),
        },
        rules: {
          "@typescript-eslint/consistent-type-definitions": ["error", "type"],
          "@typescript-eslint/no-unused-vars": "error",
        },
      },
      { filename: sourcePath },
    );

    assert.deepEqual(
      messages.map(({ line, messageId }) => [line, messageId]),
      [
        [8, "typeOverInterface"],
        [13, "typeOverInterface"],
        [17, "unusedVar"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
