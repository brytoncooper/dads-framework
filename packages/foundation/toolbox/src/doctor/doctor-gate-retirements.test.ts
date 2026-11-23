import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { runDoctorGate } from "./doctor-gate.js";
import { TS_EXPECT_ERROR_MARK } from "./hatch-names.js";

const former = { name: "@example/old", root: "packages/server/old" };
const replacement = { ...former, root: "packages/server/new" };
const floor = { floor: 1, reason: "Historical contract proof" };
const baselinePath = ".agents/source-budgets.json";
const projectPath = "dads.project.json";
const transitionsPath = ".agents/type-proof-transitions.json";
const files: string[] = [];
const previous = {
  invariantsFiles: { [former.name]: floor },
  typeTestNegativeCases: { [former.root]: floor },
};

afterEach(() => {
  for (const root of files.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

type Scenario = {
  owner?: typeof former;
  oldManifestName?: string;
  oldPath?: boolean;
  proof?: string;
  receipt?: boolean;
  floors?: object;
  global?: boolean;
  undeclared?: boolean;
};

async function compare(scenario: Scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), "dad-retired-floors-"));
  files.push(root);
  const { owner, proof } = scenario;
  write(root, projectPath, JSON.stringify({ packages: owner && !scenario.undeclared ? [owner] : [] }));
  write(root, baselinePath, JSON.stringify({ floors: scenario.floors ?? {} }));
  if (owner) write(root, `${owner.root}/package.json`, JSON.stringify({ name: owner.name }));
  if (scenario.oldPath) write(root, `${former.root}/src/kept.ts`, "export {};\n");
  if (proof !== undefined) write(root, `${replacement.root}/type-tests/proof.ts`, proof);
  if (scenario.receipt) {
    write(
      root,
      transitionsPath,
      JSON.stringify({
        [former.root]: {
          package: former.name,
          formerFloor: 1,
          replacementRoots: [replacement.root],
          reason: "New contract",
        },
      }),
    );
  }
  const base = new Map([
    [projectPath, JSON.stringify({ packages: [former] })],
    [
      baselinePath,
      JSON.stringify({
        floors: scenario.global ? { ...previous, soundnessCases: { cases: floor } } : previous,
      }),
    ],
    [`${former.root}/package.json`, JSON.stringify({ name: scenario.oldManifestName ?? former.name })],
  ]);
  return runDoctorGate({
    root,
    mode: {
      json: false,
      update: false,
      seed: false,
      report: false,
      profile: "standard",
      files: undefined,
      base: "origin/main",
      today: undefined,
      reason: undefined,
      key: undefined,
    },
    readAtRef: (_ref, path) => {
      const stdout = base.get(path);
      return stdout === undefined ? { status: 1, stdout: "" } : { status: 0, stdout };
    },
  });
}

it("allows exactly retired owner floors and leaves global floors held", async () => {
  const result = await compare({ global: true });
  expect(result.findings.map(({ measure }) => measure)).toEqual(["soundnessCases"]);
  expect(result.output).toContain("former package @example/old at packages/server/old");
});

it.each<Scenario>([{ oldManifestName: "@example/other" }, { oldPath: true }, { owner: replacement, undeclared: true }])(
  "holds the floors when the former identity or retired path is unproven",
  async (scenario) => {
    expect((await compare(scenario)).findings).toHaveLength(2);
  },
);

it("requires a same-name relocation to retain its invariant and prove an explicit replacement", async () => {
  const current = {
    invariantsFiles: { [replacement.name]: floor },
    typeTestNegativeCases: { [replacement.root]: floor },
  };
  const attempt = { owner: replacement, floors: current, receipt: true };
  const proof = 'import { expectTypeOf } from "vitest";\nexpectTypeOf<"unknown">().not.toExtend<"known">();\n';
  const quoted = `export const marker = "${TS_EXPECT_ERROR_MARK}";\n`;
  expect((await compare({ ...attempt, proof })).exitCode).toBe(0);
  expect((await compare({ ...attempt, proof, receipt: false })).exitCode).toBe(1);
  expect((await compare({ ...attempt, proof: quoted })).exitCode).toBe(1);
  expect(
    (
      await compare({
        ...attempt,
        floors: { typeTestNegativeCases: current.typeTestNegativeCases },
        proof,
      })
    ).findings.map(({ measure }) => measure),
  ).toEqual(["invariantsFiles"]);
});
