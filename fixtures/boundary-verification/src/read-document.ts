import { parseZed } from "@dads-framework/access";
import type { DocumentReadRequest } from "./consumer-types.js";
import { readDocumentResult } from "./read-document-result.js";

/** The fixture knows only direct reader tuples; it supplies no workspace tuples. */
export function readProtectedDocument(request: DocumentReadRequest): Promise<string | undefined> {
  const artifact: unknown = JSON.parse(request.policyJson);
  if (typeof artifact !== "string") throw new Error("Expected a serialized access schema.");
  const document = parseZed(artifact).find((definition) => definition.wireName === "document");
  const reader = document?.roles.find((role) => role.name === "reader");
  const directUser = reader?.subjects.some((subject) => subject.kind === "type" && subject.wireName === "user");
  const allowsReader = document?.permissions
    .find((permission) => permission.name === "view")
    ?.terms.some((term) => term.kind === "role" && term.name === "reader");
  return readDocumentResult(request, ({ userId, documentId }) =>
    Promise.resolve(
      directUser === true &&
        allowsReader === true &&
        request.readers.some((entry) => entry.userId === userId && entry.documentId === documentId),
    ),
  );
}
