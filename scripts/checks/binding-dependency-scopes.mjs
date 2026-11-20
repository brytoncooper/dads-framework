import { posix } from "node:path";

export function bindingScopes(manifest, declared, world) {
  if (
    manifest.dadsBindings === null ||
    typeof manifest.dadsBindings !== "object" ||
    Array.isArray(manifest.dadsBindings)
  ) {
    throw new Error(`Invalid source binding ${manifest.name}.`);
  }
  return Object.entries(manifest.dadsBindings).map(([name, dependencies]) => {
    const root = `${declared.root}/src/${name}`;
    if (
      declared.kind !== "core" ||
      !/^[a-z][a-z0-9-]*$/u.test(name) ||
      !world.exists(`${root}/index.ts`) ||
      manifest.exports?.[`./${name}`]?.default !== `./dist/${name}/index.js` ||
      manifest.exports?.[`./${name}`]?.types !== `./dist/${name}/index.d.ts` ||
      hasExportAlias(manifest.exports, name) ||
      !Array.isArray(dependencies) ||
      dependencies.length === 0 ||
      new Set(dependencies).size !== dependencies.length ||
      !dependencies.every(
        (dependency) =>
          (declared.allowedDependencies ?? []).includes(dependency) &&
          Object.hasOwn(manifest.peerDependencies ?? {}, dependency) &&
          manifest.peerDependenciesMeta?.[dependency]?.optional === true &&
          !Object.hasOwn(manifest.dependencies ?? {}, dependency) &&
          !Object.hasOwn(manifest.optionalDependencies ?? {}, dependency),
      )
    ) {
      throw new Error(`Invalid source binding ${manifest.name}/${name}.`);
    }
    return { name, root, dependencies: new Set(dependencies) };
  });
}

function hasExportAlias(exports, name) {
  return Object.entries(exports).some(
    ([key, target]) =>
      key !== `./${name}` &&
      targetValues(target).some((file) => file.startsWith(`./dist/${name}/`)),
  );
}

function targetValues(target) {
  if (typeof target === "string") return [target];
  if (target === null || typeof target !== "object") return [];
  return Object.values(target).flatMap(targetValues);
}

export function scopedImportProblem({
  file,
  specifier,
  owner,
  module,
  bindings,
  kind,
}) {
  const scopes = bindings.get(owner) ?? [];
  const sourceScope = scopeAt(scopes, file);
  if (specifier.startsWith(".")) {
    const target = posix.resolve("/", posix.dirname(file), specifier).slice(1);
    const targetScope = scopeAt([...bindings.values()].flat(), target);
    return targetScope !== undefined && targetScope !== sourceScope
      ? `imports binding "${specifier}" outside its source scope`
      : undefined;
  }
  if (
    scopes.some((scope) => scope.dependencies.has(module)) &&
    !sourceScope?.dependencies.has(module)
  ) {
    return `imports optional binding dependency "${specifier}" outside its source scope`;
  }
  const targetScopes = bindings.get(module) ?? [];
  const targetName = specifier.slice(module.length + 1).split("/")[0];
  const targetScope = targetScopes.find((scope) => scope.name === targetName);
  if (targetScope === undefined || sourceScope === targetScope)
    return undefined;
  if (owner !== module && (kind === "profile" || kind === "composition")) {
    return undefined;
  }
  return `imports binding "${specifier}" outside its source scope`;
}

function scopeAt(scopes, path) {
  return scopes.find(
    (scope) => path === scope.root || path.startsWith(`${scope.root}/`),
  );
}
