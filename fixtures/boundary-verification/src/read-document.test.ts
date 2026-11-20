/** Proves a protected consumer executes the serialized policy rather than its authoring source. */

import { describe, expect, it } from "vitest";
import { buildBoundaryVerificationPolicy } from "./build-policy.js";
import { readProtectedDocument } from "./read-document.js";

describe("boundary policy consumer", () => {
  it("denies without a relationship and grants through the serialized model", async () => {
    const policyJson = buildBoundaryVerificationPolicy();

    await expect(
      readProtectedDocument({
        policyJson,
        readers: [],
        userId: "alice",
        documentId: "document-1",
      }),
    ).resolves.toBeUndefined();

    await expect(
      readProtectedDocument({
        policyJson,
        readers: [{ userId: "alice", documentId: "document-1" }],
        userId: "alice",
        documentId: "document-1",
      }),
    ).resolves.toBe("document:document-1");
  });
});
