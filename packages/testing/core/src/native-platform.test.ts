import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativePackageNameForPlatform,
  resolveNativeTestingBinary,
} from "./native-platform.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Dads Testing native package selection", () => {
  it("maps every supported platform tuple to one optional package", () => {
    expect(nativePackageNameForPlatform("darwin", "arm64")).toBe(
      "@dads-framework/testing-native-darwin-arm64",
    );
    expect(nativePackageNameForPlatform("darwin", "x64")).toBe(
      "@dads-framework/testing-native-darwin-x64",
    );
    expect(nativePackageNameForPlatform("linux", "arm64", "glibc")).toBe(
      "@dads-framework/testing-native-linux-arm64-gnu",
    );
    expect(nativePackageNameForPlatform("linux", "x64", "glibc")).toBe(
      "@dads-framework/testing-native-linux-x64-gnu",
    );
    expect(nativePackageNameForPlatform("win32", "x64")).toBe(
      "@dads-framework/testing-native-win32-x64",
    );
  });

  it("reports a missing optional package precisely", () => {
    expect(() =>
      resolveNativeTestingBinary({
        platform: "darwin",
        architecture: "arm64",
        packageResolver: () => {
          throw new Error("module not found");
        },
      }),
    ).toThrow("@dads-framework/testing-native-darwin-arm64 is not installed");
  });

  it("accepts an existing development binary without spawning it", () => {
    const binary = developmentBinary("dad-test");

    expect(resolveNativeTestingBinary({ explicitBinary: binary })).toEqual({
      binary,
      source: "nativeBinary",
    });
  });
});

/**
 * The variable replaces the platform package rather than backing it up: it is
 * read before any package lookup, so a platform with no package installed
 * still resolves, and an explicit option is read before the variable.
 */
describe("Dads Testing development binary precedence", () => {
  const refuseEveryPackage = (): string => {
    throw new Error("module not found");
  };

  it("uses DADS_TEST_NATIVE_BINARY in place of a missing platform package", () => {
    const binary = developmentBinary("dad-test-from-environment");

    expect(
      resolveNativeTestingBinary({
        environment: { DADS_TEST_NATIVE_BINARY: binary },
        platform: "darwin",
        architecture: "arm64",
        packageResolver: refuseEveryPackage,
      }),
    ).toEqual({ binary, source: "DADS_TEST_NATIVE_BINARY" });
  });

  it("reads an explicit nativeBinary before the variable", () => {
    const explicitBinary = developmentBinary("dad-test-explicit");
    const environmentBinary = developmentBinary("dad-test-environment");

    expect(
      resolveNativeTestingBinary({
        explicitBinary,
        environment: { DADS_TEST_NATIVE_BINARY: environmentBinary },
        packageResolver: refuseEveryPackage,
      }),
    ).toEqual({ binary: explicitBinary, source: "nativeBinary" });
  });

  it("names the source that supplied a path with no file behind it", () => {
    const absent = join(temporaryDirectory(), "absent");

    expect(() =>
      resolveNativeTestingBinary({
        environment: { DADS_TEST_NATIVE_BINARY: absent },
        packageResolver: refuseEveryPackage,
      }),
    ).toThrow(`The DADS_TEST_NATIVE_BINARY path does not exist: ${absent}.`);
    expect(() =>
      resolveNativeTestingBinary({ explicitBinary: absent }),
    ).toThrow(`The nativeBinary path does not exist: ${absent}.`);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(
    join(tmpdir(), "dads-testing-native-platform-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function developmentBinary(name: string): string {
  const binary = join(temporaryDirectory(), name);
  writeFileSync(binary, "development fixture");
  return binary;
}
