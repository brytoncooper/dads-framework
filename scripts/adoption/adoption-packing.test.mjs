import assert from "node:assert/strict";
import test from "node:test";

import { packedFilename, tarballFor } from "./adoption-packing.mjs";

test("reads the tarball name npm reported", () => {
  assert.equal(
    packedFilename(
      "@dads-framework/contract",
      '[{"id":"@dads-framework/contract@0.1.0","filename":"dads-framework-schema-0.1.0.tgz"}]\n',
    ),
    "dads-framework-schema-0.1.0.tgz",
  );
});

test("fails loudly when npm pack did not answer in JSON", () => {
  assert.throws(
    () => packedFilename("@dads-framework/contract", "npm warn something\n"),
    /did not return JSON for @dads-framework\/contract/,
  );
});

test("fails loudly when npm pack named no tarball", () => {
  assert.throws(
    () => packedFilename("@dads-framework/http", "[]"),
    /did not name a tarball/,
  );
  assert.throws(
    () => packedFilename("@dads-framework/http", '[{"id":"x"}]'),
    /did not name a tarball/,
  );
});

test("fails loudly when a package was never packed", () => {
  assert.throws(
    () => tarballFor(new Map(), "@dads-framework/toolbox"),
    /Missing packed tarball for @dads-framework\/toolbox/,
  );
  assert.equal(
    tarballFor(
      new Map([["@dads-framework/toolbox", "/tmp/toolbox.tgz"]]),
      "@dads-framework/toolbox",
    ),
    "/tmp/toolbox.tgz",
  );
});
