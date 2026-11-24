export {
  createEnforceModuleBoundariesRule,
  enforceModuleBoundariesPlugin,
  extractBoundaryPackageName,
  type DepConstraint,
  type EslintBoundaryPlugin,
  type EslintReportDescriptor,
  type EslintRuleContext,
  type EslintRuleDefinition,
  type EslintRuleListener,
  type ModuleBoundariesOptions,
} from "./enforce-module-boundaries.js";
export {
  findBoundaryWorkspaceRoot,
  getCachedWorkspaceBoundaryIndex,
  loadWorkspaceBoundaryIndex,
  type BoundaryProject,
  type WorkspaceBoundaryIndex,
} from "./workspace-index.js";
