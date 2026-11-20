# @dads-framework/object-storage

Put, get, delete, and sign download or single-PUT upload URLs for object bytes. The composition
root picks the in-memory driver, the S3-compatible driver or the local disk driver
(`OBJECT_STORAGE_DRIVER`).

`DiskObjectStorage` keeps each object at `<root>/objects/<key>` with a SHA-256 sidecar. Writes are
whole or absent, a disk floor refuses a new file before the volume fills, and signed links are
path-only and HMAC-signed with a key the box makes (`loadOrCreateDiskSigningKey`).

`DirectTransferStorage` is the browser-direct seam on the same bucket:
server-chosen multipart uploads, presigned part and attachment-download URLs,
and the reads that verify a finished upload.

The package re-exports the capability and in-memory implementation from
[`@dads-framework/object-storage-core`](../object-storage-core/README.md).
The core's conformance suite also runs against the disk and S3 implementations.

## Try it

Use a writable temporary directory on a volume with enough free space to
leave at least 2 GiB or 5% of total capacity, whichever is larger, after the
write.

In a project using Node.js 22 or later, install the example dependencies.

```sh
npm install @dads-framework/object-storage
npm install -D tsx
```

Save this as `example.mts` and run `npx tsx example.mts`.

<!-- dads:check-example -->

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createObjectStorage,
  loadOrCreateDiskSigningKey,
} from "@dads-framework/object-storage";

const rootDirectory = await mkdtemp(join(tmpdir(), "dads-storage-"));
const storage = createObjectStorage({
  driver: "disk",
  rootDirectory,
  signingKey: () => loadOrCreateDiskSigningKey(rootDirectory),
  publicPathPrefix: "http://localhost:3000/files",
  clock: () => new Date(),
  log: console,
});

const key = "reports/daily.txt";
await storage.put(key, "Ready for review", "text/plain");
const stored = await storage.get(key);
if (stored) {
  console.log(stored.contentType, new TextDecoder().decode(stored.body));
}
console.log(join(rootDirectory, "objects", key));
```

The script prints `text/plain Ready for review` and the path to the written
file. Open that file to read its contents, then delete the temporary directory
when finished. The URL prefix configures signed links. This example uses local
file reads and writes.

The starter selects a memory or disk object store at composition time. [`apps/kit-workbench/assembly/local-services.ts`](../../../apps/kit-workbench/assembly/local-services.ts)

## Choose a storage path

Use `ObjectStorage.put` and `get` for server-owned bytes. For browser uploads,
create a signed upload with the required size, content type, and checksum.
Send the browser the returned URL and headers, then verify the stored object
before associating it with an application record.

## Download delivery

S3 options can carry one `CloudFrontDownloadSigner`, shared by
`getSignedUrl` and `presignAttachmentDownload`. Its deployment-owned HTTPS base
URL includes the public path prefix; callers use returned URLs unchanged. Native
CloudFront signatures cover the exact object path and optional `download`
filename query. The signer accepts published keys only, rejects `quarantine/`,
and limits link validity to one hour. Its clock is injected.

Uploads, object verification and server reads retain the configured S3 client.
Without the download signer, local MinIO and staged AWS environments retain S3
GET signatures. Browser download buttons navigate to attachment links; they do
not fetch the file into application memory. Before switching a deployment to the signer, configure CloudFront routing
and trusted public keys.
