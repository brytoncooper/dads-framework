# API report: @dads-framework/testing-import-nx

Published: no

Regenerate with `npm run api-report`.

Entry point: @dads-framework/testing-import-nx

```
- type DadsTestingManifest: export type DadsTestingManifest = { readonly schemaVersion: 1; readonly workspace: { readonly root: "."; readonly fullFallback: { readonly taskIds: readonly string[]; }; }; readonly projects: readonly { readonly id: string; readonly root: string; readonly fallbackDependencies: readonly string[]; }[]; readonly tasks: readonly DadsTestingTask[]; };
- type DadsTestingTask: export type DadsTestingTask = { readonly id: string; readonly project: string; readonly kind: "build" | "custom" | "lint" | "test" | "typecheck"; readonly execution: { readonly executable: string; readonly args?: readonly string[]; readonly cwd: string; }; readonly dependsOn: readonly string[]; readonly impact: { readonly mode: "project"; }; };
- type ImportNxTestingOptions: export type ImportNxTestingOptions = { readonly workspaceRoot: string; /** Full immutable Git object ID the caller approved for this import. */ readonly expectedGitSha: string; readonly runner?: NxCommandRunner; };
- type ImportNxTestingResult: export type ImportNxTestingResult = { readonly manifest: DadsTestingManifest; readonly report: NxImportReport; readonly manifestPath: string; readonly reportPath: string; };
- type JsonValue: export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue; };
- type NativeNxCoverage: export type NativeNxCoverage = { readonly projects: number; readonly targets: number; readonly registered: number; readonly excluded: number; readonly always: number; readonly tasks: readonly { readonly project: string; readonly target: string; readonly classification: "excluded" | "registered"; readonly reason: string; readonly taskId?: string; readonly impactMode?: "always" | "changed-files"; }[]; };
- type NativeNxTestingOptions: export type NativeNxTestingOptions = Omit<TestingOperationRequest, "manifestPath" | "taskIds"> & { /** Exact Nx target names; omitted selects verification target families. */ readonly targetNames?: readonly string[]; };
- type NativeNxTestingResult: export type NativeNxTestingResult = { readonly coverage: NativeNxCoverage; readonly plan: TestingPlanResult; readonly run?: TestingRunResult; };
- type NxCommandRunner: export type NxCommandRunner = (input: { readonly executable: string; readonly args: readonly string[]; readonly cwd: string; }) => Promise<{ readonly stdout: string; readonly stderr: string; }>;
- type NxImportReport: export type NxImportReport = { readonly schemaVersion: 1; readonly importer: { readonly name: "@dads-framework/testing-import-nx"; readonly manifestChecksum: null | string; }; readonly source: { readonly workspaceRoot: string; readonly expectedGitSha: string; readonly resolvedGitSha: string; readonly versions: Readonly<Record<string, string>>; readonly inputs: readonly { readonly path: string; readonly sha256: string; }[]; readonly locations: readonly string[]; }; readonly nx: { readonly projects: readonly string[]; readonly resolvedProjects: readonly { readonly name: string; readonly configuration: JsonValue; }[]; readonly projectGraph: JsonValue; readonly executors: readonly string[]; readonly plugins: readonly string[]; }; readonly summary: { readonly projects: number; readonly targets: number; readonly converted: number; readonly excluded: number; }; readonly tasks: readonly ImportedTaskAudit[]; readonly droppedFields: readonly DroppedField[]; readonly failures: readonly ImportFailure[]; };
- function importNxTestingWorkspace: export declare function importNxTestingWorkspace(options: ImportNxTestingOptions): Promise<ImportNxTestingResult>;
- function planNativeNxTesting: export declare function planNativeNxTesting(options: NativeNxTestingOptions): Promise<NativeNxTestingResult>;
- function runNativeNxTesting: export declare function runNativeNxTesting(options: NativeNxTestingOptions): Promise<NativeNxTestingResult>;
```
