const schemaRoot = "urn:ietf:params:scim:schemas:";
const maxBodyBytes = 64 * 1024;
const messageRoot = "urn:ietf:params:scim:api:messages:2.0:";

export const groupSchema = `${schemaRoot}core:2.0:Group`;
export const userSchema = `${schemaRoot}core:2.0:User`;
export const configSchema = `${schemaRoot}core:2.0:ServiceProviderConfig`;
export const resourceSchema = `${schemaRoot}core:2.0:ResourceType`;
export const schemaSchema = `${schemaRoot}core:2.0:Schema`;
export const patchSchema = `${messageRoot}PatchOp`;

export type ScimErrorType =
  | "invalidSyntax"
  | "invalidValue"
  | "invalidFilter"
  | "invalidPath"
  | "mutability"
  | "noTarget"
  | "uniqueness";

export class ScimError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly scimType?: ScimErrorType,
  ) {
    super(detail);
  }
}

export function scimJson(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/scim+json");
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

export function scimError(error: ScimError): Response {
  const headers =
    error.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined;
  return scimJson(
    {
      schemas: [`${messageRoot}Error`],
      status: String(error.status),
      detail: error.message,
      scimType: error.scimType,
    },
    error.status,
    headers,
  );
}

export function scimList(
  resources: readonly unknown[],
  totalResults = resources.length,
  startIndex = 1,
): Response {
  return scimJson({
    schemas: [`${messageRoot}ListResponse`],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function attributes(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new ScimError(400, "Expected an object.", "invalidValue");
  const entries = Object.entries(value).map(
    ([key, item]): [string, unknown] => [key.toLowerCase(), item],
  );
  return Object.fromEntries(entries);
}

export function attributePath(path: string, schema: string): string {
  const normalized = path.trim().toLowerCase();
  const prefix = `${schema.toLowerCase()}:`;
  return normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized;
}

export function userAttributePath(path: string): string {
  return attributePath(path, userSchema);
}

export function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

async function readScimPayload(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString("utf8");
      size += value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new ScimError(413, "The request body exceeds 64 KiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function scimBody(
  request: Request,
  schema: string,
): Promise<Record<string, unknown>> {
  const text = await readScimPayload(request);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ScimError(400, "The request body must be JSON.", "invalidSyntax");
  }
  const body = attributes(payload);
  const schemas = body["schemas"];
  if (
    !Array.isArray(schemas) ||
    schemas.length !== 1 ||
    schemas[0] !== schema
  ) {
    throw new ScimError(
      400,
      `The request must declare the ${schema} schema.`,
      "invalidSyntax",
    );
  }
  return body;
}

export function methodNotAllowed(methods: string): Response {
  const error = scimError(new ScimError(405, "Method not allowed."));
  error.headers.set("Allow", methods);
  return error;
}
