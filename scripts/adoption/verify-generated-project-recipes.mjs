import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { collectPackageClosure, tarballFor } from "./adoption-packing.mjs";
import { buildInternalDependencyOverrides } from "./generated-project-installation.mjs";
import { readJson, runCreator } from "./verify-generated-project-workspace.mjs";

export function assertGeneratedArtifacts(projectRoot) {
  for (const name of ["customer", "staff"]) {
    const entrypoint = join(projectRoot, "apps", name, "app.ts");
    if (!statSync(entrypoint).isFile())
      throw new Error(`Missing API entrypoint ${name}.`);
  }
  const manifest = readJson(join(projectRoot, "package.json"));
  const packages = manifest.dependencies ?? {};
  for (const name of [
    "http",
    "postgres-access",
    "identity-better-auth",
    "tenants",
  ]) {
    if (packages[`@dads-framework/${name}`] === undefined)
      throw new Error(`Missing kit dependency ${name}.`);
  }
  for (const harness of [".claude", ".codex", ".cursor"]) {
    const skills = join(projectRoot, harness, "skills");
    if (
      !lstatSync(skills).isSymbolicLink() ||
      readlinkSync(skills) !== "../.agents/skills"
    ) {
      throw new Error(`${harness} does not use canonical Dads skills.`);
    }
  }
  if (
    !statSync(
      join(projectRoot, ".agents", "skills", "add-domain", "SKILL.md"),
    ).isFile()
  ) {
    throw new Error("Missing domain skill.");
  }
}

/** Lock only local packed Dads packages. The generated project's CI owns npm ci and all checks. */
export async function lockGeneratedProject(transcript, projectRoot, context) {
  const manifestPath = join(projectRoot, "package.json");
  const manifest = readJson(manifestPath);
  const direct = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  }).filter((name) => context.packages.has(name));
  manifest.overrides = buildInternalDependencyOverrides(
    direct,
    context.packages,
    context.tarballs,
  );
  const closure = [];
  for (const name of direct)
    collectPackageClosure(name, context.packages, closure);
  for (const name of closure) {
    const section =
      manifest.devDependencies?.[name] === undefined
        ? manifest.dependencies
        : manifest.devDependencies;
    section[name] = `file:${tarballFor(context.tarballs, name)}`;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await transcript.run(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: projectRoot,
    },
  );
}

export async function verifyExistingProjectSafety({
  transcript,
  context,
  creator,
}) {
  const existingRoot = join(context.workRoot, "existing-api");
  mkdirSync(existingRoot);
  const existingPackage = '{"name":"existing-api","private":true}\n';
  writeFileSync(join(existingRoot, "package.json"), existingPackage);
  const argumentsAfterExecutable = [
    existingRoot,
    "--existing",
    "--yes",
    "--skip-install",
    "--json",
  ];
  await context.time("project-generate", async () => {
    await runCreator(transcript, creator, argumentsAfterExecutable);
    await runCreator(transcript, creator, argumentsAfterExecutable);
  });
  if (
    readFileSync(join(existingRoot, "package.json"), "utf8") !== existingPackage
  ) {
    throw new Error(
      "Existing-project initialization changed the host package.",
    );
  }
  await assertExistingProjectConflictRefused(
    transcript,
    context,
    creator,
    existingRoot,
    argumentsAfterExecutable,
  );
}

async function assertExistingProjectConflictRefused(
  transcript,
  context,
  creator,
  existingRoot,
  argumentsAfterExecutable,
) {
  const ownedRoute = join(existingRoot, "dads", "apps", "customer", "app.ts");
  writeFileSync(ownedRoute, "conflicting user content\n");
  const conflict = await context.time("project-generate", () =>
    transcript.attempt(creator.executable, argumentsAfterExecutable, {
      cwd: creator.host,
    }),
  );
  if (
    conflict.status === 0 ||
    !conflict.stderr.includes("Refusing to overwrite")
  ) {
    throw new Error(
      "Existing-project initialization did not refuse a conflict.",
    );
  }
}
