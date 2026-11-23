import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDoctorContext } from "../../doctor-context.js";
import { vendorNamedDomainSignal } from "./vendor-named-domain.js";

const CASES = [
  {
    title: "allows a private subclass inside its vendor boundary",
    declaration: "class Owned extends Pool {}",
    kind: "adapter",
    vendor: "vendor-db",
    expected: 0,
  },
  {
    title: "flags a directly exported subclass",
    declaration: "export class Owned extends Pool {}",
    kind: "adapter",
    vendor: "vendor-db",
    expected: 1,
  },
  {
    title: "flags a named export of a subclass",
    declaration: "class Owned extends Pool {}\nexport { Owned as Store };",
    kind: "adapter",
    vendor: "vendor-db",
    expected: 1,
  },
  {
    title: "flags a default export of a subclass",
    declaration: "class Owned extends Pool {}\nexport default Owned;",
    kind: "adapter",
    vendor: "vendor-db",
    expected: 1,
  },
  {
    title: "flags a private subclass of an undeclared vendor",
    declaration: "class Owned extends Pool {}",
    kind: "adapter",
    vendor: "other-db",
    expected: 1,
  },
  {
    title: "flags an exported domain alias even in an adapter",
    declaration: "export type Order = Pool;",
    kind: "adapter",
    vendor: "vendor-db",
    expected: 1,
  },
  {
    title: "flags a private vendor subclass in core",
    declaration: "class Owned extends Pool {}",
    kind: "core",
    vendor: "vendor-db",
    expected: 1,
  },
];

describe("vendor named domains", () => {
  it.each(CASES)("$title", async ({ declaration, kind, vendor, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "vendor-named-domain-"));
    const pkgRoot = "packages/server/store";
    const modulePath = `${pkgRoot}/src/store.ts`;
    try {
      mkdirSync(dirname(join(root, modulePath)), { recursive: true });
      writeFileSync(join(root, "tsconfig.json"), "{}");
      writeFileSync(
        join(root, "dads.project.json"),
        JSON.stringify({
          schemaVersion: 1,
          packages: [
            {
              name: "@fixture/store",
              root: pkgRoot,
              kind,
              allowedDependencies: ["vendor-db"],
            },
          ],
        }),
      );
      writeFileSync(join(root, modulePath), `import { Pool } from "${vendor}";\n${declaration}\n`);
      const readings = await vendorNamedDomainSignal.run(createDoctorContext({ root }));
      expect(readings.get(modulePath)?.value).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
