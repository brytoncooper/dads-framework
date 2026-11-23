/** Proves `rows-sent-whole` allows schema validation via `.parse(row)` while still flagging raw row leaks. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDoctorContext } from "../../doctor-context.js";
import { rowsSentWholeSignal } from "./rows-sent-whole.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspaceWith(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "dad-rows-sent-whole-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  return root;
}

describe("rows-sent-whole signal", () => {
  it("does not flag explicit schema.parse(row) validation while still flagging raw spreads and sends", async () => {
    const root = workspaceWith({
      "packages/notes/src/http/parsed-response.ts": `
type NoteRow = { readonly id: string; readonly secret: string };
const noteSchema = { parse: (input: unknown) => input };

export function toNoteResponse(row: NoteRow) {
  return noteSchema.parse(row);
}
`,
      "packages/notes/src/http/leaked-response.ts": `
type NoteRow = { readonly id: string; readonly secret: string };

export function spreadLeak(row: NoteRow) {
  return { ...row };
}
export function returnLeak(row: NoteRow) {
  return row;
}
`,
    });

    const readings = await rowsSentWholeSignal.run(createDoctorContext({ root }));
    expect(readings.get("packages/notes/src/http/parsed-response.ts")?.value).toBe(0);
    expect(readings.get("packages/notes/src/http/leaked-response.ts")?.value).toBe(2);
  });
});
