import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalState } from "../assembly/local-state.mjs";

const temporary = [];

function project() {
  const root = mkdtempSync(join(tmpdir(), "dads-local-stack-"));
  temporary.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true });
});

describe("local development state", () => {
  it("only creates state at startup and reuses each project's private secrets", () => {
    const root = project();
    expect(readLocalState(root, false)).toBeUndefined();
    const initial = readLocalState(root, true);
    expect(initial?.databasePassword).toMatch(/^[a-f0-9]{64}$/);
    expect(initial?.identitySecret).toMatch(/^[a-f0-9]{64}$/);
    expect(initial?.databasePassword).not.toBe(initial?.identitySecret);
    expect(readLocalState(root, true)).toEqual(initial);
    if (process.platform !== "win32") {
      expect(statSync(join(root, ".dads/local-dev.json")).mode & 0o777).toBe(0o600);
    }
    const second = readLocalState(project(), true);
    expect(second?.project).not.toBe(initial?.project);
    expect(second?.databasePassword).not.toBe(initial?.databasePassword);
  });

  it("reports a missing lockfile before touching Docker or saving secrets", () => {
    const root = project();
    const assembly = fileURLToPath(new URL("../assembly", import.meta.url));
    cpSync(assembly, join(root, "assembly"), { recursive: true });
    const launch = spawnSync(process.execPath, ["assembly/dev.mjs", "up", "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(launch.status).toBe(1);
    expect(JSON.parse(launch.stdout)).toEqual({
      ok: false,
      error: "Run npm install to create package-lock.json before starting the local stack.",
    });
    expect(existsSync(join(root, ".dads"))).toBe(false);
  });
});
