/** Proves initialization arguments reject ambiguous input at the CLI boundary. */

import { describe, expect, it } from "vitest";
import { parseDadsInitializationArguments } from "./dads-initialization-arguments.js";

describe("Dads initialization arguments", () => {
  it("parses every supported option into a typed request", () => {
    expect(
      parseDadsInitializationArguments([
        "--existing",
        "host-app",
        "--name",
        "host-http",
        "--yes",
        "--dry-run",
        "--skip-install",
        "--json",
      ]),
    ).toEqual({
      targetDirectory: "host-app",
      mode: "existing",
      projectName: "host-http",
      acceptDefaults: true,
      dryRun: true,
      skipInstall: true,
      json: true,
    });
  });

  it("rejects unknown options instead of silently applying defaults", () => {
    expect(() =>
      parseDadsInitializationArguments(["api", "--profil", "strict"]),
    ).toThrow("Unknown option --profil");
  });

  it("rejects a second positional argument", () => {
    expect(() =>
      parseDadsInitializationArguments(["api", "other-api"]),
    ).toThrow("Unexpected positional argument other-api");
  });

  it("rejects an option provided more than once", () => {
    expect(() =>
      parseDadsInitializationArguments([
        "api",
        "--name",
        "one",
        "--name",
        "two",
      ]),
    ).toThrow("Option --name was provided more than once.");
  });

  it("rejects an option whose value is missing or another option", () => {
    expect(() => parseDadsInitializationArguments(["api", "--name"])).toThrow(
      "--name requires a value.",
    );
    expect(() =>
      parseDadsInitializationArguments(["api", "--name", "--json"]),
    ).toThrow("--name requires a value.");
  });

  it("requires a project directory", () => {
    expect(() => parseDadsInitializationArguments(["--json"])).toThrow(
      "Provide a Dads project directory.",
    );
  });

  it("rejects the retired starter adapter selector", () => {
    expect(() =>
      parseDadsInitializationArguments(["api", "--adapter", "mysql"]),
    ).toThrow("Unknown option --adapter.");
  });
});
