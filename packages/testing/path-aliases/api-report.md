# API report: @dads-framework/path-aliases

Published: yes

Regenerate with `npm run api-report`.

Entry point: @dads-framework/path-aliases

```
- type AliasFileSystem: export type AliasFileSystem = { /** True when the path names a readable file. A directory is never a file. */ readonly isFile: (path: string) => boolean; /** The file's text. Throws when the path names no readable file. */ readonly readText: (path: string) => string; /** * The absolute path a package specifier resolves to when it is required * from `fromFile`, or `undefined` when nothing there answers to that name. */ readonly resolvePackage: (specifier: string, fromFile: string) => string | undefined; };
- type AliasFileSystemFactory: export type AliasFileSystemFactory = (files: Readonly<Record<string, string>>) => AliasFileSystem;
- type AliasResolver: export type AliasResolver = (specifier: string) => null | string;
- type AliasResolverConformanceFinding: export type AliasResolverConformanceFinding = { readonly case: string; readonly law: string; readonly detail: string; };
- type AliasResolverConformanceSubject: export type AliasResolverConformanceSubject = { /** An absolute directory every fixture in one run is built under. */ readonly root: string; readonly fileSystem: AliasFileSystemFactory; };
- type AliasResolverOptions: export type AliasResolverOptions = { /** Absolute paths are preferred. Relative paths resolve from process.cwd(). */ readonly tsconfig: string; /** Where the resolver reads. `nodeFileSystem` is the disk. */ readonly fileSystem: AliasFileSystem; };
- function aliasResolverConformanceLaws: export declare function aliasResolverConformanceLaws(): readonly string[];
- function createAliasResolver: export declare function createAliasResolver(options: AliasResolverOptions): AliasResolver;
- function inMemoryFileSystem: export declare function inMemoryFileSystem(files: Readonly<Record<string, string>>): AliasFileSystem;
- const nodeFileSystem: export declare const nodeFileSystem: AliasFileSystem;
- function runAliasResolverConformance: export declare function runAliasResolverConformance(subject: AliasResolverConformanceSubject): readonly AliasResolverConformanceFinding[];
```
