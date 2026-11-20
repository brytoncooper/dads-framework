// The release image must fail closed on missing database configuration and
// use its immutable in-image migration directory unless explicitly replaced.
import { describe, expect, it } from "vitest";
import { describeMigrationFailure } from "./logic/describe-migration-failure.js";
import { parseMigrationEnvironment } from "./logic/parse-migration-environment.js";

describe("release migration environment", () => {
  it("requires a database connection string", () => {
    expect(() => parseMigrationEnvironment({})).toThrow(
      expect.objectContaining({ name: "ZodError" }),
    );
  });

  it("defaults the workspace root to the process working directory", () => {
    expect(
      parseMigrationEnvironment({
        DATABASE_URL: "postgresql://app:secret@postgres:5432/app",
      }),
    ).toEqual({
      databaseUrl: "postgresql://app:secret@postgres:5432/app",
      workspaceRoot: ".",
    });
  });

  it("accepts an explicit workspace root", () => {
    expect(
      parseMigrationEnvironment({
        DATABASE_URL: "postgresql://app:secret@postgres:5432/app",
        WORKSPACE_ROOT: "/app",
      }),
    ).toEqual({
      databaseUrl: "postgresql://app:secret@postgres:5432/app",
      workspaceRoot: "/app",
    });
  });

  it("keeps driver discriminants without logging sensitive messages", () => {
    const failure = Object.assign(new Error("password=do-not-log"), {
      code: "28P01",
    });

    expect(describeMigrationFailure(failure)).toEqual({
      name: "Error",
      driverCode: "28P01",
    });
    expect(JSON.stringify(describeMigrationFailure(failure))).not.toContain(
      "do-not-log",
    );
  });
});
