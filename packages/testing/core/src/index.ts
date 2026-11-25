export {
  checkTestingBoundaries,
  diagnoseTesting,
  expandTestingManifest,
  planTesting,
  runTesting,
  type TestingBoundariesResult,
  type TestingBoundaryViolation,
  type TestingCheckBoundariesRequest,
  type TestingCouplingHotspot,
  type TestingDiagnoseRemediation,
  type TestingDiagnoseRequest,
  type TestingDiagnoseResult,
  type TestingDiagnoseSummary,
  type TestingExpandManifestRequest,
  type TestingFallbackTrap,
  type TestingOperationRequest,
  type TestingPlanIssue,
  type TestingPlanResult,
  type TestingRemediationSafety,
  type TestingRunResult,
  type TestingTaskCause,
  type TestingTaskDecision,
  type TestingTaskOutput,
  type TestingTaskRunResult,
  type TestingTaskShard,
  type TestingWideningCulprit,
} from "./testing-api.js";
export { renderBoundariesResult } from "./commands/check-boundaries.js";
export { renderDiagnosis } from "./commands/diagnose.js";
export { listDadTestCommands, runDadTestCli, type DadTestCliIo } from "./dad-test-cli.js";
export {
  parseTestingManifest,
  readTestingManifest,
  serializeTestingManifest,
  type TestingManifest,
  type TestingManifestDepConstraint,
  type TestingManifestFileNarrowing,
  type TestingManifestProject,
  type TestingManifestSqlEdge,
  type TestingManifestSqlSnapshotPattern,
  type TestingManifestTask,
  type TestingManifestTaskBatch,
  type TestingManifestTaskSqlImpact,
  type TestingManifestWorkspaceBoundaries,
  type TestingManifestWorkspaceSql,
} from "./testing-manifest.js";
export { owningProjectForPath, pathIsInside } from "./path-ownership.js";
export { formatIssueLocation, issueScope, issueSeverity } from "./plan-issues.js";
export { writeFilesAtomically } from "./write-files-atomically.js";
export {
  explainPlan,
  reasonTexts,
  renderPlanExplanation,
  type ExplainedIssue,
  type ExplainedTask,
  type ExplanationCause,
  type PlanExplanation,
} from "./explain-plan.js";
export { buildTestingReport, type ReportIssue, type TestingReport } from "./testing-report.js";
export {
  initTestingManifest,
  type InitTestingManifestOptions,
  type InitTestingManifestResult,
} from "./init/init-testing-manifest.js";
export {
  inferTestingManifest,
  type InitInference,
  type InitReport,
  type InitUnsupported,
} from "./init/infer-testing-manifest.js";
export { checkTestingManifest } from "./init/check-testing-manifest.js";
export {
  detectNativeLibc,
  nativePackageNameForPlatform,
  resolveNativeTestingBinary,
  type NativeBinaryResolution,
  type NativeBinarySource,
  type NativeLibc,
  type NativePackageResolver,
} from "./native-platform.js";
export { detectWorkspace, type DetectedWorkspace } from "./init/detect-workspace.js";
