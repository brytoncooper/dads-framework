/**
 * Testing entry point (`@dads-framework/plugin/testing`): start a composed
 * plugin set in a test and prove it stops clean.
 */
export {
  assertNoLiveEffects,
  PluginLeakError,
  startForTest,
  type PluginTestHarness,
  type StartForTestOptions,
} from "./testing/start-for-test.js";
