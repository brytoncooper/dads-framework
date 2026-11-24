# API report: @dads-framework/toolbox

Published: yes

Regenerate with `npm run api-report`.

Entry point: @dads-framework/toolbox

```
- type AccessDiffBreakingChange: export type AccessDiffBreakingChange = { readonly kind: "narrowed-role"; readonly resource: string; readonly role: string; readonly subject: string; } | { readonly kind: "removed-expiration"; readonly resource: string; readonly role: string; readonly subject: string; } | { readonly kind: "removed-resource"; readonly resource: string; } | { readonly kind: "removed-role"; readonly resource: string; readonly role: string; };
- type AccessDiffSafeChange: export type AccessDiffSafeChange = { readonly kind: "added-expiration"; readonly resource: string; readonly role: string; readonly subject: string; } | { readonly kind: "added-permission"; readonly resource: string; readonly permission: string; readonly expression: string; } | { readonly kind: "added-resource"; readonly resource: string; } | { readonly kind: "added-role"; readonly resource: string; readonly role: string; } | { readonly kind: "modified-permission"; readonly resource: string; readonly permission: string; readonly before: string; readonly after: string; } | { readonly kind: "removed-permission"; readonly resource: string; readonly permission: string; readonly before: string; } | { readonly kind: "widened-role"; readonly resource: string; readonly role: string; readonly subject: string; };
- type AccessMigrationScaffoldResult: export type AccessMigrationScaffoldResult = { readonly id: string; readonly slug: string; readonly fromPath: string; readonly toPath: string; readonly outDir: string; readonly filePath: string; readonly dryRun: boolean; readonly written: boolean; readonly requiresMigration: boolean; readonly diff: AccessSchemaDiff; readonly code: string; };
- type AccessPermissionChangeSummary: export type AccessPermissionChangeSummary = { readonly kind: "added" | "modified" | "removed"; readonly resource: string; readonly permission: string; readonly before?: string; readonly after?: string; readonly description: string; };
- type AccessSchemaDiff: export type AccessSchemaDiff = { readonly safe: readonly AccessDiffSafeChange[]; readonly breaking: readonly AccessDiffBreakingChange[]; readonly permissionChanges: readonly AccessPermissionChangeSummary[]; readonly requiresMigration: boolean; readonly summary: string; };
- type AccessSourceKind: export type AccessSourceKind = "module" | "zed";
- type AccessTreeResult: export type AccessTreeResult = { readonly inputPath: string; readonly definitionCount: number; readonly definitions: readonly string[]; readonly tree: string; };
- type ChangedVerification: export type ChangedVerification = { readonly packages: readonly VerificationRecommendation[]; readonly unownedPaths: readonly string[]; readonly tasks: readonly VerificationTaskRecommendation[]; readonly unknownPaths: readonly string[]; readonly usedFullFallback: boolean; readonly complete: boolean; readonly issues: readonly string[]; };
- const DEFAULT_ACCESS_MIGRATIONS_DIR: export declare const DEFAULT_ACCESS_MIGRATIONS_DIR = "access/migrations";
- type DadsAuthorizationAdapter: export type DadsAuthorizationAdapter = "memory" | "postgres" | "spicedb";
- type DadsCapabilityInstallation: export type DadsCapabilityInstallation = { readonly name: string; readonly recipeVersion: number; readonly profile: string; readonly client: string; readonly ownedFiles: readonly string[]; };
- type DadsClientChoice: export type DadsClientChoice = "none" | "typescript";
- type DadsInitializationArguments: export type DadsInitializationArguments = { readonly targetDirectory: string; readonly mode: "existing" | "new"; readonly projectName?: string; readonly template: DadsProjectTemplate; readonly acceptDefaults: boolean; readonly dryRun: boolean; readonly skipInstall: boolean; readonly json: boolean; };
- type DadsPackageDeclaration: export type DadsPackageDeclaration = { readonly name: string; readonly root: string; readonly responsibility: string; readonly allowedDependencies: readonly string[]; readonly verification: readonly string[]; readonly skills: readonly string[]; };
- type DadsProject: export type DadsProject = { readonly schemaVersion: 1 | 2 | 3; readonly capabilities: readonly DadsCapabilityInstallation[]; readonly packages: readonly DadsPackageDeclaration[]; readonly verificationPolicy: VerificationPolicy; };
- type DadsProjectInitialization: export type DadsProjectInitialization = { readonly projectRoot: string; readonly created: readonly string[]; readonly unchanged: readonly string[]; };
- type DadsStarterProfile: export type DadsStarterProfile = "standard" | "strict";
- type DiagnoseWorkspaceOptions: export type DiagnoseWorkspaceOptions = { /** The repository to read. Relative paths resolve against the process. */ readonly root: string; /** The date the signals that need one measure against, as `YYYY-MM-DD`. */ readonly today?: string | undefined; /** The thresholds to judge against. `standard` when it is not named. */ readonly profile?: DoctorProfile | undefined; /** Issue ids to narrow the report to. Every issue when it is not named. */ readonly issues?: readonly string[] | undefined; /** Whether the three signals that ask the network may run. Off by default. */ readonly online?: boolean | undefined; };
- type DiffZedSchemasOptions: export type DiffZedSchemasOptions = { readonly beforePath: string; readonly afterPath: string; readonly cwd?: string; };
- type DoctorReport: export type DoctorReport = { readonly ok: true; readonly overCeilingCount: number; readonly gatePassed: boolean; readonly root: string; readonly profile: DoctorProfile; /** The date `--today` supplied, or `null`. Nothing here asks a clock. */ readonly today: null | string; readonly issues: readonly ReportedIssue[]; };
- type ImportZedSchemaOptions: export type ImportZedSchemaOptions = { readonly inputPath: string; readonly outPath?: string; readonly dryRun?: boolean; readonly cwd?: string; };
- type InitializeDadsProjectOptions: export type InitializeDadsProjectOptions = { readonly targetDirectory: string; readonly mode: "existing" | "new"; readonly projectName: string; readonly template?: DadsProjectTemplate; readonly dryRun?: boolean; };
- type LoadedAccessSource: export type LoadedAccessSource = { readonly path: string; readonly kind: AccessSourceKind; readonly model: AccessModel; readonly definitions: readonly AccessIrDefinition[]; };
- type LoadedDadsProject: export type LoadedDadsProject = { readonly root: string; readonly project: DadsProject; };
- type MigrateTargetVersion: export type MigrateTargetVersion = "0.3.0" | "0.4.0" | "0.5.0" | "0.5.1" | "0.5.2" | "0.6.0" | "0.6.1";
- type MigrateToV03Options: export type MigrateToV03Options = { readonly root: string; readonly dryRun?: boolean; readonly includeMigrations?: boolean; readonly targetVersion?: MigrateTargetVersion; };
- type MigrateToV03Result: export type MigrateToV03Result = { readonly root: string; readonly targetVersion: MigrateTargetVersion; readonly dryRun: boolean; readonly filesChanged: readonly string[]; readonly packageManifestsUpdated: number; readonly importReplacements: number; readonly addedPeers: readonly string[]; readonly skippedMigrations: readonly string[]; readonly followUps: readonly string[]; };
- const PEERS_FOR_RETIRED_PACKAGE: export declare const PEERS_FOR_RETIRED_PACKAGE: Readonly<Record<string, Readonly<Record<string, string>>>>;
- type ProjectOrientation: export type ProjectOrientation = { readonly packageName: string; readonly packageRoot: string; readonly responsibility: string; readonly allowedDependencies: readonly string[]; readonly verification: readonly string[]; readonly skills: readonly string[]; };
- const RETIRED_PACKAGE_TO_TARGET: export declare const RETIRED_PACKAGE_TO_TARGET: Readonly<Record<string, string>>;
- type RenderAccessTreeOptions: export type RenderAccessTreeOptions = { readonly inputPath: string; readonly cwd?: string; };
- type ScaffoldAccessMigrationOptions: export type ScaffoldAccessMigrationOptions = { readonly slug: string; readonly fromPath: string; readonly toPath: string; readonly outDir?: string; readonly dryRun?: boolean; readonly cwd?: string; };
- type SkillSynchronization: export type SkillSynchronization = { readonly harness: string; readonly status: "correct" | "created"; };
- const V03_TARGET_VERSION: export declare const V03_TARGET_VERSION = "0.3.0";
- type VerificationRecommendation: export type VerificationRecommendation = { readonly packageName: string; readonly reason: string; readonly commands: readonly string[]; };
- type ZedSchemaDiffResult: export type ZedSchemaDiffResult = { readonly beforePath: string; readonly afterPath: string; readonly diff: AccessSchemaDiff; };
- type ZedSchemaImportResult: export type ZedSchemaImportResult = { readonly inputPath: string; readonly outPath: null | string; readonly definitionCount: number; readonly definitions: readonly string[]; readonly dryRun: boolean; readonly written: boolean; readonly code: string; };
- function dependenciesAreInstalled: export declare function dependenciesAreInstalled(projectRoot: string): boolean;
- function deriveDadsProjectName: export declare function deriveDadsProjectName(targetDirectory: string, mode: "existing" | "new"): string;
- function diagnoseWorkspace: export declare function diagnoseWorkspace(options: DiagnoseWorkspaceOptions): Promise<DoctorReport>;
- function diffAccessIrDefinitions: export declare function diffAccessIrDefinitions(before: readonly AccessIrDefinition[], after: readonly AccessIrDefinition[]): AccessSchemaDiff;
- function diffAccessSources: export declare function diffAccessSources(options: DiffZedSchemasOptions): Promise<ZedSchemaDiffResult>;
- function diffZedSchemas: export declare function diffZedSchemas(options: DiffZedSchemasOptions): ZedSchemaDiffResult;
- function findDadsProjectRoot: export declare function findDadsProjectRoot(startPath: string): string;
- function importZedSchema: export declare function importZedSchema(options: ImportZedSchemaOptions): ZedSchemaImportResult;
- function initializeDadsProject: export declare function initializeDadsProject(options: InitializeDadsProjectOptions): DadsProjectInitialization;
- function loadAccessSource: export declare function loadAccessSource(inputPath: string, cwd?: string): Promise<LoadedAccessSource>;
- function loadDadsProject: export declare function loadDadsProject(startPath: string): LoadedDadsProject;
- function migrateWorkspaceToV03: export declare function migrateWorkspaceToV03(options: MigrateToV03Options): MigrateToV03Result;
- function orientProjectPath: export declare function orientProjectPath(project: DadsProject, requestedPath: string): ProjectOrientation | undefined;
- function parseDadsInitializationArguments: export declare function parseDadsInitializationArguments(argumentsAfterCommand: readonly string[]): DadsInitializationArguments;
- function parseDadsProject: export declare function parseDadsProject(input: unknown): DadsProject;
- function recommendChangedVerification: export declare function recommendChangedVerification(project: DadsProject, changedPaths: readonly string[], options?: { readonly trustEmptyScope?: boolean; }): ChangedVerification;
- function recordDadsDependencyInstallation: export declare function recordDadsDependencyInstallation(projectRoot: string): void;
- function renderAccessTree: export declare function renderAccessTree(options: RenderAccessTreeOptions): Promise<AccessTreeResult>;
- function renderDoctorJson: export declare function renderDoctorJson(report: DoctorReport): string;
- function renderDoctorReport: export declare function renderDoctorReport(report: DoctorReport): string;
- function renderZedAccessTree: export declare function renderZedAccessTree(options: RenderAccessTreeOptions): AccessTreeResult;
- function rewriteV03ImportSpecifier: export declare function rewriteV03ImportSpecifier(specifier: string): string;
- function scaffoldAccessMigration: export declare function scaffoldAccessMigration(options: ScaffoldAccessMigrationOptions): AccessMigrationScaffoldResult;
- function scaffoldAccessMigrationFromSources: export declare function scaffoldAccessMigrationFromSources(options: ScaffoldAccessMigrationOptions): Promise<AccessMigrationScaffoldResult>;
- function synchronizeAgentSkills: export declare function synchronizeAgentSkills(projectRoot: string): readonly SkillSynchronization[];
```

Entry point: @dads-framework/toolbox/dev

```
- type WorktreeRemovalFacts: export type WorktreeRemovalFacts = { readonly primary: boolean; readonly locked: boolean; readonly dirty: boolean; readonly running: boolean; readonly pushed: boolean; readonly mergedPatch: boolean; readonly empty: boolean; readonly idleMinutes: number; };
- function decideWorktreeRemoval: export declare function decideWorktreeRemoval(facts: WorktreeRemovalFacts): { readonly remove: false; readonly reason: KeepReason; } | { readonly remove: true; readonly reason: RemovalReason; };
```
