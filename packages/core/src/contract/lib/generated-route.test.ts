/**
 * What: generated routes carry their operation and keep branded binding inputs.
 * Why: generated client bindings must not widen a branded identifier to string.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineGeneratedRoute } from "./api-path.js";

describe("defineGeneratedRoute", () => {
  it("keeps the operation, template, and branded parameter on a bound route", () => {
    const widgetId = z.string().brand<"WidgetId">().parse("widget-1");
    const route = defineGeneratedRoute(
      "GET",
      "/widgets/:widgetId",
      "getWidgetsByWidgetId",
      (...[id]: [typeof widgetId]) => `/widgets/${encodeURIComponent(id)}`,
    );

    expect(route).toMatchObject({
      method: "GET",
      template: "/widgets/:widgetId",
      operation: "getWidgetsByWidgetId",
    });
    expect(route.bind(widgetId)).toEqual({
      method: "GET",
      template: "/widgets/:widgetId",
      operation: "getWidgetsByWidgetId",
      path: "/widgets/widget-1",
    });
  });
});
