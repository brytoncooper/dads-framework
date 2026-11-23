import { buildOpenApiDocument, type HttpRoute } from "@dads-framework/http";
import { workbenchRouteErrors } from "./route-errors.js";

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const failureStatuses = [404, 409, 503];

function workbenchFailure(status: number) {
  const errors = workbenchRouteErrors.filter((error) => error.status === status);
  return {
    description: errors.map(({ description }) => description).join(" "),
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: errors.map(({ code }) => code) },
                message: { type: "string" },
                ...(status === 409
                  ? {
                      details: {
                        type: "object",
                        properties: { retryable: { type: "boolean" } },
                      },
                    }
                  : {}),
              },
            },
          },
        },
      },
    },
  };
}

/** Publish the application's guarded-operation errors beside the kit's generated schemas. */
export function workbenchOpenApi(routes: readonly HttpRoute[]) {
  const document = buildOpenApiDocument(routes, {
    title: "Dads workbench API",
    description: "Workspace membership and task workflows.",
    version: "0.1.0",
    tags: [{ name: "Workbench", description: "Workspace and task operations." }],
    pathPrefix: "",
  });
  const paths = document["paths"];
  if (!objectValue(paths)) throw new Error("Workbench OpenAPI paths are missing.");
  for (const path of Object.values(paths)) {
    if (!objectValue(path)) continue;
    for (const operation of Object.values(path)) {
      if (!objectValue(operation) || !objectValue(operation["responses"])) continue;
      for (const status of failureStatuses) {
        operation["responses"][String(status)] = workbenchFailure(status);
      }
    }
  }
  return document;
}
