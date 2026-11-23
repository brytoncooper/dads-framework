import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "./verify-generated-project-workspace.mjs";

const generators = [
  ["domain", "inventory"],
  ["endpoint", "status", "--domain", "inventory", "--api", "staff"],
  ["table", "warehouse", "--domain", "inventory"],
  ["access", "warehouse", "--domain", "inventory"],
  ["flag", "batch", "--domain", "inventory"],
  ["email", "notice", "--domain", "inventory"],
  ["page", "overview", "--domain", "inventory"],
  ["resource", "catalog", "--api", "customer"],
  ["library", "catalog-records"],
];

export const generatedCommands = generators.map(([command]) => command);

export async function runGeneratedCommands(transcript, creator, projectRoot) {
  const dad = join(creator.host, "node_modules", ".bin", "dad");
  for (const generator of generators) {
    const { stdout } = await transcript.run(dad, ["add", ...generator, "--json"], {
      cwd: projectRoot,
    });
    const result = JSON.parse(stdout);
    if (!result.ok || !Array.isArray(result.result?.files) || result.result.files.length === 0) {
      throw new Error(`Generator ${generator[0]} did not write any files.`);
    }
  }
  writeFileSync(join(projectRoot, "assembly", "generated-web.test.ts"), webProof);
}

export async function verifyGeneratedCommands(transcript, projectRoot) {
  const manifestPath = join(projectRoot, "package.json");
  const reportPath = ".adoption-vitest.json";
  const manifest = readJson(manifestPath);
  manifest.scripts.test += ` --reporter=default --reporter=json --outputFile.json=${reportPath}`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const { stdout } = await transcript.run("sh", ["ci/verify.sh"], {
    cwd: projectRoot,
  });
  for (const evidence of ["dad check boundaries", "the package entry point loads"]) {
    if (!stdout.includes(evidence)) {
      throw new Error(`Generated verification did not report ${evidence}.`);
    }
  }

  const report = readJson(join(projectRoot, reportPath));
  const canonicalRoot = realpathSync(projectRoot);
  for (const path of ["domains/catalog/server/catalog-resource.test.ts", "assembly/generated-web.test.ts"]) {
    if (!report.testResults.some((result) => result.name === join(canonicalRoot, path) && result.status === "passed")) {
      throw new Error(`Generated verification did not pass ${path}.`);
    }
  }
}

const webProof = `import { expect, it } from "vitest";

import { CatalogDetailPage, CatalogListPage, listCatalog, readCatalog, saveCatalog } from "../domains/catalog/web-client/index.js";
import { renderOverviewPage } from "../domains/inventory/web-client/index.js";

it("exposes the generated clients and pages to app composition", () => {
  const item = { id: "catalog-item", title: "Sample", rowVersion: 1 };
  expect([listCatalog, readCatalog, saveCatalog].every((method) => typeof method === "function")).toBe(true);
  expect(renderOverviewPage()).toContain("Overview");
  expect(CatalogListPage({ items: [item], detailUrl: (id) => \`/catalog/\${id}\` }).type).toBe("main");
  expect(CatalogDetailPage({ item, onSave: () => undefined }).type).toBe("main");
});
`;
