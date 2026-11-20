import {
  parsePatchOperations,
  type PatchOperation,
} from "./patch-operations.js";
import type { ScimUserData } from "./directory.js";
import {
  attributes,
  isArray,
  ScimError,
  userAttributePath,
} from "./protocol.js";
import { nameAttributes, parseScimUser } from "./user-data.js";

const writableAttributes = [
  "userName",
  "active",
  "externalId",
  "displayName",
  "name",
  "emails",
];
const readOnlyAttributes = ["id", "meta", "schemas"];

function resolvePath(path: string): {
  attribute: string;
  subAttribute: string | undefined;
} {
  const [attribute, subAttribute, ...tail] = userAttributePath(path).split(".");
  if (attribute && readOnlyAttributes.includes(attribute)) {
    throw new ScimError(
      400,
      "The requested attribute is read-only.",
      "mutability",
    );
  }
  const canonical = writableAttributes.find(
    (key) => key.toLowerCase() === attribute,
  );
  if (
    !canonical ||
    tail.length ||
    (subAttribute !== undefined && canonical !== "name")
  ) {
    throw new ScimError(400, "Unsupported operation path.", "invalidPath");
  }
  return { attribute: canonical, subAttribute };
}

function changeNameAttribute(
  fields: Record<string, unknown>,
  subAttribute: string,
  operation: PatchOperation,
): void {
  if (!nameAttributes.some((key) => key.toLowerCase() === subAttribute)) {
    throw new ScimError(400, "Unknown name attribute.", "invalidPath");
  }
  const name = attributes(fields["name"] ?? {});
  changeValue(name, subAttribute, operation);
  fields["name"] = name;
}

function changeUserAttribute(
  fields: Record<string, unknown>,
  path: string,
  operation: PatchOperation,
): void {
  const { attribute, subAttribute } = resolvePath(path);
  if (subAttribute !== undefined) {
    changeNameAttribute(fields, subAttribute, operation);
    return;
  }
  if (attribute === "name" && operation.action === "add") {
    fields[attribute] = {
      ...attributes(fields[attribute] ?? {}),
      ...attributes(operation.value),
    };
    return;
  }
  if (
    attribute === "emails" &&
    operation.action === "add" &&
    isArray(operation.value)
  ) {
    const existing = fields[attribute];
    fields[attribute] = [
      ...(isArray(existing) ? existing : []),
      ...operation.value,
    ];
    return;
  }
  changeValue(fields, attribute, operation);
}

function changeValue(
  fields: Record<string, unknown>,
  key: string,
  operation: PatchOperation,
): void {
  if (operation.action === "remove") {
    if (key === "userName")
      throw new ScimError(400, "userName is required.", "mutability");
    fields[key] = undefined;
    return;
  }
  fields[key] = operation.value;
}

export function compileUserPatch(
  body: Record<string, unknown>,
): (current: ScimUserData) => ScimUserData {
  const plan = parsePatchOperations(body);
  return (current) => plan.reduce(applyOperation, current);
}

function applyOperation(
  current: ScimUserData,
  operation: PatchOperation,
): ScimUserData {
  const fields = { ...current };
  if (operation.path !== undefined) {
    changeUserAttribute(fields, operation.path, operation);
  } else {
    for (const [path, value] of Object.entries(attributes(operation.value))) {
      changeUserAttribute(fields, path, { ...operation, value });
    }
  }
  return parseScimUser(fields, current.active);
}
