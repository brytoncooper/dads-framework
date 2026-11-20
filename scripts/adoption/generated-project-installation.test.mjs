import test from "node:test";
import assert from "node:assert/strict";
import { collectPackageClosure } from "./adoption-packing.mjs";
import { buildInternalDependencyOverrides } from "./generated-project-installation.mjs";

function packageRecord(name, dependencies = {}, optionalDependencies = {}) {
  return { manifest: { name, dependencies, optionalDependencies } };
}

test("redirects http's schema edge to its packed tarball", () => {
  const packages = new Map([
    [
      "@dads-framework/http",
      packageRecord("@dads-framework/http", {
        "@dads-framework/contract": "0.1.0",
      }),
    ],
    ["@dads-framework/contract", packageRecord("@dads-framework/contract")],
  ]);
  const tarballs = new Map([["@dads-framework/contract", "/tmp/schema.tgz"]]);

  assert.deepEqual(
    buildInternalDependencyOverrides(
      ["@dads-framework/http"],
      packages,
      tarballs,
    ),
    {
      "@dads-framework/contract": "file:/tmp/schema.tgz",
    },
  );
});

test("redirects all native options when testing is both a root and a toolbox dependency", () => {
  const nativeNames = [
    "@dads-framework/testing-native-darwin-arm64",
    "@dads-framework/testing-native-darwin-x64",
    "@dads-framework/testing-native-linux-arm64-gnu",
    "@dads-framework/testing-native-linux-x64-gnu",
    "@dads-framework/testing-native-win32-x64",
  ];
  const packages = new Map([
    [
      "@dads-framework/toolbox",
      packageRecord("@dads-framework/toolbox", {
        "@dads-framework/testing": "0.1.0",
      }),
    ],
    [
      "@dads-framework/testing",
      packageRecord(
        "@dads-framework/testing",
        {},
        Object.fromEntries(nativeNames.map((name) => [name, "0.1.0"])),
      ),
    ],
    ...nativeNames.map((name) => [name, packageRecord(name)]),
  ]);
  const tarballs = new Map(
    nativeNames.map((name) => [name, `/tmp/${name}.tgz`]),
  );
  const overrides = buildInternalDependencyOverrides(
    ["@dads-framework/testing", "@dads-framework/toolbox"],
    packages,
    tarballs,
  );

  assert.deepEqual(Object.keys(overrides), nativeNames);
  for (const name of nativeNames) {
    assert.equal(overrides[name], `file:/tmp/${name}.tgz`);
  }

  assert.deepEqual(collectPackageClosure("@dads-framework/testing", packages), [
    "@dads-framework/testing",
  ]);
});

test("does not override registry dependencies or direct roots", () => {
  const packages = new Map([
    [
      "@dads-framework/http",
      packageRecord("@dads-framework/http", {
        "@dads-framework/contract": "0.1.0",
        zod: "^4",
      }),
    ],
    ["@dads-framework/contract", packageRecord("@dads-framework/contract")],
  ]);
  const tarballs = new Map([["@dads-framework/contract", "/tmp/schema.tgz"]]);
  const overrides = buildInternalDependencyOverrides(
    ["@dads-framework/http", "@dads-framework/contract"],
    packages,
    tarballs,
  );

  assert.deepEqual(overrides, {});
});
