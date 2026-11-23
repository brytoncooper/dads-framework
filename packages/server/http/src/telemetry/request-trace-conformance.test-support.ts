import { deepEqual, equal } from "node:assert/strict";
import { context } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

import type { RequestTraceFacts } from "./core/index.js";
import { recordRequestTrace, traceAttributionCases } from "./core/testing/index.js";
import { annotateRequest } from "./trace-request.js";

type RequestTrace = {
  attributesFor(facts: RequestTraceFacts): Promise<unknown>;
};

export class RecordedTrace implements RequestTrace {
  attributesFor(facts: RequestTraceFacts): Promise<unknown> {
    const recorder = recordRequestTrace();
    recorder.annotateRequest(facts);
    return Promise.resolve(recorder.spans());
  }
}

export class OpenTelemetryTrace implements RequestTrace {
  async attributesFor(facts: RequestTraceFacts): Promise<unknown> {
    const exporter = new InMemorySpanExporter();
    const traces = new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    });
    equal(context.setGlobalContextManager(new StackContextManager()), true);
    try {
      traces.getTracer("trace-conformance").startActiveSpan("request", (span) => {
        try {
          annotateRequest(facts);
        } finally {
          span.end();
        }
      });
      await traces.forceFlush();
      return exporter.getFinishedSpans().map(({ attributes }) => attributes);
    } finally {
      context.disable();
      await traces.shutdown();
    }
  }
}

export function registerRequestTraceConformance(
  open: () => RequestTrace,
  register: (title: string, run: () => Promise<void>) => void,
): void {
  register("records only allowed request attribution", async () => {
    const provider = open();
    for (const { facts, attributes } of traceAttributionCases) {
      deepEqual(await provider.attributesFor(facts), [attributes]);
    }
  });
}
