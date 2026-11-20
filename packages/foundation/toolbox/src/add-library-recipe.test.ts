import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, test, expect } from "vitest";
import { addLibraryRecipe } from "./add-library-recipe.js";
import { loadDadsProject } from "./project-files.js";
import { orientProjectPath } from "./project-orientation.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("plans without writes and adds library ownership and verification once", () => {
  const { owner } = projects();
  const manifest = join(owner, "dads.project.json");
  const original = readFileSync(manifest, "utf8");
  expect(addLibraryRecipe(owner, "asset-records", true).status).toBe("planned");
  expect(readFileSync(manifest, "utf8")).toBe(original);
  const result = addLibraryRecipe(owner, "asset-records", false);
  expect(result.status).toBe("installed");
  const { project } = loadDadsProject(owner);
  expect(
    orientProjectPath(project, "libraries/asset-records/src/contract.ts")
      ?.packageName,
  ).toBe("@example/owner-asset-records");
  expect(project.verificationPolicy.fullFallbackTaskIds).toContain(
    "@example/owner-asset-records:library-test",
  );

  const workspace = readFileSync(join(owner, "package.json"), "utf8");
  expect(JSON.parse(workspace)).toMatchObject({
    workspaces: { packages: [result.root], nohoist: ["kept"] },
    scripts: {
      "verify:checks": `node --version && npm test --workspace ${result.packageName}`,
    },
  });
  const contract = join(owner, result.root, "src/contract.ts");
  writeFileSync(
    contract,
    "export interface AssetRecordsContract { id: number }\n",
  );
  expect(addLibraryRecipe(owner, "asset-records", false).status).toBe(
    "already-installed",
  );
  expect(readFileSync(contract, "utf8")).toContain("id: number");
  expect(readFileSync(join(owner, "package.json"), "utf8")).toBe(workspace);
  rmSync(contract);
  expect(() => addLibraryRecipe(owner, "asset-records", false)).toThrow(
    /Incomplete/,
  );
});

test("preserves a preexisting library and rejects non-package paths", () => {
  const { owner } = projects();
  const directory = join(owner, "libraries/asset-records");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "README.md");
  writeFileSync(file, "belongs to the app");
  expect(() => addLibraryRecipe(owner, "asset-records", false)).toThrow(
    /Refusing/,
  );
  expect(readFileSync(file, "utf8")).toBe("belongs to the app");
  expect(() => addLibraryRecipe(owner, "../elsewhere", false)).toThrow(
    /lowercase/,
  );
});

test("an independent npm project consumes the packed runtime and declarations", () => {
  const { owner, consumer } = projects();
  const library = addLibraryRecipe(owner, "asset-records", false);
  const require = createRequire(import.meta.url);
  const compiler = require.resolve("typescript/bin/tsc");
  const env = {
    ...process.env,
    PATH: [dirname(compiler), process.env["PATH"]].join(delimiter),
  };
  execFileSync("npm", ["run", "verify:checks"], {
    cwd: owner,
    env,
  });
  const pack = execFileSync(
    "npm",
    ["pack", "--workspace", library.packageName, "--silent"],
    {
      cwd: owner,
      env,
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n")
    .at(-1);
  if (!pack) throw new Error("npm pack did not return a tarball.");
  execFileSync(
    "npm",
    ["install", "--offline", "--ignore-scripts", join(owner, pack)],
    {
      cwd: consumer,
      env,
    },
  );
  writeFileSync(
    join(consumer, "index.mts"),
    `import type { ${library.contractName} } from "${library.packageName}";
const asset: ${library.contractName} = { id: "a1" };
export { asset };
`,
  );
  execFileSync(
    process.execPath,
    [compiler, "--noEmit", "--module", "NodeNext", "--strict", "index.mts"],
    {
      cwd: consumer,
      env,
    },
  );
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import("${library.packageName}");`],
    {
      cwd: consumer,
      env,
    },
  );
}, 30_000);

function projects() {
  const root = mkdtempSync(join(tmpdir(), "dads-library-recipe-"));
  temporaryRoots.push(root);
  const owner = join(root, "owner");
  const consumer = join(root, "consumer");
  mkdirSync(owner);
  mkdirSync(consumer);
  writeFileSync(
    join(owner, "package.json"),
    JSON.stringify({
      name: "@example/owner",
      workspaces: { packages: [], nohoist: ["kept"] },
      scripts: { "verify:checks": "node --version" },
      private: true,
    }),
  );
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
  );
  writeFileSync(
    join(owner, "dads.project.json"),
    JSON.stringify({
      schemaVersion: 3,
      packages: [],
      verification: { projectId: "owner", tasks: [], fullFallbackTaskIds: [] },
    }),
  );
  return { owner, consumer };
}
