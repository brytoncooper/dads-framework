import { isRecord } from "../parse-guards.js";
import type { GenerationPlan } from "./generation-plan.js";

const REACT = "^19.0.0";

export function ensureGeneratorDependencies(plan: GenerationPlan, artifact: "email" | "resource"): void {
  const path = "package.json";
  const source = plan.read(path);
  if (source === undefined) throw new Error("Run this generator at the application root.");
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new Error("Expected an application package.json.");
  const dependencies = dependenciesOf(value["dependencies"]);
  const devDependencies = dependenciesOf(value["devDependencies"]);
  const frameworkVersion = dependencies["@dads-framework/core"];
  if (typeof frameworkVersion !== "string")
    throw new Error("Expected a Dads starter with @dads-framework/core installed.");
  const required = runtimeDependencies(artifact, frameworkVersion);
  const requiredDev = { "@types/react": REACT };
  if (hasDependencies(dependencies, required) && hasDependencies(devDependencies, requiredDev)) return;

  plan.rewrite(
    path,
    JSON.stringify(
      {
        ...value,
        dependencies: sorted({ ...required, ...dependencies }),
        devDependencies: sorted({ ...requiredDev, ...devDependencies }),
      },
      null,
      2,
    ) + "\n",
  );
}

function runtimeDependencies(artifact: "email" | "resource", version: string): Record<string, string> {
  if (artifact === "email") return { react: REACT, "@dads-framework/email": version };
  return {
    react: REACT,
    "@dads-framework/access": version,
    "@dads-framework/client": version,
    "@dads-framework/core": version,
  };
}

function hasDependencies(existing: Record<string, string>, required: Record<string, string>): boolean {
  return Object.keys(required).every((dependency) => Object.hasOwn(existing, dependency));
}

function dependenciesOf(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("Expected package.json dependencies to be a map.");
  const entries = Object.entries(value).map(([name, version]): [string, string] => {
    if (typeof version !== "string") throw new Error(`Invalid dependency version for ${name}.`);
    return [name, version];
  });
  return Object.fromEntries(entries);
}

function sorted(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}
