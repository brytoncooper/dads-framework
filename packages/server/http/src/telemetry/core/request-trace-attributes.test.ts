import { expect, it } from "vitest";
import { recordRequestTrace, traceAttributionCases } from "./testing/index.js";

it.each(traceAttributionCases)("records request attribution for $name", ({ facts, attributes }) => {
  const recorder = recordRequestTrace();
  expect(recorder.spans()).toEqual([]);
  recorder.annotateRequest(facts);
  expect(recorder.spans()).toEqual([attributes]);
});
