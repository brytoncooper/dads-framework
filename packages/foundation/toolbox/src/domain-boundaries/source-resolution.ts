import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { contains, ignoredDirectory, type Owner } from "./ownership.js";

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/;

export function createSourceResolution(project: string) {
  const configurations = new Map<string, ts.ParsedCommandLine>();
  const resolvedConfigurations = new Map<string, ts.ParsedCommandLine>();
  const caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>();
  const defaults = {
    options: { module: ts.ModuleKind.NodeNext },
    fileNames: [],
    errors: [],
  };
  function configuration(directory: string): ts.ParsedCommandLine {
    const existing = resolvedConfigurations.get(directory);
    if (existing) return existing;
    const path = ts.findConfigFile(
      directory,
      (file) => contains(project, file) && ts.sys.fileExists(file),
    );
    const result = path ? loadConfiguration(path, configurations) : defaults;
    resolvedConfigurations.set(directory, result);
    return result;
  }
  return {
    files(owners: readonly Owner[]): readonly string[] {
      const scoped = owners.flatMap((owner) => scanSources(owner.root));
      const configured = configuration(project).fileNames.filter((file) =>
        insideSource(project, file),
      );
      const src = join(project, "src");
      const standard = lstatSync(src, { throwIfNoEntry: false })?.isDirectory()
        ? scanSources(src)
        : [];
      return [...new Set([...scoped, ...configured, ...standard])].sort();
    },
    read(path: string) {
      const { options } = configuration(dirname(path));
      return ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        {
          languageVersion: ts.ScriptTarget.Latest,
          impliedNodeFormat: ts.getImpliedNodeFormatForFile(
            path,
            undefined,
            ts.sys,
            options,
          ),
        },
        true,
      );
    },
    resolve(
      source: ts.SourceFile,
      literal: ts.StringLiteralLike,
      require: boolean,
    ) {
      const path = source.fileName;
      const { options } = configuration(dirname(path));
      const cache =
        caches.get(options) ??
        ts.createModuleResolutionCache(project, (file) => file, options);
      caches.set(options, cache);
      const mode = require
        ? ts.ModuleKind.CommonJS
        : ts.getModeForUsageLocation(source, literal, options);
      const result = ts.resolveModuleName(
        literal.text,
        path,
        options,
        ts.sys,
        cache,
        undefined,
        mode,
      ).resolvedModule;
      const file = result?.resolvedFileName;
      return file && ts.sys.fileExists(file) ? realpathSync(file) : undefined;
    },
  };
}

function loadConfiguration(
  path: string,
  cache: Map<string, ts.ParsedCommandLine>,
) {
  const saved = cache.get(path);
  if (saved) return saved;
  const config = ts.getParsedCommandLineOfConfigFile(
    path,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!config) throw new Error(`Cannot read TypeScript configuration ${path}.`);
  const problem = config.errors.find((error) => error.code !== 18003);
  if (problem)
    throw new Error(ts.flattenDiagnosticMessageText(problem.messageText, "\n"));
  cache.set(path, config);
  return config;
}

function scanSources(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (ignoredDirectory(entry.name)) return [];
    if (entry.isDirectory()) return scanSources(path);
    if (entry.isFile() && sourceExtension.test(entry.name)) return [path];
    return [];
  });
}

export function insideSource(project: string, file: string): boolean {
  if (!contains(project, file) || !sourceExtension.test(file)) return false;
  const segments = file.slice(project.length + 1).split(/[\\/]/);
  return !segments.some(ignoredDirectory) && realpathSync(file) === file;
}

export function isLocalTarget(project: string, file: string): boolean {
  return (
    contains(project, file) &&
    !file
      .slice(project.length + 1)
      .split(/[\\/]/)
      .includes("node_modules")
  );
}
