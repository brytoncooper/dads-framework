import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

import { withModuleAugmentationRules } from "./scripts/lint/module-augmentation-rules.mjs";

const typescriptPlugin = withModuleAugmentationRules(tseslint.plugin);

// --- Scope globs ---------------------------------------------------------

const productionFiles = [
  "packages/*/*/src/**/*.{ts,tsx}",
  "packages/access/src/**/*.ts",
  "packages/contract/src/**/*.ts",
  "apps/*/src/**/*.{ts,tsx}",
  "fixtures/*/src/**/*.ts",
];
const nonProductionFiles = ["**/*.test.ts", "**/*.test.tsx", "**/*.generated.ts"];
const testFiles = ["**/*.test.ts", "**/*.test.tsx"];
const typeTestFiles = ["packages/*/*/type-tests/**/*.ts"];
const scriptFiles = ["**/*.{js,mjs}"];

// --- Rule groups ---------------------------------------------------------

/**
 * Rules every hand-written TypeScript file obeys. They close the escape
 * hatches: no assertion can rewrite a type, no comment can silence the
 * compiler without a stated reason, and no value reaches a string or a throw
 * without the type system agreeing that it belongs there.
 */
const houseRules = {
  "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
  "@typescript-eslint/ban-ts-comment": [
    "error",
    {
      "ts-expect-error": "allow-with-description",
      "ts-ignore": true,
      "ts-nocheck": true,
      "ts-check": false,
      minimumDescriptionLength: 10,
    },
  ],
  "@typescript-eslint/consistent-type-definitions": ["error", "type"],
  "@typescript-eslint/switch-exhaustiveness-check": [
    "error",
    {
      considerDefaultExhaustiveForUnions: false,
      requireDefaultForNonUnion: true,
    },
  ],
  "@typescript-eslint/no-unsafe-type-assertion": "error",
  "@typescript-eslint/prefer-readonly": "error",
  "@typescript-eslint/restrict-plus-operands": [
    "error",
    {
      allowAny: false,
      allowBoolean: false,
      allowNullish: false,
      allowNumberAndString: false,
      allowRegExp: false,
    },
  ],
  "@typescript-eslint/restrict-template-expressions": [
    "error",
    {
      allowAny: false,
      allowArray: false,
      allowBoolean: false,
      allowNever: false,
      allowNullish: false,
      allowNumber: true,
      allowRegExp: false,
    },
  ],
  "@typescript-eslint/return-await": ["error", "error-handling-correctness-only"],
  "@typescript-eslint/only-throw-error": "error",
};

/**
 * Ceilings that keep one function readable at a glance. Production only:
 * a test may enumerate as many cases as it needs.
 */
const functionCeilingRules = {
  complexity: ["error", 10],
  "max-depth": ["error", 3],
  "max-statements": ["error", 20],
  "max-nested-callbacks": ["error", 2],
};

/**
 * A focused test silently narrows the suite. Environment gates belong in
 * `it.skipIf(condition)`, which still names the test and still reports it.
 */
const focusedTestRules = {
  "no-restricted-syntax": [
    "error",
    {
      selector: "CallExpression[callee.object.name=/^(it|test|describe)$/][callee.property.name=/^(only|skip|todo)$/]",
      message:
        "Focused and skipped tests narrow the suite silently. Use it.skipIf(condition) for an environment gate, or delete the test.",
    },
  ],
};

// --- Configuration -------------------------------------------------------

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  eslint.configs.recommended,
  {
    files: scriptFiles,
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: scriptFiles,
    rules: { "no-console": "off" },
  },
  ...tseslint.configs.strictTypeChecked.map((configuration) => ({
    ...configuration,
    ...(configuration.plugins?.["@typescript-eslint"]
      ? {
          plugins: {
            ...configuration.plugins,
            "@typescript-eslint": typescriptPlugin,
          },
        }
      : {}),
    files: ["**/*.ts", "**/*.tsx"],
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: productionFiles,
    ignores: nonProductionFiles,
    rules: {
      ...houseRules,
      ...functionCeilingRules,
      "no-console": "error",
    },
  },
  {
    files: testFiles,
    rules: {
      ...houseRules,
      ...focusedTestRules,
    },
  },
  {
    files: typeTestFiles,
    rules: houseRules,
  },
);
