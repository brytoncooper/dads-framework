import { writeOutput } from "./cli-io.js";
import { addAccess } from "./resource-generators/access-generator.js";
import {
  ensureDomain,
  mountDomain,
  requireDomain,
} from "./resource-generators/domain-generator.js";
import { addEmail } from "./resource-generators/email-generator.js";
import { addEndpoint } from "./resource-generators/endpoint-generator.js";
import { addFlag } from "./resource-generators/flag-generator.js";
import { addResource } from "./resource-generators/generate-resource.js";
import { GenerationPlan } from "./resource-generators/generation-plan.js";
import {
  parseGeneratorArguments,
  type GeneratorArguments,
} from "./resource-generators/generator-arguments.js";
import { ensureGeneratorDependencies } from "./resource-generators/generator-dependencies.js";
import { addPage } from "./resource-generators/page-generator.js";
import { addTable } from "./resource-generators/table-generator.js";

export function addProjectArtifact(
  args: readonly string[],
  json: boolean,
): void {
  writeOutput(
    {
      ok: true,
      result: generateProjectArtifact(
        process.cwd(),
        parseGeneratorArguments(args),
      ),
    },
    json,
  );
}

export function generateProjectArtifact(
  root: string,
  options: GeneratorArguments,
) {
  const plan = new GenerationPlan(root);
  if (plan.read("dads.project.json") === undefined)
    throw new Error("Run this generator from a Dads application root.");
  if (options.kind === "domain" || options.kind === "resource")
    ensureDomain(plan, options.domain);
  else requireDomain(plan, options.domain);

  writeArtifacts(plan, root, options);
  if (options.api !== undefined) mountDomain(plan, options.api, options.domain);
  if (!options.dryRun) plan.write();
  return {
    kind: options.kind,
    domain: options.domain,
    files: plan.paths(),
    dryRun: options.dryRun,
  };
}

function writeArtifacts(
  plan: GenerationPlan,
  root: string,
  { kind, domain, name }: GeneratorArguments,
): void {
  switch (kind) {
    case "domain":
      return;
    case "endpoint":
      addEndpoint(plan, domain, name);
      return;
    case "table":
      addTable(plan, root, domain, name);
      return;
    case "access":
      addAccess(plan, domain, name);
      return;
    case "flag":
      addFlag(plan, domain, name);
      return;
    case "email":
      ensureGeneratorDependencies(plan, kind);
      addEmail(plan, domain, name);
      return;
    case "page":
      addPage(plan, domain, name);
      return;
    case "resource":
      ensureGeneratorDependencies(plan, kind);
      addResource(plan, root, domain, name);
      return;
  }
}
