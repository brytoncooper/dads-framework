/**
 * The floor under the corpus the doctor proves itself against.
 *
 * A case is a directory whose own manifest names it, which is what stops a
 * stray copy of somebody else's fixture from raising the floor, and what makes
 * an unreadable manifest a directory that is not a case rather than a crash.
 * An absent corpus reports nothing rather than a floor of zero, because zero
 * would be a promise that no case was ever written.
 */

import { describe, expect, it } from "vitest";
import type { DoctorContext } from "../../doctor-context.js";
import { doctorCasesSignal } from "./doctor-cases.js";

const CORPUS = "fixtures/daddy-issues";

function contextOver(directories: readonly string[], manifests: Record<string, string>): DoctorContext {
  return {
    root: "/repo",
    today: undefined,
    files: () => [],
    directories: (path) => (path === CORPUS ? directories : []),
    read: (path) => manifests[path] ?? "",
    exists: (path) => manifests[path] !== undefined,
    packages: () => [],
    exec: () => ({ status: 1, stdout: "" }),
    online: false,
    fetch: () => {
      throw new Error("no network here");
    },
    program: () => {
      throw new Error("no program here");
    },
  };
}

function manifest(signal: string): string {
  return JSON.stringify({ signal, expected: {} });
}

async function cases(context: DoctorContext): Promise<number | undefined> {
  const measured = await doctorCasesSignal.run(context);
  return measured.get("cases")?.value;
}

describe("the doctor corpus floor", () => {
  it("counts the case directories the corpus holds", async () => {
    const context = contextOver(["explicit-any", "files-over-ceiling"], {
      [`${CORPUS}/explicit-any/fixture.json`]: manifest("explicit-any"),
      [`${CORPUS}/files-over-ceiling/fixture.json`]: manifest("files-over-ceiling"),
    });

    expect(await cases(context)).toBe(2);
  });

  it("ignores a manifest that names another directory", async () => {
    const context = contextOver(["explicit-any", "a-stray-copy"], {
      [`${CORPUS}/explicit-any/fixture.json`]: manifest("explicit-any"),
      [`${CORPUS}/a-stray-copy/fixture.json`]: manifest("explicit-any"),
    });

    expect(await cases(context)).toBe(1);
  });

  it("ignores a directory whose manifest it cannot read or parse", async () => {
    const context = contextOver(["explicit-any", "broken", "empty"], {
      [`${CORPUS}/explicit-any/fixture.json`]: manifest("explicit-any"),
      [`${CORPUS}/broken/fixture.json`]: "{ not json",
    });

    expect(await cases(context)).toBe(1);
  });

  it("reports nothing where the corpus is absent, rather than a floor of zero", async () => {
    expect(await cases(contextOver([], {}))).toBeUndefined();
  });
});
