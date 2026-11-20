/** Proves application result handling without loading a real policy or authorization engine. */

import { describe, expect, it } from "vitest";
import { readDocumentResult } from "./read-document-result.js";

describe("document read result", () => {
  it("returns the document only when the injected decision grants access", async () => {
    const request = { userId: "alice", documentId: "document-1" };

    await expect(
      readDocumentResult(request, () => Promise.resolve(false)),
    ).resolves.toBeUndefined();
    await expect(
      readDocumentResult(request, () => Promise.resolve(true)),
    ).resolves.toBe("document:document-1");
  });
});
