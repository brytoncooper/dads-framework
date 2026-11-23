import { describe, expect, it } from "vitest";

import { openResponseObjects } from "./open-response-objects.js";

const closedProfile = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
};

function operation(responseSchema: unknown, requestSchema?: unknown) {
  return {
    ...(requestSchema === undefined
      ? {}
      : {
          requestBody: {
            content: { "application/json": { schema: requestSchema } },
          },
        }),
    responses: {
      "200": { content: { "application/json": { schema: responseSchema } } },
    },
  };
}

describe("openResponseObjects", () => {
  it("opens an inline response object and every object nested in it", () => {
    const document = {
      paths: {
        "/me": {
          get: operation({
            type: "object",
            properties: { data: closedProfile },
            additionalProperties: false,
          }),
        },
      },
    };

    const opened = openResponseObjects(document);

    expect(opened).toHaveProperty(["paths", "/me", "get", "responses", "200", "content"], {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      },
    });
  });

  it("opens the components a response reaches through refs", () => {
    const document = {
      paths: {
        "/me": {
          get: operation({ $ref: "#/components/schemas/MeResponse" }),
        },
      },
      components: {
        schemas: {
          MeResponse: {
            type: "object",
            properties: { data: { $ref: "#/components/schemas/Profile" } },
            additionalProperties: false,
          },
          Profile: closedProfile,
        },
      },
    };

    const opened = openResponseObjects(document);

    expect(opened).not.toHaveProperty(["components", "schemas", "MeResponse", "additionalProperties"]);
    expect(opened).not.toHaveProperty(["components", "schemas", "Profile", "additionalProperties"]);
  });

  it("keeps a schema only a request uses closed", () => {
    const document = {
      paths: {
        "/visits": {
          post: operation({ type: "object" }, { $ref: "#/components/schemas/VisitBody" }),
        },
      },
      components: { schemas: { VisitBody: closedProfile } },
    };

    const opened = openResponseObjects(document);

    expect(opened).toHaveProperty(["components", "schemas", "VisitBody", "additionalProperties"], false);
  });

  it("opens a component a request shares with a response", () => {
    const shared = { $ref: "#/components/schemas/Visit" };
    const document = {
      paths: { "/visits": { post: operation(shared, shared) } },
      components: { schemas: { Visit: closedProfile } },
    };

    const opened = openResponseObjects(document);

    expect(opened).not.toHaveProperty(["components", "schemas", "Visit", "additionalProperties"]);
  });

  it("opens and follows a property whose name is a schema keyword", () => {
    const document = {
      paths: {
        "/settings": {
          get: operation({
            type: "object",
            properties: {
              default: closedProfile,
              required: { $ref: "#/components/schemas/Visit" },
            },
          }),
        },
      },
      components: { schemas: { Visit: closedProfile } },
    };

    const opened = openResponseObjects(document);

    expect(opened).not.toHaveProperty([
      "paths",
      "/settings",
      "get",
      "responses",
      "200",
      "content",
      "application/json",
      "schema",
      "properties",
      "default",
      "additionalProperties",
    ]);
    expect(opened).not.toHaveProperty(["components", "schemas", "Visit", "additionalProperties"]);
  });

  it("keeps an open map's value schema", () => {
    const meta = { type: "object", additionalProperties: { type: "string" } };
    const document = { paths: { "/me": { get: operation(meta) } } };

    const opened = openResponseObjects(document);

    expect(opened).toHaveProperty(["paths", "/me", "get", "responses", "200", "content"], {
      "application/json": { schema: meta },
    });
  });
});
