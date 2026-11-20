import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDoctorContext } from "../../doctor-context.js";
import { hasExplicitWrapperConformance } from "./explicit-wrapper-conformance.js";

const ROOT = "packages/server/adapter";
const RUNNER = "src/providers.integration.test.ts";
const DECLARATIONS = `
  import { it } from "vitest";
  import { Pool as Plain } from "vendor-db";
  import { Pool as Alias } from "vendor-db";
  import { Pool as PackageAlias } from "renamed-vendor-db";
  import { decorated } from "./decorator.js";
  import { aliasedDecorator } from "././decorator.js";
  import { laws } from "./laws.js";
  laws((config) => new Plain(config), (name, run) => { it(name, () => run()); });
`;

const NATIVE = { module: "vendor-db", name: "Pool" };
const DECORATED = { module: "./decorator.js", name: "decorated" };

function inspect(
  run: string,
  provider = DECORATED,
  test = RUNNER,
  law = "register('queries', () => open({}));",
  firstProvider = NATIVE,
): boolean {
  return inspectFiles({
    "package.json": JSON.stringify({
      dependencies: { "renamed-vendor-db": "npm:vendor-db@^1.0.0" },
      dadsConformance: {
        capability: "Pool checkout",
        suite: "src/laws.ts",
        law: "laws",
        runs: [
          { test: RUNNER, provider: firstProvider },
          { test, provider },
        ],
      },
    }),
    "src/laws.ts": `export function laws(open, register) { ${law} }`,
    "src/decorator.ts": `
      class Decorated { connect() {} }
      export function decorated(config) { return new Decorated(config); }
      export function aliasedDecorator(config) { return new Decorated(config); }
    `,
    [RUNNER]: DECLARATIONS + run,
  });
}

function inspectFiles(files: Readonly<Record<string, string>>): boolean {
  const root = mkdtempSync(join(tmpdir(), "explicit-wrapper-conformance-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, ROOT, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return hasExplicitWrapperConformance(createDoctorContext({ root }), ROOT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("explicit wrapper conformance", () => {
  const decoratorRun =
    "laws((config) => decorated(config), (name, run) => { it(name, () => run()); });";

  it("accepts two implementations running the same suite", () => {
    expect(inspect(decoratorRun)).toBe(true);
  });

  it("rejects a second import alias for the same vendor provider", () => {
    expect(
      inspect(
        decoratorRun.replace("decorated(config)", "new Alias(config)"),
        NATIVE,
      ),
    ).toBe(false);
  });

  it("rejects an npm alias of the same provider package", () => {
    expect(
      inspect(
        decoratorRun.replace("decorated(config)", "new PackageAlias(config)"),
        { module: "renamed-vendor-db", name: "Pool" },
      ),
    ).toBe(false);
  });

  it("rejects two local factories for the same provider class", () => {
    expect(
      inspect(
        decoratorRun +
          decoratorRun.replace("decorated(config)", "aliasedDecorator(config)"),
        { module: "././decorator.js", name: "aliasedDecorator" },
        RUNNER,
        undefined,
        DECORATED,
      ),
    ).toBe(false);
  });

  it("rejects missing tests and unused provider imports", () => {
    expect(inspect(decoratorRun, DECORATED, "src/missing.test.ts")).toBe(false);
    expect(inspect("")).toBe(false);
  });

  it("rejects a test registration that never runs the law", () => {
    expect(
      inspect(decoratorRun.replace("() => run()", "() => undefined")),
    ).toBe(false);
    expect(inspect(decoratorRun, DECORATED, RUNNER, "")).toBe(false);
  });
});

const TABLE = `export const laws = [{
  name: "connects",
  run(provider) { provider.connect(); },
}];`;
const TABLE_RUN = `
  describe("local provider", () => {
    it.each(laws)("$name", async ({ run }) => {
      const provider = new Local();
      try {
        await run({ provider });
      } finally {}
    });
  });
`;

function inspectTable(registration: string, suite = TABLE): boolean {
  return inspectFiles({
    "package.json": JSON.stringify({
      dadsConformance: {
        capability: "Pool checkout",
        suite: "src/laws.ts",
        law: "laws",
        runs: [
          { test: RUNNER, provider: NATIVE },
          { test: RUNNER, provider: { module: "./local.js", name: "Local" } },
        ],
      },
    }),
    "src/laws.ts": suite,
    "src/local.ts": "export class Local { connect() {} }",
    [RUNNER]:
      `
      import { describe, it } from "vitest";
      import { Pool as Plain } from "vendor-db";
      import { Local } from "./local.js";
      import { laws } from "./laws.js";

      it.each(laws)("$name", ({ run }) => { run(new Plain()); });
    ` + registration,
  });
}

describe("table-driven wrapper conformance", () => {
  it("accepts direct registrations when both implementations reach the law", () => {
    expect(inspectTable(TABLE_RUN)).toBe(true);
  });

  it("rejects fixtures without a provider law", () => {
    expect(
      inspectTable(TABLE_RUN, TABLE.replace("provider.connect();", "")),
    ).toBe(false);
    expect(
      inspectTable(TABLE_RUN, `export const laws = [{ name: "connects" }];`),
    ).toBe(false);
  });

  it("rejects a constructed provider that is unused by the law", () => {
    expect(
      inspectTable(TABLE_RUN.replace("run({ provider })", "run(new Plain())")),
    ).toBe(false);
  });

  it("rejects skipped registrations and shadowed provider imports", () => {
    expect(inspectTable(TABLE_RUN.replace("describe(", "describe.skip("))).toBe(
      false,
    );
    expect(
      inspectTable(
        TABLE_RUN.replace("  it.each", "  const Local = Plain; it.each"),
      ),
    ).toBe(false);
  });
});
