import { it } from "vitest";

import {
  OpenTelemetryTrace,
  RecordedTrace,
  registerRequestTraceConformance,
} from "./request-trace-conformance.test-support.js";

registerRequestTraceConformance(
  () => new RecordedTrace(),
  (title, run) => {
    it(`in-memory trace ${title}`, () => run());
  },
);

registerRequestTraceConformance(
  () => new OpenTelemetryTrace(),
  (title, run) => {
    it(`OpenTelemetry span ${title}`, () => run());
  },
);
