import { attributes, isArray, ScimError } from "./protocol.js";

export type PatchOperation = {
  readonly action: "add" | "replace" | "remove";
  readonly path?: string;
  readonly value?: unknown;
};

function parseOperation(input: unknown): PatchOperation {
  const operation = attributes(input);
  const action =
    typeof operation["op"] === "string"
      ? operation["op"].toLowerCase()
      : undefined;
  const path = operation["path"];
  const value = operation["value"];
  if (action !== "add" && action !== "replace" && action !== "remove") {
    throw new ScimError(
      400,
      "Expected an add, replace, or remove operation.",
      "invalidSyntax",
    );
  }
  if (path !== undefined && (typeof path !== "string" || !path)) {
    throw new ScimError(400, "Invalid operation path.", "invalidPath");
  }
  validateTarget(action, path, value);
  return { action, ...(path === undefined ? {} : { path }), value };
}

function validateTarget(
  action: PatchOperation["action"],
  path: string | undefined,
  value: unknown,
): void {
  if (action === "remove" && path === undefined) {
    throw new ScimError(400, "Remove requires a path.", "noTarget");
  }
  if (action !== "remove" && value === undefined) {
    throw new ScimError(
      400,
      "This operation requires a value.",
      "invalidValue",
    );
  }
}

export function parsePatchOperations(
  body: Record<string, unknown>,
): readonly PatchOperation[] {
  const operations = body["operations"];
  if (!isArray(operations) || operations.length === 0) {
    throw new ScimError(
      400,
      "Expected a non-empty Operations list.",
      "invalidSyntax",
    );
  }
  return operations.map(parseOperation);
}
