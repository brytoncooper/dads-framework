import { isRecord, isString, isUnknownArray } from "../../../parse-guards.js";
import type { DoctorContext } from "../../doctor-context.js";

type BindingOwner = {
  readonly name: string;
  readonly root: string;
  readonly kind: string | undefined;
  readonly allowedDependencies: readonly string[];
};

type SourceBinding = {
  readonly name: string;
  readonly sourceRoot: string;
  readonly dependencies: readonly string[];
};

/** A core can ship a binding only behind its own export and optional peers. */
export function readSourceBindings(
  context: DoctorContext,
  owner: BindingOwner,
): readonly SourceBinding[] {
  const path = `${owner.root}/package.json`;
  if (owner.kind !== "core" || !context.exists(path)) return [];
  const manifest: unknown = JSON.parse(context.read(path));
  if (!isRecord(manifest)) return [];
  const declaration = manifest["dadsBindings"];
  if (declaration === undefined) return [];
  if (!isRecord(declaration)) throw invalidBinding(owner.name, "");
  return Object.entries(declaration).map(([name, dependencies]) => {
    const sourceRoot = `${owner.root}/src/${name}`;
    if (
      !/^[a-z][a-z0-9-]*$/u.test(name) ||
      !context.exists(`${sourceRoot}/index.ts`) ||
      !hasMatchingExport(manifest["exports"], name) ||
      !isUnknownArray(dependencies) ||
      !dependencies.every(isString) ||
      dependencies.length === 0 ||
      new Set(dependencies).size !== dependencies.length ||
      !dependencies.every(
        (dependency) =>
          owner.allowedDependencies.includes(dependency) &&
          isOptionalPeer(manifest, dependency),
      )
    ) {
      throw invalidBinding(owner.name, name);
    }
    return { name, sourceRoot, dependencies };
  });
}

function hasMatchingExport(exports: unknown, name: string): boolean {
  if (!isRecord(exports)) return false;
  const target = exports[`./${name}`];
  return (
    isRecord(target) &&
    target["default"] === `./dist/${name}/index.js` &&
    target["types"] === `./dist/${name}/index.d.ts`
  );
}

function isOptionalPeer(
  manifest: Record<string, unknown>,
  dependency: string,
): boolean {
  const peers = manifest["peerDependencies"];
  const metadata = manifest["peerDependenciesMeta"];
  if (!isRecord(peers) || !isRecord(metadata)) return false;
  const peer = metadata[dependency];
  return (
    Object.hasOwn(peers, dependency) &&
    isRecord(peer) &&
    peer["optional"] === true &&
    !["dependencies", "optionalDependencies"].some((field) => {
      const dependencies = manifest[field];
      return isRecord(dependencies) && Object.hasOwn(dependencies, dependency);
    })
  );
}

function invalidBinding(packageName: string, name: string): Error {
  const specifier = name.length > 0 ? `${packageName}/${name}` : packageName;
  return new Error(`Invalid source binding ${specifier}.`);
}
