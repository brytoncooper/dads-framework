import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BASELINE_PATH, type GateMode } from "./doctor-gate-model.js";
import {
  initializeStandaloneRatchet,
  runStandaloneRatchet,
} from "./standalone-ratchet.js";
import { RATCHET_POLICY_PATH } from "./standalone-ratchet-policy.js";

const roots: string[] = [];
const reason = "Legacy parser is being migrated";
const base = "refs/remotes/origin/main";
const mode: GateMode = {
  base,
  files: undefined,
  json: false,
  key: undefined,
  profile: "standard",
  reason: undefined,
  report: false,
  seed: false,
  today: undefined,
  update: false,
};

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function freshRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "dad-standalone-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "user.name", "Ratchet Test");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "tsconfig.json"), "{}\n");
  writeFileSync(join(root, "src/legacy.ts"), "export const legacy: any = 1;\n");
  git(root, "add", ".");
  return root;
}

async function adopt(root: string): Promise<void> {
  const result = await initializeStandaloneRatchet({
    root,
    reason,
    today: "2026-11-19",
  });
  expect(result.exitCode).toBe(0);
  git(root, "add", ".");
  git(root, "commit", "-qm", "Adopt standalone ratchet");
  git(root, "update-ref", base, "HEAD");
}

function gate(root: string, overrides: Partial<GateMode> = {}) {
  return runStandaloneRatchet({
    root,
    mode: { ...mode, ...overrides },
    narrowed: false,
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("standalone TypeScript ratchet", () => {
  it("records code-health debt with a reason and measures new source against the base", async () => {
    const root = freshRepository();
    await adopt(root);
    const baseline = readFileSync(join(root, BASELINE_PATH), "utf8");
    expect(baseline).toContain("explicit-any");
    expect(baseline).toContain(reason);
    expect(baseline).not.toContain("docsConformancePackages");
    expect(await gate(root)).toMatchObject({ exitCode: 0 });

    writeFileSync(
      join(root, "src/legacy.ts"),
      "export const legacy: [any, any] = [1, 2];\n",
    );
    const failed = await gate(root);
    expect(failed).toMatchObject({ exitCode: 1 });
    expect(failed?.output).toContain("above its mark");

    writeFileSync(
      join(root, BASELINE_PATH),
      baseline.replace('"mark": 1', '"mark": 2'),
    );
    await expect(gate(root)).rejects.toThrow("rose");
  });

  it("accepts healthy deletion and refuses new exceptions and wider exemptions", async () => {
    const root = freshRepository();
    await adopt(root);
    const path = join(root, BASELINE_PATH);
    const baseline = readFileSync(path, "utf8");
    writeFileSync(path, baseline.replace('"src/legacy.ts"', '"src/other.ts"'));
    await expect(gate(root)).rejects.toThrow("new exception");
    writeFileSync(
      path,
      baseline.replace('"**/dist/**"', '"**/dist/**", "src/**"'),
    );
    await expect(gate(root)).rejects.toThrow("exempt paths changed");
    writeFileSync(path, baseline);
    git(root, "rm", "-q", "src/legacy.ts");
    expect(await gate(root, { base: undefined, update: true })).toMatchObject({
      exitCode: 0,
      wrote: true,
    });
    expect(readFileSync(path, "utf8")).not.toContain("src/legacy.ts");
    expect(await gate(root)).toMatchObject({ exitCode: 0 });
  });

  it("uses initial threshold overrides and protects the policy after adoption", async () => {
    const root = freshRepository();
    const path = join(root, RATCHET_POLICY_PATH);
    mkdirSync(join(root, ".agents"));
    writeFileSync(
      path,
      '{"schemaVersion":1,"thresholds":{"explicit-any":1}}\n',
    );
    await adopt(root);
    expect(readFileSync(join(root, BASELINE_PATH), "utf8")).not.toContain(
      "explicit-any",
    );
    expect(await gate(root)).toMatchObject({ exitCode: 0 });

    writeFileSync(
      path,
      '{"schemaVersion":1,"thresholds":{"explicit-any":2}}\n',
    );
    await expect(gate(root)).rejects.toThrow("changed relative to");
    await expect(gate(root, { base: "no-such-branch" })).rejects.toThrow(
      "Cannot resolve base ref",
    );
    rmSync(path);
    await expect(gate(root)).rejects.toThrow("was removed");
  });

  it("keeps initialization read-only when no TypeScript project was measured", async () => {
    const root = freshRepository();
    git(root, "rm", "-q", "-f", "tsconfig.json");
    await expect(
      initializeStandaloneRatchet({ root, reason, today: "2026-11-19" }),
    ).rejects.toThrow("no tsconfig");
    expect(() => readFileSync(join(root, BASELINE_PATH))).toThrow("ENOENT");
    expect(() => readFileSync(join(root, RATCHET_POLICY_PATH))).toThrow(
      "ENOENT",
    );
  });
});
