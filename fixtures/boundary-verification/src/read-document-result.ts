import type {
  CanReadDocument,
  DocumentReadIdentity,
} from "./consumer-types.js";

/** Owns the application result independently of any authorization engine. */
export async function readDocumentResult(
  request: DocumentReadIdentity,
  canRead: CanReadDocument,
): Promise<string | undefined> {
  return (await canRead(request))
    ? `document:${request.documentId}`
    : undefined;
}
