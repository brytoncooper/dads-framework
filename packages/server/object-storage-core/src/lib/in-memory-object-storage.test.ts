import { objectStorageConformance } from "./object-storage-conformance.js";
/**
 * In-memory object-storage driver.
 * Why: unit tests construct this directly instead of stubbing S3.
 */
import { describe, expect, it } from "vitest";
import { InMemoryObjectStorage } from "./in-memory-object-storage.js";

describe("InMemoryObjectStorage", () => {
  it.each(objectStorageConformance)("$name", async ({ run }) => {
    await run(new InMemoryObjectStorage());
  });

  it("round-trips an object and deletes it", async () => {
    const objectStorage = new InMemoryObjectStorage();
    await objectStorage.put("reports/a.csv", "id,name\n1,alice\n", "text/csv");

    const stored = await objectStorage.get("reports/a.csv");
    expect(stored?.contentType).toBe("text/csv");
    expect(new TextDecoder().decode(stored?.body)).toContain("alice");

    await objectStorage.delete("reports/a.csv");
    await expect(objectStorage.get("reports/a.csv")).resolves.toBeNull();
  });

  it("lists the keys under a prefix, and only those", async () => {
    const objectStorage = new InMemoryObjectStorage();
    await objectStorage.put("builds/b.json", "{}", "application/json");
    await objectStorage.put("builds/a.json", "{}", "application/json");
    await objectStorage.put("releases/a.json", "{}", "application/json");

    await expect(objectStorage.list("builds/")).resolves.toEqual([
      "builds/a.json",
      "builds/b.json",
    ]);
    await expect(objectStorage.list("nothing/")).resolves.toEqual([]);
  });

  it("misses return null, not throws", async () => {
    await expect(new InMemoryObjectStorage().get("nope")).resolves.toBeNull();
  });

  it("names the key, type, length, hash and lifetime in a fake upload", async () => {
    await expect(
      new InMemoryObjectStorage().getSignedUpload("photos/one", {
        contentType: "image/png",
        byteSize: 12,
        sha256: "ab",
        expiresInSeconds: 60,
      }),
    ).resolves.toEqual({
      url: "memory://photos/one?upload=image/png&bytes=12&sha256=ab&expires=60",
      headers: { "content-type": "image/png", "content-length": "12" },
    });
  });
});
