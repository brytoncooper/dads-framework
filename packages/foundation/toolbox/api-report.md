# API report: @dads-framework/toolbox

Published: no

Regenerate with `npm run api-report`.

Entry point: @dads-framework/toolbox

```
- type ChangedVerification: export type ChangedVerification = { readonly packages: readonly VerificationRecommendation[]; readonly unownedPaths: readonly string[]; readonly tasks: readonly VerificationTaskRecommendation[]; readonly unknownPaths: readonly string[]; readonly usedFullFallback: boolean; readonly complete: boolean; readonly issues: readonly string[]; };
- type DadsAuthorizationAdapter: export type DadsAuthorizationAdapter = "memory" | "postgres" | "spicedb";
- type DadsCapabilityInstallation: export type DadsCapabilityInstallation = { readonly name: string; readonly recipeVersion: number; readonly profile: string; readonly client: string; readonly ownedFiles: readonly string[]; };
- type DadsClientChoice: export type DadsClientChoice = "none" | "typescript";
- type DadsInitializationArguments: export type DadsInitializationArguments = { readonly targetDirectory: string; readonly mode: "existing" | "new"; readonly projectName?: string; readonly acceptDefaults: boolean; readonly dryRun: boolean; readonly skipInstall: boolean; readonly json: boolean; };
- type DadsPackageDeclaration: export type DadsPackageDeclaration = { readonly name: string; readonly root: string; readonly responsibility: string; readonly allowedDependencies: readonly string[]; readonly verification: readonly string[]; readonly skills: readonly string[]; };
- type DadsProject: export type DadsProject = { readonly schemaVersion: 1 | 2 | 3; readonly capabilities: readonly DadsCapabilityInstallation[]; readonly packages: readonly DadsPackageDeclaration[]; readonly verificationPolicy: VerificationPolicy; };
- type DadsProjectInitialization: export type DadsProjectInitialization = { readonly projectRoot: string; readonly created: readonly string[]; readonly unchanged: readonly string[]; };
- type DadsStarterProfile: export type DadsStarterProfile = "standard" | "strict";
- type DiagnoseWorkspaceOptions: export type DiagnoseWorkspaceOptions = { /** The repository to read. Relative paths resolve against the process. */ readonly root: string; /** The date the signals that need one measure against, as `YYYY-MM-DD`. */ readonly today?: string | undefined; /** The thresholds to judge against. `standard` when it is not named. */ readonly profile?: DoctorProfile | undefined; /** Issue ids to narrow the report to. Every issue when it is not named. */ readonly issues?: readonly string[] | undefined; /** Whether the three signals that ask the network may run. Off by default. */ readonly online?: boolean | undefined; };
- type DoctorReport: export type DoctorReport = { readonly ok: true; readonly root: string; readonly profile: DoctorProfile; /** The date `--today` supplied, or `null`. Nothing here asks a clock. */ readonly today: null | string; readonly issues: readonly ReportedIssue[]; };
- type InitializeDadsProjectOptions: export type InitializeDadsProjectOptions = { readonly targetDirectory: string; readonly mode: "existing" | "new"; readonly projectName: string; readonly dryRun?: boolean; };
- type LoadedDadsProject: export type LoadedDadsProject = { readonly root: string; readonly project: DadsProject; };
- type ProjectOrientation: export type ProjectOrientation = { readonly packageName: string; readonly packageRoot: string; readonly responsibility: string; readonly allowedDependencies: readonly string[]; readonly verification: readonly string[]; readonly skills: readonly string[]; };
- type SkillSynchronization: export type SkillSynchronization = { readonly harness: string; readonly status: "correct" | "created"; };
- type VerificationRecommendation: export type VerificationRecommendation = { readonly packageName: string; readonly reason: string; readonly commands: readonly string[]; };
- function dependenciesAreInstalled: export declare function dependenciesAreInstalled(projectRoot: string): boolean;
- function deriveDadsProjectName: export declare function deriveDadsProjectName(targetDirectory: string, mode: "existing" | "new"): string;
- function diagnoseWorkspace: export declare function diagnoseWorkspace(options: DiagnoseWorkspaceOptions): Promise<DoctorReport>;
- function findDadsProjectRoot: export declare function findDadsProjectRoot(startPath: string): string;
- function initializeDadsProject: export declare function initializeDadsProject(options: InitializeDadsProjectOptions): DadsProjectInitialization;
- function loadDadsProject: export declare function loadDadsProject(startPath: string): LoadedDadsProject;
- function orientProjectPath: export declare function orientProjectPath(project: DadsProject, requestedPath: string): ProjectOrientation | undefined;
- function parseDadsInitializationArguments: export declare function parseDadsInitializationArguments(argumentsAfterCommand: readonly string[]): DadsInitializationArguments;
- function parseDadsProject: export declare function parseDadsProject(input: unknown): DadsProject;
- function recommendChangedVerification: export declare function recommendChangedVerification(project: DadsProject, changedPaths: readonly string[], options?: { readonly trustEmptyScope?: boolean; }): ChangedVerification;
- function recordDadsDependencyInstallation: export declare function recordDadsDependencyInstallation(projectRoot: string): void;
- function renderDoctorJson: export declare function renderDoctorJson(report: DoctorReport): string;
- function renderDoctorReport: export declare function renderDoctorReport(report: DoctorReport): string;
- function synchronizeAgentSkills: export declare function synchronizeAgentSkills(projectRoot: string): readonly SkillSynchronization[];
```
