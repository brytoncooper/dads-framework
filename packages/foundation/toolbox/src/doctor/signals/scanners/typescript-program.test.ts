/**
 * The program's two promises: it is built from what the workspace declares,
 * and it refuses rather than guesses when the workspace declares nothing.
 *
 * The fixture corpus proves what each signal reads; this proves what they all
 * read it from. The interesting case is the repository that has no TypeScript
 * project at all, because there the honest answer is silence — a signal that
 * reported zero would be saying it looked, and it did not.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDoctorContext } from "../../doctor-context.js";
import { runDoctorSignals } from "../../doctor-signals.js";
import { explicitAnySignal } from "../daddy-issues/explicit-any.js";

const STRICT_CONFIG = `{ "compilerOptions": { "strict": true } }\n`;

function workspaceWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "dad-program-"));
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  return root;
}

describe("the TypeScript program", () => {
  it("parses the hand-written modules a project claims, and nothing else", () => {
    const root = workspaceWith({
      "tsconfig.json": STRICT_CONFIG,
      "packages/group/name/src/order.ts": "export const order = 1;\n",
      "packages/group/name/src/order.d.ts": "export declare const order: number;\n",
      "packages/group/name/src/client.generated.ts": "export const client = 1;\n",
    });
    try {
      const parsed = createDoctorContext({ root })
        .program()
        .modules.map((module) => module.path);
      expect(parsed).toStrictEqual(["packages/group/name/src/order.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("owns a module by the package its source directory sits in", () => {
    const root = workspaceWith({
      "tsconfig.json": STRICT_CONFIG,
      "packages/group/name/src/deep/order.ts": "export const order = 1;\n",
    });
    try {
      const owners = createDoctorContext({ root })
        .program()
        .modules.map((module) => module.packageRoot);
      expect(owners).toStrictEqual(["packages/group/name"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to guess when a workspace declares no TypeScript project", async () => {
    const root = workspaceWith({
      "packages/group/name/src/order.ts": "export const order: any = 1;\n",
    });
    try {
      const context = createDoctorContext({ root });
      expect(() => context.program()).toThrow("no tsconfig.json");
      const outcomes = await runDoctorSignals(context, [explicitAnySignal]);
      expect(outcomes.map((outcome) => outcome.failure)).toStrictEqual(["no tsconfig.json in this workspace"]);
      expect(outcomes.map((outcome) => outcome.readings.size)).toStrictEqual([0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
