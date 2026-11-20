/**
 * Testing entry point (`@dads-framework/client-telemetry/testing`) — the recording
 * fake only, kept out of the main barrel so production code cannot import it.
 */
export {
  FakeClientTelemetry,
  type ReportedFault,
} from "@dads-framework/client-telemetry-core/testing";
