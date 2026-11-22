export {
  loadAccessSource,
  type AccessSourceKind,
  type LoadedAccessSource,
} from "./access-source-loader.js";
export {
  importZedSchema,
  type ImportZedSchemaOptions,
  type ZedSchemaImportResult,
} from "./access-import.js";
export {
  renderAccessTree,
  renderZedAccessTree,
  type AccessTreeResult,
  type RenderAccessTreeOptions,
} from "./access-tree.js";
export {
  diffAccessIrDefinitions,
  diffAccessSources,
  diffZedSchemas,
  type AccessDiffBreakingChange,
  type AccessDiffSafeChange,
  type AccessPermissionChangeSummary,
  type AccessSchemaDiff,
  type DiffZedSchemasOptions,
  type ZedSchemaDiffResult,
} from "./access-diff.js";
export {
  DEFAULT_ACCESS_MIGRATIONS_DIR,
  scaffoldAccessMigration,
  scaffoldAccessMigrationFromSources,
  type AccessMigrationScaffoldResult,
  type ScaffoldAccessMigrationOptions,
} from "./access-migrate.js";
export {
  orientProjectPath,
  parseDadsProject,
  type DadsCapabilityInstallation,
  type DadsPackageDeclaration,
  type DadsProject,
  type ProjectOrientation,
} from "./project-orientation.js";
export {
  findDadsProjectRoot,
  loadDadsProject,
  type LoadedDadsProject,
} from "./project-files.js";
export {
  synchronizeAgentSkills,
  type SkillSynchronization,
} from "./synchronize-agent-skills.js";
export {
  recommendChangedVerification,
  type ChangedVerification,
  type VerificationRecommendation,
} from "./recommend-changed-verification.js";
export {
  deriveDadsProjectName,
  initializeDadsProject,
  type InitializeDadsProjectOptions,
  type DadsClientChoice,
  type DadsAuthorizationAdapter,
  type DadsProjectInitialization,
  type DadsStarterProfile,
} from "./initialize-dads-project.js";
export {
  parseDadsInitializationArguments,
  type DadsInitializationArguments,
} from "./dads-initialization-arguments.js";
export {
  dependenciesAreInstalled,
  recordDadsDependencyInstallation,
} from "./dependency-installation-receipt.js";
export {
  diagnoseWorkspace,
  type DiagnoseWorkspaceOptions,
} from "./doctor/diagnose-workspace.js";
export {
  renderDoctorJson,
  renderDoctorReport,
  type DoctorReport,
} from "./doctor/doctor-report.js";
