export { clockService, provideClock } from "./lib/clock-service.js";
export { composeApi, type ApiSelection } from "./lib/compose-api.js";
export { composeApp, type ComposedApp, type DependencyCheck } from "./lib/compose-app.js";
export {
  createTestHost,
  overrideService,
  startTestHost,
  type CreateTestHostPluginsOptions,
  type CreateTestHostSelectionOptions,
  type TestHost,
  type TestServiceOverride,
} from "./lib/create-test-host.js";
export {
  definePlugin,
  type AnyPlugin,
  type Plugin,
  type PluginSetupContext,
  type PluginSpec,
} from "./lib/define-plugin.js";
export { defineService, type AnyServiceBinding, type Service, type ServiceBinding } from "./lib/define-service.js";
export {
  CompositionRun,
  type AnyDependency,
  type Dependency,
  type DependencyKind,
  type DependencyValue,
} from "./lib/dependency.js";
export type { PluginMigrationSource } from "./lib/migration-sources.js";
export type {
  AccessContribution,
  AuditScopeContribution,
  AuditSettings,
  DeclaredContributions,
  MigrationFolder,
  NamedJob,
  PluginContributions,
  PluginRuntime,
  SluggedFlag,
  StartedContributions,
} from "./lib/plugin-contributions.js";
export {
  PluginCompositionError,
  PluginStartError,
  PluginStopError,
  type PluginDisposalFailure,
} from "./lib/plugin-errors.js";
export { PluginScopeClosedError, type Disposer, type PluginScope, type ScopeLedger } from "./lib/plugin-scope.js";
export { providePlugin } from "./lib/provide-plugin.js";
export type { RunningApp } from "./lib/start-plugins.js";
