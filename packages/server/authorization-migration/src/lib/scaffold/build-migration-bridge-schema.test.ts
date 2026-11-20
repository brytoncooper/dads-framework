/** A bridge accepts old facts while replacements are copied, without restoring old permission expressions. */
import { describe, expect, it } from "vitest";
import { classifySchemaDiff } from "../logic/classify-schema-diff.js";
import { buildMigrationBridgeSchema } from "./build-migration-bridge-schema.js";

const old = `definition user {}\ndefinition test/resource {\n  relation admin: user\n  relation creator: user\n  permission manage = admin + creator\n}\n`;
const next = `definition user {}\ndefinition test/actor {}\ndefinition test/resource {\n  relation admin: test/actor\n  permission manage = admin\n}\n`;

describe("buildMigrationBridgeSchema", () => {
  it("retains old allowed subjects and relations but uses the new policy", () => {
    const bridge = buildMigrationBridgeSchema(old, next);
    expect(classifySchemaDiff(old, bridge)).toEqual({ kind: "additive" });
    expect(bridge).toContain("relation admin: test/actor | user");
    expect(bridge).toContain("relation creator: user");
    expect(bridge).toContain("permission manage = admin\n");
    expect(bridge).not.toContain("permission manage = admin + creator");
    expect(classifySchemaDiff(bridge, next).kind).toBe("destructive");
  });

  it("refuses removed definitions or relation-to-permission renames that need a deliberate bridge", () => {
    expect(() =>
      buildMigrationBridgeSchema(old, "definition user {}\n"),
    ).toThrow("removed definition");
    expect(() =>
      buildMigrationBridgeSchema(
        old,
        next.replace(
          "permission manage = admin",
          "permission creator = admin\n  permission manage = admin",
        ),
      ),
    ).toThrow("permission collision");
  });

  it("generates the same bridge on a repeated invocation", () => {
    expect(buildMigrationBridgeSchema(old, next)).toEqual(
      buildMigrationBridgeSchema(old, next),
    );
  });
});
