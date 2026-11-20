import test from "node:test";
import assert from "node:assert/strict";
import { isExecutableOnlyAdoptionPackage } from "./adoption-package-classification.mjs";

test("classifies a native package with a matching root bin export", () => {
  assert.equal(
    isExecutableOnlyAdoptionPackage({
      bin: { "dad-test": "./bin/dad-test" },
      exports: { ".": "./bin/dad-test" },
    }),
    true,
  );
});

test("keeps condition-object packages importable", () => {
  assert.equal(
    isExecutableOnlyAdoptionPackage({
      bin: { "create-dads": "./bin/create-dads.js" },
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      },
    }),
    false,
  );
});

test("keeps ordinary packages importable", () => {
  assert.equal(
    isExecutableOnlyAdoptionPackage({
      exports: { ".": { default: "./dist/index.js" } },
    }),
    false,
  );
});

test("keeps mismatched string exports importable", () => {
  assert.equal(
    isExecutableOnlyAdoptionPackage({
      bin: { dad: "./bin/dad.js" },
      exports: { ".": "./dist/index.js" },
    }),
    false,
  );
});

test("fails closed for malformed external manifests", () => {
  assert.equal(isExecutableOnlyAdoptionPackage(null), false);
  assert.equal(
    isExecutableOnlyAdoptionPackage({
      bin: { dad: 42 },
      exports: { ".": "./bin/dad" },
    }),
    false,
  );
  assert.equal(
    isExecutableOnlyAdoptionPackage({
      bin: "./bin/dad",
      exports: { ".": "./bin/dad" },
    }),
    true,
  );
});
