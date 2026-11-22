export { FakeAuthorization } from "./fake-authorization.js";
export { RecordingAuthorization } from "./recording-authorization.js";
export { runOutsideHeldPartitions } from "./owner-lock.js";

export {
  ControllableClock,
  formatRelativeDuration,
  parseTestDurationMs,
  type TestDuration,
} from "../testing/duration.js";
export {
  formatPermissionExplanation,
  type PermissionExplanation,
  type PermissionTrace,
} from "../testing/explain-format.js";
export {
  InMemoryAuthorization,
  type InMemoryAuthorizationOptions,
} from "../testing/in-memory-authorization.js";
export {
  createAccessHarness,
  type AccessHarness,
} from "../testing/access-harness.js";
export type {
  AccessScenarioVerbs,
  GrantBuilder,
  HarnessEntityTarget,
  HarnessSubjectInput,
  MatrixDecision,
  MatrixRow,
  PermissionMatrixSpec,
  ProveAccessOptions,
  RevokeBuilder,
  ScenarioStep,
} from "../testing/access-harness-types.js";
export { proveAccess } from "../testing/prove-access.js";
export {
  defineAccessScenario,
  proveScenario,
  proveScenarioSync,
  proveWorld,
  proveWorldSync,
  type AccessScenario,
  type ComposableScenarioVerbs,
} from "../testing/prove-world.js";
