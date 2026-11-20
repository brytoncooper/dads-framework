import type { ObjectStorage } from "./object-storage.js";
import {
  type SignedUpload,
  type SignedUploadRequest,
  type StoredObject,
} from "./object-storage.js";

/** Test/dev driver: objects in a Map. Signed URLs are fake but stable and inspectable. */
export class InMemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, StoredObject>();

  put(
    key: string,
    body: Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { body: bytes, contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<StoredObject | null> {
    return Promise.resolve(this.objects.get(key) ?? null);
  }

  getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return Promise.resolve(
      `memory://${key}?expires=${expiresInSeconds.toString()}`,
    );
  }

  getSignedUpload(
    key: string,
    request: SignedUploadRequest,
  ): Promise<SignedUpload> {
    return Promise.resolve({
      url: `memory://${key}?upload=${request.contentType}&bytes=${request.byteSize.toString()}&sha256=${request.sha256}&expires=${request.expiresInSeconds.toString()}`,
      headers: {
        "content-type": request.contentType,
        "content-length": String(request.byteSize),
      },
    });
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve(
      [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
    );
  }
}
