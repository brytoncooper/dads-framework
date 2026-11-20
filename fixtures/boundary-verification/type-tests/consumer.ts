import type { DocumentReadRequest } from "../src/consumer-types.js";

const validRequest: DocumentReadRequest = {
  policyJson: '"definition user {}"',
  readers: [{ userId: "alice", documentId: "document-1" }],
  userId: "alice",
  documentId: "document-1",
};

void validRequest;

const invalidReader: DocumentReadRequest = {
  policyJson: "{}",
  readers: [
    {
      userId: "alice",
      // @ts-expect-error Reader declarations require a document identity.
      documentId: 1,
    },
  ],
  userId: "alice",
  documentId: "document-1",
};

void invalidReader;
